# C-2 — INTERNAL-allowlist bypass via DEFAULT-routing (drain of unlocked deposits)

**Status:** verified real. Root cause is in the **DeXe protocol contracts**
(not dexe-mcp). dexe-mcp was an *amplifier*; this repo now ships a guardrail
(harm-reduction only — see "What this does NOT fix").

**Reported:** red-team test users, against dexe-mcp@0.7.2.
**Verified against:** `D:\dev\DeXe-Protocol\contracts\` + `src\tools\proposalBuild.ts`.

---

## Summary

A DeXe governance proposal can call
`GovUserKeeper.withdrawTokens(payer, receiver, amount)` against an **arbitrary
depositor** (`payer`) and send the funds to an attacker (`receiver`) — draining
the victim's **unlocked** deposited balance — by hiding that privileged action
behind a trailing action whose executor routes to the DEFAULT settings bucket.

The protocol's INTERNAL allowlist exists precisely to make `withdrawTokens`
unreachable-by-proposal. The bug lets an attacker step around it.

---

## Verified mechanism

The chain has three load-bearing facts, all confirmed in source:

### 1. Proposal settings are keyed on the LAST action only
`libs/gov/gov-pool/GovPoolCreate.sol:140,147`
```solidity
address mainExecutor = actionsFor[actionsFor.length - 1].executor;
...
settingsId = govSettings.executorToSettings(mainExecutor);
```
Any executor that isn't a registered governance contract maps to
`DEFAULT == 0` (`interfaces/gov/settings/IGovSettings.sol:8-12`).

### 2. The DEFAULT bucket validates nothing
`GovPoolCreate.sol:276-296` — `_handleDataForProposal`:
```solidity
if (settingsId == DEFAULT) { return false; }   // :291-293 — no per-action checks
```
The selector allowlist (`_handleDataForInternalProposal`, `:240-274`) iterates
**every** action — but it only runs on the INTERNAL branch (`:281-283`), i.e.
when the *last* executor is a registered INTERNAL executor. `withdrawTokens` is
deliberately absent from that allowlist. Route the proposal to DEFAULT and the
allowlist never executes.

### 3. `withdrawTokens` accepts an arbitrary payer
`gov/user-keeper/GovUserKeeper.sol:117-136`
```solidity
function withdrawTokens(address payer, address receiver, uint256 amount)
    external override onlyOwner ...        // owner == GovPool
{
    ...
    require(amount <= balance.max(maxTokensLocked) - maxTokensLocked, ...); // unlocked only
    payerBalanceInfo.tokens = balance - amount;   // debits _usersInfo[payer]
    _sendNativeOrToken(receiver, amount);         // pays receiver
}
```
`payer` is a free argument, not bound to `msg.sender`.

### Execution has no second guard
`libs/gov/gov-pool/GovPoolExecute.sol:60-68` does a raw
`actions[i].executor.call{value}(data)` with GovPool as `msg.sender`. No
re-validation, no allowlist. The only gate is creation (step 2), which DEFAULT
routing bypasses.

### The differential that proves it
- `withdrawTokens` as the sole action → routes INTERNAL → **REVERT**
  `"Gov: invalid internal data"`.
- `withdrawTokens` + a trailing DEFAULT-routed action → routes DEFAULT →
  **passes** creation; executes on a successful vote.

Selector: `withdrawTokens(address,address,uint256)` = `0x5e35359e` (recomputed).

---

## Severity

**Protocol-side: CRITICAL/HIGH.** Theft of any depositor's unlocked deposit,
bypassing a security-critical allowlist.

**Mitigant:** governance-gated. The proposal must reach quorum and pass
(`GovPoolExecute.sol:37-41`) before it executes — it is **not** a permissionless
one-tx drain. Realistic exploitation = the attacker holds/borrows enough voting
power, OR socially engineers a vote with deceptive IPFS metadata while the raw
on-chain actions hide the `withdrawTokens` call, OR a low-quorum / captured DAO.
The allowlist was meant to make the call impossible *regardless of vote outcome*;
the bug removes that structural guarantee.

---

## The MCP amplifier (and the guardrail shipped)

`dexe_proposal_build_custom_abi` (`src/tools/proposalBuild.ts`) encoded any
`{target, signature, args}` with zero semantic checks — a one-command way to
build the malicious action. `dexe_proposal_build_external` assembled the
multi-action proposal without inspecting calldata.

**Shipped guard:** `src/lib/dangerousSelectors.ts` denylists the full family of
`GovUserKeeper` `onlyOwner` accounting functions (these take a `payer`/
`delegator` decoupled from the caller and must never be a proposal target):

| selector | function |
|----------|----------|
| `0x5e35359e` | `withdrawTokens(address,address,uint256)` |
| `0x39dc5ef2` | `depositTokens(address,address,uint256)` |
| `0x9161babb` | `delegateTokens(address,address,uint256)` |
| `0x0ae1398e` | `undelegateTokens(address,address,uint256)` |
| `0x69b5330b` | `delegateTokensTreasury(address,uint256)` |
| `0x86be8d2d` | `undelegateTokensTreasury(address,uint256)` |
| `0x1f96f376` | `withdrawNfts(address,address,uint256[])` |
| `0x9693caad` | `depositNfts(address,address,uint256[])` |
| `0xbfb1a57d` | `delegateNfts(address,address,uint256[])` |
| `0x37267d4c` | `undelegateNfts(address,address,uint256[])` |
| `0x6ad6d3c1` | `delegateNftsTreasury(address,uint256[])` |
| `0x39be038b` | `undelegateNftsTreasury(address,uint256[])` |

Both `dexe_proposal_build_custom_abi` and `dexe_proposal_build_external` now
**hard-refuse** (no override) when an action's calldata carries one of these
selectors.

---

## What this does NOT fix

The MCP guard is **harm-reduction only**. An attacker can still hand-craft the
calldata with cast/ethers/etc. and submit it directly. **Only a DeXe protocol
contract upgrade closes C-2.** Reference remedy (owner's responsibility):

1. Validate settings per-action / reject mixed settings buckets in
   `GovPoolCreate` so a trailing DEFAULT action can't waive earlier actions'
   INTERNAL-allowlist checks.
2. Bind `GovUserKeeper.withdrawTokens` so `payer` cannot be set arbitrarily
   (e.g. `payer == receiver`, or explicit payer consent).

Either fix alone closes the hole.

---

## Tests

`tests/lib/dangerousSelectors.test.ts` — pins the canonical selectors, proves
all 12 forbidden signatures are detected from realistic calldata, and proves
benign calls (transfer/approve/setX) pass through.
