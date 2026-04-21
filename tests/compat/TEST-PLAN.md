# E2E Compat Test Plan — Full Coverage

## Status (2026-04-21)

- **Harness:** COMPLETE (orchestrator, comparator, form-filler, interceptor)
- **Bug fix applied:** `descriptionURL` + `executorDescription` ipfs:// prefix stripping in `src/tools/daoDeploy.ts`
- **Next action:** Re-run minimal-dao to verify fix, then proposal tests

---

## Tier 1: DAO Creation

| # | Fixture | Status | Notes |
|---|---------|--------|-------|
| 1 | `minimal-dao.json` — existing token, no validators | NEAR-PASS (1 bug) → **RE-RUN NEEDED** post-fix | Should be full PASS now |
| 2 | `full-dao.json` — new token + validators enabled | NOT TESTED | |

## Tier 2: Proposals (33 types)

### Off-chain (5 types)

| # | Type | Tool | Fixture | Status |
|---|------|------|---------|--------|
| 3 | `offchain` (single option) | `dexe_proposal_build_offchain_single_option` | `offchain-proposal.json` ready | NOT TESTED |
| 4 | `offchain-for-against` | `dexe_proposal_build_offchain_for_against` | needs fixture | NOT TESTED |
| 5 | `offchain-multi-option` | `dexe_proposal_build_offchain_multi_option` | needs fixture | NOT TESTED |
| 6 | `offchain-internal-proposal` | `dexe_proposal_build_offchain_internal_proposal` | needs fixture | NOT TESTED |
| 7 | `offchain-settings` | `dexe_proposal_build_offchain_settings` | needs fixture | NOT TESTED |

### Internal (4 types)

| # | Type | Tool | Status |
|---|------|------|--------|
| 8 | `change-voting-settings` (internal) | `dexe_proposal_build_change_voting_settings` | NOT TESTED |
| 9 | `change-validator-settings` (internal) | `dexe_proposal_build_change_validator_settings` | NOT TESTED |
| 10 | `change-validator-balances` (internal) | `dexe_proposal_build_change_validator_balances` | NOT TESTED |
| 11 | `manage-validators` (internal) | `dexe_proposal_build_manage_validators` | NOT TESTED |

### External (24 types)

| # | Type | Tool | Status |
|---|------|------|--------|
| 12 | `token-transfer` | `dexe_proposal_build_token_transfer` | NOT TESTED |
| 13 | `withdraw-treasury` | `dexe_proposal_build_withdraw_treasury` | NOT TESTED |
| 14 | `monthly-withdraw` | `dexe_proposal_build_monthly_withdraw` | NOT TESTED |
| 15 | `add-expert` | `dexe_proposal_build_add_expert` | NOT TESTED |
| 16 | `remove-expert` | `dexe_proposal_build_remove_expert` | NOT TESTED |
| 17 | `delegate-to-expert` | `dexe_proposal_build_delegate_to_expert` | NOT TESTED |
| 18 | `revoke-from-expert` | `dexe_proposal_build_revoke_from_expert` | NOT TESTED |
| 19 | `blacklist` | `dexe_proposal_build_blacklist` | NOT TESTED |
| 20 | `custom-abi` | `dexe_proposal_build_custom_abi` | NOT TESTED |
| 21 | `external` (raw actions) | `dexe_proposal_build_external` | NOT TESTED |
| 22 | `modify-dao-profile` | `dexe_proposal_build_modify_dao_profile` | NOT TESTED |
| 23 | `new-proposal-type` | `dexe_proposal_build_new_proposal_type` | NOT TESTED |
| 24 | `change-voting-settings` (external) | `dexe_proposal_build_change_voting_settings` | NOT TESTED |
| 25 | `change-math-model` | `dexe_proposal_build_change_math_model` | NOT TESTED |
| 26 | `token-distribution` | `dexe_proposal_build_token_distribution` | NOT TESTED |
| 27 | `token-sale` | `dexe_proposal_build_token_sale` | NOT TESTED |
| 28 | `token-sale-recover` | `dexe_proposal_build_token_sale_recover` | NOT TESTED |
| 29 | `create-staking-tier` | `dexe_proposal_build_create_staking_tier` | NOT TESTED |
| 30 | `reward-multiplier` | `dexe_proposal_build_reward_multiplier` | NOT TESTED |
| 31 | `apply-to-dao` | `dexe_proposal_build_apply_to_dao` | NOT TESTED |
| 32 | `change-validator-settings` (external) | `dexe_proposal_build_change_validator_settings` | NOT TESTED |
| 33 | `change-validator-balances` (external) | `dexe_proposal_build_change_validator_balances` | NOT TESTED |
| 34 | `manage-validators` (external) | `dexe_proposal_build_manage_validators` | NOT TESTED |
| 35 | `change-voting-settings` (external dup) | `dexe_proposal_build_change_voting_settings` | NOT TESTED |

## Tier 3: Voting / Participation Flows

| # | Flow | Tool | Status |
|---|------|------|--------|
| 36 | `vote` (for/against on-chain) | `dexe_vote_build_vote` | NOT TESTED |
| 37 | `offchain-vote` | `dexe_offchain_build_vote` | NOT TESTED |
| 38 | `delegate` | `dexe_vote_build_delegate` | NOT TESTED |
| 39 | `undelegate` | `dexe_vote_build_undelegate` | NOT TESTED |
| 40 | `deposit` tokens | `dexe_vote_build_deposit` | NOT TESTED |
| 41 | `withdraw` tokens | `dexe_vote_build_withdraw` | NOT TESTED |
| 42 | `execute` proposal | `dexe_vote_build_execute` | NOT TESTED |
| 43 | `cancel-vote` | `dexe_vote_build_cancel_vote` | NOT TESTED |
| 44 | `validator-vote` | `dexe_vote_build_validator_vote` | NOT TESTED |

## Tier 4: Token Sale / Staking / Distribution

| # | Flow | Tool | Status |
|---|------|------|--------|
| 45 | `token-sale-buy` | `dexe_vote_build_token_sale_buy` | NOT TESTED |
| 46 | `token-sale-claim` | `dexe_vote_build_token_sale_claim` | NOT TESTED |
| 47 | `vesting-withdraw` | `dexe_vote_build_token_sale_vesting_withdraw` | NOT TESTED |
| 48 | `distribution-claim` | `dexe_vote_build_distribution_claim` | NOT TESTED |
| 49 | `staking-stake` | `dexe_vote_build_staking_stake` | NOT TESTED |
| 50 | `staking-claim` | `dexe_vote_build_staking_claim` | NOT TESTED |
| 51 | `staking-claim-all` | `dexe_vote_build_staking_claim_all` | NOT TESTED |
| 52 | `staking-reclaim` | `dexe_vote_build_staking_reclaim` | NOT TESTED |
| 53 | `nft-multiplier-lock` | `dexe_vote_build_nft_multiplier_lock` | NOT TESTED |
| 54 | `nft-multiplier-unlock` | `dexe_vote_build_nft_multiplier_unlock` | NOT TESTED |

## Tier 5: Edge Cases

| # | Case | Fixture | Status |
|---|------|---------|--------|
| 55 | Deliberate failures / validation | `deliberate-fail.json` ready | NOT TESTED |

---

## Priority Order

1. **Re-run minimal-dao** — verify descriptionURL fix → should be PASS
2. **Off-chain proposals** — simplest, no on-chain state needed (fixture ready for #3)
3. **High-use externals** — token-transfer, modify-dao-profile, custom-abi
4. **Full DAO creation** — validators, new token
5. **Voting flows** — need existing DAO + proposals
6. **Participation** — need active token sales / staking
7. **Edge cases**

## Key Files

| File | Purpose |
|------|---------|
| `tests/compat/orchestrator.md` | Full E2E test protocol (7 phases) |
| `tests/compat/FORM-GUIDE.md` | Browser form-filling reference |
| `tests/compat/comparator.ts` | Hex diff + ABI decoder + report generator |
| `tests/compat/form-filler.js` | Injected browser script for wizard |
| `tests/compat/interceptor.js` | Captures frontend calldata |
| `tests/compat/HANDOFF.md` | Results from first test run |
| `tests/fixtures/*.json` | Test parameter fixtures |
| `tests/reports/` | Generated comparison reports |
