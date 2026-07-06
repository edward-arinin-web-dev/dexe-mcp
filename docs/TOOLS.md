# dexe-mcp tool catalog

`dexe-mcp` is an MCP (Model Context Protocol) server that exposes DeXe Protocol DAO operations and Solidity-dev tooling to AI agents — plus a generic `dexe_gov_*` surface for external OpenZeppelin Governor + Compound Bravo DAOs (Uniswap, Compound, Optimism). Total tools: **159** across **19** groups. Call **`dexe_context`** first each session — it returns the signer, active chain, env readiness, and the DAOs/proposals recorded in prior sessions.

The server is **calldata-first**: most tools return a `TxPayload` (`{to, data, value, chainId, description}`) that the user's wallet signs and broadcasts. A subset (`dexe_dao_info`, `dexe_proposal_state`, all `dexe_read_*`, all `dexe_ipfs_*`, `dexe_decode_*`, all `dexe_get_*` / `dexe_list_*`) are pure reads. Four composite tools (`dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`) opt into auto-signing when `DEXE_PRIVATE_KEY` is configured.

Discover tools at runtime via the MCP client's `tools/list`, or call `dexe_proposal_catalog` for the live list of supported proposal types and which builder maps to each.

## Toolset profiles

Registering all 159 tools costs ~206 KB of `tools/list` per session. **`DEXE_TOOLSETS`** (comma list) gates which profiles load. **The default changed to `core,proposals` in v0.13.0** (breaking) — a slim surface instead of everything.

| Profile | Tools | What it covers |
|---------|------:|----------------|
| `core` | 34 | Everyday flow: `dexe_context` (call first), `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, all 5 `dexe_otc_*`, `dexe_tx_send/status`, `dexe_wc_*`, key vote builders (deposit/withdraw/vote/execute/erc20_approve) + `dexe_vote_user_power`, IPFS upload trio + avatar, `dexe_read_treasury/settings`, `dexe_proposal_state/list/catalog`, `dexe_dao_info/registry_lookup/predict_addresses`, `dexe_doctor`, `dexe_get_config`. |
| `proposals` | 41 | Every `dexe_proposal_build_*` builder (33 types), the offchain + backend-auth surface, and proposal/DAO IPFS writes. |
| `read` | 32 | All `dexe_read_*` (chain + subgraph + backend balances/holders/stats/NFTs), `dexe_proposal_voters`, `dexe_user_inbox`, `dexe_proposal_forecast`, `dexe_proposal_risk_assess`, IPFS reads. |
| `vote` | 28 | Every direct `dexe_vote_build_*` builder (delegate, staking, NFT multiplier, claims, privacy policy, …) + `dexe_vote_get_votes`. |
| `governor` | 18 | The external `dexe_gov_*` OpenZeppelin/Bravo Governor surface. |
| `dev` | 23 | `dexe_compile/test/coverage/lint`, introspection (`dexe_get_*`, `dexe_list_*`, `dexe_find_selector`), `dexe_decode_*`, `dexe_read_gov_state`, simulator, merkle, Safe, and the low-level `dexe_dao_build_deploy`. |
| `full` | 159 | Everything (pre-v0.13.0 behavior). |

Sets union; a typo/unknown name → falls back to `full` (never silently strips). The union of the six named sets equals all 159 tools, so every tool is reachable under some profile.

Measured `tools/list` sizes: **full 206 KB (159 tools)** · **default `core,proposals` 112 KB (72 tools, −46%)** · **`core` alone 49 KB (34 tools, −76%)**. Set `DEXE_TOOLSETS=core` for the deepest cut (the composites cover the common proposal types), or `DEXE_TOOLSETS=full` to restore everything. `dexe_doctor` reports the active profile.

## Table of contents

1. [Dev tooling](#1-dev-tooling)
2. [Contract introspection](#2-contract-introspection)
3. [DAO reads](#3-dao-reads)
4. [IPFS](#4-ipfs)
5. [DAO deploy](#5-dao-deploy)
6. [Proposal catalog and primitives](#6-proposal-catalog-and-primitives)
7. [External proposal wrappers](#7-external-proposal-wrappers)
8. [Internal validator wrappers](#8-internal-validator-wrappers)
9. [Off-chain wrappers and auth](#9-off-chain-wrappers-and-auth)
10. [Vote, stake, delegate, execute, claim builders](#10-vote-stake-delegate-execute-claim-builders)
11. [Composite signing flows](#11-composite-signing-flows)
12. [Merkle utility](#12-merkle-utility)
13. [OTC composites](#13-otc-composites)
14. [Safe multisig](#14-safe-multisig)
15. [Simulator](#15-simulator)
16. [Multi-DAO inbox + forecast](#16-multi-dao-inbox--forecast)
17. [External Governor DAOs (dexe_gov_*)](#17-external-governor-daos-dexe_gov_)
18. [WalletConnect](#18-walletconnect)
19. [Diagnostics](#19-diagnostics)

Each row links to the runtime schema. Args, return shapes, and zod input validators live in `src/tools/*.ts` — call the tool with no args (or via your MCP client) to see the JSON schema.

---

## 1. Dev tooling

Source: `src/tools/build.ts`. All four require `DEXE_PROTOCOL_PATH` (path to a checked-out DeXe-Protocol Hardhat workspace).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_compile` | Runs `npm run compile`, parses solc diagnostics, invalidates artifact cache. Must run once per session before introspection. | `DEXE_PROTOCOL_PATH` |
| `dexe_test` | Runs `npx hardhat test`. Optional mocha `--grep` or specific test file. Captures up to 20 failure bodies. | `DEXE_PROTOCOL_PATH` |
| `dexe_coverage` | Runs `npm run coverage` and reads `coverage/coverage-summary.json`. Slow — minutes. | `DEXE_PROTOCOL_PATH` |
| `dexe_lint` | `npm run lint-fix` (when `fix: true`) or `npm run lint-check`. Chains solhint + eslint + jsonlint. | `DEXE_PROTOCOL_PATH` |

---

## 2. Contract introspection

Source: `src/tools/introspect.ts` + `src/tools/gov.ts`. All require `dexe_compile` to have run at least once. Reads compiled artifacts from `DEXE_PROTOCOL_PATH/artifacts/`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_list_contracts` | Lists compiled contracts. Filter by name substring and/or kind (contract/interface/library). | `DEXE_PROTOCOL_PATH` |
| `dexe_get_abi` | Returns ABI JSON for a compiled contract by name. | `DEXE_PROTOCOL_PATH` |
| `dexe_get_methods` | Per-function metadata partitioned read vs write. Includes signature, 4-byte selector, mutability, structured I/O. | `DEXE_PROTOCOL_PATH` |
| `dexe_get_selectors` | All function selectors, event topic hashes, and error selectors for a contract. | `DEXE_PROTOCOL_PATH` |
| `dexe_find_selector` | Reverse lookup: 4-byte selector or 32-byte event topic → matching contracts/signatures. Handles collisions. | `DEXE_PROTOCOL_PATH` |
| `dexe_get_natspec` | Reads devdoc/userdoc from build-info. Optionally scoped to a single member. | `DEXE_PROTOCOL_PATH` |
| `dexe_get_source` | Returns source file path. Optionally slices around a symbol via regex. | `DEXE_PROTOCOL_PATH` |
| `dexe_decode_calldata` | Decodes raw `0x…` calldata against loaded ABIs. Tries every artifact whose selector matches if `contract` omitted. | `DEXE_PROTOCOL_PATH` |
| `dexe_decode_proposal` | Fetches a proposal via `getProposals(offset, limit)` and decodes every action in `actionsOnFor` + `actionsOnAgainst`. | `DEXE_PROTOCOL_PATH`, `DEXE_RPC_URL` |
| `dexe_list_gov_contract_types` | Static catalog of governance subsystem contracts: what each does, where source lives. Cheap orientation. | (none) |

---

## 3. DAO reads

Sources: `src/tools/dao.ts`, `src/tools/gov.ts`, `src/tools/proposal.ts`, `src/tools/vote.ts`, `src/tools/read.ts`, `src/tools/risk.ts`, `src/tools/subgraph.ts`. All on-chain reads need `DEXE_RPC_URL`. Subgraph reads need the relevant `DEXE_SUBGRAPH_*_URL`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_dao_info` | Helpers + NFT contracts + descriptionURL + validator count for a GovPool. One multicall. | `DEXE_RPC_URL` |
| `dexe_dao_predict_addresses` | `PoolFactory.predictGovAddresses(deployer, poolName)` → 6 CREATE2 addresses. Useful for pre-deploy wiring. | `DEXE_RPC_URL` |
| `dexe_dao_registry_lookup` | `PoolRegistry.isGovPool(address)` — true if address is a registered DeXe GovPool. | `DEXE_RPC_URL` |
| `dexe_proposal_state` | `getProposalState` + `getProposalRequiredQuorum` in one multicall. Returns named state. | `DEXE_RPC_URL` |
| `dexe_proposal_list` | `GovPool.getProposals(offset, limit)` → compact summaries. | `DEXE_RPC_URL` |
| `dexe_proposal_voters` | Voter list from interactions subgraph, paginated. | `DEXE_SUBGRAPH_INTERACTIONS_URL` |
| `dexe_proposal_risk_assess` | Treasury-safety risk readout for a proposal (or hypothetical actions): quorum %, safe floor, treasury at risk, indicative share of supply required to meet quorum, verdict (SAFE/CAUTION/DANGER). | `DEXE_RPC_URL` |
| `dexe_read_gov_state` | Reads `getHelperContracts()` + `getNftContracts()`, returns resolved helper + NFT addresses. | `DEXE_RPC_URL` |
| `dexe_vote_user_power` | `tokenBalance` + `nftBalance` on GovUserKeeper for every VoteType (Personal/Micropool/Delegated/Treasury). | `DEXE_RPC_URL` |
| `dexe_vote_get_votes` | `GovPool.getUserVotes(proposalId, voter, voteType)` → VoteInfoView. Defaults to PersonalVote. | `DEXE_RPC_URL` |
| `dexe_read_multicall` | Arbitrary batched view-calls via Multicall3. Each call supplies its own ABI fragment. | `DEXE_RPC_URL` |
| `dexe_read_treasury` | Wallet/DAO balances. Backend-first (auto-discovers every token + USD prices + total via `api-proxy-cache/<chain>/wallet-balances`, same source as app.dexe.io); RPC multicall fallback on testnet 97, explicit `tokens`, or unset backend. | `DEXE_BACKEND_API_URL` (backend) · `DEXE_RPC_URL` (fallback) |
| `dexe_read_token_holders` | Holders + raw balances of any ERC20 via `token-holders-balances/<token>`, sorted desc. Backend-only (mainnets). | `DEXE_BACKEND_API_URL` |
| `dexe_read_dao_stats` | DAO TVL + member/proposal/delegation time series via `tracker/<chain>/pools/gov/<dao>/stats/<period>`. `period` is a human duration ('24 hours', '7 days', '1 months'). Backend-only. | `DEXE_BACKEND_API_URL` |
| `dexe_read_nfts` | NFTs held by any address via `nfts-by-wallet/<addr>` (Moralis), optional contract filter. Backend-only. | `DEXE_BACKEND_API_URL` |
| `dexe_read_validators` | `validatorsCount()` + optional `isValidator(candidate)` on GovValidators. | `DEXE_RPC_URL` |
| `dexe_read_settings` | `GovSettings.getDefaultSettings()` + `getInternalSettings()`. | `DEXE_RPC_URL` |
| `dexe_read_expert_status` | `GovPool.getExpertStatus(user)` + optional BABT balance check. | `DEXE_RPC_URL` |
| `dexe_read_token_sale_tiers` | `latestTierId()` + `getTierViews(offset, limit)` from a TokenSaleProposal. | `DEXE_RPC_URL` |
| `dexe_read_token_sale_user` | `getUserViews(user, tierIds)` — per-tier purchase, claimable, vesting info. | `DEXE_RPC_URL` |
| `dexe_read_distribution_status` | `isClaimed(proposalId, voter)` + `getPotentialReward` from DistributionProposal. | `DEXE_RPC_URL` |
| `dexe_read_staking_info` | `stakingsCount()` + `getActiveStakings()` + optional `getUserInfo(user)`. | `DEXE_RPC_URL` |
| `dexe_read_privacy_policy_status` | `UserRegistry.documentHash()` + `agreed(user)`. | `DEXE_RPC_URL` |
| `dexe_read_dao_list` | Paginated DAO discovery via pools subgraph. Search by name, ordered by voter count. | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_dao_members` | Paginated members with voting power, delegation counts, rewards, expert status. | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_dao_experts` | Paginated local experts (DAO-specific expert NFT holders) with delegation info. | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_validator_list` | Paginated validators ordered by balance descending. | `DEXE_SUBGRAPH_VALIDATORS_URL` |
| `dexe_read_user_activity` | Paginated tx history per user — proposals/votes/delegations/claims by timestamp desc. | `DEXE_SUBGRAPH_INTERACTIONS_URL` |
| `dexe_read_delegation_map` | Outgoing or incoming delegation pairs for a user. | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_otc_list_sales_for_dao` | Reads `latestTierId()` + `getTierViews(0, latestTierId)` on a DAO's TokenSaleProposal helper. Returns tiers with `totalSold`, `upcoming`/`active`/`ended`/`off` status (block timestamp + on-chain `isOff`), and both raw + `saleStartTimeUTC`/`saleEndTimeUTC` human-readable UTC times. Works chain 56 + 97, no subgraph needed. Pass `tokenSaleProposal` explicitly until per-DAO helper discovery lands. | `DEXE_RPC_URL` |

---

## 4. IPFS

Source: `src/tools/ipfs.ts`. Pinata-backed; reads use the configured gateway with optional fallback chain.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_ipfs_upload_proposal_metadata` | Pins `{proposalName, proposalDescription, ...}` (proposal-shaped) to IPFS via Pinata. Returns CID for `descriptionURL`. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_dao_metadata` | Nested upload chain: description content → IPFS, outer metadata → IPFS. Returns outer CID for `deployGovPool.descriptionURL`. Auto-normalizes input `avatarCID` to v1 base32. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_update_dao_metadata` | Fetches current DAO metadata, applies partial overrides (avatar/name/website/socialLinks/etc.), re-uploads. Returns new outer CID for `dexe_proposal_build_modify_dao_profile`. Unspecified fields preserved. | `DEXE_PINATA_JWT`, `DEXE_IPFS_GATEWAY` |
| `dexe_ipfs_upload_file` | Pins raw bytes (base64 input). Returns CID **v1 base32** (subdomain-gateway compatible) + the original v0. Image filenames normalized to `.jpeg`. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_avatar` | One-shot avatar upload: returns the `{avatarCID, avatarFileName, avatarUrl}` triple ready for `dexe_ipfs_upload_dao_metadata` or `*_update_dao_metadata`. | `DEXE_PINATA_JWT` |
| `dexe_dao_generate_avatar` | Generates a deterministic SVG identicon (initials over hash-coloured gradient — no external provider) and pins it. Same `{avatarCID, avatarFileName, avatarUrl}` shape. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_fetch` | Fetches CID via `DEXE_IPFS_GATEWAY` (recommended dedicated gateway). Public fallbacks opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK`. | `DEXE_IPFS_GATEWAY` |
| `dexe_ipfs_cid_info` | Parses CIDv0/v1, reports codec + multihash, converts between versions, emits gateway URLs. | (none) |
| `dexe_ipfs_cid_for_json` | Computes deterministic CIDv1 (json codec, sha-256) locally — no network. Useful for dry-run flows. | (none) |

---

## 5. DAO deploy

Source: `src/tools/daoDeploy.ts`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_dao_create` | **Composite (auto-signs):** one-call DAO deploy — uploads DAO profile metadata to IPFS, builds `deployGovPool` (reusing `dexe_dao_build_deploy`), pre-flights the deploy reverts (cap>minted, LINEAR initData, non-zero userKeeper asset, mainnet treasury remainder), then broadcasts or returns the payload. Validate on BSC testnet (chain 97). | `DEXE_PINATA_JWT`, `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` (for auto-broadcast) |
| `dexe_dao_build_deploy` | Builds `PoolFactory.deployGovPool(GovPoolDeployParams)` calldata. Mirrors the frontend wizard at app.dexe.network/create-dao. Auto-expands proposal settings (1 → 5: default/internal/validators/distributionProposal/tokenSale). | `DEXE_RPC_URL` |

---

## 6. Proposal catalog and primitives

Source: `src/tools/proposalBuild.ts`. The catalog tool is your runtime registry of proposal types; the four `*_build_external|internal|custom_abi|offchain` tools are raw primitives every wrapper composes through.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_catalog` | Full catalog of proposal types: target contract/endpoint, IPFS metadata requirement, gating, and which MCP wrapper builds it. | (none) |
| `dexe_proposal_build_external` | Primitive: builds `GovPool.createProposal(descriptionURL, actionsOnFor, actionsOnAgainst)` calldata. | (none) |
| `dexe_proposal_build_internal` | Primitive: builds `GovValidators.createInternalProposal`. `proposalType` 0=ChangeBalances, 1=ChangeSettings, 2=MonthlyWithdraw, 3=OffchainProposal. | (none) |
| `dexe_proposal_build_custom_abi` | Encodes a single `ProposalAction` from a user-supplied function signature + args. Drop result into `actionsOnFor`. | (none) |
| `dexe_proposal_build_offchain` | Primitive: returns the ready HTTP request for the off-chain proposal backend. No wallet needed. | `DEXE_BACKEND_API_URL` |

---

## 7. External proposal wrappers

Sources: `src/tools/proposalBuild.ts`, `src/tools/proposalBuildMore.ts`, `src/tools/proposalBuildComplex.ts`. Each returns: IPFS metadata to upload, the encoded `ProposalAction`(s), and a hint about how to compose into `dexe_proposal_build_external`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_build_token_transfer` | Treasury → recipient ERC20 transfer. Encodes `ERC20.transfer`. Aborts if `DEXE_RPC_URL` set and recipient is `ERC20Gov.isBlacklisted`. | `DEXE_RPC_URL` (optional, for blacklist precheck) |
| `dexe_proposal_build_token_distribution` | Batch distribution via DistributionProposal. Auto-prepends `ERC20.approve` for non-native tokens. | (none) |
| `dexe_proposal_build_token_sale` | Launches a single tier via `TokenSaleProposal.createTiers`. Plain whitelist supported; merkle requires custom_abi. | (none) |
| `dexe_proposal_build_token_sale_multi` | `TokenSaleProposal.createTiers([...])` for one or more tiers. Each tier may declare participation requirements (DAOVotes / Whitelist / BABT / TokenLock / NftLock / MerkleWhitelist), encoded per-type. ERC20 approves are summed + deduped per sale token; plain-`Whitelist` tiers auto-append the matching `addToWhitelist` action when users are supplied. | (none) |
| `dexe_proposal_build_token_sale_whitelist` | `TokenSaleProposal.addToWhitelist([{tierId, users, uri}, ...])` — extend the whitelist of an already-live tier (plain `Whitelist` type only; merkle tiers are gated by their root). | (none) |
| `dexe_proposal_build_token_sale_recover` | `TokenSaleProposal.recover(tierIds)` — recover unsold tokens. | (none) |
| `dexe_proposal_build_create_staking_tier` | `StakingProposal.createStaking(rewardToken, amount, startedAt, deadline, metadata)`. Auto-prepends approve for ERC20 rewards. | (none) |
| `dexe_proposal_build_change_math_model` | `GovPool.changeVotePower(newVotePower)` — swap LINEAR / POLYNOMIAL / custom power contract. | (none) |
| `dexe_proposal_build_modify_dao_profile` | `GovPool.editDescriptionURL(url)`. Upload new DAO metadata via `dexe_ipfs_upload_dao_metadata` first. End-to-end round-trip contract documented in [`docs/PROFILE.md`](./PROFILE.md) — directory pin for avatar, `isMeta:false`, `changes.currentChanges.descriptionUrl` are load-bearing. | (none) |
| `dexe_proposal_build_blacklist` | Up to 2 actions: `ERC20Gov.blacklist(add,true)` + `blacklist(remove,false)`. | (none) |
| `dexe_proposal_build_reward_multiplier` | 4 modes: set_address / set_token_uri / mint / change_token on the multiplier NFT. `mint`/`change_token` use `uint64` duration + multiplier scaled by `PRECISION = 1e25` (1.5x = 1.5e25); builder rejects unscaled or zero values. | (none) |
| `dexe_proposal_build_apply_to_dao` | Disburse DAO tokens to a receiver. Treasury-sufficient → 1 transfer; shortfall → transfer + mint. Aborts if `DEXE_RPC_URL` set and recipient is `ERC20Gov.isBlacklisted`. | `DEXE_RPC_URL` (optional, for blacklist precheck) |
| `dexe_proposal_build_new_proposal_type` | 2 actions: `GovSettings.addSettings([new])` + `changeExecutors`. Path for enabling staking. | (none) |
| `dexe_proposal_build_change_voting_settings` | `GovSettings.editSettings` (when `settingsIds` given) or `addSettings` (when empty). | (none) |
| `dexe_proposal_build_manage_validators` | `GovValidators.changeBalances(balances, users)`. Set 0 to remove. | (none) |
| `dexe_proposal_build_add_expert` | Mint Expert NFT — `scope='local'` (DAO ExpertNft) or `'global'` (DeXeExpertNft). | (none) |
| `dexe_proposal_build_remove_expert` | `ExpertNft.burn(from)` — local or global. | (none) |
| `dexe_proposal_build_withdraw_treasury` | One ERC20 `transfer(receiver, amount)` action and/or one ERC721 `transferFrom(govPool, receiver, tokenId)` action per NFT. Treasury sits in GovPool as a regular ERC20/721 balance — withdrawal is a plain external token call. Aborts if `DEXE_RPC_URL` set and recipient is `ERC20Gov.isBlacklisted`. | `DEXE_RPC_URL` (optional, for blacklist precheck) |
| `dexe_proposal_build_delegate_to_expert` | `GovPool.delegateTreasury(delegatee, amount, nftIds)`. | (none) |
| `dexe_proposal_build_revoke_from_expert` | `GovPool.undelegateTreasury(delegatee, amount, nftIds)`. | (none) |

---

## 8. Internal validator wrappers

Source: `src/tools/proposalBuildInternal.ts`. Each returns the `data` bytes you feed to `dexe_proposal_build_internal`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_build_change_validator_balances` | Internal type 0: `changeBalances(balances, users)`. Balance=0 removes a validator. | (none) |
| `dexe_proposal_build_change_validator_settings` | Internal type 1: `changeSettings(duration, executionDelay, quorum)`. Seconds + percent-as-BN. | (none) |
| `dexe_proposal_build_monthly_withdraw` | Internal type 2: `monthlyWithdraw(tokens, amounts, destination)`. Parallel arrays; tokens != zero. | (none) |
| `dexe_proposal_build_offchain_internal_proposal` | Internal type 3: `data` MUST be empty (`0x`). DescriptionURL carries the payload. | (none) |

---

## 9. Off-chain wrappers and auth

Source: `src/tools/proposalBuildOffchain.ts`. All return ready HTTP request objects (method/url/headers/body) — your client sends them. The DeXe backend uses Bearer-token auth via signed nonce.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_auth_request_nonce` | Step 1/2: `POST /integrations/nonce-auth-svc/nonce` — returns a message to sign. | `DEXE_BACKEND_API_URL` |
| `dexe_auth_login_request` | Step 2/2: `POST /integrations/nonce-auth-svc/login` — exchange signed nonce for `{access_token, refresh_token}`. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_single_option` | `POST /integrations/voting/proposals` with `voting_type='one_of'`. Pick exactly one of N. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_multi_option` | Same endpoint, `voting_type='multiple_of'`. Pick any subset. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_for_against` | Same endpoint, `voting_type='for_against'`. Binary, default labels For/Against. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_settings` | `attributes.type='edit_proposal_type'` (DAO-wide settings) or `'create_proposal_type'` (reusable template). | `DEXE_BACKEND_API_URL` |
| `dexe_offchain_build_vote` | `POST /integrations/voting/vote`. `options` is array of selected option strings. | `DEXE_BACKEND_API_URL` |
| `dexe_offchain_build_cancel_vote` | `DELETE /integrations/voting/vote/{proposalId}/{voterAddress}`. No body. | `DEXE_BACKEND_API_URL` |

---

## 10. Vote, stake, delegate, execute, claim builders

Source: `src/tools/voteBuild.ts`. All return calldata `TxPayload`. None require env beyond your wallet (no RPC reads happen here — these are pure encoders).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_vote_build_erc20_approve` | `ERC20.approve(spender, amount)`. Prepend before deposit when staking ERC20 (spender = UserKeeper). | (none) |
| `dexe_vote_build_deposit` | `GovPool.deposit(amount, nftIds)`. Payable — pass `value` for native-coin staking. | (none) |
| `dexe_vote_build_withdraw` | `GovPool.withdraw(receiver, amount, nftIds)`. | (none) |
| `dexe_vote_build_delegate` | `GovPool.delegate(delegatee, amount, nftIds)`. User-level delegation (not treasury). | (none) |
| `dexe_vote_build_undelegate` | `GovPool.undelegate(delegatee, amount, nftIds)`. | (none) |
| `dexe_vote_build_vote` | `GovPool.vote(proposalId, isVoteFor, amount, nftIds)`. Requires staked/delegated power. | (none) |
| `dexe_vote_build_cancel_vote` | `GovPool.cancelVote(proposalId)`. | (none) |
| `dexe_vote_build_validator_vote` | `GovValidators.vote{Internal,External}Proposal`. Note: amount BEFORE isVoteFor (differs from GovPool.vote). | (none) |
| `dexe_vote_build_validator_cancel_vote` | `GovValidators.cancelVote{Internal,External}Proposal(proposalId)`. | (none) |
| `dexe_vote_build_move_to_validators` | `GovPool.moveProposalToValidators(proposalId)` — escalate passing proposal to validators tier. | (none) |
| `dexe_vote_build_execute` | `GovPool.execute(proposalId)`. | (none) |
| `dexe_vote_build_claim_rewards` | `GovPool.claimRewards(proposalIds, user)`. | (none) |
| `dexe_vote_build_claim_micropool_rewards` | `GovPool.claimMicropoolRewards(proposalIds, delegator, delegatee)`. | (none) |
| `dexe_vote_build_nft_multiplier_lock` | `ERC721Multiplier.lock(tokenId)` — apply multiplier bonus to caller's voting power. | (none) |
| `dexe_vote_build_nft_multiplier_unlock` | `ERC721Multiplier.unlock()` — release locked multiplier NFT. | (none) |
| `dexe_vote_build_token_sale_buy` | `TokenSaleProposal.buy(tierId, tokenToBuyWith, amount, proof)`. Native: pass ETHEREUM_ADDRESS (0xEeee...EEeE) as token (0x0 aliased); `value` auto-set to `amount` when left 0. Whitelisted: pass merkle proof. | (none) |
| `dexe_vote_build_token_sale_claim` | `TokenSaleProposal.claim(tierIds)` — after claim lock duration. | (none) |
| `dexe_vote_build_token_sale_vesting_withdraw` | `TokenSaleProposal.vestingWithdraw(tierIds)` — withdraw currently unlocked vested portion. | (none) |
| `dexe_vote_build_distribution_claim` | `DistributionProposal.claim(voter, proposalIds)` — claim proportional share. | (none) |
| `dexe_vote_build_staking_stake` | `GovUserKeeper.stakeTokens(tierId, amount)`. Target is UserKeeper, not StakingProposal. | (none) |
| `dexe_vote_build_staking_claim` | `StakingProposal.claim(id)` — claim rewards from one tier without unstaking. | (none) |
| `dexe_vote_build_staking_claim_all` | `StakingProposal.claimAll()` — claim from every active tier in one tx. | (none) |
| `dexe_vote_build_staking_reclaim` | `StakingProposal.reclaim(id)` — withdraw staked tokens + pending rewards. | (none) |
| `dexe_vote_build_privacy_policy_sign` | EIP712 typed-data envelope. Wallet signs with `signTypedData`, signature passes to `_agree`. | (none) |
| `dexe_vote_build_privacy_policy_agree` | `UserRegistry.agreeToPrivacyPolicy(signature)`. Optional `profileURL` to bundle update. | (none) |
| `dexe_vote_build_multicall` | `GovPool.multicall(calls)` — atomic batch of inner calldatas. Only GovPool methods. | (none) |

---

## 11. Composite signing flows

Sources: `src/tools/flow.ts`, `src/tools/txSend.ts`, `src/tools/getConfig.ts`. The signing flows (`dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_tx_send`) **require `DEXE_PRIVATE_KEY` for the auto-signed mode** — they sign and broadcast directly (and run the B6/B7/B10 broadcast guards first; `dexe_tx_send` also runs B9 simulation). Other tools always return calldata for an external signer.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_context` | **Call first.** Read-only orientation: signer + mode, active/configured chains, env readiness, and the persisted state — DAOs deployed and proposals broadcast in prior sessions (via `dexe_dao_create` / `dexe_proposal_create`), plus deposited voting power in the most recent DAO. State at `~/.dexe-mcp/state.json` (override `DEXE_STATE_PATH`). | (none) |
| `dexe_proposal_create` | End-to-end create-proposal flow: balance check, approve UserKeeper if needed, deposit if needed, build + broadcast `createProposalAndVote`. `proposalType` accepts `modify_dao_profile`, `custom`, or a wired catalog type (`token_transfer`, `withdraw_treasury`, `change_voting_settings`, `add_expert`, `remove_expert`, `token_distribution`, `token_sale`, `custom_abi`) — pass the type's inputs in `params` and the tool builds correct calldata + IPFS metadata. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL`, `DEXE_PINATA_JWT` |
| `dexe_proposal_vote_and_execute` | Vote on a proposal, optionally execute when state allows. Handles deposits + state transitions. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_send` | Sign and broadcast any TxPayload from a `*_build_*` tool. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_status` | Read receipt/status of a previously submitted tx hash. | `DEXE_RPC_URL` |
| `dexe_get_config` | Diagnostic read: the server's chain set, default chain, and signer status (`readonly`/`eoa`/`safe`). Call once at session start when unsure which chain is configured. Never writes. | (none) |

---

## 12. Merkle utility

Source: `src/tools/merkle.ts`. OZ `StandardMerkleTree`-compatible. No env required (pure compute).

| Tool | What it does |
|------|--------------|
| `dexe_merkle_build` | Build a merkle tree over `entries[]` with `leafEncoding` (default `["address"]`). Returns `{ root, proofs[], leafHashes[] }`. Sorted-pair commutative keccak; double-hash leaf `keccak256(keccak256(abi.encode(...)))`. Matches frontend's `@openzeppelin/merkle-tree` 1:1. |
| `dexe_merkle_proof` | Single-target convenience wrapper: `{ entries, target, leafEncoding? }` → `{ root, proof, leafHash, included }`. |

---

## 13. OTC composites

Source: `src/tools/otc.ts`. Composites that orchestrate `proposal_create` + `TokenSaleProposal` reads/writes for an end-to-end OTC sale flow. See [`docs/OTC.md`](./OTC.md) for the full project-owner + buyer recipe.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_otc_dao_open_sale` | Project-owner composite. Builds the multi-tier `createTiers` envelope (deduped approves, auto-merkle, auto-`addToWhitelist`) and runs the full proposal_create flow (balance/threshold check, IPFS metadata, approve, deposit, `createProposalAndVote`). Flags: `buildOnly` (skip proposal flow, return envelope only), `dryRun` (return TxPayloads even with key set). | `DEXE_RPC_URL`, `DEXE_PINATA_JWT`, `DEXE_PRIVATE_KEY` for broadcast |
| `dexe_otc_buyer_status` | Read-only aggregator. Multicalls `getTierViews` + `getUserViews(user, tierIds, proofs)`, surfaces participation requirements, per-tier `saleStartTimeUTC`/`saleEndTimeUTC` (human-readable UTC), and pre-computed `claimable` and `vestingWithdrawable`. Optional per-tier `whitelists[]` triggers merkle root + proof + verifyProof for the user, and the proof is passed into `getUserViews` so `canParticipate` is accurate for merkle tiers. | `DEXE_RPC_URL` |
| `dexe_otc_buyer_buy` | Buyer composite. Preflights ERC20 balance + allowance (skipped on native sentinel ETHEREUM_ADDRESS 0xEeee...EEeE; 0x0 accepted as alias, calldata always carries ETHEREUM_ADDRESS), prepends approve when needed, builds `buy(tierId, paymentToken, amount, proof)`. Auto-derives merkle proof when `whitelistUsers[]` supplied. Native path sets `value=amount`. Optional `simulateFirst` runs sim before broadcast. | `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` for broadcast |
| `dexe_otc_buyer_claim_all` | Picks tiers with `canClaim && !isClaimed` → `claim`, tiers with `amountToWithdraw > 0` → `vestingWithdraw`. `mode='noop'` when nothing pending. | `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` for broadcast |

---

## 14. Safe multisig

Source: `src/tools/safe.ts`, `src/lib/ethersProvider.ts`. Alternative signer posture: instead of broadcasting from a hot EOA, **queue** the tx in the [Safe Transaction Service](https://docs.safe.global/) for the Safe's owners to co-sign and execute. Use when the DAO/treasury operator key is custodied in a Gnosis Safe rather than a bare `DEXE_PRIVATE_KEY`. See [`docs/SAFE.md`](./SAFE.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_safe_info` | Read-only: live Safe `nonce` / `threshold` / `owners` / singleton version, whether the configured signer is an owner, and which Safe Transaction Service endpoint this chain resolves to. | `DEXE_RPC_URL` |
| `dexe_safe_propose_tx` | Takes a `TxPayload` (`to`/`value`/`data`/`operation`), reads the Safe's next `nonce()` (unless supplied), computes the EIP-712 `safeTxHash`, signs it with `DEXE_PRIVATE_KEY` (which must be a Safe owner), and assembles the create-multisig-transaction body. **`dryRun` defaults to `true`** — returns the signed payload + resolved POST target without sending; `dryRun=false` POSTs to the service. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL`; `DEXE_SAFE_API_KEY` for api.safe.global; `DEXE_SAFE_TX_SERVICE_URL` for chains without a hosted service |

---

## 15. Simulator

Source: `src/tools/simulate.ts`. `eth_call`-based preflight gate. Catches reverts before broadcast without spending real money. See [`docs/SIMULATOR.md`](./SIMULATOR.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_sim_calldata` | Generic preflight. Returns `{ success, revertReason?, returnData?, gasEstimate? }`. Decodes `Error(string)` (selector `0x08c379a0`) and `Panic(uint256)` revert payloads. Optional `from`/`value`/`blockTag` overrides. | `DEXE_RPC_URL` |
| `dexe_sim_proposal` | Preflight `GovPool.execute(proposalId)`. Reads proposal state first; refuses to sim unless `SucceededFor` (idx 4). Surfaces `proposalState` + `proposalStateIndex`. | `DEXE_RPC_URL` |
| `dexe_sim_buy` | Preflight `TokenSaleProposal.buy(...)`. Native path uses `value=amount`. ERC20 path also reads current allowance and reports `willNeedApprove: true` when allowance < amount. | `DEXE_RPC_URL` |

---

## 16. Multi-DAO inbox + forecast

Sources: `src/tools/inbox.ts`, `src/tools/predict.ts`. Read-side "what needs my attention" tools. See [`docs/INBOX.md`](./INBOX.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_user_inbox` | Multi-DAO attention aggregator. Per DAO surfaces `unvotedProposal` (Voting state + zero personal vote), `claimableRewards`, `lockedDeposit`. Mainnet auto-discovers DAOs via pools subgraph; testnet requires explicit `daos[]`. | `DEXE_RPC_URL`, `DEXE_SUBGRAPH_POOLS_URL` for auto-discovery |
| `dexe_proposal_forecast` | Predictive pass-rate. Reads latest 10 proposals + final states, computes historical pass-rate + average For-vote weight, returns `{ quorum, historicalPassRate, risks, recommendation }`. Mainnet only by default; pass `forceRpcOnly: true` for testnet. | `DEXE_RPC_URL`, `DEXE_SUBGRAPH_POOLS_URL` |

---

## 17. External Governor DAOs (`dexe_gov_*`)

Sources: `src/governor/tools/read.ts`, `src/governor/tools/build.ts`,
`src/governor/tools/simulate.ts`. Configs: `src/governor/configs/*.json`.
Family-branched internally — callers see normalized OZ-shaped output regardless
of whether the target is OZ v4+ or Compound Bravo. See [`docs/GOVERNOR.md`](./GOVERNOR.md).

Tier-1 fixtures shipped: **uniswap**, **compound**, **optimism**.
No DeXe Protocol contract is required on the target chain.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_gov_list_governors` | Lists every DAO config under `src/governor/configs/`. Pure read, no RPC. | — |
| `dexe_gov_get_proposal` | Returns `{state, snapshotBlock, deadlineBlock, votes: {against, for, abstain}}` for a proposal. Bravo paths flatten `proposals(uint256)`; OZ paths use `proposalSnapshot`/`proposalDeadline`/`proposalVotes`. | RPC for the DAO's chain |
| `dexe_gov_get_voting_power` | `IVotes.getPastVotes` (ERC20Votes) or `getPriorVotes` (ERC20VotesComp). Falls back to `getVotes`/`getCurrentVotes` when block omitted. | RPC for the DAO's chain |
| `dexe_gov_get_quorum` | `quorum(blockNumber)` on OZ; `quorumVotes()` on Bravo. Returns the actual method invoked. | RPC for the DAO's chain |
| `dexe_gov_get_proposal_threshold` | `proposalThreshold()`. | RPC for the DAO's chain |
| `dexe_gov_build_propose` | Encodes Governor.propose. OZ: `(targets, values, calldatas, description)`. Bravo: `(targets, values, signatures, calldatas, description)`. Validates length parity + bytes/address shapes. | — |
| `dexe_gov_build_vote_cast` | Encodes `castVote` or `castVoteWithReason`. Identical signature both families. support: 0=Against, 1=For, 2=Abstain. | — |
| `dexe_gov_build_queue` | OZ: `(targets, values, calldatas, descriptionHash)` — accepts raw description (auto-hashed) or pre-computed hash. Bravo: `queue(proposalId)`. | — |
| `dexe_gov_build_execute` | Same shape split as queue. Optional `msgValue`. | — |
| `dexe_gov_build_delegate` | `IVotes.delegate(delegatee)` on the voting token (NOT the Governor). Zero address allowed as self-revoke. | — |
| `dexe_gov_simulate_proposal` | Builds Governor.execute() calldata and runs `eth_call` against the configured RPC. Decodes `Error(string)` and `Panic(uint256)` revert reasons. Single-block dry-run only; for fork-and-time-warp, run against a hardhat/anvil fork. | RPC for the DAO's chain |
| `dexe_gov_simulate_vote_impact` | Projects proposal outcome after a hypothetical vote — `{currentTallies, projectedTallies, quorumMet, willPass}`. Quorum semantics branch by family (Bravo counts forVotes only). | RPC for the DAO's chain |
| `dexe_gov_get_state` | Shorthand for the state field of `dexe_gov_get_proposal` — single eth_call returning `{index, name}`. | RPC for the DAO's chain |
| `dexe_gov_has_voted` | Whether `account` has voted on `proposalId`. Family-aware: OZ reads `hasVoted(proposalId, account)`; Bravo (Uniswap/Compound) has no `hasVoted` and reads `getReceipt(proposalId, voter).hasVoted`. Output includes the `method` actually used. | RPC for the DAO's chain |
| `dexe_gov_build_cancel` | Encode Governor.cancel. OZ 4-arg + descriptionHash; Bravo `cancel(proposalId)`. | — |
| `dexe_gov_decode_calldata` | Decode any Governor write calldata back to `{method, args}` against the family-aware ABI. Useful for wallet-side preview of `dexe_gov_build_*` output. | — |
| `dexe_gov_hash_description` | `keccak256(toUtf8Bytes(description))` — pre-compute the descriptionHash OZ queue/execute/cancel/hashProposal expect. | — |
| `dexe_gov_hash_proposal` | OZ-only `Governor.hashProposal()` — preview the deterministic on-chain proposalId before submission. Errors clearly when called on Bravo. | RPC for the DAO's chain (OZ DAOs only) |

Parity vs Tally — `tests/governor/parity.test.ts` compares `state()` for 30
sampled proposals (10 per Tier-1 DAO) against Tally's GraphQL status. Live
mode gated by `TALLY_API_KEY` + chain RPCs.

---

## 18. WalletConnect

Source: `src/tools/walletconnectStatus.ts` + `src/lib/walletconnect.ts`. A fourth signer mode (`readonly` | `eoa` | `safe` | `walletconnect`): broadcast convenience **without a hot key** — every tx is approved on the operator's phone wallet, key never leaves the device. When active, `dexe_tx_send` forwards the tx over the WalletConnect v2 relay; the wallet signs **and broadcasts**. Only `dexe_tx_send`/`dexe_tx_status` route through WC — composite flows still require a hot key. See [`docs/WALLETCONNECT.md`](./WALLETCONNECT.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_wc_status` | Report the resolved WalletConnect config plus live session state (`connected`, `connecting`, `account`, `chainId`, `topic`, `peerName`, `expiry`, `lastError`) and whether `walletconnect` is the active `signerMode`. Read-only. WalletConnect activates only when `DEXE_WALLETCONNECT_PROJECT_ID` is set AND no `DEXE_PRIVATE_KEY` is present. | `DEXE_WALLETCONNECT_PROJECT_ID` (for active mode) |
| `dexe_wc_connect` | Start a session and render a scannable QR (ASCII + PNG) for the phone wallet (MetaMask / Trust / Rainbow) — the recommended signer, no key on disk. Non-blocking — approval completes in the background; poll `dexe_wc_status` until `connected`. Pairs even when a hot key is set (the key keeps precedence until unset). | `DEXE_WALLETCONNECT_PROJECT_ID` |
| `dexe_wc_disconnect` | Tear down the active session. Safe no-op when not connected. | — |

---

## 19. Diagnostics

Source: `src/tools/doctor.ts` + `src/diag/checks.ts`. Pure reads. First stop when an env-related failure shows up. Also runnable as a CLI: `npx dexe-mcp doctor` (exit 0 pass, 1 warn-only, 2 any fail).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_doctor` | Diagnose env setup end-to-end. Walks every recognized `DEXE_*` var, runs `eth_chainId` per configured RPC, `testAuthentication` on Pinata, DNS lookup on the IPFS gateway, `{ __typename }` introspection on each configured subgraph, then validates signer broadcast-guard config and chain consistency. Returns pass/warn/fail per check + paste-ready remediation hints. Network checks have a 3s hard timeout that downgrades to `warn` so offline laptops don't see all-red. | — |

---

## Notes

- **Calldata model.** Default mode for every builder is "return calldata, you sign it." The MCP server never holds a key unless `DEXE_PRIVATE_KEY` is set; only the four tools in section 11 use it.
- **Composing wrappers.** Wrappers (`dexe_proposal_build_*`) return `{ipfsMetadata, action(s), hint}`. Upload metadata via `dexe_ipfs_upload_proposal_metadata` to get a CID, then call `dexe_proposal_build_external` with that CID + the actions.
- **Settings auto-expand.** `dexe_dao_build_deploy` accepts 1 setting and auto-expands to all 5 slots (default / internal / validators / distributionProposal / tokenSale). Override individually if you need non-default behavior on any.
- **Frontend parity.** All builders are cross-checked against `C:/dev/investing-dashboard` (the DeXe frontend). When in doubt, that is the source of truth — see `feedback_frontend_source_of_truth.md` in user memory.
