# Compat Report: Internal & Governance Proposals

**Date:** 2026-04-21
**Method:** Source extraction (code-level comparison)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuild*.ts`

## Summary

| # | Type | MCP Tool | Verdict | Key Finding |
|---|------|----------|---------|-------------|
| 1 | Change Voting Settings | `dexe_proposal_build_change_voting_settings` | MATCH | Same ABI, same struct field order, same editSettings/addSettings branching |
| 2 | Change Math Model | `dexe_proposal_build_change_math_model` | MATCH | Both call `GovPool.changeVotePower(newVotePower)`, executor = govPool address |
| 3 | New Proposal Type | `dexe_proposal_build_new_proposal_type` | MATCH | Both emit 2 actions: `addSettings` + `changeExecutors`, same tuple encoding |
| 4 | Manage Validators (external) | `dexe_proposal_build_manage_validators` | MATCH | Both call `GovValidators.changeBalances(balances, users)` with same arg order |
| 5 | Change Validator Balances (internal type 0) | `dexe_proposal_build_change_validator_balances` | MATCH | Same selector + encoding as frontend `transformInternalProposalData(ChangeBalances)` |
| 6 | Change Validator Settings (internal type 1) | `dexe_proposal_build_change_validator_settings` | MATCH | Same `changeSettings(duration, executionDelay, quorum)` encoding |
| 7 | Monthly Withdraw (internal type 2) | `dexe_proposal_build_monthly_withdraw` | MATCH | Same `monthlyWithdraw(tokens, amounts, destination)` encoding |
| 8 | Off-chain Internal (internal type 3) | `dexe_proposal_build_offchain_internal_proposal` | MATCH | Both use `data = "0x"` (empty bytes) |

## Detailed Findings

### 1. Change Voting Settings (`editSettings` / `addSettings`)

**Frontend** (`useGovPoolCreateProposalChangeSettings.ts`):
- Encodes via `encodeAbiMethod(GovSettings, "editSettings", [ids, params])`
- Settings struct built inline with fields: `earlyCompletion`, `delegatedVotingAllowed`, `validatorsVote`, `duration`, `durationValidators`, `quorum`, `quorumValidators`, `minVotesForVoting`, `minVotesForCreating`, `executionDelay`, `rewardsInfo { rewardToken, creationReward, executionReward, voteRewardsCoefficient }`, `executorDescription`
- Quorum values converted via `toBigFromHumanReadable(quorum, APP_DECIMALS.PERCENTAGE)` (25 decimals = 10^25 scale)
- Executor: `govSettingsAddress` (resolved via `useGovPoolHelperContracts`)

**MCP** (`proposalBuildMore.ts` → `registerChangeVotingSettings`):
- ABI string: `"function editSettings(uint256[] ids, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] params)"`
- Uses `toSettingsTuple()` which maps fields in identical order
- Branches on `settingsIds.length > 0` → `editSettings` vs `addSettings` (same logic as frontend)
- Executor: user-supplied `govSettings` address (from `dexe_dao_info.helpers.settings`)

**Verdict: MATCH** — Struct field order, ABI encoding, and branching logic are identical. The only difference is unit conversion: frontend converts human-readable quorum/votes to BigNumber internally, while MCP expects pre-scaled BigInt strings (caller responsibility). This is by design.

---

### 2. Change Math Model (`changeVotePower`)

**Frontend** (`useGovPoolCreateProposalChangeMathModel.ts`):
- Encodes via `encodeAbiMethod(GovPool, "changeVotePower", [customPowerContractAddress])`
- Executor: `daoPoolAddress` (the GovPool itself)
- Single action, single argument (address)

**MCP** (`proposalBuildComplex.ts` → `registerChangeMathModel`):
- ABI: `"function changeVotePower(address)"`
- Encodes via `iface.encodeFunctionData("changeVotePower", [newVotePower])`
- Executor: user-supplied `govPool` address

**Verdict: MATCH** — Identical encoding. Both target `GovPool.changeVotePower(address)` with executor = GovPool address.

---

### 3. New Proposal Type (`addSettings` + `changeExecutors`)

**Frontend** (`useGovPoolCreateProposalType.ts`):
- Two actions in sequence:
  1. `encodeAbiMethod(GovSettings, "addSettings", [[{ ...settings, executorDescription: daoProposalTypeIPFSCode }]])`
  2. `encodeAbiMethod(GovSettings, "changeExecutors", [executors, executors.map(() => newSettingId)])`
- Both target `govSettingsAddress`
- `newSettingId` resolved via `useGovSettingsNewSettingId` hook (reads `getSettingsLength()` on-chain)
- `executorDescription` is set to `"ipfs://" + daoProposalIpfsEntity._path`

**MCP** (`proposalBuildComplex.ts` → `registerNewProposalType`):
- Two actions in sequence:
  1. `iface.encodeFunctionData("addSettings", [[tuple]])` — tuple built with same field order
  2. `iface.encodeFunctionData("changeExecutors", [executors, executors.map(() => BigInt(newSettingId))])`
- Both target user-supplied `govSettings`
- `newSettingId` supplied by caller (agent reads it via `dexe_read_settings` first)
- `executorDescription` included in settings object

**Verdict: MATCH** — Same 2-action pattern, same tuple encoding, same `changeExecutors` mapping. The `newSettingId` resolution differs (frontend reads on-chain in hook, MCP expects it pre-supplied), but the encoding is identical given the same inputs.

---

### 4. Manage Validators — External (`changeBalances`)

**Frontend** (`useGovPoolCreateProposalValidators.ts`):
- Encodes via `encodeAbiMethod(GovValidators, "changeBalances", [balances, users])`
- Executor: `govValidatorsAddress` (from `useGovPoolHelperContracts`)
- Creates an **external** proposal via `createProposalFunc`

**MCP** (`proposalBuildMore.ts` → `registerManageValidators`):
- ABI: `"function changeBalances(uint256[] balances, address[] users)"`
- Encodes via `iface.encodeFunctionData("changeBalances", [balances, users])`
- Executor: user-supplied `govValidators`

**Verdict: MATCH** — Argument order `(balances, users)` is identical. Both create external proposals targeting GovValidators.

---

### 5. Change Validator Balances — Internal Type 0

**Frontend** (`transformInternalProposalData` in `utils/proposals.ts`):
```typescript
case InternalProposalType.ChangeBalances:
  return encodeAbiMethod(GovValidators, "changeBalances", [values, users])
```

**MCP** (`proposalBuildInternal.ts` → `registerChangeValidatorBalances`):
```typescript
const data = iface.encodeFunctionData("changeBalances", [balances, users]);
// returns { proposalType: 0, data }
```

**Frontend call path** (`useGovPoolCreateValidatorInternalProposal.ts`):
```typescript
govValidatorsContract.createInternalProposal(
  internalProposalType,         // 0
  daoProposalIPFSCode,          // "ipfs://..."
  transformInternalProposalData(internalProposalType, values, users)
)
```

**MCP call path**: Agent calls wrapper to get `data`, then calls `dexe_proposal_build_internal` which encodes `GovValidators.createInternalProposal(0, descriptionURL, data)`.

**Verdict: MATCH** — Same function selector, same argument order, same two-step flow.

---

### 6. Change Validator Settings — Internal Type 1

**Frontend** (`transformInternalProposalData`):
```typescript
case InternalProposalType.ChangeSettings:
  return encodeAbiMethod(GovValidators, "changeSettings", values)
  // values = [duration, executionDelay, quorum]
```

**MCP** (`proposalBuildInternal.ts` → `registerChangeValidatorSettings`):
```typescript
const data = iface.encodeFunctionData("changeSettings", [
  BigInt(duration), BigInt(executionDelay), BigInt(quorum)
]);
// returns { proposalType: 1, data }
```

ABI: `"function changeSettings(uint64 duration, uint64 executionDelay, uint128 quorum)"`

**Verdict: MATCH** — Same 3-argument signature in same order.

---

### 7. Monthly Withdraw — Internal Type 2

**Frontend** (`transformInternalProposalData`):
```typescript
case InternalProposalType.MonthlyWithdraw:
  return encodeAbiMethod(GovValidators, "monthlyWithdraw", [
    users.slice(0, users.length - 1),  // tokens (packed in users array)
    values,                             // amounts
    users[users.length - 1],           // destination (last element)
  ])
```

**MCP** (`proposalBuildInternal.ts` → `registerMonthlyWithdraw`):
```typescript
const tokens = withdrawals.map((w) => w.token);
const amounts = withdrawals.map((w) => BigInt(w.amount));
const data = iface.encodeFunctionData("monthlyWithdraw", [tokens, amounts, destination]);
```

ABI: `"function monthlyWithdraw(address[] tokens, uint256[] amounts, address destination)"`

**Verdict: MATCH** — Same `(tokens, amounts, destination)` encoding. The frontend packs tokens and destination into the `users` array (tokens first, destination last), while MCP accepts structured `withdrawals[]` + `destination`. Different API surface, identical calldata output.

---

### 8. Off-chain Internal Proposal — Internal Type 3

**Frontend** (`transformInternalProposalData`):
```typescript
case InternalProposalType.OffchainProposal:
  return "0x"
```

**MCP** (`proposalBuildInternal.ts` → `registerOffchainInternalProposal`):
```typescript
return internalResult({ ..., proposalType: 3, data: "0x" });
```

**Verdict: MATCH** — Both emit empty bytes for type 3.

---

## Shared Pattern Analysis

### Executor Resolution

| Aspect | Frontend | MCP | Match? |
|--------|----------|-----|--------|
| GovSettings address | `useGovPoolHelperContracts` → on-chain ContractsRegistry | User supplies from `dexe_dao_info` output | YES (same source) |
| GovValidators address | `useGovPoolHelperContracts` → on-chain | User supplies from `dexe_dao_info` output | YES (same source) |
| GovPool address | Direct from hook param `daoPoolAddress` | User supplies as `govPool` | YES |
| Internal executor | Not applicable (internal proposals don't use executors in the same way) | Same | YES |

### ProposalSettings Struct Field Order

Both MCP and frontend use the same struct layout (verified against contract ABI):
1. `earlyCompletion` (bool)
2. `delegatedVotingAllowed` (bool)
3. `validatorsVote` (bool)
4. `duration` (uint64)
5. `durationValidators` (uint64)
6. `executionDelay` (uint64)
7. `quorum` (uint128)
8. `quorumValidators` (uint128)
9. `minVotesForVoting` (uint256)
10. `minVotesForCreating` (uint256)
11. `rewardsInfo` (tuple: rewardToken, creationReward, executionReward, voteRewardsCoefficient)
12. `executorDescription` (string)

### Unit Scaling Responsibility

| Value | Frontend | MCP |
|-------|----------|-----|
| Quorum | `toBigFromHumanReadable(quorum, 25)` — converts "51" → "51000...0" (10^25) | Expects pre-scaled string, e.g. `"510000000000000000000000000"` |
| Votes | `toBigFromHumanReadable(votes, 18)` — converts human to wei | Expects wei string |
| Duration | `Number(duration)` — seconds as number | Expects seconds as string |

This is by design: MCP tools are low-level and expect already-scaled values. The agent (or caller) is responsible for unit conversion.

## Divergences Found

**None.** All 8 proposal types produce identical calldata given the same inputs. The encoding logic, struct field ordering, function selectors, and argument ordering are all consistent between frontend and MCP.

### Notes

- The frontend's `useGovPoolCreateProposalValidators` creates an **external** proposal to change validators, while internal proposals (type 0-3) go through `useGovPoolCreateValidatorInternalProposal`. MCP mirrors this separation: `dexe_proposal_build_manage_validators` (external) vs `dexe_proposal_build_change_validator_balances` (internal type 0). Both paths exist and are correctly implemented.
- No `useGovPoolCreateMonthlyWithdrawProposal` hook exists in the frontend — monthly withdraw is handled via the generic `useGovPoolCreateValidatorInternalProposal` with `InternalProposalType.MonthlyWithdraw`. MCP correctly uses its own dedicated wrapper that feeds into the same `dexe_proposal_build_internal` primitive.
