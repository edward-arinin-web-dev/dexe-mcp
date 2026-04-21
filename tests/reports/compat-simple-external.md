# Compat Report: Simple External Proposals

**Date:** 2026-04-21 (re-verified after bug fixes)
**Method:** Source extraction (code-level comparison)
**Previous report:** 2026-04-21 (initial)

## Summary
| Type | Previous Verdict | Updated Verdict | Key Finding |
|------|-----------------|-----------------|-------------|
| token_transfer | DIVERGENCE | **FIXED** | Native path added (`isNative`). Multi-recipient still single-only (by design). |
| withdraw_treasury | MATCH | MATCH | No changes needed. Same encoding. |
| token_distribution | DIVERGENCE | **FIXED** | `isNative` param added. ERC20.approve prepended for non-native. Native sets value. |
| add_expert | MATCH | MATCH | No changes needed. |
| remove_expert | MATCH | MATCH | No changes needed. |
| blacklist | MATCH | MATCH | No changes needed. |
| apply_to_dao | DIVERGENCE (minor) | MATCH (minor notes) | Same selector `0xa9059cbb` for both ABIs. Transfer+mint logic identical. |
| reward_multiplier | DIVERGENCE | **FIXED** | 4-arg mint, `changeToken` mode, `setTokenURI` rename all applied. |

**Score: 8/8 PASS** (0 blocking divergences remain)

## Detailed Findings

### token_transfer (FIXED)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateTokenTransferProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuild.ts` (lines 335-403)
**Fix applied:** Added `isNative` boolean param (default false).

**ERC20 path (isNative=false):**
- Frontend: `{executor: tokenAddress, data: ERC20.transfer(receiver, amount), value: 0}`
- MCP: `{executor: token, data: ERC20.transfer(recipient, BigInt(amount)), value: "0"}`
- **MATCH** -- same selector `transfer(address,uint256)`

**Native path (isNative=true):**
- Frontend: `{executor: receiverAddress, data: "0x", value: tokenAmount}`
- MCP: `{executor: recipient, data: "0x", value: amount}`
- **MATCH** -- identical action shape

**Remaining note (non-blocking):**
- Frontend supports multi-recipient via `data[]` array producing N actions. MCP accepts single recipient per call. This is by design -- the agent can call the tool N times or use `dexe_proposal_build_external` with multiple actions directly.

---

### withdraw_treasury (unchanged -- MATCH)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateWithdrawProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildMore.ts`
- Same function: `withdraw(address receiver, uint256 amount, uint256[] nftIds)`
- Same executor: govPool address
- Same value: 0

---

### token_distribution (FIXED)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateDistributionProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildComplex.ts` (lines 113-170)
**Fix applied:** Added `isNative` boolean param. Non-native now prepends `ERC20.approve`. Native sets `value: amount`.

**ERC20 path (isNative=false):**
- Frontend: `[{executor: tokenAddress, data: ERC20.approve(distProposal, amount), value: 0}, {executor: distProposal, data: DistributionProposal.execute(id+1, token, amount), value: 0}]`
- MCP: `[{executor: token, data: ERC20.approve(distributionProposal, amount), value: "0"}, {executor: distributionProposal, data: DistributionProposal.execute(proposalId, token, amount), value: "0"}]`
- **MATCH** -- 2 actions, approve first then execute, same selectors, same ordering

**Native path (isNative=true):**
- Frontend: `[{executor: distProposal, data: DistributionProposal.execute(id+1, token, amount), value: tokenAmount}]`
- MCP: `[{executor: distributionProposal, data: DistributionProposal.execute(proposalId, token, amount), value: amount}]`
- **MATCH** -- single action with value set

**Note:** `proposalId` semantics: both use `latestProposalId + 1`. MCP relies on caller to pass correct value (documented).

---

### add_expert (unchanged -- MATCH)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateExpertApplicationProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildMore.ts`
- Same: `ExpertNft.mint(nominatedUser, "")`
- Same executor: scope-dependent NFT contract

---

### remove_expert (unchanged -- MATCH)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateExpertRemovalProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildMore.ts`
- Same: `ExpertNft.burn(nominatedUser)`

---

### blacklist (unchanged -- MATCH)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateBlacklistManagementProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildComplex.ts`
- Same dual-action pattern: `blacklist(users[], true)` + `blacklist(users[], false)`

---

### apply_to_dao (unchanged -- MATCH with notes)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateApplyToDaoProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildComplex.ts` (lines 693-750)

**Sufficient treasury (amount <= treasuryBalance):**
- Frontend: `[{executor: tokenAddress, data: ERC20.transfer(account, amount), value: 0}]`
- MCP: `[{executor: token, data: ERC20Gov.transfer(receiver, total), value: "0"}]`
- **MATCH** -- `transfer(address,uint256)` selector `0xa9059cbb` is identical in ERC20 and ERC20Gov

**Insufficient treasury (amount > treasuryBalance):**
- Frontend: `[{executor: token, data: ERC20Gov.transfer(account, amount), value: 0}, {executor: token, data: ERC20Gov.mint(account, shortfall), value: 0}]`
- MCP: `[{executor: token, data: ERC20Gov.transfer(receiver, total), value: "0"}, {executor: token, data: ERC20Gov.mint(receiver, shortfall), value: "0"}]`
- **MATCH** -- same 2-action pattern, same selectors, same ordering

**Note:** MCP has no native-token guard (FE throws for native). Low risk -- apply_to_dao is inherently an ERC20Gov operation.

---

### reward_multiplier (FIXED)
**Frontend:** `C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateRewardMultiplierProposal.ts`
**MCP:** `D:/dev/dexe-mcp/src/tools/proposalBuildComplex.ts` (lines 557-690)
**Fixes applied:**
1. ABI changed to `mint(address,uint256,uint256,string)` (4-arg with metadataUrl)
2. Added `change_token` mode with `changeToken(tokenId, multiplier, rewardPeriod)`
3. Renamed `set_uri` to `set_token_uri`, method `setURI` to `setTokenURI`
4. Removed `hasRewardPeriod` flag -- now always uses rewardPeriod + metadataUrl

**set_address mode:**
- Frontend: `GovPool.setNftMultiplierAddress(addr)` / `GovPool.setNftMultiplierAddress(ZERO_ADDR)` to disable
- MCP: same -- `setNftMultiplierAddress(addr)` or `setNftMultiplierAddress(ZeroAddress)`
- **MATCH**

**mint mode:**
- Frontend (non-DeXe): `ERC721Multiplier.mint(address, multiplierBN, rewardPeriod, metadataUrl)` -- 4 args
- MCP: `ERC721Multiplier.mint(to, multiplier, rewardPeriod, metadataUrl)` -- 4 args
- ABI: `function mint(address to, uint256 multiplier, uint256 rewardPeriod, string metadataUrl)`
- **MATCH**

**change_token mode (NEW):**
- Frontend: `ERC721Multiplier.changeToken(tokenId, multiplier, rewardPeriod)` -- 3 args
- MCP: `ERC721Multiplier.changeToken(tokenId, multiplier, rewardPeriod)` -- 3 args
- ABI: `function changeToken(uint256 tokenId, uint256 multiplier, uint256 rewardPeriod)`
- **MATCH**

**set_token_uri mode (RENAMED):**
- Frontend: `ERC721Multiplier.setTokenURI(tokenId, uri)`
- MCP: `ERC721Multiplier.setTokenURI(tokenId, uri)`
- ABI: `function setTokenURI(uint256 tokenId, string uri)`
- **MATCH**

**Remaining notes (non-blocking):**
- Frontend has special DeXe DAO path with 5-arg `DexeERC721Multiplier.mint(address, multiplier, rewardPeriod, averageBalance, metadataUrl)`. MCP uses standard 4-arg only. This is acceptable -- DeXe global DAO is a special case not expected via MCP.
- Frontend batches multiple mint/changeToken operations into a single proposal. MCP handles single operations per call -- agent composes multiple actions via `dexe_proposal_build_external`.

---

## Previously-Reported Divergences -- Resolution Status

| # | Type | Severity | Issue | Status |
|---|------|----------|-------|--------|
| 1 | token_transfer | HIGH | No native token support | **FIXED** -- `isNative` param added |
| 2 | token_transfer | MEDIUM | Single-recipient only | **BY DESIGN** -- agent composes multi-action |
| 3 | token_distribution | HIGH | Missing `ERC20.approve` action | **FIXED** -- auto-prepended for non-native |
| 4 | token_distribution | MEDIUM | No native-token value | **FIXED** -- `value: amount` when `isNative=true` |
| 5 | apply_to_dao | LOW | No native-token guard | **ACCEPTED** -- low risk, ERC20Gov-only operation |
| 6 | reward_multiplier | HIGH | Mint ABI wrong (missing metadataUrl) | **FIXED** -- 4-arg `mint(address,uint256,uint256,string)` |
| 7 | reward_multiplier | HIGH | Missing `changeToken` method | **FIXED** -- `change_token` mode added |
| 8 | reward_multiplier | MEDIUM | `setURI` vs `setTokenURI` name | **FIXED** -- renamed to `setTokenURI` |

## Matches Confirmed (no action needed)

- **withdraw_treasury**: `GovPool.withdraw(receiver, amount, nftIds)` -- encoding identical
- **add_expert**: `ExpertNft.mint(user, "")` -- encoding identical
- **remove_expert**: `ExpertNft.burn(user)` -- encoding identical
- **blacklist**: Dual `blacklist(users[], bool)` action pattern -- encoding identical
- **apply_to_dao**: `transfer` + optional `mint` -- selector-identical across ERC20/ERC20Gov ABIs
