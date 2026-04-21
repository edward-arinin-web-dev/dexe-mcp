# Compat Report: Participation (Token Sale, Staking, Distribution, Validators, NFT, Privacy)

**Date:** 2026-04-21
**Method:** Source extraction (code-level comparison)
**MCP source:** `D:/dev/dexe-mcp/src/tools/voteBuild.ts`
**Frontend source:** `C:/dev/investing-dashboard/src/`

## Summary

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 1 | `dexe_vote_build_token_sale_buy` | PASS | `buy(tierId, tokenToBuyWith, amount, proof)` matches frontend. MCP accepts `value` for native-coin purchases. Frontend passes `{ value: amount }` override when `isNativeToken` — same effect. |
| 2 | `dexe_vote_build_token_sale_claim` | PASS | `claim(tierIds)` — MCP takes `uint256[]`, frontend calls `tokenSaleContract.claim([tierId])`. Identical ABI. |
| 3 | `dexe_vote_build_token_sale_vesting_withdraw` | PASS | `vestingWithdraw(tierIds)` — MCP takes `uint256[]`, frontend calls `tokenSaleContract.vestingWithdraw([tierId])`. Identical. |
| 4 | `dexe_vote_build_staking_stake` | DIVERGENCE | **MCP calls `StakingProposal.stake(user, amount, id)`. Frontend calls `userKeeper.stakeTokens(tierId, amount)` — different contract and method.** See Divergence D1. |
| 5 | `dexe_vote_build_staking_claim` | PASS | `StakingProposal.claim(id)` — both MCP and frontend call `stakingProposal.claim(tierId)`. Identical. |
| 6 | `dexe_vote_build_staking_claim_all` | PASS | `StakingProposal.claimAll()` — MCP matches typechain signature. No frontend call found (likely unused in UI), but ABI is correct per typechain. |
| 7 | `dexe_vote_build_staking_reclaim` | PASS | `StakingProposal.reclaim(id)` — both MCP and frontend call `stakingProposal.reclaim(tierId)`. Identical. |
| 8 | `dexe_vote_build_distribution_claim` | PASS | `DistributionProposal.claim(voter, proposalIds)` — MCP takes `(address, uint256[])`. Frontend: `govDistributionProposalContract.claim(account!, [proposalId])`. Identical signature. |
| 9 | `dexe_vote_build_validator_vote` | PASS | MCP dispatches `voteInternalProposal` or `voteExternalProposal` based on `scope` param. Frontend uses `govValidators[isInternal ? "voteInternalProposal" : "voteExternalProposal"](proposalId, voteAmount, isVoteFor)`. Same args: `(proposalId, amount, isVoteFor)`. |
| 10 | `dexe_vote_build_validator_cancel_vote` | PASS | MCP dispatches `cancelVoteInternalProposal` or `cancelVoteExternalProposal` based on `scope`. Frontend not found as a standalone hook but typechain confirms `cancelVoteInternalProposal(uint256)` / `cancelVoteExternalProposal(uint256)`. ABI matches. |
| 11 | `dexe_vote_build_move_to_validators` | PASS | `GovPool.moveProposalToValidators(proposalId)` — MCP uses GOV_POOL_WRITE_ABI. No dedicated frontend hook found (`moveToValidators` grep returned empty), but the ABI `moveProposalToValidators(uint256)` is correct per contract. |
| 12 | `dexe_vote_build_nft_multiplier_lock` | MINOR DIFF | MCP: `lock(uint256 tokenId)` — passes raw `tokenId`. Frontend: `multiplierContract.lock([tokenId])` — wraps in array. See note N1. |
| 13 | `dexe_vote_build_nft_multiplier_unlock` | PASS | `ERC721Multiplier.unlock()` — both MCP and frontend call with no args. Identical. |
| 14 | `dexe_vote_build_multicall` | PASS | `GovPool.multicall(bytes[] calls)` — MCP wraps N calldatas. Frontend uses multicall in `useGovPoolVote` and `useGovPoolDelegate`. Same ABI shape. |
| 15 | `dexe_vote_build_privacy_policy_agree` | PASS | `UserRegistry.agreeToPrivacyPolicy(signature)` — MCP matches frontend's `userRegistry.agreeToPrivacyPolicy(signature)`. |
| 16 | `dexe_vote_build_privacy_policy_sign` | PASS | EIP712 typed data: domain `USER_REGISTRY` v1, type `Agreement[{documentHash: bytes32}]`. Frontend uses identical domain/types in `usePrivacyPolicySign`. |

**Overall: 14 PASS, 1 DIVERGENCE (D1), 1 MINOR DIFF (N1)**

## Detailed Findings

### Token Sale (Tools 1-3)

**Frontend flow:** `useTokenSaleTerminal` calls `useTokenSaleProposalContract.buy(tierId, tokenToBuyWith, amount, proof, isNativeToken)`. When `isNativeToken` is true, ethers override `{ value: amount }` is passed. MCP's `value` parameter serves the same purpose.

**Approve handling:** Neither MCP nor frontend prepend ERC20.approve before `buy()`. The TokenSaleProposal contract handles allowance internally or the user is expected to approve separately. MCP provides `dexe_vote_build_erc20_approve` as a separate tool if needed.

**Claim/VestingWithdraw:** Both pass `uint256[]` tierIds. Frontend typically passes a single-element array `[tierId]`. MCP accepts arrays natively.

### Staking (Tools 4-7)

**Claim/Reclaim:** Both MCP and frontend call `StakingProposal.claim(id)` and `StakingProposal.reclaim(id)` with matching signatures.

**ClaimAll:** MCP encodes `StakingProposal.claimAll()` with no args, matching the typechain definition `"claimAll()": FunctionFragment`. No frontend usage found but ABI is correct.

### Distribution (Tool 8)

Frontend: `govDistributionProposalContract.claim(account!, [proposalId])` — `claim(address, uint256[])`.
MCP: `DistributionProposal.claim(voter, proposalIds)` with same signature. Match confirmed.

### Validators (Tools 9-11)

**Vote:** Both MCP and frontend dispatch to `voteInternalProposal` / `voteExternalProposal` based on a boolean/enum. Arg order `(proposalId, amount, isVoteFor)` matches in both. MCP uses `scope: "internal"|"external"` enum; frontend uses `isInternal: boolean`. Functionally identical.

**CancelVote:** MCP dispatches `cancelVoteInternalProposal` / `cancelVoteExternalProposal` with `(proposalId)`. Matches contract ABI.

**MoveToValidators:** MCP calls `GovPool.moveProposalToValidators(proposalId)`. No frontend hook found, but ABI is correct.

### NFT Multiplier (Tools 12-13)

**Lock:** See note N1 below.
**Unlock:** Both call `unlock()` with no arguments. Match confirmed.

### Privacy Policy (Tools 15-16)

**Sign:** MCP returns EIP712 typed data with domain `{ name: "USER_REGISTRY", version: "1", chainId, verifyingContract }` and types `{ Agreement: [{ name: "documentHash", type: "bytes32" }] }`. Frontend's `usePrivacyPolicySign` constructs identical domain and types. Match confirmed.

**Agree:** Both call `UserRegistry.agreeToPrivacyPolicy(signature)`. Match confirmed.

### Approve Handling (Cross-cutting)

MCP provides `dexe_vote_build_erc20_approve` as a separate tool. Frontend does NOT prepend approve calls inline for any of these participation flows — approve is handled separately in the UI flow. This is consistent: MCP returns individual payloads and the caller composes approve + action as needed (or uses multicall for GovPool methods).

### Multicall (Tool 14)

MCP's multicall wraps `bytes[]` calldatas into `GovPool.multicall(calls)`. This is only for GovPool methods (deposit+delegate, execute+claim, etc.). Token sale / staking / distribution calls target different contracts and cannot be multicalled through GovPool. This matches frontend behavior.

## Divergences Found

### D1: Staking Stake — Different Contract & Method (SIGNIFICANT)

| Aspect | MCP | Frontend |
|--------|-----|----------|
| Contract | `StakingProposal` | `GovUserKeeper` |
| Method | `stake(user, amount, id)` | `stakeTokens(tierId, amount)` |
| Args | `(address, uint256, uint256)` | `(uint256, uint256)` |

**Analysis:** The frontend calls `userKeeper.stakeTokens(tierId, amount)` on the GovUserKeeper contract, NOT `StakingProposal.stake()`. The StakingProposal typechain does define `stake(address, uint256, uint256)`, but the frontend routes staking through UserKeeper instead. This may be a higher-level wrapper that internally calls StakingProposal, or the two may produce different on-chain behavior.

**Risk:** Medium-High. If `GovUserKeeper.stakeTokens` performs additional bookkeeping (e.g., updating voting power, checking deposit requirements) that `StakingProposal.stake` does not, MCP's direct call could fail or produce incomplete state.

**Recommendation:** Investigate whether `GovUserKeeper.stakeTokens(tierId, amount)` is the correct entry point. If so, update MCP to call `GovUserKeeper.stakeTokens` instead of `StakingProposal.stake`. Add `GovUserKeeper.stakeTokens(uint256, uint256)` to the ABI and change the tool to target the userKeeper address.

### N1: NFT Multiplier Lock — Array Wrapping (MINOR)

| Aspect | MCP | Frontend |
|--------|-----|----------|
| Call | `lock(tokenId)` | `lock([tokenId])` |
| Arg type | `uint256` | `uint256` (ethers unwraps single-element arrays) |

**Analysis:** The ERC721Multiplier typechain defines `lock(uint256)` — a single uint256, not an array. The frontend passes `[tokenId]` which ethers v5 auto-unwraps to the single value. MCP passes the raw `tokenId` directly. Both produce identical calldata: `lock(uint256)` with the token ID.

**Risk:** None. Both encode to the same on-chain call. The frontend's array wrapping is a JavaScript convention that ethers handles transparently.

## Approve Flow Summary

| Tool | Needs ERC20 Approve? | Frontend Approach | MCP Approach |
|------|---------------------|-------------------|--------------|
| Token Sale Buy | Yes (ERC20 payments) | Separate approve step in UI | Separate `dexe_vote_build_erc20_approve` tool |
| Staking Stake | Possibly (via UserKeeper) | Not visible in hook | Separate approve tool |
| Distribution Claim | No | N/A | N/A |
| Validator Vote | No (uses staked tokens) | N/A | N/A |
| NFT Lock | No (NFT transfer) | N/A | N/A |
| Privacy Agree | No | N/A | N/A |
