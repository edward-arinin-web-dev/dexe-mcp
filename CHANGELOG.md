# Changelog

## 0.5.0

Transaction simulator gate, multi-DAO inbox + forecast + OTC discovery, and
frontend byte-diff harness. Adds preflight tools (catch reverts before
broadcast), the read-side "what needs my attention" loop (inbox +
forecast), OTC tier discovery, and a fixture-driven calldata-equivalence
test against the production DeXe frontend. **125 tools** total
(119 → 125).

### Added

**Simulator tools (3)**
- `dexe_sim_calldata` — generic preflight. Returns `{ success, revertReason?, returnData?, gasEstimate? }`. Decodes `Error(string)` (selector `0x08c379a0`) and `Panic(uint256)` revert payloads. Optional `from`/`value`/`blockTag` overrides.
- `dexe_sim_proposal` — preflight `GovPool.execute(proposalId)`. Reads proposal state first; refuses to sim unless `SucceededFor` (idx 4). Surfaces `proposalState` + `proposalStateIndex` for diagnostics.
- `dexe_sim_buy` — preflight `TokenSaleProposal.buy(...)`. Native path (paymentToken = `0x0`) sets `value=amount`. ERC20 path also reads current allowance and reports `willNeedApprove: true` when allowance < amount.

**Integration**
- `dexe_otc_buyer_buy` — new `simulateFirst?: boolean` flag. When true, runs `dexe_sim_calldata` on the encoded `buy()` payload before the broadcast/return path; aborts with the revert reason on failure. Ignored when `dryRun: true`.

**Frontend ↔ MCP byte-diff harness**
- `tests/compat/diff-otc.mjs` — fixture-driven runner. For each `tests/compat/fixtures/otc-frontend-*.json` it calls `buildTokenSaleMultiActions(input)` from compiled `dist/`, byte-compares every `actions[i].data` against the fixture, and on mismatch prints an ABI-decoded field-level diff via `Interface.parseTransaction`. Exit 0 = all green, 1 = at least one diverged. Wired as `npm run test:compat`.
- `tests/compat/gen-otc-fixtures.mjs` — fixture generator. Runs an *independent* synthesizer that mirrors the frontend hook's pipeline (lines 33-130 of `useGovPoolCreateTokenSaleProposal.ts`) **and** the MCP helper, asserts byte-identical calldata, then writes the fixture using the helper's output. Refuses to write on synth/helper divergence. Re-run after any helper refactor or frontend ABI bump.
- Three fixtures covering the canonical OTC shapes:
  - `otc-frontend-1tier-open.json` — single open tier (no participation gating).
  - `otc-frontend-2tier-merkle.json` — open + `MerkleWhitelist` (auto-derived root, no `addToWhitelist`).
  - `otc-frontend-2tier-plain-whitelist.json` — open + plain `Whitelist` (auto-appended `addToWhitelist` action).
- `tests/compat/CAPTURE.md` — runbook documenting both capture methods (synthesizer + live WalletConnect intercept) and the form-field → TierSpec field map for re-capture.

**Docs + scenarios**
- `docs/SIMULATOR.md` — explains the three sim tools, response shapes, revert decoding, integration with `dexe_otc_buyer_buy`, and the limits of `eth_call`-based simulation (pending state, reorg risk, L2 divergence).
- `S47-sim-calldata-balance` — exercises `dexe_sim_calldata` calling `balanceOf` on the active chain's first allowlisted token; verifies `success: true` and a 32-byte return.
- `S48-sim-buy-no-tier` — exercises `dexe_sim_buy` against Glacier's TokenSaleProposal on BSC testnet with `tierId=999`; verifies `success: false` + revert reason set.

**Subgraph trio — read-side "what needs my attention" tools (3)**
- `dexe_user_inbox` — multi-DAO attention aggregator. Per DAO, surfaces
  `unvotedProposal` items (Voting state + zero personal vote), `claimableRewards`
  (non-zero pending rewards across the scanned window), and `lockedDeposit`
  (UserKeeper.tokenBalance > 0). Mainnet auto-discovers DAOs via the pools
  subgraph (`voterInPools` for the user, limit 50). Testnet requires explicit
  `daos[]` since chain 97 has no subgraph. Read-only. See `docs/INBOX.md`.
- `dexe_proposal_forecast` — predictive pass-rate. Reads latest 10 proposals via
  `getProposals(0, 10)` + their final states, computes historical pass-rate +
  average For-vote weight, and returns `{ quorum, historicalPassRate, risks,
  recommendation }`. `recommendation` is `likelyPass` / `borderline` /
  `likelyFail` based on `hitProbability = clamp(projectedFor / required, 0, 1)`.
  Mainnet only by default; pass `forceRpcOnly: true` to run on testnet.
- `dexe_otc_list_sales_for_dao` — OTC tier discovery. Reads `latestTierId()`
  then `getTierViews(0, latestTierId)` on a DAO's TokenSaleProposal helper.
  Returns tiers tagged with `status` (`upcoming` / `active` / `ended`)
  computed against `block.timestamp`, plus aggregate counts. Works on both
  chain 56 and chain 97 — no subgraph required. `totalSold` returns `null`
  in v1 (not exposed via `getTierViews`).

**Tests**
- `S50-otc-list-for-dao.json` — chain 97, validates tier-list shape on
  Glacier (zero tiers expected).
- `S51-inbox-with-supplied-daos.json` — chain 97/56, exercises
  `dexe_user_inbox` with explicit `daos[]`.

### Notes

- Compat fixtures are **synthesized** for v1: the synthesizer encodes via the same canonical `TokenSaleProposal` ABI signature both the frontend artifact and `TOKEN_SALE_PROPOSAL_ABI` regenerate from (post-Bug #25 fix). Live WalletConnect-intercept re-cert is documented in `CAPTURE.md` and remains the ground-truth check after frontend major bumps.
- All three fixtures round-trip cleanly through `Interface.decodeFunctionData`.

### Follow-ups (v0.5.1+)

- `dexe_otc_list_active_sales` — cross-DAO global live-sale list. Requires a subgraph entity that doesn't exist yet.
- Per-DAO TokenSaleProposal helper auto-discovery from registry / deploy receipt so callers don't need to thread the address.
- State-override allowance for ERC20 sim path (currently flags `willNeedApprove`).

## 0.4.0

OTC DAO support. Adds the calldata builders, merkle utilities, and four
composite tools needed to launch and operate an over-the-counter token sale
end-to-end through one MCP surface. **119 tools** total. Lifecycle proven
on BSC testnet (deploy → open_sale → vote → execute → buy → claim →
balance delta verified).

### Added

**Phase A — calldata builders (4 tools)**
- `dexe_proposal_build_token_sale_multi` — N-tier sale envelope. Sums and dedupes ERC20 approves per sale token, auto-derives merkle roots for `MerkleWhitelist` tiers when only `users[]` is supplied, auto-appends `addToWhitelist` for plain `Whitelist` tiers.
- `dexe_proposal_build_token_sale_whitelist` — standalone external proposal that calls `addToWhitelist([{tierId, users[], uri}, …])` on a live tier.
- `dexe_proposal_build_token_sale` — kept as back-compat shim forwarding `[tier]` to `_multi`. Gains optional `participation` field.
- `dexe_merkle_build` / `dexe_merkle_proof` — OZ `StandardMerkleTree`-compatible: sorted-pair commutative keccak, double-hash leaf `keccak256(keccak256(abi.encode(...)))`. Default leaf shape `["address"]`; advanced shapes via `entries` + `leafEncoding`.

**Phase B — composite tools (4 tools)**
- `dexe_otc_dao_open_sale` — orchestrates `_multi` + `runProposalCreate` (balance/threshold check, approve, deposit, IPFS metadata, `createProposalAndVote`). `buildOnly: true` short-circuits the proposal flow and just returns the envelope. `dryRun: true` returns ordered TxPayloads even when `DEXE_PRIVATE_KEY` is set.
- `dexe_otc_buyer_status` — read-only aggregator. Multicalls `getTierViews` + `getUserViews(user, tierIds, proofs)`, surfaces participation requirements + pre-computed `claimable` (`canClaim && !isClaimed ? claimTotalAmount : 0`) and `vestingWithdrawable` (`amountToWithdraw`). Optional per-tier `whitelists[]` triggers merkle-tree build + proof + verify check for the user.
- `dexe_otc_buyer_buy` — preflights ERC20 balance + allowance (skipped on native sentinel `ZeroAddress`), prepends `approve(spender=TokenSaleProposal, MAX_UINT256)` when needed, builds `buy(tierId, paymentToken, amount, proof)`. Auto-derives the merkle proof when `whitelistUsers[]` is supplied without a precomputed `proof`. Native path sets `value=amount`.
- `dexe_otc_buyer_claim_all` — picks tiers with `canClaim && !isClaimed` → `claim`, tiers with `amountToWithdraw > 0` → `vestingWithdraw`. Skips silently when nothing pending (`mode='noop'`).

**Refactors**
- `proposalBuildComplex.ts` — extracted `buildTokenSaleMultiActions(input)` pure helper; `tierSchema`, `TierSpec`, `buildTierTuple`, `buildSaleApprovals`, `TOKEN_SALE_PROPOSAL_ABI` now exported. The `dexe_proposal_build_token_sale_multi` registrar is a thin shim around the helper.
- `flow.ts` — extracted `runProposalCreate(input, deps)` + `sendOrCollect` exported. `dexe_proposal_create` gains a `dryRun` flag. `sendOrCollect` distinguishes `mode='dryRun'` (caller-requested) from `mode='payloads'` (no signer); the swarm orchestrator's `mcpFallbackDispatcher` only auto-broadcasts on `'payloads'`.

**Docs + scripts**
- `docs/OTC.md` — project-owner + buyer flows with paste-ready examples. Documents every gotcha that bit during integration: PRECISION 1e25 (not 1e18) on `exchangeRates`; `canClaim` requires `block.timestamp >= saleEndTime + claimLockDuration` so buyers must wait for the sale window to close even with `claimLockDuration: 0`; `maxAllocationPerUser == 0` means unlimited (not zero); newly-passed proposals briefly land in `Locked` (idx 6) before `SucceededFor` (idx 4); treasury must be seeded with sale token (mint via `tokenParams.users[]` + predicted `govPool` address).
- `scripts/lifecycle-otc.mjs` — runnable end-to-end proof on BSC testnet (chain 97). Single command. Deploys a fresh DAO, opens a 1-tier sale, votes+executes, buys, claims, verifies balance delta.

**Swarm scenarios**
- `S41-otc-multi-merkle-build` — 2 tiers Open + MerkleWhitelist, auto-derived root.
- `S42-otc-multi-whitelist-build` — 2 tiers Open + plain Whitelist, auto-appended `addToWhitelist`.
- `S43-otc-whitelist-extend-build` — standalone `_whitelist` proposal extending an existing tier.
- `S44-otc-open-sale-build` — `buildOnly` envelope sanity.
- `S45-otc-buyer-buy-native-build` — `dryRun` + native sentinel.
- `S46-otc-buyer-buy-merkle-build` — `dryRun` + auto-merkle proof.

### Fixed

- **Bug #25** — `TOKEN_SALE_PROPOSAL_ABI` had two field-order transpositions vs the contract: `TierInitParams` swapped `saleTokenAddress` <-> `claimLockDuration`, and `VestingSettings` was declared `(cliff, step, duration, percentage)` instead of canonical `(percentage, duration, cliff, step)`. Selector matched (`0x6a6effda`) but calldata was silently misdecoded — every prior single-tier sale proposal built via dexe-mcp landed with vesting + claim-lock fields scrambled.
- **Bug #26** — `getUserViews` ABI in `read.ts` (and copied into `otc.ts`) declared `UserView` as a flat 7-field struct (`canParticipate, isWhitelisted, purchasedAmount, owedAmount, lockedAmount, claimableAmount, vestingWithdrawAmount`). Actual contract returns `tuple(bool canParticipate, PurchaseView purchaseView, VestingUserView vestingUserView)` with nested structs. Both files now match the contract; affected callers (`dexe_read_token_sale_user`, `dexe_otc_buyer_status`, `dexe_otc_buyer_claim_all`) updated to read fields via the correct paths.
- **Bug #27** — `getUserViews` is a 3-arg function (`address user, uint256[] tierIds, bytes32[][] proofs`); ABI was missing the third parameter, causing every call to revert with `require(false)` at the abicoder layer. Fixed in both `read.ts` and `otc.ts`; non-merkle tiers pass `tierIds.map(() => [])`.
- **`flow.ts` `vote_and_execute` Locked state.** When `open_sale`'s `createProposalAndVote` clears quorum + earlyCompletion, the proposal lands directly in state 6 (`Locked`) before transitioning to `SucceededFor`. The skip-vote-and-execute branch only matched 4/5; now also matches 6.
- **`otc.ts` multicall double-unwrap.** Single-return-value functions are already unwrapped by `src/lib/multicall.ts`; the OTC composites were treating the result as one extra layer deep and indexing `[0]`. Fixed.

### Lifecycle proof

Live run on BSC testnet (chain 97) on 2026-05-01:
- govPool: `0x028C447c72A6Fd1955f0937bb3C5926E8EAC297c`
- deploy tx: `0x3e17ff4e46a6840bf4945e15a9c3af620be276b7de0e1efe807e08ec8a097dbe`
- execute proposal 1: `0x17b677e3fb0b078ca670d3a16c3a776cc36dac97e4497446b19d6490633873df`
- buyer balance: `400000.0` → `399999.0` (buy) → `400000.0` (claim) — delta verified

---

## 0.3.0

End-to-end testnet validation. Every proposal-builder tool is now exercised by an automated swarm scenario on BSC testnet, and the harness itself ships in-repo so external integrators can run it. **111 tools** total, **41 swarm scenarios**, full sweep green.

### Added

**Swarm test harness (`tests/swarm/` + `scripts/swarm/`)**
- `scripts/swarm/orchestrator.ts` — scenario loader + dispatcher. Inline ethers dispatchers for the no-IPFS toolset (vote_user_power, read_delegation_map, build_undelegate, build_withdraw, build_withdraw_all, build_erc20_approve, build_deposit, build_delegate, build_vote). Generic MCP-stdio fallback (`mcpFallbackDispatcher`) routes anything else through the dexe-mcp child server, so adding a scenario for a new tool is JSON-only — no code changes.
- Loop expansion (`spec.loop.over` × `appliesToSteps`), template engine (`{{dao}}`, `{{firstAllowlistedToken}}`, `{{firstAllowlistedDao}}`, `{{secondAllowlistedDao}}`, `{{dao.<helper>}}`, `{{agent:X:address}}`, `{{capture.path}}`, `{{capture.0.field}}`), `skipIf` evaluator with limited expressions, deferred-cascade for chained captures, wallet semaphore for parallel-safe broadcasts, per-scenario `prefund` hook that tops up agents from `AGENT_FUNDER_PK` before each scenario runs.
- `scripts/swarm/preflight.ts` + `scripts/swarm/fund-pool.ts` — wallet-readiness check + token allowlist–enforced top-up. Hard-refuses to send to any non-pool address or any token not on the allowlist.
- `scripts/swarm/nightly.sh` — Phase 5 cron runner. Pulls main, runs preflight + full sweep, tails the run report, posts the one-line summary to `SWARM_SUMMARY_WEBHOOK` and/or `SWARM_SUMMARY_ISSUE` (gh CLI), runs a triage stub on failure (with `SWARM_FIXER=1` opt-in for auto-fix), and rotates run-report dirs older than 30 days while keeping the latest 50.
- `scripts/swarm/orchestrator.ts` emits a single greppable summary line after `writeReport`: `SWARM <runId> <pass>/<total> <mode> <chainTag> <reportPath>` — consumed by nightly.sh and any external poster.
- `scripts/swarm/one-shot-execute.mjs` — closes a proposal lifecycle once it reaches `SucceededFor`. Polls + caps `wait()` at 90 s to avoid sandbox hangs.
- 41 scenario JSONs covering: reset, delegation chain, validator pass / veto / full lifecycle, expert / participation / staking / validator / catalog / cross-DAO / multi-proposal-state read snapshots, cancel-vote, decode-and-introspect, build-only sanity for every external + internal proposal type from `dexe_proposal_catalog`.
- Role prompts: `proposer`, `voter`, `delegator`, `reporter`, `triage`, `validator`, `expert`, `fixer`, plus `_shared.md` and the dao-personas fixture. Fixer prompt encodes the CLAUDE.md auto-fix loop verbatim — branch `swarm-fix/<YYYY-MM-DD>`, never push to main, diff scope hard-bounded to `src/tools/`, `src/lib/`, `tests/swarm/`.

**Composite + signing tools**
- `dexe_proposal_create` — full prerequisite handling: balance check, ERC20 approve, deposit, IPFS metadata upload, `createProposalAndVote`. When `DEXE_PRIVATE_KEY` is set the tool signs and broadcasts; otherwise returns the ordered `TxPayload` list. Supports `proposalType: 'modify_dao_profile' | 'custom'`.
- `dexe_proposal_vote_and_execute` — vote-then-execute composite with `autoExecute` + `depositFirst` flags.
- `dexe_tx_send` + `dexe_tx_status` — opt-in signer surface that uses the configured `DEXE_PRIVATE_KEY` when present. Calls remain calldata-by-default; users opt in by setting the env var.
- `dexe_dao_build_deploy` predicted-address auto-wiring: `govToken` flowed into `userKeeperParams.tokenAddress` and `distributionProposal` + `govTokenSale` into `additionalProposalExecutors` automatically. LINEAR / POLYNOMIAL `votePower` initData auto-encoded.

**Reads + introspection**
- `dexe_read_dao_list`, `_dao_members`, `_dao_experts`, `_user_activity`, `_distribution_status`, `_token_sale_tiers`, `_token_sale_user`, `_staking_info`, `_validator_list`, `_privacy_policy_status`, `_delegation_map` — fill out the DAO read surface.
- `dexe_get_methods` returns structured per-function metadata (4-byte selectors, mutability, full structured inputs/outputs with `internalType` preserved for tuples).
- `dexe_proposal_voters` switched to the `pools` subgraph and the proposalInteractions composite ID format (poolAddr + uint32LE(proposalId), no separator).
- `dexe_decode_proposal` understands every external + internal proposal action shape.

### Fixed

- **Proposal metadata format**: builders now emit `proposalName` / `proposalDescription` (not `name` / `description`), wrap diffs inside `changes: { proposedChanges, currentChanges }`, set `isMeta: false`, and round-trip identical to the frontend reference. 17 builders touched.
- **Approve target for deposits** is `UserKeeper`, not `GovPool`. Both flow tools (`proposal_create`, `vote_and_execute`) now approve the right address.
- **Personal voting power** = `tokenBalance.balance − ownedBalance` (deposited only). Without this, `withdraw` on freshly-funded agents reverts `GovUK: can't withdraw this`.
- **VotePower initData** uses `__LinearPower_init()` selector `0x892aea1f` (not empty `0x`) so newly-deployed DAOs initialize their LINEAR vote-power proxy correctly.
- **`STATE_NAMES` enum order** corrected (Defeated / Locked positions were swapped).
- **Custom-proposal IPFS metadata** now includes `category`, `isMeta`, `proposedChanges`, `currentChanges`.
- **Subgraph migration**: Studio URLs deprecated; switched to The Graph decentralized network with API key. Per-chain endpoints documented.
- **IPFS gateway path normalization**: dedicated gateways configured with a trailing `/ipfs` (e.g. `https://<sub>.mypinata.cloud/ipfs`) no longer produce `/ipfs/ipfs/<cid>` 404s.

### Changed

- README updated: tool count `83 → 111`, new "Swarm test harness" section.
- `process.loadEnvFile()` is invoked from `index.ts` so the MCP server loads `.env` itself; users no longer have to plumb env-var changes through their MCP client config (which often doesn't reload).
- Repo now ships `.claude/skills/swarm-test/SKILL.md` for users running Claude Code; lets them invoke the swarm with `/swarm-test`.

### Notes

- **Validated network**: BSC testnet (chain 97). Two fixture DAOs deployed for the harness — Glacier (50% quorum, no validators) and Sentinel (5% quorum, 2 validators with 1k SVT each).
- **Mainnet status**: a separate run pass is staged (Stage B per `tests/swarm/README.md`) but blocked on a previously-observed `PoolFactory.deployGovPool` revert. Re-validate when the protocol team confirms a fix.
- **Off-chain backend tools** require `DEXE_BACKEND_API_URL` and only run on chains where DeXe operates a backend. The corresponding swarm scenarios declare `requiresChain: [56]` so they auto-skip on testnet.

## 0.2.0

The big one — dexe-mcp expands from 15 dev-tooling tools to **83 tools** covering the full DeXe DAO lifecycle. AI agents can now create DAOs, build any of the 33 proposal types the DeXe frontend exposes, upload metadata to IPFS, stake/delegate/vote/execute/claim — all end-to-end.

### Added

**Foundations + reads (13 tools)** — `dexe_dao_info`, `dexe_dao_predict_addresses`, `dexe_dao_registry_lookup`, `dexe_proposal_state`, `dexe_proposal_list`, `dexe_proposal_voters`, `dexe_vote_user_power`, `dexe_vote_get_votes`, `dexe_read_multicall`, `dexe_read_treasury`, `dexe_read_validators`, `dexe_read_settings`, `dexe_read_expert_status`. Backed by an `AddressBook` that resolves contracts via `ContractsRegistry`, a Multicall3 batch helper, a canonical `TxPayload` shape, enum mirrors for `ProposalState` / `VoteType`, and a minimal subgraph GraphQL client.

**IPFS (6 tools)** — `dexe_ipfs_upload_proposal_metadata`, `_upload_dao_metadata`, `_upload_file`, `_fetch`, `_cid_info`, `_cid_for_json`. Backed by a Pinata client and local CID computation via `multiformats`. Public gateways (dweb.link, ipfs.io, cf-ipfs, 4everland) are unreliable and NOT defaulted. Users must set `DEXE_IPFS_GATEWAY` to a dedicated gateway (the one Pinata provides alongside the JWT is recommended). Public gateways are opt-in via `DEXE_IPFS_GATEWAYS_FALLBACK` (comma-separated, tried sequentially — no parallel races).

**Proposals — all 33 types (35 tools)**
- `dexe_proposal_catalog` — enumerate every proposal type the DeXe UI exposes (24 external, 4 internal, 5 off-chain), with metadata shape, gating, and linked MCP builder.
- Primitives: `dexe_proposal_build_external` (+ `createProposalAndVote`), `dexe_proposal_build_internal`, `dexe_proposal_build_custom_abi`, `dexe_proposal_build_offchain`.
- External wrappers (each returns `{ metadata, actions: Action[] }`): `token_transfer`, `token_distribution`, `token_sale`, `token_sale_recover`, `change_voting_settings`, `manage_validators`, `add_expert`, `remove_expert`, `withdraw_treasury`, `delegate_to_expert`, `revoke_from_expert`, `create_staking_tier`, `change_math_model`, `modify_dao_profile`, `blacklist`, `reward_multiplier`, `apply_to_dao`, `new_proposal_type` (also covers *Enable Staking*).
- Internal validator wrappers (each returns `{ metadata, proposalType, data }`): `change_validator_balances` (type 0), `change_validator_settings` (type 1), `monthly_withdraw` (type 2), `offchain_internal_proposal` (type 3).
- Off-chain backend proposals: `offchain_single_option`, `offchain_multi_option`, `offchain_for_against`, `offchain_settings`. Plus `dexe_auth_request_nonce` + `dexe_auth_login_request` for the 2-step Bearer flow, and `dexe_offchain_build_vote` / `dexe_offchain_build_cancel_vote`.
- **Write model is calldata-only.** No signer, no private keys. Every write tool emits a signable payload the agent's wallet submits.

**Vote / stake / execute / claim writes (14 tools)** — `erc20_approve`, `deposit` (payable for native-staking DAOs), `withdraw`, `delegate`, `undelegate`, `vote`, `cancel_vote`, `validator_vote`, `validator_cancel_vote`, `move_to_validators`, `execute`, `claim_rewards`, `claim_micropool_rewards`, plus `multicall` to batch any of the above into one atomic tx. Arg-order gotchas captured in code comments (e.g. `GovPool.vote(pid, isFor, amount, nftIds)` vs `GovValidators.voteInternalProposal(pid, amount, isFor)`).

**DAO deploy (1 tool)** — `dexe_dao_build_deploy` encodes `PoolFactory.deployGovPool(GovPoolDeployParams)` with the full nested struct (settings / validators / userKeeper / token / votePower / verifier / BABT flag / descriptionURL / name). Auto-resolves PoolFactory via `ContractsRegistry` if omitted. When `deployer` + RPC are available, also returns the predicted GovPool address so agents can wire follow-up txs before the DAO exists. Encodes against the compiled `PoolFactory.json` artifact when present (strict parity); falls back to a hand-rolled tuple signature derived from `IPoolFactory.sol` otherwise.

### Changed

- `src/config.ts` adds `DEXE_CHAIN_ID` (default 56), `DEXE_CONTRACTS_REGISTRY` override, `DEXE_PINATA_JWT`, three subgraph URL overrides, `DEXE_BACKEND_API_URL`.
- `package.json` description rewritten to reflect full DAO-ops scope. New dep: `multiformats` (Protocol Labs, for local CID computation).
- `README.md` reorganized around the eight tool groups; added the full env-var matrix.

### Notes

- **No breaking changes.** All v0.1.x tools remain. The write contract is new-world: `TxPayload` for single-tx builders, `Action[]` for proposal wrappers — never a singular `action` field.
- **Deferred to future work** (`FUTURE.md`): Hardhat-fork simulation (`dexe_simulate_vote`), signer-aware send mode, additional IPFS pinning providers (Storacha, Lighthouse), and alternate subgraphs.

## 0.1.5

### Fixed
- **`'npx' is not recognized`** from inside `npm run compile` (and other npm scripts that internally call `npx hardhat …`) on stripped-Node Windows installs. v0.1.4 got `npm` itself spawning cleanly, but DeXe-Protocol's `compile` script is literally `npx hardhat compile --force`, and when npm spawned that child, `cmd.exe` couldn't find `npx.cmd` on PATH — the stripped `C:\Program Files\nodejs\` has `node.exe` only. Root cause: we weren't propagating the resolved Node's shim directory into the child's `PATH`.
- New `deriveNodeBinDir()` + `envWithNodeBinDir()` helpers in `src/runtime.ts` derive the directory containing `npm.cmd`/`npx.cmd` (Windows) or `bin/npm`/`bin/npx` (Unix) from the resolved `npm-cli.js` path, and prepend it to `PATH` on every child spawn (`bootstrap` npm install, `runNpmScript`, `runHardhat`). Child shells launched by npm scripts can now resolve `npx` / `npm` / any locally-installed binary as expected.
- `npmCommand()` now returns a `binDir` field alongside `command` / `prefixArgs` / `needsShell`. Bootstrap logs the prepended directory on first run so it's visible which Node install is contributing the shims.

## 0.1.4

### Fixed
- **`spawn EINVAL` during first-run `npm install`** on Windows hosts where `process.execPath` points at a Node install that does not bundle npm (e.g. a bare `node.exe` dropped under `C:\Program Files\nodejs\` without the rest of the toolchain). Two root causes addressed:
  1. `resolveNpmCli()` now searches a broader set of locations for a usable `npm-cli.js` — including `%APPDATA%\nvm\v*\node_modules\npm\bin\npm-cli.js` (nvm-windows), `%APPDATA%\npm\node_modules\npm\bin\npm-cli.js` (per-user npm prefix), `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` (stock Windows installer), `~/.nvm/versions/node/v*/lib/node_modules/npm/bin/npm-cli.js` (nvm Unix), and Homebrew paths. Because `npm-cli.js` is plain JavaScript, *any* modern `node` can execute any of these, so the MCP process's own Node is free to "borrow" npm from a completely different Node install.
  2. When no `npm-cli.js` is found anywhere and we fall back to spawning `npm.cmd` directly, `execFile` / `execa` now pass `{ shell: true }` — without it, Node refuses to spawn `.cmd` / `.bat` files (CVE-2024-27980 mitigation) and throws `spawn EINVAL`.
- Progress logging on first bootstrap now prints the resolved `npm-cli.js` path (or "shell-resolved" fallback), so "which npm is about to run" is visible in stderr.

## 0.1.3

### Docs
- **Windows install section rewritten** to lead with the absolute-path recipe (`node <abs path to dist/index.js>`) instead of `cmd /c dexe-mcp`. End-to-end testing against Claude Code on Windows showed the `cmd /c` wrapper, while standalone functional, did not reliably complete the MCP handshake when spawned by Claude Code — the absolute-path recipe has zero shim resolution and is known-working.
- **New prereq step**: verify `npm --version` actually runs in your shell *before* attempting `npm install -g dexe-mcp`. Users with a stripped `node.exe`-only install (common on Windows) will hit a silent `npm i -g` no-op otherwise, with no visible error.
- Added a "Verify the install" section showing how to smoke-test `dexe-mcp` over stdio without involving Claude Code, so users can distinguish "MCP server broken" from "client registration broken".

No code changes — 0.1.3 is a docs-only patch on top of 0.1.2's behavior.

## 0.1.2

### Fixed
- **Server no longer hangs / fails on first launch.** The heavy `git clone` + `npm install` bootstrap is now lazy — it runs only when a build tool (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`) is first invoked, not inside MCP `initialize()`. Previously the MCP handshake would block for minutes or time out, and crash outright on hosts where `npm` / `git` were not on the spawned process's PATH.
- **PATH-independent spawning of `npm` and `hardhat`.** The runner now invokes `node <npm-cli.js>` and `node <protocol>/node_modules/hardhat/internal/cli/cli.js` directly via `process.execPath`, so it works on Windows installs where `npm.cmd` / `npx.cmd` aren't on the MCP client's spawn PATH (common with nvm-windows and with stripped `node.exe`-only installs).
- **Actionable error messages** when `git` is not installed, when `DEXE_PROTOCOL_PATH` points at a non-Hardhat directory, or when the user-managed checkout is missing `node_modules`.
- Concurrent build-tool calls now coalesce into a single bootstrap instead of racing `git clone` / `npm install`.

### Changed
- `loadConfig()` no longer hard-fails when the DeXe-Protocol checkout is missing or incomplete at startup — it logs a soft warning to stderr and defers preparation to the first build-tool invocation.
- `src/bootstrap.ts` split into `resolveProtocolPath()` (cheap, startup-safe) and `ensureBuildReady()` (lazy, idempotent).
- New `src/runtime.ts` with portable `npmCommand()` / `hardhatCommand()` / `hasGit()` helpers.

### Docs
- README now has an OS-specific install matrix (Mac/Linux vs. Windows) and a "dev / local checkout" recipe. Troubleshooting section updated for the new lazy-bootstrap behavior and the `process.execPath` npm resolution.

## 0.1.1

### Added
- `dexe_get_methods` introspection tool — returns per-contract methods partitioned into `read` (view/pure) and `write` (nonpayable/payable). Each entry includes `name`, canonical `signature`, 4-byte `selector`, `stateMutability`, and structured `inputs`/`outputs` with `internalType` preserved (so tuple-typed args like `IGovPool.ProposalView[]` survive intact). Designed for generating TypeScript interfaces or ethers wrappers without re-parsing raw ABIs. Supports `kind` filter (`read`/`write`/`all`) and optional `includeEvents`/`includeErrors`.

Tool count: 14 → 15.

## 0.1.0

Initial public release (Phase A): build/test, contract introspection, read-only governance tools. 14 tools.
