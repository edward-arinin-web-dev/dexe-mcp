import { beforeAll, describe, expect, it } from "vitest";
import { AbiCoder, Interface, getAddress } from "ethers";
import { Evm, compileSol } from "../helpers/evm.js";
import {
  AGENT_FAST_LANE_ABI,
  AGENT_FAST_LANE_ADMIN_ABI,
  AGENT_FAST_LANE_BYTECODE,
} from "../../src/lib/abi/agentFastLane.generated.js";

/**
 * AgentFastLane against an in-process EVM (tests/helpers/evm.ts).
 *
 * The contract is the fast lane of the agent treasury: a DeXe GovPool calls
 * `validate(actions)` with 30 000 gas before creating a proposal whose last
 * action targets the lane, and treats a REVERT or OUT-OF-GAS as "allowed"
 * (GovPoolCreate._validateProposalCreation). So the two properties under test
 * are: `validate` never reverts and stays far under 30k gas for any input, and
 * `pay` enforces every cap again at execution time.
 *
 * MockGovPool below reproduces the protocol's exact gating line so the budget
 * is measured the way the real pool spends it.
 */

const DEPLOYER = "0x1000000000000000000000000000000000000001";
const STRANGER = "0x1000000000000000000000000000000000000009";
const R1 = "0x4000000000000000000000000000000000000004";
const R2 = "0x4000000000000000000000000000000000000005";
const R3 = "0x4000000000000000000000000000000000000006";
const R4 = "0x4000000000000000000000000000000000000007";
const OUTSIDER = "0x4000000000000000000000000000000000000099";

const PER_PAYMENT = 100n;
const WINDOW = 300n;
const DAY = 86_400;

const laneIface = new Interface(AGENT_FAST_LANE_ABI);
const PAY = laneIface.getFunction("pay")!.selector;

const MOCKS = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

struct ProposalAction { address executor; uint256 value; bytes data; }
interface IProposalValidator { function validate(ProposalAction[] calldata actions) external view returns (bool); }
interface ILane { function pay(address to, uint256 amount) external; }

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    bool public returnFalse;
    address public hook;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setReturnFalse(bool v) external { returnFalse = v; }
    function setHook(address h) external { hook = h; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        require(balanceOf[msg.sender] >= amount, "ERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (hook != address(0)) IHook(hook).onTransfer(to, amount);
        return true;
    }
}
interface IHook { function onTransfer(address to, uint256 amount) external; }

/// transfer() with no return value (USDT-style)
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "ERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// The protocol's creation-time gate, verbatim (GovPoolCreate._validateProposalCreation),
/// plus an execute() that calls the lane the way GovPoolExecute does.
contract MockGovPool is IHook {
    uint256 public lastGasUsed;
    bool public reentered;
    string public reentryReason;
    address public lane;

    function setLane(address l) external { lane = l; }

    function validateProposalCreation(address executor, ProposalAction[] calldata actionsFor) external {
        uint256 g0 = gasleft();
        (bool ok, bytes memory data) = executor.staticcall{gas: 30000}(
            abi.encodeWithSelector(IProposalValidator.validate.selector, actionsFor)
        );
        lastGasUsed = g0 - gasleft();
        require(!ok || data.length == 0 || abi.decode(data, (bool)), "Gov: validation failed");
    }

    function execute(ProposalAction[] calldata actions) external {
        for (uint256 i; i < actions.length; i++) {
            (bool status, bytes memory returnedData) = actions[i].executor.call{value: actions[i].value}(actions[i].data);
            if (!status) {
                assembly { revert(add(returnedData, 32), mload(returnedData)) }
            }
        }
    }

    /// Re-enter the lane from inside the token transfer (a token with hooks).
    function onTransfer(address to, uint256) external {
        try ILane(lane).pay(to, 1) { reentered = true; } catch Error(string memory r) { reentryReason = r; }
    }
}
`;

let erc20: { abi: any; bytecode: string };
let noReturn: { abi: any; bytecode: string };
let govPoolMock: { abi: any; bytecode: string };

beforeAll(() => {
  erc20 = compileSol(MOCKS, "MockERC20");
  noReturn = compileSol(MOCKS, "NoReturnToken");
  govPoolMock = compileSol(MOCKS, "MockGovPool");
});

interface World {
  evm: Evm;
  gov: string;
  token: string;
  lane: string;
  admin: string;
}

async function world(opts: { float?: bigint; window?: bigint; token?: "erc20" | "noReturn"; allow?: string[] } = {}): Promise<World> {
  const evm = await Evm.create();
  await evm.fund(DEPLOYER);
  await evm.fund(STRANGER);
  const gov = await evm.deploy(DEPLOYER, govPoolMock.bytecode, govPoolMock.abi);
  const tk = opts.token === "noReturn" ? noReturn : erc20;
  const token = await evm.deploy(DEPLOYER, tk.bytecode, tk.abi);
  const lane = await evm.deploy(DEPLOYER, AGENT_FAST_LANE_BYTECODE, AGENT_FAST_LANE_ABI, [
    gov,
    token,
    PER_PAYMENT,
    opts.window ?? WINDOW,
    opts.allow ?? [R1, R2, R3, R4],
  ]);
  const [admin] = await evm.call(DEPLOYER, lane, AGENT_FAST_LANE_ABI, "admin");
  await evm.send(DEPLOYER, token, tk.abi, "mint", [lane, opts.float ?? 10_000n]);
  await evm.send(DEPLOYER, gov, govPoolMock.abi, "setLane", [lane]);
  return { evm, gov, token, lane, admin: String(admin) };
}

type Action = { executor: string; value: bigint; data: string };
const payAction = (lane: string, to: string, amount: bigint, value = 0n): Action => ({
  executor: lane,
  value,
  data: laneIface.encodeFunctionData("pay", [to, amount]),
});

/** validate() straight on the lane (10M gas): the boolean and the gas it took. */
async function validateDirect(w: World, actions: Action[]) {
  const r = await w.evm.send(w.gov, w.lane, AGENT_FAST_LANE_ABI, "validate", [actions]);
  if (!r.ok) throw new Error(`validate REVERTED: ${r.error}`);
  const [valid] = laneIface.decodeFunctionResult("validate", r.returnData);
  return { valid: Boolean(valid), gasUsed: r.gasUsed };
}

/** validate() through the protocol's 30k-gas gate (MockGovPool). ok = creation allowed. */
async function validateViaGov(w: World, actions: Action[]) {
  const r = await w.evm.send(DEPLOYER, w.gov, govPoolMock.abi, "validateProposalCreation", [w.lane, actions]);
  const [gas] = await w.evm.call(DEPLOYER, w.gov, govPoolMock.abi, "lastGasUsed");
  return { allowed: r.ok, error: r.error, gateGas: BigInt(gas as bigint) };
}

async function execute(w: World, actions: Action[]) {
  return w.evm.send(DEPLOYER, w.gov, govPoolMock.abi, "execute", [actions]);
}

async function balance(w: World, who: string): Promise<bigint> {
  const [b] = await w.evm.call(DEPLOYER, w.token, erc20.abi, "balanceOf", [who]);
  return BigInt(b as bigint);
}

async function spent(w: World): Promise<bigint> {
  const [s] = await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "spentInWindow");
  return BigInt(s as bigint);
}

// ---------------------------------------------------------------------------

describe("constructor", () => {
  it("refuses a zero govPool, a zero cap, a per-payment cap above the window cap, and a zero recipient", async () => {
    const evm = await Evm.create();
    await evm.fund(DEPLOYER);
    const token = await evm.deploy(DEPLOYER, erc20.bytecode, erc20.abi);
    const gov = await evm.deploy(DEPLOYER, govPoolMock.bytecode, govPoolMock.abi);
    const cases: Array<[unknown[], string]> = [
      [["0x0000000000000000000000000000000000000000", token, 1n, 2n, []], "FastLane: zero govPool"],
      [[gov, "0x0000000000000000000000000000000000000000", 1n, 2n, []], "FastLane: zero token"],
      [[gov, token, 0n, 2n, []], "FastLane: zero per-payment cap"],
      [[gov, token, 3n, 2n, []], "FastLane: per-payment cap > window cap"],
      [[gov, token, 1n, 2n ** 160n, []], "FastLane: window cap too large"],
      [[gov, token, 1n, 2n, ["0x0000000000000000000000000000000000000000"]], "FastLane: zero recipient"],
    ];
    for (const [args, reason] of cases) {
      const r = await evm.tryDeploy(DEPLOYER, AGENT_FAST_LANE_BYTECODE, AGENT_FAST_LANE_ABI, args);
      expect(r.ok, reason).toBe(false);
      expect(r.error).toBe(reason);
    }
  });

  it("deploys its admin child bound to the same govPool and seeds the allowlist", async () => {
    const w = await world({ allow: [R1] });
    const [adminGov] = await w.evm.call(DEPLOYER, w.admin, AGENT_FAST_LANE_ADMIN_ABI, "govPool");
    const [adminLane] = await w.evm.call(DEPLOYER, w.admin, AGENT_FAST_LANE_ADMIN_ABI, "lane");
    expect(getAddress(String(adminGov))).toBe(getAddress(w.gov));
    expect(getAddress(String(adminLane))).toBe(getAddress(w.lane));
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "allowed", [R1]))[0]).toBe(true);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "allowed", [R2]))[0]).toBe(false);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "MAX_ACTIONS"))[0]).toBe(3n);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "WINDOW_DAYS"))[0]).toBe(30n);
  });
});

describe("validate — accepts", () => {
  it("one allowlisted pay within the cap", async () => {
    const w = await world();
    expect((await validateDirect(w, [payAction(w.lane, R1, PER_PAYMENT)])).valid).toBe(true);
    expect((await validateViaGov(w, [payAction(w.lane, R1, 1n)])).allowed).toBe(true);
  });

  it("MAX_ACTIONS pays to distinct recipients whose sum fits the window", async () => {
    const w = await world();
    const actions = [R1, R2, R3].map((r) => payAction(w.lane, r, PER_PAYMENT)); // 300 = window cap
    expect((await validateDirect(w, actions)).valid).toBe(true);
  });
});

describe("validate — refuses (returns false, never reverts)", () => {
  const refusals: Array<[string, (w: World) => Action[] | Promise<Action[]>]> = [
    ["an empty action list", () => []],
    ["more than MAX_ACTIONS actions (checked before anything else)", (w) => Array(4).fill(payAction(w.lane, R1, 1n))],
    ["an action whose executor is not the lane", (w) => [{ ...payAction(w.lane, R1, 1n), executor: w.gov }]],
    [
      "a mixed list: a big token.transfer first, then the lane pay",
      (w) => [
        {
          executor: w.token,
          value: 0n,
          data: new Interface(erc20.abi).encodeFunctionData("transfer", [OUTSIDER, 1_000_000n]),
        },
        payAction(w.lane, R1, 1n),
      ],
    ],
    ["a mixed list: the lane pay first, then a big token.transfer (the lane is not last — the DAO would use default settings; the lane still refuses it as a bundle)",
      (w) => [
        payAction(w.lane, R1, 1n),
        { executor: w.token, value: 0n, data: new Interface(erc20.abi).encodeFunctionData("transfer", [OUTSIDER, 1n]) },
      ],
    ],
    [
      // GovPoolCreate exempts `approve` / `setApprovalForAll` from the "forced to
      // DEFAULT" rule, so [token.approve, lane.pay] would land on the FAST slot
      // if the lane did not refuse every bundle with a foreign executor.
      "a mixed list: token.approve(attacker, huge) first, then the lane pay (the protocol's approve exemption)",
      (w) => [
        {
          executor: w.token,
          value: 0n,
          data: new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [OUTSIDER, 2n ** 255n]),
        },
        payAction(w.lane, R1, 1n),
      ],
    ],
    ["a pay carrying native value", (w) => [payAction(w.lane, R1, 1n, 1n)]],
    ["a selector other than pay (adminSetAllowed on the lane)", (w) => [
      { executor: w.lane, value: 0n, data: laneIface.encodeFunctionData("adminSetAllowed", [OUTSIDER, true]) },
    ]],
    ["a selector other than pay (adminRecall on the lane)", (w) => [
      { executor: w.lane, value: 0n, data: laneIface.encodeFunctionData("adminRecall", [1n]) },
    ]],
    ["a recipient that is not allowlisted", (w) => [payAction(w.lane, OUTSIDER, 1n)]],
    ["a zero amount", (w) => [payAction(w.lane, R1, 0n)]],
    ["an amount over the per-payment cap", (w) => [payAction(w.lane, R1, PER_PAYMENT + 1n)]],
    ["an amount of 2^256−1 (no overflow in the sum)", (w) => [payAction(w.lane, R1, 2n ** 256n - 1n), payAction(w.lane, R2, 2n ** 256n - 1n)]],
    ["pay data one byte short", (w) => [{ ...payAction(w.lane, R1, 1n), data: payAction(w.lane, R1, 1n).data.slice(0, -2) }]],
    ["pay data with a trailing byte", (w) => [{ ...payAction(w.lane, R1, 1n), data: payAction(w.lane, R1, 1n).data + "00" }]],
    ["empty data", (w) => [{ executor: w.lane, value: 0n, data: "0x" }]],
    ["a bare selector with no arguments", (w) => [{ executor: w.lane, value: 0n, data: PAY }]],
    [
      "a dirty address word (high bits set) that abi.decode would have reverted on",
      (w) => [{
        executor: w.lane,
        value: 0n,
        data: PAY + "ff".repeat(12) + R1.slice(2) + AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]).slice(2),
      }],
    ],
  ];

  for (const [name, mk] of refusals) {
    it(name, async () => {
      const w = await world();
      const actions = await mk(w);
      const direct = await validateDirect(w, actions);
      expect(direct.valid).toBe(false);
      const gate = await validateViaGov(w, actions);
      expect(gate.allowed).toBe(false);
      expect(gate.error).toBe("Gov: validation failed");
    });
  }

  it("a sum over the window cap even though each pay is within the per-payment cap", async () => {
    const w = await world({ window: 250n });
    const actions = [payAction(w.lane, R1, PER_PAYMENT), payAction(w.lane, R2, PER_PAYMENT), payAction(w.lane, R3, 51n)];
    expect((await validateDirect(w, actions)).valid).toBe(false);
    expect((await validateViaGov(w, actions)).allowed).toBe(false);
    actions[2] = payAction(w.lane, R3, 50n);
    expect((await validateDirect(w, actions)).valid).toBe(true);
  });

  it("a 1 000-action list is refused on the length check alone, for a few hundred gas", async () => {
    const w = await world();
    const actions = Array(1000).fill(payAction(w.lane, R1, 1n));
    const r = await validateDirect(w, actions);
    expect(r.valid).toBe(false);
    expect(r.gasUsed).toBeLessThan(2_000n);
  });

  it("refuses once the rolling window is spent, and accepts again when it rolls", async () => {
    const w = await world();
    for (const r of [R1, R2, R3]) {
      expect((await execute(w, [payAction(w.lane, r, PER_PAYMENT)])).ok).toBe(true);
      w.evm.warp(DAY);
    }
    // day 3: 300 spent on days 0,1,2 — nothing left
    expect((await validateDirect(w, [payAction(w.lane, R4, 1n)])).valid).toBe(false);
    w.evm.warp(26 * DAY); // day 29: the day-0 bucket is still inside [0, 29]
    expect((await validateDirect(w, [payAction(w.lane, R4, 1n)])).valid).toBe(false);
    w.evm.warp(DAY); // day 30: window is [1, 30] — day 0 expired, 100 free
    expect((await validateDirect(w, [payAction(w.lane, R4, PER_PAYMENT)])).valid).toBe(true);
    expect((await validateDirect(w, [payAction(w.lane, R4, PER_PAYMENT + 1n)])).valid).toBe(false);
  });
});

describe("validate — gas budget (the protocol forwards 30 000)", () => {
  it("worst case — MAX_ACTIONS distinct cold recipients with expired buckets pending — passes the 30k gate with margin", async () => {
    const w = await world();
    // Payments on days 0..3, then jump to day 32 (window [3, 32]): buckets 0,1,2
    // are expired and not yet settled (pay() has not run since) → three cold
    // bucket reads on top of the three cold allowlist reads and the packed slot.
    for (const r of [R1, R2, R3, R4]) {
      expect((await execute(w, [payAction(w.lane, r, 1n)])).ok).toBe(true);
      w.evm.warp(DAY);
    }
    w.evm.warp(28 * DAY);
    const actions = [R1, R2, R3].map((r) => payAction(w.lane, r, 99n)); // 297 + 1 still inside the window
    const direct = await validateDirect(w, actions);
    expect(direct.valid).toBe(true);
    expect(direct.gasUsed).toBeLessThan(25_000n);
    const gate = await validateViaGov(w, actions);
    expect(gate.allowed).toBe(true);
    expect(gate.gateGas).toBeLessThan(30_000n);
  });

  it("is conservative, never permissive, when more non-empty buckets expired than it will read", async () => {
    const w = await world();
    // Five payments of 60 on days 0..4 (window full), then day 33: window [4, 33],
    // days 0..3 expired = four non-empty buckets; validate reads at most three.
    for (const r of [R1, R2, R3, R4, R1]) {
      expect((await execute(w, [payAction(w.lane, r, 60n)])).ok).toBe(true);
      w.evm.warp(DAY);
    }
    w.evm.warp(28 * DAY); // day 33
    expect(await spent(w)).toBe(60n); // exact: only day 4 is inside the window
    // validate subtracts three of the four → thinks 120 is still spent → accepts 180, refuses 181.
    expect((await validateDirect(w, [payAction(w.lane, R1, 90n), payAction(w.lane, R2, 90n)])).valid).toBe(true);
    expect((await validateDirect(w, [payAction(w.lane, R1, 91n), payAction(w.lane, R2, 90n)])).valid).toBe(false);
    // pay settles exactly and lets the whole window through
    for (const r of [R1, R2, R3, R4]) expect((await execute(w, [payAction(w.lane, r, 60n)])).ok).toBe(true);
    expect(await spent(w)).toBe(300n);
    expect((await validateDirect(w, [payAction(w.lane, R1, 1n)])).valid).toBe(false);
  });

  it("stays exact across a long gap when few distinct days were paid (the mask skips empty days)", async () => {
    const w = await world();
    expect((await execute(w, [payAction(w.lane, R1, PER_PAYMENT)])).ok).toBe(true);
    w.evm.warp(DAY);
    expect((await execute(w, [payAction(w.lane, R2, PER_PAYMENT)])).ok).toBe(true);
    w.evm.warp(DAY);
    expect((await execute(w, [payAction(w.lane, R3, PER_PAYMENT)])).ok).toBe(true);
    // day 2, window full. Jump 28 days → day 30: window [1, 30], day 0 expired → 100 free, exactly.
    w.evm.warp(28 * DAY);
    const r = await validateDirect(w, [payAction(w.lane, R4, PER_PAYMENT)]);
    expect(r.valid).toBe(true);
    expect((await validateDirect(w, [payAction(w.lane, R4, PER_PAYMENT + 1n)])).valid).toBe(false);
  });
});

describe("pay — execution-time enforcement", () => {
  it("moves the float to an allowlisted recipient and records the spend", async () => {
    const w = await world();
    const r = await execute(w, [payAction(w.lane, R1, 40n)]);
    expect(r.ok).toBe(true);
    expect(await balance(w, R1)).toBe(40n);
    expect(await balance(w, w.lane)).toBe(10_000n - 40n);
    expect(await spent(w)).toBe(40n);
    const [remaining, float] = await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "available");
    expect(remaining).toBe(WINDOW - 40n);
    expect(float).toBe(10_000n - 40n);
  });

  it("refuses a caller that is not the govPool (an EOA, the admin, the token)", async () => {
    const w = await world();
    for (const from of [DEPLOYER, STRANGER, w.admin, w.token]) {
      const r = await w.evm.send(from, w.lane, AGENT_FAST_LANE_ABI, "pay", [R1, 1n]);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("FastLane: not govPool");
    }
  });

  it("refuses native value (non-payable)", async () => {
    const w = await world();
    await w.evm.fund(w.gov);
    const r = await w.evm.send(w.gov, w.lane, AGENT_FAST_LANE_ABI, "pay", [R1, 1n], { value: 1n });
    expect(r.ok).toBe(false);
  });

  it("refuses a recipient that is not allowlisted, a zero amount, and an amount over the per-payment cap", async () => {
    const w = await world();
    const cases: Array<[Action, string]> = [
      [payAction(w.lane, OUTSIDER, 1n), "FastLane: recipient not allowed"],
      [payAction(w.lane, R1, 0n), "FastLane: zero amount"],
      [payAction(w.lane, R1, PER_PAYMENT + 1n), "FastLane: over per-payment cap"],
    ];
    for (const [a, reason] of cases) {
      const r = await execute(w, [a]);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(reason);
    }
    expect(await balance(w, OUTSIDER)).toBe(0n);
  });

  it("enforces the rolling 30-day cap exactly, bucket by bucket", async () => {
    const w = await world();
    // day 0: 100, day 10: 100, day 20: 100 → window full
    expect((await execute(w, [payAction(w.lane, R1, PER_PAYMENT)])).ok).toBe(true);
    w.evm.warp(10 * DAY);
    expect((await execute(w, [payAction(w.lane, R2, PER_PAYMENT)])).ok).toBe(true);
    w.evm.warp(10 * DAY);
    expect((await execute(w, [payAction(w.lane, R3, PER_PAYMENT)])).ok).toBe(true);
    expect(await spent(w)).toBe(300n);

    const full = await execute(w, [payAction(w.lane, R4, 1n)]);
    expect(full.ok).toBe(false);
    expect(full.error).toBe("FastLane: over 30-day cap");

    w.evm.warp(9 * DAY); // day 29: window [0, 29] still holds day 0
    expect((await execute(w, [payAction(w.lane, R4, 1n)])).error).toBe("FastLane: over 30-day cap");

    w.evm.warp(DAY); // day 30: window [1, 30] — day 0 expired → 100 free
    expect(await spent(w)).toBe(200n);
    expect((await execute(w, [payAction(w.lane, R4, 100n)])).ok).toBe(true);
    expect((await execute(w, [payAction(w.lane, R4, 1n)])).error).toBe("FastLane: over 30-day cap");

    w.evm.warp(10 * DAY); // day 40: window [11, 40] — day 10 expired
    expect(await spent(w)).toBe(200n);
    w.evm.warp(10 * DAY); // day 50: window [21, 50] — day 20 expired
    expect(await spent(w)).toBe(100n);
    w.evm.warp(10 * DAY); // day 60: window [31, 60] — day 30 expired
    expect(await spent(w)).toBe(0n);
  });

  it("a multi-pay proposal stops at the first pay that breaks the window and the whole execute reverts", async () => {
    const w = await world();
    const r = await execute(w, [
      payAction(w.lane, R1, PER_PAYMENT),
      payAction(w.lane, R2, PER_PAYMENT),
      payAction(w.lane, R3, PER_PAYMENT),
      payAction(w.lane, R4, 1n),
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("FastLane: over 30-day cap");
    // the mock pool reverts as a whole, like GovPoolExecute.execute
    expect(await balance(w, R1)).toBe(0n);
    expect(await spent(w)).toBe(0n);
  });

  it("refuses when the float is short, and when the token returns false", async () => {
    const w = await world({ float: 10n });
    const short = await execute(w, [payAction(w.lane, R1, 11n)]);
    expect(short.ok).toBe(false);
    expect(short.error).toBe("FastLane: transfer failed");
    expect(await spent(w)).toBe(0n);

    await w.evm.send(DEPLOYER, w.token, erc20.abi, "setReturnFalse", [true]);
    const falsy = await execute(w, [payAction(w.lane, R1, 1n)]);
    expect(falsy.ok).toBe(false);
    expect(falsy.error).toBe("FastLane: transfer failed");
  });

  it("works with a token whose transfer() returns nothing", async () => {
    const w = await world({ token: "noReturn" });
    expect((await execute(w, [payAction(w.lane, R1, 5n)])).ok).toBe(true);
    const [b] = await w.evm.call(DEPLOYER, w.token, noReturn.abi, "balanceOf", [R1]);
    expect(b).toBe(5n);
  });

  it("blocks re-entry from a token transfer hook even when the re-entrant caller is the govPool", async () => {
    const w = await world();
    await w.evm.send(DEPLOYER, w.token, erc20.abi, "setHook", [w.gov]);
    const r = await execute(w, [payAction(w.lane, R1, 10n)]);
    expect(r.ok).toBe(true);
    const [reentered] = await w.evm.call(DEPLOYER, w.gov, govPoolMock.abi, "reentered");
    const [reason] = await w.evm.call(DEPLOYER, w.gov, govPoolMock.abi, "reentryReason");
    expect(reentered).toBe(false);
    expect(reason).toBe("FastLane: reentrant");
    expect(await balance(w, R1)).toBe(10n);
    expect(await spent(w)).toBe(10n);
    // the lock is released after the outer pay
    expect((await execute(w, [payAction(w.lane, R2, 10n)])).ok).toBe(true);
  });
});

describe("admin — allowlist and float are the govPool's, through the admin child only", () => {
  it("setAllowed / setAllowedBatch / recall work only from the govPool", async () => {
    const w = await world({ allow: [R1] });
    const adminAbi = AGENT_FAST_LANE_ADMIN_ABI;
    for (const fn of ["setAllowed", "setAllowedBatch", "recall"] as const) {
      const args = fn === "setAllowed" ? [OUTSIDER, true] : fn === "setAllowedBatch" ? [[OUTSIDER], true] : [1n];
      const r = await w.evm.send(STRANGER, w.admin, adminAbi, fn, args);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("FastLaneAdmin: not govPool");
    }
    const adminIface = new Interface(adminAbi);
    const viaGov = (fn: string, args: unknown[]) =>
      execute(w, [{ executor: w.admin, value: 0n, data: adminIface.encodeFunctionData(fn, args) }]);

    expect((await viaGov("setAllowed", [OUTSIDER, true])).ok).toBe(true);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "allowed", [OUTSIDER]))[0]).toBe(true);
    expect((await viaGov("setAllowedBatch", [[OUTSIDER, R1], false])).ok).toBe(true);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "allowed", [OUTSIDER]))[0]).toBe(false);
    expect((await w.evm.call(DEPLOYER, w.lane, AGENT_FAST_LANE_ABI, "allowed", [R1]))[0]).toBe(false);
    expect((await viaGov("setAllowed", ["0x0000000000000000000000000000000000000000", true])).error).toBe("FastLane: zero recipient");

    expect((await viaGov("recall", [4_000n])).ok).toBe(true);
    expect(await balance(w, w.gov)).toBe(4_000n);
    expect(await balance(w, w.lane)).toBe(6_000n);
    expect((await viaGov("recall", [6_001n])).error).toBe("FastLane: transfer failed");
  });

  it("the lane's admin entry points reject everyone but the admin child, govPool included", async () => {
    const w = await world();
    for (const from of [DEPLOYER, STRANGER, w.gov]) {
      const a = await w.evm.send(from, w.lane, AGENT_FAST_LANE_ABI, "adminSetAllowed", [OUTSIDER, true]);
      expect(a.error).toBe("FastLane: not admin");
      const b = await w.evm.send(from, w.lane, AGENT_FAST_LANE_ABI, "adminRecall", [1n]);
      expect(b.error).toBe("FastLane: not admin");
    }
  });

  it("the admin's address is not the lane's, so a proposal that targets it does not pass the lane's validate", async () => {
    const w = await world();
    const adminIface = new Interface(AGENT_FAST_LANE_ADMIN_ABI);
    // A fast-lane proposal cannot smuggle an allowlist change: the lane refuses
    // the admin action in any position. (With the admin as LAST action the DAO
    // would pick DEFAULT settings — the validator round — and call validate on
    // the admin, which has none.)
    const smuggle = [
      { executor: w.admin, value: 0n, data: adminIface.encodeFunctionData("setAllowed", [OUTSIDER, true]) },
      payAction(w.lane, R1, 1n),
    ];
    expect((await validateDirect(w, smuggle)).valid).toBe(false);
    expect((await validateViaGov(w, smuggle)).allowed).toBe(false);
    expect(getAddress(w.admin)).not.toBe(getAddress(w.lane));
  });
});
