# Test Backlog — Client Demo Coverage

Live demo DAO on BSC mainnet `0xCAe32Fa6e6D1C223Ed1047caA58F7fC0b2D65B41` (DEMO token `0x00346dAfbbFB3B6822cd246E175adfd7678B8686`). 8/33 proposal types exercised end-to-end. Backlog tracks remaining surface + bugs.

**Exercised (live mainnet):**
- #1 modify_dao_profile (proposal id 1) — ExecutedFor
- #2 change_voting_settings (proposal id 2) — ExecutedFor
- #3 token_transfer external (proposal id 3) — ExecutedFor
- #4 offchain.single_option (api.dexe.io #58) — Live
- #5 blacklist (proposal id 4) — ExecutedFor — added `0xdead…dead`
- #6 add_local_expert (proposal id 5) — ExecutedFor — minted local ExpertNft to deployer
- #7 custom_abi (proposal id 6) — ExecutedFor — DEMO.approve(0xdead, 0)
- #8b apply_to_dao (proposal id 8) — ExecutedFor — 100 DEMO → deployer

**Stuck on-chain (cannot execute, can never recover):**
- proposal id 7 — apply_to_dao to 0xdead. Recipient was blacklisted by id 4 before id 7 reached execute. Bug A29 (see below).
- proposal id 9 — token_distribution. State Voting until +1h (settings index 3 has `earlyCompletion=false`, `duration=3600s`). Will move to SucceededFor → ExecutedFor available after that, then claim per-voter via `vote_build_distribution_claim`.
- proposal id 10 — reward_multiplier mint. SucceededFor; execute reverts silently. Bug A31.

## Bugs found 2026-05-06

### Bug A — Deploy revert when `cap == mintedTotal` (P1)
**Symptom.** `PoolFactory.deployGovPool` reverts with `Address: low-level delegate call failed`. Generic message hides the real init failure.
**Reproduce.** `dexe_dao_build_deploy` with `tokenParams: { cap: "1e24", mintedTotal: "1e24" }` (cap equals minted).
**Root cause.** ERC20Gov init likely requires headroom for future minting. Even when no future mint planned, `cap` must be strictly greater than `mintedTotal`.
**Fix path.**
- `src/tools/daoBuildDeploy.ts` — add validation: if `cap > 0 && cap <= mintedTotal` → throw with clear message (or auto-bump cap by 1 wei)
- `dexe_dao_build_deploy` description — flag the constraint
**Workaround.** Set `cap = mintedTotal * 10` (or any safe multiple).

### Bug B — Off-chain proposal `type` is unix timestamp (P1)
**Symptom.** POST `/integrations/voting/proposals` → 400 `proposal type was not found` with `meta.proposal_type=<unix_ts>`.
**Reproduce.** `dexe_proposal_build_offchain_single_option` (and likely siblings) — generated request body has `attributes.type = "<Math.floor(Date.now()/1000)>"`.
**Root cause.** Builder uses timestamp generator instead of registered template name.
**Real values (verified).** `default_single_option_type` for `voting_type=one_of`. Likely siblings: `default_for_against_type`, `default_multi_option_type`. Verify with GET `/integrations/voting/proposals`.
**Fix path.**
- `src/tools/proposalBuildOffchainSingleOption.ts` — replace timestamp with const `default_single_option_type` (both outer `attributes.type` AND `custom_parameters.type`).
- Same for `proposalBuildOffchainMultiOption.ts`, `proposalBuildOffchainForAgainst.ts`.
- Add unit test that snapshots the body and asserts `type` against registered constants.

### Bug C — Off-chain quorum percent unit mismatch (P2, suspected)
**Symptom.** Real backend examples carry `general_closing_percent: 0.5` (decimal). MCP builder sends whole number `50`. Backend may silently treat as 5000% or normalize — needs verification.
**Reproduce.** Compare GET response of #58 (created with 0.5) vs a fresh POST using the raw MCP output (50).
**Fix path.** If broken: divide all `*_percent` by 100 inside builders. Update tool descriptions.

### Bug A29 — apply_to_dao does not check ERC20Gov blacklist (P2)
**Symptom.** Proposal passes voting (SucceededFor) but `GovPool.execute` reverts with `ERC20Gov: account is blacklisted`. Proposal sits unexecutable forever.
**Reproduce.** Stage A 2026-05-06: id 4 blacklisted `0x000000000000000000000000000000000000dEaD`; id 7 = `apply_to_dao(receiver=0xdead, 100 DEMO)` passed voting; execute reverts.
**Fix path.**
- `src/tools/proposalBuildApplyToDao.ts` — when token is detected as ERC20Gov, multicall `isBlacklisted(receiver)` at build time and either throw or surface a clear warning in metadata.
- Same idea applies to `proposal_build_token_transfer` and any builder that emits `ERC20Gov.transfer` to an arbitrary address.
**Workaround.** Don't reuse blacklisted addresses as test recipients in subsequent transfers.

### Bug A30 — withdraw_treasury builder encodes wrong selector (P1)
**Symptom.** `proposal_create` reverts at create-time with `Gov: invalid internal data`.
**Reproduce.** `dexe_proposal_build_withdraw_treasury({ govPool, receiver, amount: "100e18" })` → action targets GovPool with selector `0xfb8c5ef0` = `withdraw(address,uint256,uint256[])` (user deposit-withdraw, not treasury). GovPool's internal-action allowlist rejects.
**Root cause.** Treasury sits in GovPool address as a normal ERC20 holding. Withdrawing it is just an external proposal calling `token.transfer(receiver, amount)` — exactly what `apply_to_dao` already does. There is no special internal "withdrawTreasury" action.
**Fix path.**
- Rewrite `src/tools/proposalBuildWithdrawTreasury.ts` to emit `{ executor: token, data: erc20.encodeFunctionData("transfer", [receiver, amount]) }` (plus per-NFT `transferFrom(govPool, receiver, id)` for NFT treasury). Or remove the builder and document that `apply_to_dao` covers this.
**Workaround.** Use `apply_to_dao` for treasury withdrawals.

### Bug A31 — reward_multiplier mint reverts silently (P2, root cause TBD)
**Symptom.** `ERC721Multiplier.mint(to, multiplier, rewardPeriod, metadataUrl)` called by GovPool reverts with empty returndata. Sim confirms `require(false)` from inside the contract.
**Reproduce.** Stage A id 10 on DexeClientDemo — args: multiplier=1.5e27, rewardPeriod=2592000, metadataUrl="ipfs://stage-a-11-multiplier-deployer". Pre-state: GovPool.getNftContracts.nftMultiplier set, ERC721Multiplier.owner=GovPool, totalSupply=0, recipient balance=0.
**Suspected root cause.** Multiplier-scale unit. PRECISION on ERC721Multiplier is likely `1e25` (so 1.5× = 1.5e25), and 1.5e27 may exceed an internal cap. MCP builder doesn't document the unit or validate.
**Fix path.**
- Read `DeXe-Protocol/contracts/gov/ERC721/ERC721Multiplier.sol` to confirm the actual revert.
- Add unit-explicit `@param` description to `dexe_proposal_build_reward_multiplier.multiplier` and a build-time bound check.
**Workaround.** None until verified — do not mint multipliers on mainnet via this builder.

## Backlog — proposal-type coverage

### Stage A — Same-DAO external (no validators needed)

| # | Proposal type | Builder | Notes |
|---|---|---|---|
| 5 | blacklist | `proposal_build_blacklist` | ✅ DONE 2026-05-06, proposal id 4. Added `0xdead…dead`. |
| 6 | add_local_expert | `proposal_build_add_expert` | ✅ DONE 2026-05-06, proposal id 5. Local ExpertNft minted to deployer. |
| 7 | custom_abi | `proposal_build_custom_abi` | ✅ DONE 2026-05-06, proposal id 6. DEMO.approve(0xdead, 0). |
| 8 | apply_to_dao | `proposal_build_apply_to_dao` | ✅ DONE 2026-05-06, proposal id 8 (id 7 stuck — Bug A29). 100 DEMO → deployer. |
| 9 | token_distribution | `proposal_build_token_distribution` | ⏳ proposal id 9 — Voting; settings index 3 has `earlyCompletion=false`, must wait 3600s. Fund-flow (approve+execute) on DistributionProposal `0x5220…BF109` succeeded at create-time. Re-check + execute after delay. |
| 10 | withdraw_treasury | `proposal_build_withdraw_treasury` | ❌ BLOCKED — Bug A30. Builder encodes wrong selector. Use apply_to_dao until rewritten. |
| 11 | reward_multiplier | `proposal_build_reward_multiplier` | ❌ STUCK — proposal id 10 SucceededFor, execute reverts silently. Bug A31. |
| 12 | new_proposal_type | `proposal_build_new_proposal_type` | Register new settings + bind executor. |
| 13 | change_math_model | `proposal_build_change_math_model` | Swap LinearPower → custom. Risky — gate behind a flag. |
| 14 | create_staking_tier | `proposal_build_create_staking_tier` | Staking pool for DEMO. |

### Stage B — Validator-gated (4 internal types)

Prereq: run #15 first to add validators, then #16-19.

| # | Proposal type | Builder |
|---|---|---|
| 15 | manage_validators (external) | `proposal_build_manage_validators` |
| 16 | change_validator_balances (internal type 0) | `proposal_build_change_validator_balances` |
| 17 | change_validator_settings (internal type 1) | `proposal_build_change_validator_settings` |
| 18 | monthly_withdraw (internal type 2) | `proposal_build_monthly_withdraw` |
| 19 | offchain_internal_proposal (internal type 3) | `proposal_build_offchain_internal_proposal` |

### Stage C — OTC full lifecycle

| # | Tool | Notes |
|---|---|---|
| 20 | `otc_dao_open_sale` | Open 1 tier: 1K DEMO @ 0.10 USDT, 7-day vesting. |
| 21 | `read_token_sale_tiers` | Verify tier visible. |
| 22 | `otc_buyer_status` | Check eligibility. |
| 23 | `otc_buyer_buy` | Buy 100 DEMO. |
| 24 | `otc_buyer_claim_all` | Claim post-vesting. |
| 25 | `token_sale_recover` proposal | Recover unsold. |

### Stage D — Off-chain breadth

| # | Proposal type | Builder | Re-test after Bug B fix |
|---|---|---|---|
| 26 | offchain.multi_option | `proposal_build_offchain_multi_option` | ✓ |
| 27 | offchain.for_against | `proposal_build_offchain_for_against` | ✓ |
| 28 | offchain.change_voting_settings | `proposal_build_offchain_settings` | ✓ |
| 29 | offchain.new_template | `proposal_build_offchain_settings` (template mode) | ✓ |

### Stage E — Read/subgraph/decode breadth

| # | Tool | Coverage |
|---|---|---|
| 30 | `proposal_voters` | Subgraph indexed our proposals 1-3? Test mainnet lag. |
| 31 | `user_activity` for deployer | Should list 3 created proposals + 3 votes. |
| 32 | `user_inbox` (auto-discover) | Pending state across all our DAOs. |
| 33 | `read_distribution_status` | After #5. |
| 34 | `read_token_sale_user` | After Stage C. |
| 35 | `read_staking_info` | After #14. |
| 36 | `decode_proposal` on #1-3 | Roundtrip test. |
| 37 | `decode_calldata` on deploy tx | Verify decode logic. |
| 38 | `find_selector` / `get_selectors` / `get_methods` | Static intro. |
| 39 | `get_natspec` / `get_source` / `get_abi` | Artifact reads. |
| 40 | `read_multicall` | Custom batch read. |

### Stage F — Delegation + rewards (need 2nd wallet OR redeploy with rewards)

| # | Tool | Blocker |
|---|---|---|
| 41 | `vote_build_delegate` | Need 2nd funded wallet. |
| 42 | `vote_build_undelegate` | After 41. |
| 43 | `vote_build_claim_rewards` | Current DAO `creationReward=0` — would need redeploy with reward token. |
| 44 | `vote_build_claim_micropool_rewards` | Same. |
| 45 | `vote_build_nft_multiplier_lock` / unlock | Need ERC721Multiplier minted (via #10). |

### Stage G — Privacy + staking + distribution

| # | Tool |
|---|---|
| 46 | `vote_build_privacy_policy_agree` |
| 47 | `vote_build_privacy_policy_sign` |
| 48 | `vote_build_staking_stake` / claim / reclaim |
| 49 | `vote_build_distribution_claim` |
| 50 | `read_privacy_policy_status` / `read_user_inbox` recheck |

### Stage H — IPFS + Merkle + auxiliary

| # | Tool |
|---|---|
| 51 | `ipfs_cid_for_json` |
| 52 | `ipfs_cid_info` |
| 53 | `ipfs_fetch` |
| 54 | `ipfs_upload_proposal_metadata` |
| 55 | `ipfs_upload_dao_metadata` |
| 56 | `merkle_build` / `merkle_proof` |
| 57 | `lint` / `coverage` / `test` |

## Cost budget

Per-proposal cost on BSC mainnet: ≈ 0.0001 BNB ≈ $0.06.
Stage A (10 props): ~$0.60. Stage B+C: ~$1.50. Total backlog full sweep: **~$3-4**.

Wallet currently 0.00681 BNB. Enough for Stages A-D.

## Run order recommendation

1. **Fix Bug A + B in code** (1h) — block-critical for client demo.
2. **Verify Bug C** (15min) — quick regression on backend response.
3. Stage A items 5-11 (skip 12-14 risk profile) → ~$0.50.
4. Stage E items 30-32 → subgraph + activity readback.
5. Stage D items 26-28 (after Bug B fix) → off-chain breadth proven.
6. Stop. Decide if Stage B/C needed for client.

## Memory notes

- `bug_offchain_proposal_type_field.md` — Bug B saved.
- Bug A — needs new memory file `bug_deploy_cap_equals_minted.md`.
