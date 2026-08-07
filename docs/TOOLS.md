# dexe-mcp tool catalog

`dexe-mcp` is an MCP (Model Context Protocol) server that exposes DeXe Protocol DAO operations and Solidity-dev tooling to AI agents — plus a generic `dexe_gov_*` surface for external OpenZeppelin Governor + Compound Bravo DAOs (Uniswap, Compound, Optimism). Total tools: **168** across **19** groups. Call **`dexe_context`** first each session — it returns the signer, active chain, env readiness, the toolset profiles that are off (and what each unlocks), and the DAOs/proposals recorded in prior sessions.

> **Not every tool below is loaded in your session.** A default session loads the **`core`** profile only — 44 of the 168. Each section names the profile it needs; `dexe_context` reports the active set. Calling a tool from a profile you have not loaded fails as "unknown tool", so check before you plan a flow around one.

The server is **calldata-first**: most tools return a `TxPayload` (`{to, data, value, chainId, description}`) that the user's wallet signs and broadcasts. A subset (`dexe_dao_report`, `dexe_dao_info`, `dexe_proposal_state`, all `dexe_read_*`, `dexe_graph_query` / `dexe_graph_schema`, all `dexe_ipfs_*`, `dexe_decode_*`, all `dexe_get_*` / `dexe_list_*`) are pure reads. Four composite tools (`dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`) opt into auto-signing when `DEXE_PRIVATE_KEY` is configured.

Discover tools at runtime via the MCP client's `tools/list`, or call `dexe_proposal_catalog` for the live list of supported proposal types and which builder maps to each. `dexe_proposal_catalog` is in `core`, so the full type list stays discoverable even when the per-type builders are not loaded.

## Toolset profiles

Registering all 168 tools costs ~261 KB of `tools/list` per session. **`DEXE_TOOLSETS`** (comma list) gates which profiles load.

**The default is `core` alone as of v0.31.0** (it was `core,proposals` from v0.13.0). Two things changed:

- The **zero-config reporting reads moved into `core`** — `dexe_dao_report`, `dexe_graph_query`, `dexe_read_dao_list/dao_members/dao_stats/token_holders/delegation_map`, `dexe_ipfs_fetch`. Before 0.31.0 these needed `DEXE_TOOLSETS=read`, so a fresh install could not actually build the DAO report the docs advertised.
- The ~30 single-purpose **`dexe_proposal_build_*` builders left the default** to pay for it. `dexe_proposal_create` (in `core`) covers every on-chain catalog type from `proposalType` + `params`, and `dexe_proposal_catalog` still enumerates all 33. **`DEXE_TOOLSETS=core,proposals` restores the pre-0.31 default exactly** — nothing was removed, only ungated by default.

| Profile | Tools | What it covers |
|---------|------:|----------------|
| `core` (default) | 44 | Everyday flow **plus the zero-config report surface**: `dexe_context` (call first), `dexe_guide`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, all 5 `dexe_otc_*`, `dexe_tx_send/status`, `dexe_wc_*`, key vote builders (deposit/withdraw/vote/execute/erc20_approve) + `dexe_vote_user_power`, IPFS upload trio + avatar + `dexe_ipfs_fetch`, `dexe_read_treasury/settings`, `dexe_proposal_state/list/catalog`, `dexe_dao_info/registry_lookup/predict_addresses`, `dexe_doctor`, `dexe_get_config`, and the reporting reads `dexe_dao_report`, `dexe_graph_query`, `dexe_read_dao_list/dao_members/dao_stats/token_holders/delegation_map`. |
| `proposals` | 42 | Every `dexe_proposal_build_*` builder (33 types), the offchain + backend-auth surface, and proposal/DAO IPFS writes. **Opt-in since v0.31.0.** |
| `read` | 36 | All `dexe_read_*` (chain + subgraph + backend balances/holders/stats/NFTs), `dexe_dao_report`, `dexe_graph_query`, `dexe_graph_schema`, `dexe_proposal_voters`, `dexe_user_inbox`, `dexe_proposal_forecast`, `dexe_proposal_risk_assess`, IPFS reads. Superset of `core`'s reads — the long-tail ones a report does not need. |
| `vote` | 30 | Every direct `dexe_vote_build_*` builder (delegate, staking, NFT multiplier, claims, privacy policy, …) + `dexe_vote_get_votes` + the agent keyring (`dexe_agents_list`, `dexe_agents_fund`). |
| `agents` | 3 | **New in v0.32.0.** The multi-persona fleet surface: `dexe_agents_list` (keyring roster + balances), `dexe_agents_fund` (preview-then-confirm top-ups inside the enforced caps), `dexe_agents_ledger` (per-persona action history + spend). Set `DEXE_TOOLSETS=core,agents`; add `vote` (`core,agents,vote`) for the raw delegation/validator builders a fleet run needs. Read [AGENTS.md](./AGENTS.md) first — these tools drive hot keys. |
| `governor` | 18 | The external `dexe_gov_*` OpenZeppelin/Bravo Governor surface. |
| `dev` | 23 | `dexe_compile/test/coverage/lint`, introspection (`dexe_get_*`, `dexe_list_*`, `dexe_find_selector`), `dexe_decode_*`, `dexe_read_gov_state`, simulator, merkle, Safe, and the low-level `dexe_dao_build_deploy`. |
| `full` | 168 | Everything (pre-v0.13.0 behavior). |

Sets union, and profiles overlap by design (a tool in both `core` and `read` is the same tool). An unrecognized name is **dropped** with a stderr warning and the recognized ones still apply — a typo never escalates to `full`; if nothing recognizable is left, the default applies. The union of the seven named sets equals all 168 tools, so every tool is reachable under some profile.

Measured `tools/list` sizes on this tree: **full 267,347 B / ~261 KB (168 tools)** · **default `core` 86,989 B / ~85 KB (44 tools, −67.5%)** · **`core,agents` 92,123 B / ~90 KB (47 tools, −65.5%)** · **`core,proposals` 154,345 B / ~151 KB (83 tools, −42.3%)**. `dexe_doctor` and `dexe_context` both report the active profile.

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

**Profile: `dev`** — not in a default session; set `DEXE_TOOLSETS=core,dev`.

Source: `src/tools/build.ts`. All four operate on a DeXe-Protocol Hardhat workspace — auto-cloned (shallow) on first use, or set `DEXE_PROTOCOL_PATH` to an existing checkout.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_compile` | Runs `npm run compile`, parses solc diagnostics, invalidates artifact cache. Must run once per session before introspection. | `DEXE_PROTOCOL_PATH` |
| `dexe_test` | Runs `npx hardhat test`. Optional mocha `--grep` or specific test file. Captures up to 20 failure bodies. | `DEXE_PROTOCOL_PATH` |
| `dexe_coverage` | Runs `npm run coverage` and reads `coverage/coverage-summary.json`. Slow — minutes. | `DEXE_PROTOCOL_PATH` |
| `dexe_lint` | `npm run lint-fix` (when `fix: true`) or `npm run lint-check`. Chains solhint + eslint + jsonlint. | `DEXE_PROTOCOL_PATH` |

---

## 2. Contract introspection

**Profile: `dev`** — not in a default session; set `DEXE_TOOLSETS=core,dev`.

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

**Profiles: `core` + `read`.** A default session gets the zero-config reporting subset — `dexe_dao_report`, `dexe_graph_query`, `dexe_read_dao_list/dao_members/dao_stats/token_holders/delegation_map`, `dexe_read_treasury/settings`, `dexe_dao_info/registry_lookup/predict_addresses`, `dexe_proposal_state/list`, `dexe_vote_user_power`, `dexe_otc_list_sales_for_dao`. Everything else in this section (incl. `dexe_graph_schema`, `dexe_proposal_voters`, `dexe_read_validator_list`, `dexe_read_user_activity`, `dexe_read_dao_experts`, `dexe_read_protocol_stats`, `dexe_read_nfts`, `dexe_read_gov_state`) needs `DEXE_TOOLSETS=core,read` (`dexe_read_gov_state`: `core,dev`).

Sources: `src/tools/dao.ts`, `src/tools/gov.ts`, `src/tools/proposal.ts`, `src/tools/vote.ts`, `src/tools/read.ts`, `src/tools/report.ts`, `src/tools/risk.ts`, `src/tools/subgraph.ts`. All on-chain reads need `DEXE_RPC_URL`.

**Subgraph reads are chain-explicit (0.30.2).** One endpoint indexes one chain, so every subgraph-backed tool below takes `chainId` (default: the MCP's default chain) and returns **`indexedChainId`** in `structuredContent` — the chain the rows actually came from. Endpoint resolution is per *(kind, chain)*: `DEXE_SUBGRAPH_<KIND>_URL_<chainId>`, else the unsuffixed `DEXE_SUBGRAPH_<KIND>_URL` for the chain named by `DEXE_SUBGRAPH_CHAIN_ID` (default 56), else the baked chain-56 default. **A chain with no endpoint returns an error**, naming the var to set plus the subgraph-free alternatives (`dexe_read_gov_state`, `dexe_proposal_list`, `dexe_read_multicall`) — it never answers from another chain's index. The "Required env" column below names the chain-56 var; append `_<chainId>` for any other chain. See [ENVIRONMENT.md § 8](ENVIRONMENT.md#8-subgraph-configuration).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_dao_report` | **One call → the whole DAO.** Eleven independent sections (`identity`, `settings`, `treasury`, `membership`, `delegation`, `experts`, `validators`, `proposals`, `turnout`, `activity`, `deadlines`) composed from on-chain multicalls plus one batched query per subgraph — so per-proposal turnout costs no extra round-trips. `since` (ISO-8601, Unix seconds, `block:<n>`, or `"last"`) returns only what changed: new proposals, proposals that MOVED STATE, members joined, delegation shifts, treasury deltas. Each run persists a small per-DAO snapshot (`reports.json`, beside `state.json`) so `since:"last"` has a baseline — **the first run must omit `since`, or it errors with no baseline**. `user` adds that wallet's unvoted proposals + claimable rewards to `deadlines`. Sections degrade independently: one that cannot render comes back `available:false` with a `reason` and a `followUp` naming the tool to call instead, and is listed in `unavailable[]` — never a silent omission. Typed `outputSchema`. Narrow with `sections`; `proposalLimit` (default 30) / `memberLimit` (default 50) bound the window. Full guide: [REPORTING.md](./REPORTING.md). | (none — public RPC + subgraph defaults; set `DEXE_RPC_URL` / `DEXE_SUBGRAPH_*_URL` for reliability or non-default chains) |
| `dexe_dao_info` | Helpers + NFT contracts + descriptionURL + validator count for a GovPool. One multicall. | `DEXE_RPC_URL` |
| `dexe_dao_predict_addresses` | `PoolFactory.predictGovAddresses(deployer, poolName)` → 6 CREATE2 addresses. Useful for pre-deploy wiring. | `DEXE_RPC_URL` |
| `dexe_dao_registry_lookup` | `PoolRegistry.isGovPool(address)` — true if address is a registered DeXe GovPool. | `DEXE_RPC_URL` |
| `dexe_proposal_state` | `getProposalState` + `getProposalRequiredQuorum` in one multicall. Returns named state. | `DEXE_RPC_URL` |
| `dexe_proposal_list` | `GovPool.getProposals(offset, limit)` → compact summaries. | `DEXE_RPC_URL` |
| `dexe_proposal_voters` | Voter list for one proposal from the **pools** subgraph (`proposalInteractions`), paginated. Returns `{govPool, proposalId, indexedChainId, voters[]}`. | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_proposal_risk_assess` | Treasury-safety risk readout for a proposal (or hypothetical actions): quorum %, safe floor, treasury at risk, indicative share of supply required to meet quorum, verdict (SAFE/CAUTION/DANGER). | `DEXE_RPC_URL` |
| `dexe_read_gov_state` | Reads `getHelperContracts()` + `getNftContracts()`, returns resolved helper + NFT addresses. | `DEXE_RPC_URL` |
| `dexe_vote_user_power` | `tokenBalance` + `nftBalance` on GovUserKeeper for every VoteType (Personal/Micropool/Delegated/Treasury). | `DEXE_RPC_URL` |
| `dexe_vote_get_votes` | `GovPool.getUserVotes(proposalId, voter, voteType)` → VoteInfoView. Defaults to PersonalVote. | `DEXE_RPC_URL` |
| `dexe_read_multicall` | Arbitrary batched view-calls via Multicall3. Each call supplies its own ABI fragment. | `DEXE_RPC_URL` |
| `dexe_read_treasury` | Wallet/DAO balances. Backend-first (auto-discovers every token + USD prices + total via `api-proxy-cache/<chain>/wallet-balances`, same source as app.dexe.io); RPC multicall fallback on testnet 97, explicit `tokens`, or unset backend. | `DEXE_BACKEND_API_URL` (backend) · `DEXE_RPC_URL` (fallback) |
| `dexe_read_token_holders` | Holders + raw balances of any ERC20 via `token-holders-balances/<token>`, sorted desc. Backend-only (mainnets). | `DEXE_BACKEND_API_URL` |
| `dexe_read_dao_stats` | DAO TVL + member/proposal/delegation time series via `tracker/<chain>/pools/gov/<dao>/stats/<period>`. `period` is a human duration ('24 hours', '7 days', '1 months'); long series are evenly downsampled to `maxPoints` (default 30). Backend-only. | `DEXE_BACKEND_API_URL` |
| `dexe_read_nfts` | NFTs held by any address via `nfts-by-wallet/<addr>` (Moralis), optional contract filter. Backend-only. | `DEXE_BACKEND_API_URL` |
| `dexe_read_validators` | `validatorsCount()` + optional `isValidator(candidate)` on GovValidators, plus the validators' monthly credit lines (`GovPool.getCreditInfo`) — an internal monthly_withdraw against an unfunded line reverts. | `DEXE_RPC_URL` |
| `dexe_read_settings` | `GovSettings.getDefaultSettings()` + `getInternalSettings()`. | `DEXE_RPC_URL` |
| `dexe_read_expert_status` | `GovPool.getExpertStatus(user)` + optional BABT balance check. | `DEXE_RPC_URL` |
| `dexe_read_token_sale_tiers` | `latestTierId()` + `getTierViews(offset, limit)` from a TokenSaleProposal. | `DEXE_RPC_URL` |
| `dexe_read_token_sale_user` | `getUserViews(user, tierIds)` — per-tier purchase, claimable, vesting info. | `DEXE_RPC_URL` |
| `dexe_read_distribution_status` | `isClaimed(proposalId, voter)` + `getPotentialReward` from DistributionProposal. | `DEXE_RPC_URL` |
| `dexe_read_staking_info` | `stakingsCount()` + `getActiveStakings()` + optional `getUserInfo(user)`. | `DEXE_RPC_URL` |
| `dexe_read_privacy_policy_status` | `UserRegistry.documentHash()` + `agreed(user)`. | `DEXE_RPC_URL` |
| `dexe_read_dao_list` | Paginated DAO discovery via pools subgraph. Search by name, ordered by voter count. → `{query, offset, limit, indexedChainId, daoPools[]}` | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_dao_members` | Paginated members with voting power, delegation counts, rewards, expert status. → `{govPool, offset, limit, indexedChainId, members[]}` | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_dao_experts` | Paginated local experts (DAO-specific expert NFT holders) with delegation info. → `{govPool, offset, limit, indexedChainId, experts[]}` | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_read_validator_list` | Paginated validators ordered by balance descending. → `{govPool, offset, limit, indexedChainId, validators[]}` | `DEXE_SUBGRAPH_VALIDATORS_URL` |
| `dexe_read_user_activity` | Paginated tx history per user — proposals/votes/delegations/claims by timestamp desc. → `{user, offset, limit, indexedChainId, transactions[]}` | `DEXE_SUBGRAPH_INTERACTIONS_URL` |
| `dexe_read_delegation_map` | Outgoing or incoming delegation pairs for a user (accepts wallet addresses or VoterInPool composite ids). → `{addresses, direction, offset, limit, indexedChainId, delegations[]}` | `DEXE_SUBGRAPH_POOLS_URL` |
| `dexe_graph_query` | Free-form read-only GraphQL against the pools / interactions / validators subgraphs. Entity reference: [GRAPH.md](GRAPH.md) (served in-band as the MCP resource `dexe://graph-schema`); live names via `dexe_graph_schema`. Bound results with `first:`; oversized responses rejected. `chainId` picks the chain for the chosen `subgraph`. → `{subgraph, indexedChainId, data}` | `DEXE_SUBGRAPH_*_URL` (of the requested `subgraph`) |
| `dexe_graph_schema` | Live GraphQL introspection of one subgraph — the recovery path when `dexe_graph_query` answers `Type 'X' has no field 'Y'`, and the way to stop guessing names. Omit `entity` for the **root query field map**: the query field is not derivable from the entity (`DaoPool` → `daoPools`, `ProposalSettings` → `proposalSettings_collection`, `DPContract` → `dpcontracts`). Pass `entity` (e.g. `'Proposal'`) for that type's fields with their GraphQL types; an unknown name returns ranked "did you mean" candidates instead of a dead end. Filter/sort vocabularies are types too — ask for `'<Entity>_filter'` (every valid `where:` key) or `'<Entity>_orderBy'`. → `{subgraph, indexedChainId, entity, kind, fields, enumValues, rootFields}`. Static copy that may lag the deployed schema: [GRAPH.md](GRAPH.md) / `dexe://graph-schema`. | `DEXE_SUBGRAPH_*_URL` (of the requested `subgraph`) |
| `dexe_read_protocol_stats` | Protocol-wide aggregates (app.dexe.io landing numbers): total TVL across all DAOs on the selected chains, total proposals, DAO count, voting-locked value, TVL time series (downsampled), optional top-N DAOs by TVL. Backend-only. | `DEXE_BACKEND_API_URL` |
| `dexe_otc_list_sales_for_dao` | Reads `latestTierId()` + `getTierViews(0, latestTierId)` on a DAO's TokenSaleProposal helper. Returns tiers with `totalSold`, `upcoming`/`active`/`ended`/`off` status (block timestamp + on-chain `isOff`), and both raw + `saleStartTimeUTC`/`saleEndTimeUTC` human-readable UTC times. Works chain 56 + 97, no subgraph needed. Pass `tokenSaleProposal` explicitly until per-DAO helper discovery lands. | `DEXE_RPC_URL` |

---

## 4. IPFS

**Profiles: `core` + `proposals` + `read`.** Default session: `dexe_ipfs_upload_file`, `_upload_avatar`, `_upload_proposal_metadata`, `dexe_dao_generate_avatar`, `dexe_ipfs_fetch`. The DAO-metadata writes (`_upload_dao_metadata`, `_update_dao_metadata`) need `DEXE_TOOLSETS=core,proposals`; `_cid_info` / `_cid_for_json` need `core,read`.

Source: `src/tools/ipfs.ts`. Pinata-backed; reads use the configured gateway with optional fallback chain.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_ipfs_upload_proposal_metadata` | Pins `{proposalName, proposalDescription, ...}` (proposal-shaped) to IPFS via Pinata. Returns CID for `descriptionURL`. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_dao_metadata` | Nested upload chain: description content → IPFS, outer metadata → IPFS. Returns outer CID for `deployGovPool.descriptionURL`. Auto-normalizes input `avatarCID` to v1 base32 and best-effort sniffs the avatar bytes (confirmed SVG/HTML hard-blocks). | `DEXE_PINATA_JWT` |
| `dexe_ipfs_update_dao_metadata` | Fetches current DAO metadata, applies partial overrides (avatar/name/website/socialLinks/etc.), re-uploads. Returns new outer CID for `dexe_proposal_build_modify_dao_profile`. Unspecified fields preserved. New `avatarCID` overrides are byte-sniffed (raster only). | `DEXE_PINATA_JWT`, `DEXE_IPFS_GATEWAY` |
| `dexe_ipfs_upload_file` | Pins a file — prefer `filePath` (local path, read server-side, max 25 MB) over `base64`. Returns CID **v1 base32** (subdomain-gateway compatible) + the original v0. Image filenames normalized to `.jpeg`; on that path bytes are magic-byte-checked (raster only; `normalizeImageExt:false` opts out for generic image attachments). | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_avatar` | One-shot avatar upload: returns the `{avatarCID, avatarFileName, avatarUrl}` triple ready for `dexe_ipfs_upload_dao_metadata` or `*_update_dao_metadata`. Prefer `filePath` (local image path — the server reads it itself, max 10 MB) over `base64`. Magic-byte-validated: only real rasters (JPEG/PNG/WebP/GIF) pass; SVG/HTML is rejected. | `DEXE_PINATA_JWT` |
| `dexe_dao_generate_avatar` | Generates a deterministic JPEG identicon (pixel initials over hash-coloured gradient — no external provider) and pins it. Same `{avatarCID, avatarFileName, avatarUrl}` shape. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_fetch` | Fetches CID via `DEXE_IPFS_GATEWAY` (recommended dedicated gateway). Public fallbacks opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK`. | `DEXE_IPFS_GATEWAY` |
| `dexe_ipfs_cid_info` | Parses CIDv0/v1, reports codec + multihash, converts between versions, emits gateway URLs. | (none) |
| `dexe_ipfs_cid_for_json` | Computes deterministic CIDv1 (json codec, sha-256) locally — no network. Useful for dry-run flows. | (none) |

---

## 5. DAO deploy

**Profiles: `core` (`dexe_dao_create`) + `dev` (`dexe_dao_build_deploy`).** The low-level encoder needs `DEXE_TOOLSETS=core,dev`; the composite is default-visible.

Source: `src/tools/daoDeploy.ts`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_dao_create` | **Composite (auto-signs):** one-call DAO deploy — uploads DAO profile metadata to IPFS (avatar via `avatarPath`, a local image path pinned + validated server-side, or `avatarCID`), builds `deployGovPool` (reusing `dexe_dao_build_deploy` — inherits the round-trip self-check, name-collision pre-check, and validator/CUSTOM guards), pre-flights the deploy reverts (cap≥minted>0, LINEAR initData, non-zero userKeeper asset, treasury remainder), **simulates the exact calldata via eth_call from the deployer right before signing** (v0.24: a provable revert is refused with a classified cause + fix before gas is spent; RPC outage → warning only), then broadcasts or returns the payload. Success includes `readiness.govPoolLive` + `nextSteps` (deposit-first first-proposal guidance). SIMPLE mode also takes `minVotesTokens` (min balance to vote + create, whole tokens, default 1) and `earlyCompletion` (default true). Validate on BSC testnet (chain 97). | `DEXE_PINATA_JWT`, `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` (for auto-broadcast) |
| `dexe_dao_build_deploy` | Builds `PoolFactory.deployGovPool(GovPoolDeployParams)` calldata. Mirrors the frontend wizard at app.dexe.network/create-dao. Auto-expands proposal settings (1 → 5: default/internal/validators/distributionProposal/tokenSale). v0.24: round-trip calldata self-check + pre-sign eth_call simulation — refuses to emit a provably-reverting payload (cause + fix instead); `skipSimulation: true` is the deliberate bypass. | `DEXE_RPC_URL` |

---

## 6. Proposal catalog and primitives

**Profiles: `core` (`dexe_proposal_catalog`) + `proposals` (the four primitives).** The catalog stays default-visible so every proposal type is discoverable; the primitives need `DEXE_TOOLSETS=core,proposals`.

Source: `src/tools/proposalBuild.ts`. The catalog tool is your runtime registry of proposal types; the four `*_build_external|internal|custom_abi|offchain` tools are raw primitives every wrapper composes through.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_catalog` | Full catalog of proposal types: target contract/endpoint, IPFS metadata requirement, gating, and which MCP wrapper builds it. | (none) |
| `dexe_proposal_build_external` | Primitive: builds `GovPool.createProposal(descriptionURL, actionsOnFor, actionsOnAgainst)` calldata. | (none) |
| `dexe_proposal_build_internal` | Primitive: builds `GovValidators.createInternalProposal`. `proposalType` 0=ChangeSettings, 1=ChangeBalances, 2=MonthlyWithdraw, 3=OffchainProposal (contract enum order — 0/1 read the reverse of the intuitive guess). | (none) |
| `dexe_proposal_build_custom_abi` | Encodes a single `ProposalAction` from a user-supplied function signature + args. Drop result into `actionsOnFor`. | (none) |
| `dexe_proposal_build_offchain` | Primitive: returns the ready HTTP request for the off-chain proposal backend. No wallet needed. | `DEXE_BACKEND_API_URL` |

---

## 7. External proposal wrappers

**Profile: `proposals`** — **not in a default session since v0.31.0**; set `DEXE_TOOLSETS=core,proposals`. Without it, use `dexe_proposal_create` (in `core`) with the matching `proposalType` + `params` — it builds the same actions server-side and broadcasts them. Reach for these builders when you want the raw calldata: inspecting actions before creating, hand-assembling a multi-action proposal, or composing through `dexe_proposal_build_external`.

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

**Profile: `proposals`** — not in a default session; set `DEXE_TOOLSETS=core,proposals`. `dexe_proposal_create` covers these four types too (it auto-routes internal types to `GovValidators.createInternalProposal`).

Source: `src/tools/proposalBuildInternal.ts`. Each returns the `data` bytes you feed to `dexe_proposal_build_internal`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_build_change_validator_balances` | Internal type 0: `changeBalances(balances, users)`. Balance=0 removes a validator. | (none) |
| `dexe_proposal_build_change_validator_settings` | Internal type 1: `changeSettings(duration, executionDelay, quorum)`. Seconds + percent-as-BN. | (none) |
| `dexe_proposal_build_monthly_withdraw` | Internal type 2: `monthlyWithdraw(tokens, amounts, destination)`. Parallel arrays; tokens != zero. | (none) |
| `dexe_proposal_build_offchain_internal_proposal` | Internal type 3: `data` MUST be empty (`0x`). DescriptionURL carries the payload. | (none) |

---

## 9. Off-chain wrappers and auth

**Profile: `proposals`** — not in a default session; set `DEXE_TOOLSETS=core,proposals`. The off-chain types are the one family `dexe_proposal_create` deliberately does **not** execute (they are backend API calls, not transactions) — it signposts here instead, so this profile is required for off-chain voting and for `dexe_auth_login`.

Source: `src/tools/proposalBuildOffchain.ts`. All return ready HTTP request objects (method/url/headers/body) — your client sends them. The DeXe backend uses Bearer-token auth via signed nonce.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_auth_request_nonce` | Step 1/2: `POST /integrations/nonce-auth-svc/nonce` — returns a message to sign. | `DEXE_BACKEND_API_URL` |
| `dexe_auth_login_request` | Step 2/2: `POST /integrations/nonce-auth-svc/login` — exchange signed nonce for `{access_token, refresh_token}`. | `DEXE_BACKEND_API_URL` |
| `dexe_auth_login` | **One call**: fetches the nonce, signs it with the configured signer (DEXE_PRIVATE_KEY or a connected WalletConnect session), logs in, and returns the Bearer `accessToken` — the server signs internally so an agent never handles the key. Falls back to the manual 2-step tools when no signer is set. | `DEXE_BACKEND_API_URL` (+ signer) |
| `dexe_proposal_build_offchain_single_option` | `POST /integrations/voting/proposals` with `voting_type='one_of'`. Pick exactly one of N. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_multi_option` | Same endpoint, `voting_type='multiple_of'`. Pick any subset. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_for_against` | **Not creatable** — the DeXe backend supports only single-option and multi-option off-chain voting; returns a not-supported error pointing to `offchain_single_option` with `["For","Against"]`. | `DEXE_BACKEND_API_URL` |
| `dexe_proposal_build_offchain_settings` | `attributes.type='edit_proposal_type'` (DAO-wide settings) or `'create_proposal_type'` (reusable template). | `DEXE_BACKEND_API_URL` |
| `dexe_offchain_build_vote` | `POST /integrations/voting/vote`. `options` is array of selected option strings. | `DEXE_BACKEND_API_URL` |
| `dexe_offchain_build_cancel_vote` | `DELETE /integrations/voting/vote/{proposalId}/{voterAddress}`. No body. | `DEXE_BACKEND_API_URL` |

---

## 10. Vote, stake, delegate, execute, claim builders

**Profiles: `core` + `vote`.** A default session gets the five it needs to vote a proposal through — `dexe_vote_build_erc20_approve`, `_deposit`, `_withdraw`, `_vote`, `_execute` — plus `dexe_vote_user_power`. Everything else here (delegation, staking, NFT multiplier, claims, token-sale, privacy policy, `dexe_vote_build_multicall`, `dexe_vote_get_votes`) needs `DEXE_TOOLSETS=core,vote`.

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
| `dexe_vote_build_execute` | `GovPool.execute(proposalId)`; `scope:'internal'` + `govValidators` builds `GovValidators.executeInternalProposal(proposalId)` for internal validator proposals. | (none) |
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

**Profile: `core`** (default-visible), except the three agent-keyring tools — `dexe_agents_list`, `dexe_agents_fund`, `dexe_agents_ledger` — which need the **`agents`** profile: `DEXE_TOOLSETS=core,agents` (add `vote` for the raw delegation/validator builders a fleet run needs). `dexe_agents_list` / `dexe_agents_fund` also remain in `vote`, so an existing `core,vote` session keeps exactly the surface it had; `dexe_agents_ledger` is new in v0.32.0 and reachable only via `agents` (or `full`).

Sources: `src/tools/flow.ts`, `src/tools/txSend.ts`, `src/tools/getConfig.ts`, `src/tools/agents.ts`. The signing flows (`dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_tx_send`) **require `DEXE_PRIVATE_KEY` for the auto-signed mode** — they sign and broadcast directly (and run the B6/B7/B10 broadcast guards first; `dexe_tx_send` also runs B9 simulation). Other tools always return calldata for an external signer.

**Per-persona signing.** `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_tx_send`, `dexe_otc_buyer_buy` and `dexe_otc_buyer_claim_all` all accept an optional **`signerKey`** — omit it and the primary `DEXE_PRIVATE_KEY` signs; pass `'agent3'` (or the address) and that keyring wallet signs instead. Agent keys are never used implicitly. As of v0.32.0 every one of those broadcasts is attributed in the agent ledger, so `dexe_agents_ledger` can answer "which persona did this, and what did it cost". `signerKey` is hot-key-only: in WalletConnect mode the phone owns the only key and the call is rejected. A fleet of hot keys in `.env` is a loaded gun — the safety model, the guards that enforce versus advise, and the run sequence that actually works on-chain are in [AGENTS.md](./AGENTS.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_context` | **Call first when you need orientation.** Read-only: signer + mode, active/configured chains, env readiness, enabled vs hidden toolsets (and what each hidden set unlocks), and the persisted state — DAOs deployed and proposals broadcast in prior sessions, plus deposited voting power in the most recent DAO. State at `~/.dexe-mcp/state.json` (override `DEXE_STATE_PATH`). | (none) |
| `dexe_guide` | **Call first for any multi-step request.** The protocol knowledge tool (v0.26): serves the flow corpus from `src/knowledge/` in two tiers — a flow index (menu + triggers), and per-flow detail: interview questions with per-parameter risk notes, exact ordered tool steps, the relevant protocol gotchas (danger-first), chain notes (e.g. "staking doesn't exist on testnet 97"), and session-context prefill (known DAOs, active chain, and any mid-journey `activeFlow` for cross-session resume). Step templates for the four chaining composites carry a pre-filled `flowContext` — pass it through and their success payloads return `flowProgress` + `next` (what to call next). Read-only; the generated PLAYBOOK sections, the six skills' recipe sections, and the `dexe-flow-*` MCP prompts all render from the same source (`npm run gen:knowledge`, drift-checked in CI). | (none) |
| `dexe_proposal_create` | End-to-end create-proposal flow: balance check, approve UserKeeper if needed, deposit if needed, build + broadcast `createProposalAndVote`. `proposalType` is a strict enum covering **all 33 catalog types** (v0.22): external types build server-side from `params`, internal validator types auto-route to `GovValidators.createInternalProposal`, off-chain types return the backend flow to use. Amounts accept raw wei or human decimals (`"12.5"`). For avatar updates pass `newAvatarPath` (local image path — uploaded + validated server-side). Full recipes: [docs/PLAYBOOK.md](./PLAYBOOK.md). | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL`, `DEXE_PINATA_JWT` |
| `dexe_proposal_vote_and_execute` | Vote on a proposal, optionally execute when state allows. `depositFirst:'auto'` (default, v0.22) deposits exactly the missing amount from the wallet before voting; non-Voting state errors name the per-state remedy; partial failures return the landed-steps ledger. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_send` | Sign and broadcast any TxPayload from a `*_build_*` tool. Optional `signerKey` picks a `DEXE_AGENT_PK_*` keyring signer instead of the primary key; the broadcast is attributed to that persona in `dexe_agents_ledger`. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_status` | Read receipt/status of a previously submitted tx hash. | `DEXE_RPC_URL` |
| `dexe_agents_list` | **Profile `agents` (or `vote`).** The agent keyring (v0.28): every keyring signer (`DEXE_AGENT_PK_*` or the `AGENT_PK_*` alias; `AGENT_FUNDER_PK` → `funder`) with its `signerKey` ('agent1'…, 'funder'), address, native balance, optional ERC20 balance. Addresses only — keys never leave the server. An empty roster means the keyring never loaded; nothing else in a fleet run will work until it does. | `DEXE_AGENT_PK_*`, `DEXE_RPC_URL` |
| `dexe_agents_fund` | **Profile `agents` (or `vote`). Previews, then broadcasts on `confirm: true`** — the first call returns who would be funded, how much each, the total and the remaining daily budget, and moves nothing (`dryRun: true` never broadcasts at all). Tops up keyring wallets from the PRIMARY signer, or `source:'funder'` to send from the `AGENT_FUNDER_PK` wallet; native by default, ERC20 via `token`. Top-up semantics — only the shortfall is sent, agents already at the target are skipped, so re-running after a partial failure is safe. Enforced guards (v0.32.0): recipients can only be keyring addresses (not configurable); the per-agent amount is capped by `DEXE_AGENT_FUND_MAX_WEI` (default 0.1 native) **rescaled into the token's own decimals** — a token whose `decimals()` cannot be read is refused rather than funded unbounded; the rolling-24h `SWARM_DAILY_BNB_BUDGET` is re-checked before *every* transfer so a batch stops at the boundary; and every transfer runs the standard broadcast guards (B6 allowlist, B7 value cap, B9 `eth_call` preflight, B10 rate limit, B11 chain coherence). A budget the server cannot parse **refuses to fund** rather than disabling itself. Every transfer is recorded — read it back with `dexe_agents_ledger`. | `DEXE_PRIVATE_KEY`, `DEXE_AGENT_PK_*`, `DEXE_RPC_URL`; `DEXE_AGENT_FUND_MAX_WEI`, `SWARM_DAILY_BNB_BUDGET` (optional caps) |
| `dexe_agents_ledger` | **Profile `agents`. New in v0.32.0.** Reconcile what the fleet actually did. For a rolling window (`windowHours`, default 24 — the budget window) returns every broadcast attributed to the signer that made it (`agent1`…, `funder`, `primary`) with tool, action, tx hash and `outcome` (`broadcast` / `confirmed` / `reverted` / `failed`); per-agent and total spend (native value **+** gas); and the remaining `SWARM_DAILY_BNB_BUDGET` for the chain. Filter by `signerKey`, `tool`, `chainId`; bound with `limit` (default 20). **Read-only and local — it makes no RPC call**, so it still answers on a chain you can no longer reach. The store lives beside the session state file (`DEXE_AGENT_LEDGER_PATH` to move it, `DEXE_AGENT_LEDGER=off` to disable recording — which also blinds the spend budget). Records slot labels and addresses only; private keys are never written. | (none — reads the local ledger; `DEXE_AGENT_LEDGER_PATH` optional) |
| `dexe_get_config` | Diagnostic read: the server's chain set, default chain, and signer status (`readonly`/`eoa`/`safe`). Call once at session start when unsure which chain is configured. Never writes. | (none) |

---

## 12. Merkle utility

**Profile: `dev`** — not in a default session; set `DEXE_TOOLSETS=core,dev`. (The OTC composites in section 13 derive merkle roots/proofs internally, so a plain whitelist sale does not need these.)

Source: `src/tools/merkle.ts`. OZ `StandardMerkleTree`-compatible. No env required (pure compute).

| Tool | What it does |
|------|--------------|
| `dexe_merkle_build` | Build a merkle tree over `entries[]` with `leafEncoding` (default `["address"]`). Returns `{ root, proofs[], leafHashes[] }`. Sorted-pair commutative keccak; double-hash leaf `keccak256(keccak256(abi.encode(...)))`. Matches frontend's `@openzeppelin/merkle-tree` 1:1. |
| `dexe_merkle_proof` | Single-target convenience wrapper: `{ entries, target, leafEncoding? }` → `{ root, proof, leafHash, included }`. |

---

## 13. OTC composites

**Profile: `core`** — all five `dexe_otc_*` tools are default-visible (the fifth, `dexe_otc_list_sales_for_dao`, is listed in section 3).

Source: `src/tools/otc.ts`. Composites that orchestrate `proposal_create` + `TokenSaleProposal` reads/writes for an end-to-end OTC sale flow. See [`docs/OTC.md`](./OTC.md) for the full project-owner + buyer recipe.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_otc_dao_open_sale` | Project-owner composite. Builds the multi-tier `createTiers` envelope (deduped approves, auto-merkle, auto-`addToWhitelist`) and runs the full proposal_create flow (balance/threshold check, IPFS metadata, approve, deposit, `createProposalAndVote`). Flags: `buildOnly` (skip proposal flow, return envelope only), `dryRun` (return TxPayloads even with key set). | `DEXE_RPC_URL`, `DEXE_PINATA_JWT`, `DEXE_PRIVATE_KEY` for broadcast |
| `dexe_otc_buyer_status` | Read-only aggregator. Multicalls `getTierViews` + `getUserViews(user, tierIds, proofs)`, surfaces participation requirements, per-tier `saleStartTimeUTC`/`saleEndTimeUTC` (human-readable UTC), and pre-computed `claimable` and `vestingWithdrawable`. Optional per-tier `whitelists[]` triggers merkle root + proof + verifyProof for the user, and the proof is passed into `getUserViews` so `canParticipate` is accurate for merkle tiers. | `DEXE_RPC_URL` |
| `dexe_otc_buyer_buy` | Buyer composite. Preflights ERC20 balance + allowance in the payment token's REAL decimals (v0.22 — no silent under-pay on <18-dec tokens; skipped on native sentinel ETHEREUM_ADDRESS 0xEeee...EEeE; 0x0 accepted as alias, calldata always carries ETHEREUM_ADDRESS), prepends the exact-amount approve when needed, builds `buy(tierId, paymentToken, amount, proof)`. Amount accepts human units (`"100.5"`). Auto-derives merkle proof when `whitelistUsers[]` supplied. Native path sets `value=amount`. Optional `simulateFirst` runs sim before broadcast. | `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` for broadcast |
| `dexe_otc_buyer_claim_all` | Picks tiers with `canClaim && !isClaimed` → `claim`, tiers with `amountToWithdraw > 0` → `vestingWithdraw`. `mode='noop'` when nothing pending. | `DEXE_RPC_URL`, `DEXE_PRIVATE_KEY` for broadcast |

---

## 14. Safe multisig

**Profile: `dev`** — not in a default session; set `DEXE_TOOLSETS=core,dev`.

Source: `src/tools/safe.ts`, `src/lib/ethersProvider.ts`. Alternative signer posture: instead of broadcasting from a hot EOA, **queue** the tx in the [Safe Transaction Service](https://docs.safe.global/) for the Safe's owners to co-sign and execute. Use when the DAO/treasury operator key is custodied in a Gnosis Safe rather than a bare `DEXE_PRIVATE_KEY`. See [`docs/SAFE.md`](./SAFE.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_safe_info` | Read-only: live Safe `nonce` / `threshold` / `owners` / singleton version, whether the configured signer is an owner, and which Safe Transaction Service endpoint this chain resolves to. | `DEXE_RPC_URL` |
| `dexe_safe_propose_tx` | Takes a `TxPayload` (`to`/`value`/`data`/`operation`), reads the Safe's next `nonce()` (unless supplied), computes the EIP-712 `safeTxHash`, signs it with `DEXE_PRIVATE_KEY` (which must be a Safe owner), and assembles the create-multisig-transaction body. **`dryRun` defaults to `true`** — returns the signed payload + resolved POST target without sending; `dryRun=false` POSTs to the service. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL`; `DEXE_SAFE_API_KEY` for api.safe.global; `DEXE_SAFE_TX_SERVICE_URL` for chains without a hosted service |

---

## 15. Simulator

**Profile: `dev`** — not in a default session; set `DEXE_TOOLSETS=core,dev`. (The `core` composites `dexe_dao_create` and `dexe_tx_send` already simulate before broadcasting; these are the standalone gates.)

Source: `src/tools/simulate.ts`. `eth_call`-based preflight gate. Catches reverts before broadcast without spending real money. See [`docs/SIMULATOR.md`](./SIMULATOR.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_sim_calldata` | Generic preflight. Returns `{ success, revertReason?, returnData?, gasEstimate? }`. Decodes `Error(string)` (selector `0x08c379a0`) and `Panic(uint256)` revert payloads. Optional `from`/`value`/`blockTag` overrides. | `DEXE_RPC_URL` |
| `dexe_sim_proposal` | Preflight `GovPool.execute(proposalId)`. Reads proposal state first; refuses to sim unless `SucceededFor` (idx 4). Surfaces `proposalState` + `proposalStateIndex`. | `DEXE_RPC_URL` |
| `dexe_sim_buy` | Preflight `TokenSaleProposal.buy(...)`. Native path uses `value=amount`. ERC20 path also reads current allowance and reports `willNeedApprove: true` when allowance < amount. | `DEXE_RPC_URL` |

---

## 16. Multi-DAO inbox + forecast

**Profile: `read`** — not in a default session; set `DEXE_TOOLSETS=core,read`. For a single DAO, `dexe_dao_report`'s `deadlines` section (with `user`) covers the same ground from the default profile; `dexe_user_inbox` is the multi-DAO sweep.

Sources: `src/tools/inbox.ts`, `src/tools/predict.ts`. Read-side "what needs my attention" tools. See [`docs/INBOX.md`](./INBOX.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_user_inbox` | Multi-DAO attention aggregator. Per DAO surfaces `unvotedProposal` (Voting state + zero personal vote), `claimableRewards`, `lockedDeposit`. Discovery **and** scan run on `chainId`: omitting `daos[]` auto-discovers the user's DAOs from that chain's pools subgraph, so a chain with no endpoint refuses to guess — pass `daos[]` and the scan (pure on-chain) works anywhere. → adds `{daoSource, indexedChainId}` (`null` when you supplied the list). | `DEXE_RPC_URL`; `DEXE_SUBGRAPH_POOLS_URL[_<chainId>]` for auto-discovery |
| `dexe_proposal_forecast` | Predictive pass-rate. Reads latest 10 proposals + final states, computes historical pass-rate + average For-vote weight, returns `{ quorum, historicalPassRate, risks, recommendation }`. The history cross-check resolves a pools subgraph **for the chain being forecast**; a chain with no endpoint stops the call with the var to set unless you pass `forceRpcOnly: true` (on-chain history only). → adds `{indexedChainId, subgraphNote}` so one chain's forecast is never enriched with another's history. | `DEXE_RPC_URL`; `DEXE_SUBGRAPH_POOLS_URL[_<chainId>]` unless `forceRpcOnly` |

---

## 17. External Governor DAOs (`dexe_gov_*`)

**Profile: `governor`** — not in a default session; set `DEXE_TOOLSETS=core,governor`.

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

**Profile: `core`** — all three are default-visible.

Source: `src/tools/walletconnectStatus.ts` + `src/lib/walletconnect.ts`. A fourth signer mode (`readonly` | `eoa` | `safe` | `walletconnect`): broadcast convenience **without a hot key** — every tx is approved on the operator's phone wallet, key never leaves the device. When active, `dexe_tx_send` forwards the tx over the WalletConnect v2 relay; the wallet signs **and broadcasts**. Only `dexe_tx_send`/`dexe_tx_status` route through WC — composite flows still require a hot key. See [`docs/WALLETCONNECT.md`](./WALLETCONNECT.md).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_wc_status` | Report the resolved WalletConnect config plus live session state (`connected`, `connecting`, `account`, `chainId`, `topic`, `peerName`, `expiry`, `lastError`) and whether `walletconnect` is the active `signerMode`. Read-only. WalletConnect activates only when `DEXE_WALLETCONNECT_PROJECT_ID` is set AND no `DEXE_PRIVATE_KEY` is present. | `DEXE_WALLETCONNECT_PROJECT_ID` (for active mode) |
| `dexe_wc_connect` | Start a session and render a scannable QR (ASCII + PNG) for the phone wallet (MetaMask / Trust / Rainbow) — the recommended signer, no key on disk. Non-blocking — approval completes in the background; poll `dexe_wc_status` until `connected`. Pairs even when a hot key is set (the key keeps precedence until unset). | `DEXE_WALLETCONNECT_PROJECT_ID` |
| `dexe_wc_disconnect` | Tear down the active session. Safe no-op when not connected. | — |

---

## 19. Diagnostics

**Profile: `core`** — default-visible.

Source: `src/tools/doctor.ts` + `src/diag/checks.ts`. Pure reads. First stop when an env-related failure shows up. Also runnable as a CLI: `npx dexe-mcp doctor` (exit 0 pass, 1 warn-only, 2 any fail).

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_doctor` | Diagnose env setup end-to-end. Walks every recognized `DEXE_*` var, runs `eth_chainId` per configured RPC, `testAuthentication` on Pinata, DNS lookup on the IPFS gateway, `{ __typename }` introspection on each configured subgraph, then validates signer broadcast-guard config and chain consistency. Returns pass/warn/fail per check + paste-ready remediation hints. Network checks have a 3s hard timeout that downgrades to `warn` so offline laptops don't see all-red. | — |

---

## Notes

- **Calldata model.** Default mode for every builder is "return calldata, you sign it." The MCP server never holds a key unless `DEXE_PRIVATE_KEY` (or an opt-in `DEXE_AGENT_PK_*` keyring) is set. The tools that actually sign are the composites — `dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute` (section 11), the OTC composites (section 13), and `dexe_agents_fund`. All of them except the OTC owner flow take `signerKey` to pick a persona.
- **Toolset profiles.** Every section above names the profile its tools need. A default session is `core` (44 tools); anything else must be added via `DEXE_TOOLSETS`, and calling a tool from an unloaded profile fails as an unknown tool. `dexe_context` lists which sets are off and what each unlocks.
- **Composing wrappers.** Wrappers (`dexe_proposal_build_*`, profile `proposals`) return `{ipfsMetadata, action(s), hint}`. Upload metadata via `dexe_ipfs_upload_proposal_metadata` to get a CID, then call `dexe_proposal_build_external` with that CID + the actions. From the default profile, `dexe_proposal_create` does all of that in one call.
- **Settings auto-expand.** `dexe_dao_build_deploy` accepts 1 setting and auto-expands to all 5 slots (default / internal / validators / distributionProposal / tokenSale). Override individually if you need non-default behavior on any.
- **Frontend parity.** All builders are cross-checked against `C:/dev/investing-dashboard` (the DeXe frontend). When in doubt, that is the source of truth — see `feedback_frontend_source_of_truth.md` in user memory.
