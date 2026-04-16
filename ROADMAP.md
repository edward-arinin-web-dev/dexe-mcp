# dexe-mcp Roadmap

Living progress doc. Updated as phases ship. Detailed plan lives at `C:\Users\edwar\.claude\plans\fuzzy-bubbling-swing.md`.

## Vision

`dexe-mcp` = one MCP server covering the **full DeXe DAO lifecycle** for AI agents: compile/test contracts, introspect ABIs, **create DAOs, build every proposal type, upload IPFS metadata, stake/vote/delegate (user + validator), execute, claim rewards, read live state**.

Writes return calldata payloads (`{ to, data, value, chainId, description }`). No signer ever lives in the MCP — agent's wallet signs.

## Reference projects

- **Contracts:** `D:/dev/DeXe-Protocol` (Hardhat)
- **Frontend (flow source of truth):** `C:/dev/investing-dashboard` — React + Vite + ethers v5 + wagmi + Pinata + The Graph
- **Plan file:** `C:/Users/edwar/.claude/plans/fuzzy-bubbling-swing.md`

## Status legend

- [x] shipped
- [~] in progress
- [ ] not started

---

## Shipped so far

### v0.1.0 — Phase A (dev tooling, 14 tools)
- [x] `dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`
- [x] `dexe_list_contracts`, `dexe_get_abi`, `dexe_get_selectors`, `dexe_find_selector`, `dexe_get_natspec`, `dexe_get_source`
- [x] `dexe_decode_calldata`, `dexe_decode_proposal`, `dexe_read_gov_state`, `dexe_list_gov_contract_types`

### v0.1.1–v0.1.5 — hardening
- [x] `dexe_get_methods` (introspect read/write/payable surface)
- [x] Public install refactor — Mac + Windows `npx -y dexe-mcp`
- [x] Windows PATH / `.cmd` spawn fixes
- [x] Node shim PATH propagation

---

## v0.2.0 — DAO-ops extension (in flight)

### Phase 1 — Foundations + reads [x] (pending mainnet smoke)
- [x] `src/lib/addresses.ts` — per-chain `ContractsRegistry` map + `getContract(name)` resolver
- [x] `src/lib/multicall.ts` — Multicall3 batch helper
- [x] `src/lib/subgraph.ts` — minimal GraphQL fetch helper + votes query
- [x] `src/lib/calldata.ts` — canonical `{ to, data, value, chainId, description }` shape
- [x] `src/lib/govEnums.ts` — ProposalState + VoteType enum mirrors
- [x] `src/config.ts` — add `DEXE_CHAIN_ID`, `DEXE_CONTRACTS_REGISTRY`, `DEXE_PINATA_JWT`, 3× subgraph URLs
- [x] Tools: `dexe_dao_info`, `dexe_dao_predict_addresses`, `dexe_dao_registry_lookup`
- [x] Tools: `dexe_proposal_state`, `dexe_proposal_list`, `dexe_proposal_voters` (subgraph)
- [x] Tools: `dexe_vote_user_power`, `dexe_vote_get_votes`
- [x] Tools: `dexe_read_multicall`, `dexe_read_treasury`, `dexe_read_validators`, `dexe_read_settings`, `dexe_read_expert_status`
- [ ] Mainnet smoke against `0x178618d1…` (deferred to pre-release verification)

### Phase 2 — IPFS [x]
- [x] `src/lib/ipfs.ts` — Pinata upload (JSON + file), CID v0↔v1 parse, local `cidForJson`/`cidForBytes`, sequential gateway fetch
- [x] `dexe_ipfs_upload_proposal_metadata`, `dexe_ipfs_upload_dao_metadata`, `dexe_ipfs_upload_file`
- [x] `dexe_ipfs_fetch` — **dedicated gateway required** (`DEXE_IPFS_GATEWAY`); public gateways are opt-in only via `DEXE_IPFS_GATEWAYS_FALLBACK`
- [x] `dexe_ipfs_cid_info` (parse + alt version + gateway URLs from configured set)
- [x] `dexe_ipfs_cid_for_json` (local precompute, no network — dry-run support)

**IPFS gateway policy:** Public gateways (dweb.link, ipfs.io, cf-ipfs, 4everland) are **unreliable** in 2026 — frequent 502s, outages, rate limits. We do NOT default to them. Users must set `DEXE_IPFS_GATEWAY` (recommended: the dedicated Pinata gateway that comes free with the JWT, `https://<subdomain>.mypinata.cloud`). Public fallback is opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK` (comma-separated). `fetchIpfs()` tries the list sequentially; first 2xx wins. No parallel race (wasteful).

### Phase 3 — Proposal writes [~] (revised 2026-04-15 — frontend has **33 proposal types**, not 7)

Four-layer architecture:

**3a — primitives + catalog + first wrapper** [x]
- [x] `dexe_proposal_build_external` — raw `GovPool.createProposal(url, actionsFor, actionsAgainst)` (+ `andVote` for `createProposalAndVote`)
- [x] `dexe_proposal_build_internal` — raw `GovValidators.createInternalProposal(type, url, data)`
- [x] `dexe_proposal_build_custom_abi` — encode any ABI call → one `ProposalAction`
- [x] `dexe_proposal_build_offchain` — DeXe backend HTTP request builder (needs `DEXE_BACKEND_API_URL`)
- [x] `dexe_proposal_catalog` — enumerate all 33 types with schemas + gating + metadata shape
- [x] `dexe_proposal_build_token_transfer` — first named wrapper (pattern proof)

**3b — most-used named on-chain wrappers** [x] (7/8; token_distribution moved to 3c)
- [x] `dexe_proposal_build_change_voting_settings` — `GovSettings.editSettings/addSettings`
- [x] `dexe_proposal_build_manage_validators` — `GovValidators.changeBalances`
- [x] `dexe_proposal_build_add_expert` — ExpertNft.mint (local/global via scope param)
- [x] `dexe_proposal_build_remove_expert` — ExpertNft.burn (local/global via scope param)
- [x] `dexe_proposal_build_withdraw_treasury` — `GovPool.withdraw`
- [x] `dexe_proposal_build_delegate_to_expert` — `GovPool.delegateTreasury`
- [x] `dexe_proposal_build_revoke_from_expert` — `GovPool.undelegateTreasury`
- [ ] token_distribution — **moved to 3c** (requires DistributionProposal surface investigation)

**3c — remaining complex wrappers** [x]
- [x] `dexe_proposal_build_token_distribution` — `DistributionProposal.execute`
- [x] `dexe_proposal_build_token_sale` — `TokenSaleProposal.createTiers` (basic tier; merkle whitelist via `build_custom_abi`)
- [x] `dexe_proposal_build_token_sale_recover` — `TokenSaleProposal.recover`
- [x] `dexe_proposal_build_create_staking_tier` — `StakingProposal.createStaking`
- [x] `dexe_proposal_build_change_math_model` — `GovPool.changeVotePower`
- [x] `dexe_proposal_build_modify_dao_profile` — `GovPool.editDescriptionURL`
- [x] `dexe_proposal_build_blacklist` — `ERC20Gov.blacklist` (1–2 actions)
- [x] `dexe_proposal_build_reward_multiplier` — 3 modes (set_address / set_uri / mint)
- [x] `dexe_proposal_build_apply_to_dao` — `ERC20.transfer` [+ `ERC20Gov.mint` for shortfall]
- [x] `dexe_proposal_build_new_proposal_type` — `GovSettings.addSettings` + `changeExecutors` (also handles `enable_staking`)
- [x] `validators_allocation` → routed to `manage_validators` wrapper (same underlying method)
- **Refactor:** all wrappers now return `actions: Action[]` (not singular `action`) — supports multi-action proposals (blacklist, apply_to_dao, new_proposal_type)

**3d — off-chain backend builders** [x]
- [x] `dexe_auth_request_nonce` — auth step 1 (GET nonce to sign)
- [x] `dexe_auth_login_request` — auth step 2 (POST signed message, get Bearer token)
- [x] `dexe_proposal_build_offchain_single_option` — voting_type=one_of
- [x] `dexe_proposal_build_offchain_multi_option` — voting_type=multiple_of
- [x] `dexe_proposal_build_offchain_for_against` — voting_type=for_against
- [x] `dexe_proposal_build_offchain_settings` — edit_proposal_type / create_proposal_type
- [x] `dexe_offchain_build_vote` — cast vote
- [x] `dexe_offchain_build_cancel_vote` — cancel vote
- All tools return ready-to-send HTTP requests `{ method, url, headers, body }`. MCP never dispatches HTTP; agent wallet/client signs + sends.
- JSON:API format (`{ data: { type, attributes } }`) matched to DeXe backend. Bearer auth via `Authorization: Bearer <access_token.id>`.
- Env: `DEXE_BACKEND_API_URL` (e.g. `https://api.dexe.io`).

**3e — internal proposal wrappers** [x]
- [x] `dexe_proposal_build_change_validator_balances` — type 0, encodes `changeBalances(balances, users)`
- [x] `dexe_proposal_build_change_validator_settings` — type 1, encodes `changeSettings(duration, executionDelay, quorum)`
- [x] `dexe_proposal_build_monthly_withdraw` — type 2, encodes `monthlyWithdraw(tokens[], amounts[], destination)`
- [x] `dexe_proposal_build_offchain_internal_proposal` — type 3, empty data
- Output shape: `{ metadata, proposalType, data, nextStep }` — agent composes with `dexe_proposal_build_internal(validators, proposalType, descriptionURL, data)`

**Phase 3 COMPLETE.** All 33 proposal types now have dedicated MCP builders. Total Phase 3 tools: 6 (3a) + 7 (3b) + 10 (3c) + 8 (3d) + 4 (3e) = **35 tools added across Phase 3 alone**.

**Fixture tests** [ ]
- [ ] Golden-file hex calldata vs. frontend-captured payloads per type

### Phase 4 — Vote writes [x]
- [x] `dexe_vote_build_erc20_approve` — `ERC20.approve(spender, amount)` (prepend before `deposit` for ERC20-staking DAOs)
- [x] `dexe_vote_build_deposit` — `GovPool.deposit(amount, nftIds)` payable (native supported)
- [x] `dexe_vote_build_withdraw` — `GovPool.withdraw(receiver, amount, nftIds)`
- [x] `dexe_vote_build_delegate` — `GovPool.delegate(delegatee, amount, nftIds)` (user-level)
- [x] `dexe_vote_build_undelegate` — `GovPool.undelegate(delegatee, amount, nftIds)`
- [x] `dexe_vote_build_vote` — `GovPool.vote(proposalId, isVoteFor, amount, nftIds)`
- [x] `dexe_vote_build_cancel_vote` — `GovPool.cancelVote(proposalId)`
- [x] `dexe_vote_build_validator_vote` — `GovValidators.vote{Internal,External}Proposal(pid, amount, isFor)` — **arg order differs from GovPool.vote**
- [x] `dexe_vote_build_validator_cancel_vote` — `GovValidators.cancelVote{Internal,External}Proposal`
- [x] `dexe_vote_build_move_to_validators` — `GovPool.moveProposalToValidators`
- [x] `dexe_vote_build_execute` — `GovPool.execute(proposalId)`
- [x] `dexe_vote_build_claim_rewards` — `GovPool.claimRewards(proposalIds, user)`
- [x] `dexe_vote_build_claim_micropool_rewards` — `GovPool.claimMicropoolRewards(proposalIds, delegator, delegatee)`
- [x] `dexe_vote_build_multicall` — `GovPool.multicall(bytes[])` wrapper for atomic batching (deposit+delegate, execute+claim, etc.)

Output shape: `{ payload: TxPayload }` — single signable tx per tool. Compose multi-step flows via `multicall`.

### Phase 5 — DAO deploy [x]
- [x] `dexe_dao_build_deploy` — `PoolFactory.deployGovPool(GovPoolDeployParams)` with full nested-struct encoding
- [x] Auto-resolves `poolFactory` via ContractsRegistry if not provided
- [x] Optional `predictedGovPool` output when `deployer` + RPC configured (best-effort via `predictGovAddresses`)
- [x] Encodes against compiled artifact (`PoolFactory.json`) when available; falls back to hand-rolled tuple ABI otherwise — fallback signature carefully matched to `IPoolFactory.sol`
- [ ] Fixture tests against frontend-captured deploy calldata (deferred to Phase 6)

### Phase 6 — Polish + release [x]
- [x] README rewritten — 8 tool groups, full env-var matrix, points at ROADMAP.md
- [x] CHANGELOG v0.2.0 entry (comprehensive)
- [x] FUTURE.md updated (signer mode, fork sim, extra IPFS providers, fixture tests)
- [x] `.mcp.example.json` — full env var example
- [x] `package.json` bumped 0.1.5 → 0.2.0, new description, `multiformats` dep, `ROADMAP.md` in files list
- [x] Git commit + tag `v0.2.0` — published

---

## v0.2.1 — User participation tools (12 new tools, 85 total)

### Phase A — Token Sale + Distribution participation writes [x]
- [x] `dexe_vote_build_token_sale_buy` — `TokenSaleProposal.buy(tierId, tokenToBuyWith, amount, proof)` payable
- [x] `dexe_vote_build_token_sale_claim` — `TokenSaleProposal.claim(tierIds[])`
- [x] `dexe_vote_build_token_sale_vesting_withdraw` — `TokenSaleProposal.vestingWithdraw(tierIds[])`
- [x] `dexe_vote_build_distribution_claim` — `DistributionProposal.claim(voter, proposalIds[])`

### Phase B — Staking participation writes [x]
- [x] `dexe_vote_build_staking_stake` — `StakingProposal.stake(user, amount, id)`
- [x] `dexe_vote_build_staking_claim` — `StakingProposal.claim(id)`
- [x] `dexe_vote_build_staking_claim_all` — `StakingProposal.claimAll()`
- [x] `dexe_vote_build_staking_reclaim` — `StakingProposal.reclaim(id)`

### Phase C — Participation read tools [x]
- [x] `dexe_read_token_sale_tiers` — `latestTierId()` + `getTierViews(offset, limit)`
- [x] `dexe_read_token_sale_user` — `getUserViews(user, tierIds)`
- [x] `dexe_read_distribution_status` — `isClaimed()` + `getPotentialReward()` per proposal
- [x] `dexe_read_staking_info` — `stakingsCount()` + `getActiveStakings()` + optional `getUserInfo(user)`

### Phase D — NFT Multiplier lock/unlock [x]
- [x] `dexe_vote_build_nft_multiplier_lock` — `ERC721Multiplier.lock(tokenId)`
- [x] `dexe_vote_build_nft_multiplier_unlock` — `ERC721Multiplier.unlock()`

### Phase E — Subgraph query tools [x]
- [x] `dexe_read_dao_list` — paginated DAO discovery (name search, ordered by voters) — pools subgraph
- [x] `dexe_read_dao_members` — member list with voting power, delegation counts, rewards, expert status — pools subgraph
- [x] `dexe_read_delegation_map` — outgoing/incoming delegation pairs with amounts/NFTs — pools subgraph
- [x] `dexe_read_validator_list` — validators ordered by balance — validators subgraph
- [x] `dexe_read_user_activity` — transaction history across DAOs (proposals, votes, delegations) — interactions subgraph
- [x] `dexe_read_dao_experts` — local experts with delegation info — pools subgraph

New file: `src/tools/subgraph.ts` (uses existing `src/lib/subgraph.ts` + 3 subgraph env vars).

**v0.2.1 total: 95 tools** (73 base + 12 participation + 2 NFT multiplier + 8 subgraph [including existing proposal_voters])

---

## Deferred (FUTURE.md)

- Hardhat fork simulation (`dexe_simulate_vote`, originally Phase B)
- Signer-aware write mode (actually send txs)
- DeXe backend API (off-chain-only proposal type)
- web3.storage / alternate IPFS adapters

---

## How to update this doc

- When starting a tool/item, flip `[ ]` → `[~]`
- When finished + verified (smoke or fixture), flip `[~]` → `[x]`
- Move phases whole-hog between sections when they ship + release
- Keep entries terse; deep context lives in the plan file
