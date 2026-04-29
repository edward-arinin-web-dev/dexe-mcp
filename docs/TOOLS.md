# dexe-mcp tool catalog

`dexe-mcp` is an MCP (Model Context Protocol) server that exposes DeXe Protocol DAO operations and Solidity-dev tooling to AI agents. Total tools: **111**.

The server is **calldata-first**: most tools return a `TxPayload` (`{to, data, value, chainId, description}`) that the user's wallet signs and broadcasts. A subset (`dexe_dao_info`, `dexe_proposal_state`, all `dexe_read_*`, all `dexe_ipfs_*`, `dexe_decode_*`, all `dexe_get_*` / `dexe_list_*`) are pure reads. Three composite tools (`dexe_tx_send`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`) opt into auto-signing when `DEXE_PRIVATE_KEY` is configured.

Discover tools at runtime via the MCP client's `tools/list`, or call `dexe_proposal_catalog` for the live list of supported proposal types and which builder maps to each.

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

Sources: `src/tools/dao.ts`, `src/tools/gov.ts`, `src/tools/proposal.ts`, `src/tools/vote.ts`, `src/tools/read.ts`, `src/tools/subgraph.ts`. All on-chain reads need `DEXE_RPC_URL`. Subgraph reads need the relevant `DEXE_SUBGRAPH_*_URL`.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_dao_info` | Helpers + NFT contracts + descriptionURL + validator count for a GovPool. One multicall. | `DEXE_RPC_URL` |
| `dexe_dao_predict_addresses` | `PoolFactory.predictGovAddresses(deployer, poolName)` → 6 CREATE2 addresses. Useful for pre-deploy wiring. | `DEXE_RPC_URL` |
| `dexe_dao_registry_lookup` | `PoolRegistry.isGovPool(address)` — true if address is a registered DeXe GovPool. | `DEXE_RPC_URL` |
| `dexe_proposal_state` | `getProposalState` + `getProposalRequiredQuorum` in one multicall. Returns named state. | `DEXE_RPC_URL` |
| `dexe_proposal_list` | `GovPool.getProposals(offset, limit)` → compact summaries. | `DEXE_RPC_URL` |
| `dexe_proposal_voters` | Voter list from interactions subgraph, paginated. | `DEXE_SUBGRAPH_INTERACTIONS_URL` |
| `dexe_read_gov_state` | Reads `getHelperContracts()` + `getNftContracts()`, returns resolved helper + NFT addresses. | `DEXE_RPC_URL` |
| `dexe_vote_user_power` | `tokenBalance` + `nftBalance` on GovUserKeeper for every VoteType (Personal/Micropool/Delegated/Treasury). | `DEXE_RPC_URL` |
| `dexe_vote_get_votes` | `GovPool.getUserVotes(proposalId, voter, voteType)` → VoteInfoView. Defaults to PersonalVote. | `DEXE_RPC_URL` |
| `dexe_read_multicall` | Arbitrary batched view-calls via Multicall3. Each call supplies its own ABI fragment. | `DEXE_RPC_URL` |
| `dexe_read_treasury` | Native + ERC20 balances (symbol/decimals/balance) in one multicall. | `DEXE_RPC_URL` |
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

---

## 4. IPFS

Source: `src/tools/ipfs.ts`. Pinata-backed; reads use the configured gateway with optional fallback chain.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_ipfs_upload_proposal_metadata` | Pins `{proposalName, proposalDescription, ...}` (proposal-shaped) to IPFS via Pinata. Returns CID for `descriptionURL`. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_dao_metadata` | Nested upload chain: description content → IPFS, outer metadata → IPFS. Returns outer CID for `deployGovPool.descriptionURL`. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_upload_file` | Pins raw bytes (base64 input). Use for avatars, attachments. | `DEXE_PINATA_JWT` |
| `dexe_ipfs_fetch` | Fetches CID via `DEXE_IPFS_GATEWAY` (recommended dedicated gateway). Public fallbacks opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK`. | `DEXE_IPFS_GATEWAY` |
| `dexe_ipfs_cid_info` | Parses CIDv0/v1, reports codec + multihash, converts between versions, emits gateway URLs. | (none) |
| `dexe_ipfs_cid_for_json` | Computes deterministic CIDv1 (json codec, sha-256) locally — no network. Useful for dry-run flows. | (none) |

---

## 5. DAO deploy

Source: `src/tools/daoDeploy.ts`.

| Tool | What it does | Required env |
|------|--------------|--------------|
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
| `dexe_proposal_build_token_transfer` | Treasury → recipient ERC20 transfer. Encodes `ERC20.transfer`. | (none) |
| `dexe_proposal_build_token_distribution` | Batch distribution via DistributionProposal. Auto-prepends `ERC20.approve` for non-native tokens. | (none) |
| `dexe_proposal_build_token_sale` | Launches a single tier via `TokenSaleProposal.createTiers`. Plain whitelist supported; merkle requires custom_abi. | (none) |
| `dexe_proposal_build_token_sale_recover` | `TokenSaleProposal.recover(tierIds)` — recover unsold tokens. | (none) |
| `dexe_proposal_build_create_staking_tier` | `StakingProposal.createStaking(rewardToken, amount, startedAt, deadline, metadata)`. Auto-prepends approve for ERC20 rewards. | (none) |
| `dexe_proposal_build_change_math_model` | `GovPool.changeVotePower(newVotePower)` — swap LINEAR / POLYNOMIAL / custom power contract. | (none) |
| `dexe_proposal_build_modify_dao_profile` | `GovPool.editDescriptionURL(url)`. Upload new DAO metadata via `dexe_ipfs_upload_dao_metadata` first. | (none) |
| `dexe_proposal_build_blacklist` | Up to 2 actions: `ERC20Gov.blacklist(add,true)` + `blacklist(remove,false)`. | (none) |
| `dexe_proposal_build_reward_multiplier` | 4 modes: set_address / set_token_uri / mint / change_token on the multiplier NFT. | (none) |
| `dexe_proposal_build_apply_to_dao` | Disburse DAO tokens to a receiver. Treasury-sufficient → 1 transfer; shortfall → transfer + mint. | (none) |
| `dexe_proposal_build_new_proposal_type` | 2 actions: `GovSettings.addSettings([new])` + `changeExecutors`. Path for enabling staking. | (none) |
| `dexe_proposal_build_change_voting_settings` | `GovSettings.editSettings` (when `settingsIds` given) or `addSettings` (when empty). | (none) |
| `dexe_proposal_build_manage_validators` | `GovValidators.changeBalances(balances, users)`. Set 0 to remove. | (none) |
| `dexe_proposal_build_add_expert` | Mint Expert NFT — `scope='local'` (DAO ExpertNft) or `'global'` (DeXeExpertNft). | (none) |
| `dexe_proposal_build_remove_expert` | `ExpertNft.burn(from)` — local or global. | (none) |
| `dexe_proposal_build_withdraw_treasury` | `GovPool.withdraw(receiver, amount, nftIds)`. Executor IS GovPool itself. | (none) |
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
| `dexe_vote_build_token_sale_buy` | `TokenSaleProposal.buy(tierId, tokenToBuyWith, amount, proof)`. Native: pass `value`. Whitelisted: pass merkle proof. | (none) |
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

Sources: `src/tools/flow.ts`, `src/tools/txSend.ts`. **These four require `DEXE_PRIVATE_KEY` for the auto-signed mode** — they sign and broadcast directly. Other tools always return calldata for an external signer.

| Tool | What it does | Required env |
|------|--------------|--------------|
| `dexe_proposal_create` | End-to-end create-proposal flow: balance check, approve if needed, deposit if needed, build + broadcast `createProposalAndVote`. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL`, `DEXE_PINATA_JWT` |
| `dexe_proposal_vote_and_execute` | Vote on a proposal, optionally execute when state allows. Handles deposits + state transitions. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_send` | Sign and broadcast any TxPayload from a `*_build_*` tool. | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| `dexe_tx_status` | Read receipt/status of a previously submitted tx hash. | `DEXE_RPC_URL` |

---

## Notes

- **Calldata model.** Default mode for every builder is "return calldata, you sign it." The MCP server never holds a key unless `DEXE_PRIVATE_KEY` is set; only the four tools in section 11 use it.
- **Composing wrappers.** Wrappers (`dexe_proposal_build_*`) return `{ipfsMetadata, action(s), hint}`. Upload metadata via `dexe_ipfs_upload_proposal_metadata` to get a CID, then call `dexe_proposal_build_external` with that CID + the actions.
- **Settings auto-expand.** `dexe_dao_build_deploy` accepts 1 setting and auto-expands to all 5 slots (default / internal / validators / distributionProposal / tokenSale). Override individually if you need non-default behavior on any.
- **Frontend parity.** All builders are cross-checked against `C:/dev/investing-dashboard` (the DeXe frontend). When in doubt, that is the source of truth — see `feedback_frontend_source_of_truth.md` in user memory.
