// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title AgentFastLane — a capped petty-cash lane for a DeXe agent treasury
 * @notice TESTNET ONLY. UNAUDITED. Do not point a mainnet treasury at this code.
 *
 * A DeXe GovPool picks a proposal's voting settings by the executor of its LAST
 * action (`GovPoolCreate._validateProposal`), and calls that executor's
 * `validate(actions)` through a 30 000-gas staticcall before the proposal is
 * created. A DAO registers this contract as an executor with its own fast
 * settings (short vote, `validatorsVote = false`, the same agent quorum), so a
 * small payment needs only the agent vote — no human validator round.
 *
 * Because the settings cannot depend on the amount, the lane bounds what the
 * fast path can move, and bounds it twice:
 *
 *  1. `validate` (creation time) returns false for anything that is not a
 *     well-formed, allowlisted, capped `pay` on this lane. It never reverts and
 *     stays well under the 30k gas budget: on this protocol a reverting or
 *     out-of-gas `validate` counts as ALLOWED.
 *  2. `pay` (execution time) enforces the same per-payment cap, a rolling
 *     30-day cap and the allowlist again. Even if creation-time validation were
 *     bypassed, execution still refuses.
 *
 * The lane HOLDS A FLOAT of one ERC20 (sent to it at DAO deploy or by a normal
 * treasury proposal) rather than pulling from the GovPool by allowance: the
 * exposure is then the float itself, there is no allowance state to grief, and a
 * refill is an ordinary validator-round proposal — a human decision per top-up.
 *
 * The allowlist and the float can only be changed by the GovPool, and only via
 * `admin` (a child contract). Its address is NOT the lane's, so a proposal that
 * targets it runs under the DAO's DEFAULT settings, with the validator round.
 * (A proposal whose last action targets the lane with any selector other than
 * `pay` fails validation, so the allowlist cannot be edited on the fast path.)
 */

/// @dev Mirrors `IGovPool.ProposalAction` (DeXe-Protocol, interfaces/gov/IGovPool.sol).
struct ProposalAction {
    address executor;
    uint256 value;
    bytes data;
}

/// @dev Mirrors `IProposalValidator` (DeXe-Protocol, interfaces/gov/proposals/IProposalValidator.sol).
interface IProposalValidator {
    function validate(ProposalAction[] calldata actions) external view returns (bool valid);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @notice The lane's admin surface. A separate address on purpose: proposals
 * that target it run under the DAO's default settings (validator round).
 */
contract AgentFastLaneAdmin {
    AgentFastLane public immutable lane;
    address public immutable govPool;

    constructor(address govPool_) {
        lane = AgentFastLane(msg.sender);
        govPool = govPool_;
    }

    modifier onlyGovPool() {
        require(msg.sender == govPool, "FastLaneAdmin: not govPool");
        _;
    }

    /// @notice Allow or disallow one recipient. GovPool only (slow lane).
    function setAllowed(address recipient, bool allowed) external onlyGovPool {
        lane.adminSetAllowed(recipient, allowed);
    }

    /// @notice Allow or disallow several recipients at once. GovPool only (slow lane).
    function setAllowedBatch(address[] calldata recipients, bool allowed) external onlyGovPool {
        for (uint256 i; i < recipients.length; i++) {
            lane.adminSetAllowed(recipients[i], allowed);
        }
    }

    /// @notice Send `amount` of the float back to the GovPool. GovPool only (slow lane).
    function recall(uint256 amount) external onlyGovPool {
        lane.adminRecall(amount);
    }
}

contract AgentFastLane is IProposalValidator {
    /// @notice Length of the rolling spend window, in days.
    uint256 public constant WINDOW_DAYS = 30;
    /// @notice Most actions a fast-lane proposal may carry (keeps `validate` under its gas budget).
    uint256 public constant MAX_ACTIONS = 3;
    /// @dev Expired, non-empty day-buckets `validate` is willing to read (each is a cold SLOAD).
    uint256 private constant VALIDATE_SETTLE_READS = 3;
    uint256 private constant MASK_30 = (1 << WINDOW_DAYS) - 1;

    address public immutable govPool;
    IERC20Minimal public immutable token;
    uint256 public immutable perPaymentCap;
    uint256 public immutable windowCap;
    AgentFastLaneAdmin public immutable admin;

    mapping(address => bool) public allowed;

    /// @dev One slot. `_spent` is the exact sum of `dayBuckets[d]` for d in [_lastDay − 29, _lastDay];
    ///      bit k of `_mask` is set iff `dayBuckets[_lastDay − k]` is non-zero (k < 30).
    uint64 private _lastDay;
    uint32 private _mask;
    uint160 private _spent;
    /// @notice Amount paid on day `d` (`block.timestamp / 1 days`).
    mapping(uint256 => uint256) public dayBuckets;

    uint256 private _entered;

    event Paid(address indexed to, uint256 amount, uint256 spentInWindow);
    event AllowedSet(address indexed recipient, bool allowed);
    event Recalled(uint256 amount);

    /**
     * @param govPool_ The GovPool that may call `pay` (predicted before the DAO deploy).
     * @param token_ The one ERC20 this lane pays with. Caps are in its units.
     * @param perPaymentCap_ Largest single payment (> 0, ≤ windowCap_).
     * @param windowCap_ Largest total over any rolling 30-day window (≤ 2^160 − 1).
     * @param initialAllowlist Recipients allowed from the start (non-zero).
     */
    constructor(
        address govPool_,
        address token_,
        uint256 perPaymentCap_,
        uint256 windowCap_,
        address[] memory initialAllowlist
    ) {
        require(govPool_ != address(0), "FastLane: zero govPool");
        require(token_ != address(0), "FastLane: zero token");
        require(perPaymentCap_ != 0, "FastLane: zero per-payment cap");
        require(perPaymentCap_ <= windowCap_, "FastLane: per-payment cap > window cap");
        require(windowCap_ <= type(uint160).max, "FastLane: window cap too large");

        govPool = govPool_;
        token = IERC20Minimal(token_);
        perPaymentCap = perPaymentCap_;
        windowCap = windowCap_;
        admin = new AgentFastLaneAdmin(govPool_);

        for (uint256 i; i < initialAllowlist.length; i++) {
            require(initialAllowlist[i] != address(0), "FastLane: zero recipient");
            allowed[initialAllowlist[i]] = true;
            emit AllowedSet(initialAllowlist[i], true);
        }
    }

    // ------------------------------------------------------------------ execution

    /**
     * @notice Pay `amount` of `token` to an allowlisted `to`. GovPool only (a proposal action).
     * @dev Non-payable: a call with value reverts. Enforces every cap again at execution.
     */
    function pay(address to, uint256 amount) external {
        require(msg.sender == govPool, "FastLane: not govPool");
        require(_entered == 0, "FastLane: reentrant");
        _entered = 1;

        require(allowed[to], "FastLane: recipient not allowed");
        require(amount != 0, "FastLane: zero amount");
        require(amount <= perPaymentCap, "FastLane: over per-payment cap");

        (uint256 today, uint256 spent, uint256 mask, ) = _settle(type(uint256).max);
        require(spent + amount <= windowCap, "FastLane: over 30-day cap");
        spent += amount;

        _lastDay = uint64(today);
        _mask = uint32(mask | 1);
        _spent = uint160(spent);
        dayBuckets[today] += amount;

        emit Paid(to, amount, spent);
        _transfer(to, amount);

        _entered = 0;
    }

    // ------------------------------------------------------------------ validation

    /**
     * @notice The GovPool's creation-time hook. Never reverts; false means "refuse".
     * @dev Accepts only: 1..MAX_ACTIONS actions, each `this.pay(to, amount)` with
     *      value 0, exactly 68 bytes of data, an allowlisted `to`, 0 < amount ≤
     *      perPaymentCap, and the sum within what the rolling window still allows.
     *      Checks the cheap, bounded things first so a huge or hostile action list
     *      costs almost nothing.
     */
    function validate(ProposalAction[] calldata actions) external view override returns (bool) {
        uint256 n = actions.length;
        if (n == 0 || n > MAX_ACTIONS) return false;

        uint256 total;
        for (uint256 i; i < n; i++) {
            ProposalAction calldata a = actions[i];
            if (a.executor != address(this) || a.value != 0) return false;

            bytes calldata d = a.data;
            if (d.length != 68) return false;
            if (bytes4(d[:4]) != this.pay.selector) return false;

            uint256 toWord;
            uint256 amount;
            assembly ("memory-safe") {
                toWord := calldataload(add(d.offset, 4))
                amount := calldataload(add(d.offset, 36))
            }
            if (toWord >> 160 != 0) return false; // dirty address word
            if (!allowed[address(uint160(toWord))]) return false;
            if (amount == 0 || amount > perPaymentCap) return false;
            total += amount; // ≤ MAX_ACTIONS × perPaymentCap ≤ 3 × 2^160: cannot overflow
        }

        // Conservative when more than VALIDATE_SETTLE_READS non-empty buckets
        // expired since the last payment (`exact == false`): it may refuse a
        // payment `pay` would still accept; it never accepts one `pay` would
        // refuse. A smaller payment that fits what was settled goes through and
        // `pay` then settles everything exactly.
        (, uint256 spent, , ) = _settle(VALIDATE_SETTLE_READS);
        return spent + total <= windowCap;
    }

    // ------------------------------------------------------------------ views

    /// @notice Exact amount paid in the current rolling 30-day window.
    function spentInWindow() public view returns (uint256) {
        (, uint256 spent, , ) = _settle(type(uint256).max);
        return spent;
    }

    /// @notice What the lane can still pay: the window headroom and the float balance.
    function available() external view returns (uint256 windowRemaining, uint256 floatBalance) {
        uint256 spent = spentInWindow();
        windowRemaining = spent >= windowCap ? 0 : windowCap - spent;
        floatBalance = token.balanceOf(address(this));
    }

    // ------------------------------------------------------------------ admin (via `admin` only)

    function adminSetAllowed(address recipient, bool isAllowed) external {
        require(msg.sender == address(admin), "FastLane: not admin");
        require(recipient != address(0), "FastLane: zero recipient");
        allowed[recipient] = isAllowed;
        emit AllowedSet(recipient, isAllowed);
    }

    function adminRecall(uint256 amount) external {
        require(msg.sender == address(admin), "FastLane: not admin");
        emit Recalled(amount);
        _transfer(govPool, amount);
    }

    // ------------------------------------------------------------------ internals

    /**
     * @dev Rolls the window forward to today. Returns the day index, the spend
     *      still inside the window, the occupancy mask re-based on today, and
     *      whether every expired bucket was subtracted. Only non-empty buckets
     *      are read (the mask says which); with `maxReads` below their number the
     *      spend is an over-estimate (never an under-estimate). Never reverts.
     */
    function _settle(uint256 maxReads)
        internal
        view
        returns (uint256 today, uint256 spent, uint256 mask, bool exact)
    {
        today = block.timestamp / 1 days;
        uint256 last = _lastDay;
        spent = _spent;
        mask = _mask;
        exact = true;

        if (today <= last) return (today, spent, mask, true);
        uint256 delta = today - last;
        if (delta >= WINDOW_DAYS || spent == 0) return (today, 0, 0, true);

        // The window at `last` covered [last − 29, last]; today it covers
        // [today − 29, today]. Bucket `last − k` has expired when k ≥ 30 − delta.
        uint256 reads;
        for (uint256 k = WINDOW_DAYS - delta; k < WINDOW_DAYS; k++) {
            if (mask & (1 << k) == 0) continue;
            if (reads == maxReads) return (today, spent, mask, false);
            spent -= dayBuckets[last - k];
            reads++;
        }
        mask = (mask << delta) & MASK_30;
    }

    function _transfer(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "FastLane: transfer failed");
    }
}
