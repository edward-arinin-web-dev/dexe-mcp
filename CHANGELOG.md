# Changelog

## 0.26.0 — 2026-07-22

The protocol knowledge layer (Phase A) — a machine-readable "source of truth"
so ANY MCP agent (including weak models: Haiku/Sonnet, or non-Claude hosts like
Cursor) knows the DeXe flows, interview questions, and protocol gotchas without
external research. Tool count 160 → **161** (new `dexe_guide`).

### New: `dexe_guide` — the protocol knowledge tool (core, always visible)

Weak models reliably call tools but don't reliably read resources — so the
knowledge is served AS a tool result, landing in context right before the
agent's next decision. Two tiers keep tokens low: a flow index (menu +
triggers, ~2.5 KB), and per-flow detail (~4–9 KB): the interview questions
with per-parameter risk notes, the exact ordered tool steps, the relevant
gotchas danger-first, chain notes, and session-context prefill (known DAOs,
active chain from `~/.dexe-mcp/state.json`). Free-text `intent` matching
resolves multi-leg requests ("create token + distribute + OTC + staking") to
the end-to-end `launch_token_economy` journey; ambiguity returns the visible
menu, never a confident wrong guess.

### New: `src/knowledge/` — single-source corpus, generated docs

- 7 flows (`create_dao`, `create_proposal`, `vote_execute`,
  `token_distribution`, `otc_sale`, **`staking_setup`** — previously zero
  coverage — and **`launch_token_economy`**, the canonical end-to-end journey).
- 38 gotchas incl. ~15 previously documented nowhere in the shipped package:
  `delegatedVotingAllowed` inversion, one-level delegation,
  staking-absent-on-testnet-97, the token_distribution vs token_transfer
  disambiguation (pro-rata airdrop ≠ address list!), the internal
  `executorDescription` requirement, the "low creating power" first-proposal
  race, off-chain decimal quorum.
- `npm run gen:knowledge` renders the corpus into marked GENERATED regions of
  `docs/PLAYBOOK.md` (flows, gotchas, and the error→remedy slugs from
  `src/lib/errors.ts` — finally one source); `gen:knowledge:check` guards
  drift in `prepublishOnly`.
- Integrity tests: every step tool exists in the toolset union, every gotcha /
  subflow / `{{placeholder}}` reference resolves, payload size ceilings.

### New: weak-model eval harness (dev-only) — acceptance GREEN

`scripts/eval-weak-model.mjs` boots the built server over stdio and lets a
real Haiku (`EVAL_MODEL` override) drive the canonical story on testnet with a
scripted testnet-only user. 10 transcript asserts: `dexe_guide` called first,
interview + parameter echo before broadcast, DAO → distribution → OTC land on
97, app.dexe.io links reported, no staking writes on 97 (deferred to mainnet,
as the chain note says), zero improvised BROADCASTS (read-only/builder tools
are free), zero mainnet writes. `--dry-run` checks the guide surface without
an API key. **Acceptance met 2026-07-22: claude-haiku-4-5, 10/10 asserts.**

### Fixed by the eval's findings

- **`create_staking_tier` zero-address remediation now returns the exact
  paste-able TxPayload** for the one-off permissionless
  `GovUserKeeper.deployStakingProposal()` (`data: 0x82e97c92`) and states it
  must NEVER be wrapped in a governance proposal. Previously the error only
  named the function — a weak model was observed GUESSING a selector (wrong;
  the B9 pre-broadcast simulation caught the revert) and then improvising a
  custom-proposal wrapper. Rule extracted: every "send X()" remediation must
  include `{to, data, value, chainId}`.
- **`spherex-addsettings` gotcha softened**: an `enable_staking` (addSettings
  route) execute SUCCEEDED on a fresh mainnet pool on 2026-07-22 —
  contradicting the previously deterministic block (bug #36) — so the corpus
  now states both observations; if execute reverts 'disallowed tx pattern',
  use editSettings (settingsIds).

### Wiring

Server `instructions` + the composite descriptions (`dexe_dao_create`,
`dexe_proposal_create`, `dexe_proposal_vote_and_execute`,
`dexe_otc_dao_open_sale`) now point to `dexe_guide` first for multi-step
requests.

## 0.25.0 — 2026-07-22

Agent-UX improvements found while running the mainnet campaign — the validator
round, off-chain auth, and multichain reads that made an AI agent do manual or
unsafe work. Tool count 159 → **160** (new `dexe_auth_login`).

### New: `dexe_auth_login` — one-call off-chain auth (signs internally)

Off-chain proposals/votes need a Bearer token from the DeXe backend (nonce →
sign → login). Previously the MCP only *built* those HTTP requests, so signing
the nonce forced the agent to write code that extracts the private key — the
exact pattern a safety classifier flags. `dexe_auth_login` does the whole dance
inside the server when a signer is available (DEXE_PRIVATE_KEY **or** a connected
WalletConnect session — same opt-in surface as `dexe_tx_send`) and returns
`{ accessToken, refreshToken, expiresIn }`. `SignerManager.signMessage` and
`WalletConnectManager.signMessage` (personal_sign) back it. Falls back to the
manual `dexe_auth_request_nonce` / `dexe_auth_login_request` tools when no signer
is set.

### `dexe_proposal_vote_and_execute` drives the validator round

DAOs with validators use two-stage voting (members, then validators). The tool
previously stopped after the member vote when a proposal entered
`WaitingForVotingTransfer` / `ValidatorVoting`, returning a remedy string. It now
auto-drives that stage (new `driveValidatorRound`, default true): moves the
proposal to validators, and — when the configured signer is itself a validator —
casts its validator vote (`voteExternalProposal`, amount-before-isVoteFor) and
executes. Non-validator signers move the proposal and stop with a note. A re-run
on a proposal already in state 1/2 also advances it. Set `driveValidatorRound:
false` for the old member-vote-only behavior.

### Multichain reads

- `dexe_read_multicall` now accepts `chainId` (previously always hit the default
  chain — broke reads against a non-default chain).
- `dexe_read_staking_info` accepts a `govPool` and **auto-resolves** the
  StakingProposal address (`getHelperContracts().userKeeper` →
  `stakingProposalAddress()`), like `create_staking_tier` — no need to look it up
  by hand.
- `dexe_read_delegation_map` accepts `chainId`; since the pools subgraph URL is
  env-bound to one chain, a mismatch with the default chain now surfaces a
  warning instead of silently querying the wrong chain.

### Skills

`dexe-create-proposal` and `dexe-vote-execute` now document the validator round,
the `confirmRisky` quorum-danger gate, the locked-power-blocks-delegation trap
(`GovUK: overdelegation`), the cross-DAO delegation recipe, and that
`offchain_for_against` is not creatable (use single-option with For/Against).

## 0.24.2 — 2026-07-22

Mainnet full-flow verification campaign (chain 56, fresh SphereX-era pools). All
10 governance flows exercised end-to-end with on-chain + app.dexe.io visual
verification; every fix below was found by running the flow, then re-verified
via tools after shipping.

### Guard / validation fixes

- **F17** — `dexe_proposal_create` now runs governance-safety advisories on
  `change_voting_settings` / `new_proposal_type` / `enable_staking` builds. A
  DANGER-level advisory (e.g. quorum lowered below the safe floor into
  treasury-drain territory) **blocks the flow before any transaction** until the
  caller re-runs with `confirmRisky: true`; CAUTION-level advisories attach to
  the result (`governanceAdvisories`) without blocking. Previously only the
  standalone `dexe_proposal_build_change_voting_settings` tool computed these,
  and only in free-text `detail` (lost when a client renders structuredContent).
- **F19** — `manage_validators` / `validators_allocation` now read the
  post-change validator-token distribution and emit a CAUTION advisory when the
  change would push the external validator quorum above every single validator's
  stake (a config that stalls the validator stage for every future proposal).
- **F20 / F20b** — the blacklist pre-send guard was dead on every chain: it
  probed the **default** chain instead of the tx chain (token has no code there
  → silent skip), and called a non-existent `isBlacklisted(address)` selector.
  Now `checkBlacklist` takes the target `chainId` and pages the real
  `totalBlacklistAccounts()` / `getBlacklistAccounts()` API. A treasury transfer
  to a blacklisted recipient is refused **before** any transaction.

### Off-chain fixes

- **F21** — off-chain multi-option built the wrong backend type name
  (`default_multi_option_type`); the backend auto-provisions
  `default_multiple_option_type`. Fixed.
- **F22** — `dexe_proposal_build_offchain_for_against` and
  `offchain_settings(votingType=for_against)` built requests the DeXe backend
  **always** rejects: the product supports only single-option and multi-option
  off-chain voting (verified against the web app — the template form exposes
  only those two voting-type tabs — and the backend proposal-types endpoint).
  Both now return an explicit "not creatable — use single-option with
  ['For','Against']" error instead of an always-400 request. Vote/read paths for
  for_against are unchanged.

### DAO create / settings

- **F16** — `dexe_dao_create` now accepts a `documents` array (external DAO
  profile documents, e.g. a governance charter). Previously the field was
  hardcoded empty and dropped.
- **F18** — editing existing settings via `dexe_proposal_create`
  (`change_voting_settings`) no longer wipes each entry's `executorDescription`
  (the settings-JSON IPFS ref the frontend reads): blank entries are preserved
  by reading the current on-chain value first. The standalone build tool warns.

### Env

- `DEXE_RPC_URL_MAINNET` default note: the previous `mbsc3.dexe.io` endpoint can
  return the wrong `chainId`; use a standard BSC dataseed for chain 56.

## 0.24.1 — 2026-07-22

Full-verify campaign (2026-07-21, chain 97 + clean-room): every fix below was
found by exercising all 19 tool groups against live fresh SphereX-era pools,
then re-verified via tools after shipping.

### Campaign leg-4 fix batch: F1/F2/F7/F10 + K1/K2 (2026-07-21)

- **K1** — the BSC-testnet (97) `ContractsRegistry` address is baked into
  defaults (same deterministic deploy as mainnet, verified live). A zero-config
  install can now read AND predict/deploy on chain 97; previously every
  registry-dependent tool (incl. `dexe_dao_info`) failed with
  "No ContractsRegistry address known for chainId=97".
- **K2** — `docs/` ships in the npm package (`files` whitelist), so the
  `dexe://playbook` MCP resource exists in published builds. Without it the
  server registered no resources capability at all (`resources/*` → -32601).
- **F7** — `create_staking_tier` via `dexe_proposal_create` auto-resolves the
  `stakingProposal` address the way the frontend does
  (`GovUserKeeper.stakingProposalAddress()`); when it's not deployed yet the
  error says to send `GovUserKeeper.deployStakingProposal()` first. The param
  is now optional; primitive/read tool descriptions document the source.
- **F2** — `dexe_dao_create` runs the confirm-stage coherence checks
  (`deploy.min-votes`, `deploy.settings-bounds`) in the fast preflight, so the
  SIMPLE preview can no longer claim "config looks coherent" for a config the
  confirm call would reject.
- **F1** — the quorum-floor treasury advisory no longer sweeps the validator
  chamber's quorum (it is a % of the hand-picked validator token supply, not of
  votable DAO supply); a deliberate 30% validator quorum no longer warns.
- **F10** — deploy previews/builds emit a `[reward-economics advisory]` when
  any settings entry has non-zero rewards: 30% DeXe commission at execute,
  mint-on-shortfall dilution, silent zero-claims on an empty treasury, and the
  all-five-settings-ids rule. Advisory-only, never blocks.
- **F6 re-verify regressions** (commit edf5954): inbox `getPendingRewards`
  single-output unwrap crash and `getTotalVotes` field-1/field-3 mixup (the
  voter's stake is the THIRD output) — unvoted proposals now surface correctly.

### SphereX frontend-parity for vote/delegate (F4, campaign 2026-07-21)

SphereX-protected pools (every GovPool deployed since ~2026-07-06) revert raw
top-level `vote()`/`delegate()` with "SphereX error: disallowed tx pattern" —
proven with a real broadcast (status 0 on-chain), not just eth_call. The
frontend never sends them raw: it always wraps in `GovPool.multicall([...])`,
and that shape lands (status 1, verified live on chain 97).

- `dexe_vote_build_vote` / `dexe_vote_build_delegate` now emit
  `multicall([inner])` — the exact frontend shape (useGovPoolVote.ts /
  useGovPoolDelegate.ts). `undelegate` stays raw (allowed by SphereX).
- `dexe_proposal_vote_and_execute` bundles its deposit+vote steps into one
  `multicall([deposit?, vote])` payload, mirroring the frontend voter flow.
- `dexe_vote_build_multicall` now accepts a single-element batch (was min 2) —
  the frontend wraps even lone calls, and SphereX-era pools require it.
- Doc fix: `dexe_vote_build_erc20_approve` said the spender is "typically the
  GovPool" — deposits must approve the **GovUserKeeper**, never the GovPool.
- PLAYBOOK: SphereX error row extended with the vote/delegate case + the
  raw-call allow/deny map.
- New guardrail tests: `tests/tools/spherex-vote-shape.test.ts`.

## 0.24.0 — 2026-07-11

### One-shot DAO deploys: simulate before signing, classify every revert

The DAO deploy path is now guarded end-to-end so `dexe_dao_create` lands
first-try — no more signed transactions reverting because params were built
wrong. Every guard returns a concrete fix the calling model can apply verbatim.

- **Pre-sign eth_call simulation** (`src/lib/deploySim.ts`). The deploy is a
  single independent payload, so right before the wallet signs, the exact
  calldata is simulated from the deployer against live chain state. A provable
  revert **blocks the broadcast** with a classified cause + fix (no gas spent);
  an RPC transport failure only downgrades to a warning (fail-open).
  `dexe_dao_build_deploy` likewise **refuses to emit a provably-reverting
  payload** — new `skipSimulation: true` input is the deliberate bypass.
- **Deploy revert knowledge base** (`src/lib/deployRevertMap.ts`). Every known
  `deployGovPool` revert string (PoolFactory, ERC20Gov, GovSettings,
  GovValidators, SphereX — verified against the contract sources) maps to a
  stable slug + cause + fix. Used by the simulation verdict, the
  mined-but-reverted failure path (`knownCause` in the output), and the new
  PLAYBOOK "DAO deploy reverts → fix" table.
- **Calldata round-trip self-check** (`src/lib/deployGuard.ts`). The built
  calldata is decoded with the same Interface and field-diffed against the
  intended params — catches encode-time ABI/positional drift (the historical
  "pool name cannot be empty" revert) before anything is signed.
- **Name-collision pre-check.** `getCode(predictedGovPool)` before building:
  a name this deployer already used on this chain is now a deterministic build
  error instead of an on-chain "pool name is already taken" revert.
- **New coherence guards**: `checkValidatorsCoherence` (duplicate validators,
  zero balances, validator-settings bounds) and `checkCustomVotePower`
  (CUSTOM requires a deployed preset contract — verified via getCode — and
  well-formed initData; POLYNOMIAL initData overrides must match
  `__PolynomialPower_init`).
- **Post-deploy readiness probe.** On success, `dexe_dao_create` verifies the
  new govPool has code (`readiness.govPoolLive`) and returns `nextSteps` with
  the deposit-first first-proposal guidance (fresh pools reject the bundled
  multicall pattern — bug #35).
- **Golden-vector parity test** (`tests/lib/deployParity.test.ts` +
  `tests/fixtures/deploy-golden.json`). Builder output is byte-compared against
  an independently-declared frontend-order encoding (useCreateDAO.ts rules) and
  a frozen fixture — any future ABI or transform drift fails with a field-level
  diff.
- Docs: `dexe-create-dao` skill (simulation verdict semantics, new gotchas),
  tool descriptions, PLAYBOOK revert table, TOOLS.md. Fixed the stale
  "cap=0 = uncapped" line in the `dexe_dao_build_deploy` description
  (correct rule: cap ≥ mintedTotal > 0).
- Live testnet acceptance (2026-07-19, chain 97): one-shot deploy (SIMPLE +
  full ERC20/rewards/validators), 4/4 negative guards pre-sign, proposal
  create→vote→execute, full OTC cycle — green. PLAYBOOK fixes from the run:
  `change_voting_settings` settingsIds semantics (0 = default, 1 = internal)
  and the SphereX KB row now covers the execute-path block on
  `GovSettings.addSettings` for fresh pools (deterministic — use editSettings;
  affects `new_proposal_type`/`enable_staking`).

### Plugin: self-contained bundle, launched by `node` (no more `npx`)

The Claude Code plugin now ships a single esbuild bundle
(`dexe-plugin/server/index.mjs`, built by `npm run bundle:plugin`) and launches
it with plain `node` instead of `npx -y dexe-mcp@…`. This clears the Windows
`-32000` spawn failure of the npx launcher and drops the launch-time network
fetch — the plugin runs offline with no `node_modules` on the user's machine.
The bundle carries a trimmed `package.json` (version for the MCP handshake) and
`docs/PLAYBOOK.md` (backs the `dexe://playbook` resource) beside it.

Tool count unchanged (159); `dexe_dao_build_deploy` gains the `skipSimulation`
input.

## 0.23.1 — 2026-07-08

### Fix: env config now loads regardless of working directory (all OSes)

The server self-loads `.env`, but only from `process.cwd()` and the package
dir. An MCP host (the Claude Code plugin) launches `npx dexe-mcp` with an
arbitrary working directory — **not** the user's project — so a project `.env`
was silently missed and every `DEXE_*` var looked unset: `dexe_context` /
`dexe_doctor` showed `readonly`, `rpcConfigured:false`, `ipfsUploads:false`, and
no restart fixed it (there was no cwd where the plugin ever found the file).
This affected macOS, Linux, and Windows identically.

- **New universal location: `~/.dexe-mcp/.env`.** The server now also loads
  `.env` from the home config directory it already uses for `state.json` —
  resolved per-OS via `os.homedir()`, so it works from any folder on any
  platform. Load order (first existing file wins per key; host-injected OS env
  still beats all files): `$DEXE_ENV_FILE` → `<cwd>/.env` → `~/.dexe-mcp/.env`
  → `<pkgdir>/.env`.
- **New `DEXE_ENV_FILE`** — absolute-path override for CI/containers/hosts that
  can inject one variable but not a working directory.
- **`npx dexe-mcp init` / `/dexe-setup` now write to `~/.dexe-mcp/.env`** when
  running as an installed package (the previous target was the ephemeral npx
  cache dir, so the wizard's config vanished). A source checkout still uses the
  repo-local `.env`.

No action for setups that already worked; if a project `.env` wasn't being
picked up under the plugin, move it to `~/.dexe-mcp/.env`. Tool count unchanged.

## 0.23.0 — 2026-07-08

### SIMPLE-mode DAO creation: configurable min-votes and early completion

`dexe_dao_create` SIMPLE mode gains two optional fields, so common governance
requirements no longer force a hand-built ADVANCED `params` struct:

- **`minVotesTokens`** (whole tokens, default `"1"`) — the minimum token balance
  to both vote and create proposals (sets `minVotesForVoting` =
  `minVotesForCreating`). Scaled to 18-dec wei. The deploy's existing min-votes
  guard still rejects a value above the largest holder's allocation, with
  remediation. The default `"1"` is clamped to the distributed amount on dust
  supplies — unchanged behavior.
- **`earlyCompletion`** (default `true`) — end voting as soon as quorum is
  reached.

Both thread through the synthesized, coherence-checked config; the reachable-
quorum and ≥50%-floor safety proofs are unchanged. ADVANCED mode already exposed
these via the full `params` struct. No tool-count change (159 / 19 groups).

## 0.22.0 — 2026-07-07

### "Works like charm": full proposal-type coverage, auto-deposit voting, reliability hardening, AI playbook

The production-readiness release. Goal: an AI assistant serves "create a DAO /
create a proposal / vote / run an OTC sale" without investigating anything —
and every failure tells you exactly what to do next.

**Every proposal type, one call**
- `dexe_proposal_create` now wires **all 33 catalog types** (was 10):
  new external builders `manage_validators`, `validators_allocation`,
  `delegate_to_expert`/`revoke_from_expert` (+ catalog-style aliases),
  `add/remove_local/global_expert`, `token_sale_recover`, `token_sale_whitelist`,
  `create_staking_tier`, `change_math_model`, `blacklist`, `reward_multiplier`,
  `apply_to_dao`, `new_proposal_type`/`enable_staking` — byte-parity with the
  `dexe_proposal_build_*` tools (shared ABI fragments, no copies).
- Internal proposals (`change_validator_balances`, `change_validator_settings`,
  `monthly_withdraw`, `offchain_internal_proposal`) auto-route to
  `GovValidators.createInternalProposal` — the correct validators-only path.
- Off-chain types are rejected with the exact backend flow to run instead.
- `proposalType` is a **strict enum**: unknown values fail at validation with
  the full valid list (previously errored mid-flow).

**Voting that just works**
- `dexe_proposal_vote_and_execute`: `depositFirst` is now `boolean|'auto'`,
  **default `'auto'`** — deposits exactly the missing amount from the wallet
  (approve UserKeeper → deposit → vote), matching the frontend's bundled flow.
  `false` restores never-deposit.
- Non-Voting state errors name the per-state remedy (Defeated → new proposal;
  Succeeded/Locked → re-run with autoExecute; Executed → done).

**Human units everywhere**
- Every amount accepts raw smallest units (digits-only, unchanged) **or**
  human units with a decimal point (`"12.5"`), scaled by the token's REAL
  on-chain decimals — `voteAmount`, `token_transfer`/`withdraw_treasury`/
  `apply_to_dao` params, OTC buy.
- OTC `dexe_otc_buyer_buy` now converts the 18-dec-normalized amount to the
  payment token's native decimals for the balance check and the exact-amount
  approve — a <18-decimals payment token can no longer silently under-pay.

**Protocol compatibility**
- **SphereX fix (bug #35)**: newly deployed GovPools ship with SphereX
  protection that rejects the old `multicall([deposit, createProposalAndVote])`
  bundle with `"SphereX error: disallowed tx pattern"` — proposal creation on
  any fresh DAO was broken. `dexe_proposal_create` (and the OTC open-sale
  composite that rides it) now sends deposit and createProposalAndVote as
  separate sequential transactions; the partial-failure ledger makes the
  two-step sequence safely resumable. Caught by the new testnet golden-path
  E2E (`scripts/e2e-testnet.mjs`), verified live on chain 97.

**Reliability (the P1 batch)**
- Transport-level **RPC retry + fallback rotation**: all RPC env vars accept
  comma-separated URL lists; the zero-config public fallback ships multiple
  endpoints per chain; the signer path uses the same resilient factory (it
  previously bypassed even the flaky-RPC hint).
- **Mining-wait timeout** (`DEXE_TX_WAIT_TIMEOUT_MS`, default 180 s): a stuck
  tx returns "check dexe_tx_status" instead of hanging the tool forever.
- **Reverted ≠ success**: `receipt.status === 0` now surfaces as a failure
  everywhere (`dexe_tx_send` sets `isError` + `reverted:true`; composites stop
  before dependent steps run on unchanged state).
- **Partial-failure ledger**: composite flows return `mode:"failed"` with
  `failure.{failedStep, error, landedSteps, resume}` — fix the cause and
  re-run the same call; completed steps are detected on-chain and skipped.
- **Startup env validation**: invalid `DEXE_*` values now fail fast at boot
  with the var name (doctor already flagged them). New schema vars:
  `DEXE_TX_WAIT_TIMEOUT_MS`, `DEXE_MAX_DESCRIPTION_LEN`, `DEXE_PROTOCOL_REF`.
- **`chainId` on every read**: 19 read tools no longer hardcode the default
  chain (proposal/vote/read_*/gov/inbox/dao/forecast/OTC status + list).

**AI ergonomics**
- **`docs/PLAYBOOK.md`** (new): intent → exact-call table, all-33 proposalType
  params reference, error → remedy table, unit conventions, toolset map,
  signer bootstrap + faucets. Served as MCP resource `dexe://playbook`;
  drift-guarded by tests.
- `dexe_context` reports enabled vs hidden toolsets and what each hidden set
  unlocks, plus the exact `DEXE_TOOLSETS` fix.
- MCP handshake now reports the real package version (was hardcoded `0.1.5`).
- Missing-Pinata errors are a numbered 3-step guide; the OTC open-sale
  description stops pointing at a dev-gated tool.

**Migration notes** (details in `docs/MIGRATION.md`)
- Unknown `proposalType` strings are rejected at validation.
- Scripts that treated mined-but-reverted txs as success must check
  `isError`/`reverted`.
- `depositFirst` default changed `false` → `'auto'` (may broadcast
  approve+deposit when power is short; pass `false` for the old behavior).
- Invalid `.env` values now stop startup.

## 0.21.0 — 2026-07-06

### One-call avatar updates + file-path uploads

"Update the DAO avatar, here's the image" used to take three tools and a
context-busting file read: the agent had to read the image from disk, base64
it through the conversation, call `dexe_ipfs_upload_avatar`, then thread the
CID into `dexe_proposal_create`. Now the server reads local files itself.

- **`newAvatarPath` on `dexe_proposal_create`** (modify_dao_profile) and
  **`avatarPath` on `dexe_dao_create`**: pass a local image path; the server
  reads, magic-byte-validates, pins, and wires the CID — one call total.
  `newAvatarBase64` also accepted; combining path and CID inputs errors.
- **`filePath` on `dexe_ipfs_upload_avatar` (10 MB cap) and
  `dexe_ipfs_upload_file` (25 MB cap)** as the preferred alternative to base64.
- Shared implementation in `src/lib/avatarUpload.ts`
  (`pinAvatarFromInput` / `readAvatarInput`; `buildAvatarUrl` moved here).
- `modify_dao_profile` with a by-reference `newAvatarCID` now gets the same
  best-effort fetch-and-sniff gate as the other by-CID paths (v0.20.0), and
  `dexe_dao_create` honours `DEXE_IPFS_AVATAR_GATEWAY` instead of hardcoding
  dweb.link.
- De-escalated agent guidance: server instructions and the
  `dexe-create-proposal` skill no longer mandate `dexe_context` first when the
  user already named the target; both now tell agents to pass image paths
  instead of reading files.

## 0.20.1 — 2026-07-06

### Composite flows render the WalletConnect QR inline

The v0.18.0 "instant QR" only covered `dexe_wc_connect` / `dexe_tx_send` /
`dexe_wc_status` — those return the QR as real MCP content blocks (ASCII +
`image/png`), which clients render inline. The composite write flows
(`dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_dao_create`,
OTC buy/claim/open-sale) buried the pairing QR inside the JSON `pairing`
field instead, so no client could render it and assistants fell back to
hand-rolled PNG files and deep-link strings.

- `sendOrCollect`'s no-signer branch now also returns ready-to-attach QR
  content blocks; all six composite return sites prepend them via a shared
  `attachPairingQr` helper — identical presentation to `dexe_wc_connect`.
- New `wcQrBlocks()` in `src/lib/qr.ts` (the scannable blocks without the
  JSON envelope); `wcPairingContent()` now composes it.
- The JSON `pairing` field stays for programmatic callers but drops the
  escaped `ascii` dump in favour of `qrFallbackUrl` + an accurate `renderHint`.
- `dexe_otc_dao_open_sale` re-parses the proposal_create envelope from the
  last text block (it may now lead with QR blocks) and preserves them.

## 0.20.0 — 2026-07-06

### Avatars: real JPEG generation + magic-byte validation (bug #34)

`dexe_dao_generate_avatar` pinned **SVG bytes under an `avatar.jpeg` name**.
The DeXe serving chain makes that unrenderable: the Go `ipfs-cache` service
copies avatar bytes to R2 as `<descCid>.jpeg` with a hardcoded `image/jpeg`
content-type (no byte inspection), the app.dexe.io `<img>` has no error
fallback after a successful GET, and browsers never content-sniff SVG — so
every generated avatar showed as a permanently broken image (hit live on the
Generative Collective DAO, `0x3910…d622`).

- **`dexe_dao_generate_avatar` now renders a real JPEG** (`src/lib/avatarImage.ts`):
  pixel initials (embedded 8x8 font, public-domain font8x8) over the same
  hash-coloured diagonal gradient, encoded with `jpeg-js` (pure JS, no native
  deps). Colour hash unchanged (djb2), so re-generated avatars keep their
  palette. Deterministic: same `daoName` → byte-identical file.
- **Magic-byte validation on every avatar upload path**
  (`src/lib/imageSniff.ts`): only real rasters — JPEG/PNG/WebP/GIF — are
  accepted; SVG, HTML, and unrecognized bytes are rejected with an actionable
  error. Applied to `dexe_ipfs_upload_avatar` (which now also pins with the
  *sniffed* MIME, not the caller's claim, and returns `detectedFormat`) and to
  `dexe_ipfs_upload_file` on its `.jpeg`-normalized (avatar-contract) path —
  `normalizeImageExt: false` is the escape hatch for generic image attachments
  (e.g. a legitimate SVG logo pinned as `image/svg+xml`).
- **By-reference avatar CIDs are validated too.** `dexe_ipfs_upload_dao_metadata`,
  `dexe_ipfs_update_dao_metadata`, and `dexe_dao_create` accept an `avatarCID`
  pinned elsewhere; they now fetch the first KB of `<cid>/<fileName>` off the
  gateway chain and sniff it — confirmed non-raster bytes hard-block, an
  unreachable pin (fresh, not yet propagated) proceeds with a warning.
- Docs: `docs/PROFILE.md` gains a troubleshooting entry for the
  "HTTP 200 but broken image" case; `docs/TOOLS.md` rows updated.
- New dep: `jpeg-js@0.4.4`. Tool count unchanged.

Existing DAOs with an SVG avatar stay broken until rotated: re-generate with
v0.20.0+, then `dexe_ipfs_update_dao_metadata` → `modify_dao_profile`
proposal → vote + execute.

## 0.19.0 — 2026-07-06

### DAO creation: governance coherence guards + frontend parity

`dexe_dao_create` could ship broken/reverting DAOs — it invented no defaults, ran
no coherence checks, and carried assumptions that diverged from the frontend
(`investing-dashboard`, the 3-year production source of truth that deploys to BSC
mainnet daily). Reconciled the whole path to the frontend.

- **SIMPLE mode.** `dexe_dao_create` now takes high-level fields (`symbol`,
  `totalSupply`, optional `treasuryPercent`/`quorumPercent`/`voteModel`/
  `durationSeconds`) and synthesizes a coherent, frontend-equivalent deploy
  config — LINEAR power, treasury as an **implicit remainder**, a reachable
  quorum. It returns a `mode:"preview"` (resolved config + safety proof) and only
  broadcasts on a second call with `confirm:true`. ADVANCED mode (full `params`)
  still works. `params` is now optional.
- **Governance coherence guards** (`src/lib/preflight.ts`, enforced in
  `buildDeployGovPool` for both `dexe_dao_create` and `dexe_dao_build_deploy`),
  mirroring the frontend's blocking validation:
  - `checkQuorumReachable` — `quorum% × supply ≤ votable tokens` (treasury/
    undistributed tokens can't vote). LINEAR exact; POLYNOMIAL via a port of the
    frontend `calcMeritocraticVotingPower`. **Hard block.**
  - `checkMinVotesVsDistribution` — `minVotesForVoting/Creating ≤ largest
    recipient`. **Hard block.**
  - `checkSettingsBounds` — `0<quorum≤1e27`, `duration>0`, etc. (`GovSettings.sol`).
  - `checkNoTreasuryRecipient` — the predicted govPool must never be in
    `tokenParams.users[]`.
- **Corrected the cap rule (verified live on mainnet via eth_call).** The gov
  token is `ERC20Capped`: `cap = 0` reverts (`ERC20Capped: cap is 0`) — there is
  **no uncapped mode** — and `cap < mintedTotal` reverts. `cap == mintedTotal` is
  a valid fixed supply (old bug #28 "cap==minted reverts" is outdated). New rule:
  `cap ≥ mintedTotal > 0`. `checkDeployCap` + the deploy builder now enforce it;
  SIMPLE mode sets `cap = totalSupply`.
- **Reversed the treasury-remainder rule (old bug #32 was wrong — verified live).**
  A treasury remainder (`sum(amounts) < mintedTotal`) deploys fine on mainnet — the
  contract mints the remainder to the DAO. `checkTreasuryRemainder` now only rejects
  OVER-distribution (`sum > minted`), on all chains. The prior "mainnet needs
  `mintedTotal == sum(amounts)`" belief forced the treasury address into the voter list.
- **Mainnet is NOT broken.** Dropped the false "mainnet deployGovPool reverts /
  `require(false)`" gating text. Mainnet (56) is a supported target; it just
  requires `confirm:true` (spends real BNB). Testnet-first is a recommendation.
- Default vote model = **LINEAR**; default quorum **51%** with a ≥50% advisory
  floor. No new tools.

## 0.18.0 — 2026-07-06

### WalletConnect QR + hot-key "NOT SAFE" warnings

WalletConnect is now the clearly-primary signer, and pairing takes zero copy-paste.

- **`dexe_wc_connect` renders a scannable QR**, not a raw URI. It returns both a
  terminal ASCII QR (scannable in a bare terminal, no browser, no external
  service) **and** an `image/png` MCP content block (crisp QR in GUI clients).
  The raw `uri` + an `api.qrserver.com` fallback URL are still included. New
  helper `src/lib/qr.ts` (lazy-imports `qrcode`, so read-only installs pay
  nothing and a missing install degrades gracefully).
- **Auto-print QR when a write needs a wallet.** `dexe_tx_send` in WalletConnect
  mode with no session now *starts pairing and prints the QR* instead of
  erroring "call dexe_wc_connect". The composite flows (`dexe_dao_create`,
  `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, OTC) attach a live
  `pairing` QR to their read-only response. (Composites still emit payloads to
  feed to `dexe_tx_send` — no WC broadcast routing inside composites.)
- **Hot keys are flagged "⚠️ NOT SAFE" everywhere.** Every `dexe_tx_send`
  hot-key broadcast carries a `safety` field; `dexe_get_config` reports
  `recommendedSigner: "walletconnect"` + a `safety` note; `dexe_doctor` adds a
  `signer.hotKey` advisory; the startup log warns about the plaintext key.
- **`dexe_wc_connect` no longer refuses when `DEXE_PRIVATE_KEY` is set** — it
  pairs and tells you the hot key still takes signing precedence until removed
  (non-breaking: key-wins precedence is unchanged).
- New: `WalletConnectManager.ensurePairing()` (reuses an in-flight URI / live
  session). No new tools — tool count unchanged.

## 0.17.0 — 2026-07-06

### Zero-config public defaults + guided setup

A fresh install is now useful immediately — **reads and WalletConnect signing
work with no `.env` at all.** The plugin ships public defaults, all overridable
by a user `.env` (env value always wins).

- **Baked defaults** (`src/config.ts` `DEFAULTS`): DeXe backend (`api.dexe.io`),
  a shared WalletConnect project id, and the three DeXe subgraph URLs (The Graph
  decentralized network, modern `gateway.thegraph.com` host, key embedded in the
  path — no standalone `DEXE_GRAPH_API_KEY` needed, which also removes the old
  Bearer-vs-URL key mismatch). RPC public fallback + the chain-56 registry were
  already baked.
- **IPFS reads default to public gateways** (ipfs.io, dweb.link, cloudflare) when
  no dedicated gateway is set. New `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1` opt-out.
- **Behavior change:** with no hot key, `signerMode` is now `walletconnect`
  (WalletConnect available) instead of `readonly`. Signing is still gated on an
  actual `dexe_wc_connect`; `address` stays `null` until you connect.
- **Runtime hints instead of bare errors.** A failing public-RPC call now carries
  a "set a private RPC" nudge (only for the public fallback, never your own RPC;
  contract reverts pass through untouched). A failing all-public IPFS fetch nudges
  toward a dedicated gateway. The Pinata-JWT block on create flows now uses a
  shared, actionable message pointing at `/dexe-setup`.
- **`dexe_doctor`** validates the *default* subgraph + backend endpoints (no
  longer skipped when unset) and adds an `env.sharedDefaults` advisory — the
  shared Graph key + WC id are billable-shared, so heavy users should bring their
  own. `dexe_context.env` gains `usingSharedDefaults`, `ipfsReads`,
  `walletConnectAvailable`, and `usingPublicRpcFallback`.
- **`/dexe-setup` rewritten** as a tiered "skip → what breaks" journey, plus a
  once-only SessionStart onboarding nudge shipped with the plugin.
- Docs: `docs/ENVIRONMENT.md` gains a baked-defaults table + key-rotation note;
  `.env.example` reframed around optional overrides with current var names.

No new tools (159). No breaking config changes — every default is overridable.

## 0.16.0 — 2026-07-04

### Backend-powered treasury + holder/stats/NFT reads (156 → 159 tools)

`dexe_read_treasury` used to require an on-chain multicall with an explicit
token list and reverted ("missing revert data") on any address that wasn't a
GovPool — useless for reading a real DAO treasury. The app.dexe.io UI never
does this; it reads balances from the DeXe backend
(`api-proxy-cache/<chain>/wallet-balances/<addr>`, Moralis-backed). We now copy
that logic and expose the sibling backend endpoints too.

- **`dexe_read_treasury` (rewritten).** Backend-first: auto-discovers every
  token, returns `symbol`/`name`/`decimals`/`balance` + `usdPrice`/`usdValue`
  per token and a `totalUsd`, following `next_page_token`. Adds a `chainId`
  input and `source: backend|rpc` to the output. RPC multicall retained as
  fallback for testnet 97, explicit `tokens`, or unset/unreachable
  `DEXE_BACKEND_API_URL`. Works on any address, not just GovPools.
- **`dexe_read_token_holders` (new).** Holders + raw balances of any ERC20 via
  `token-holders-balances/<token>`, sorted descending. Backend-only.
- **`dexe_read_dao_stats` (new).** DAO TVL + member/proposal/delegation time
  series via `tracker/<chain>/pools/gov/<dao>/stats/<period>`. `period` is a
  human duration (`'7 days'`). Backend-only.
- **`dexe_read_nfts` (new).** NFTs held by any address via
  `nfts-by-wallet/<addr>` (Moralis), optional contract filter. Backend-only.
- Shared `backendGetJson()` helper (`DEXE_BACKEND_API_URL`, 8s timeout,
  paste-ready error when unset). All three new tools join the `read` toolset
  (29 → 32).

## 0.15.0 — 2026-07-04

### One-command install — Claude Code plugin + zero-config reads

Onboarding overhaul: an average user should install dexe-mcp from inside Claude
with no terminal, no JSON editing, and no env vars until they actually want to
write. No new MCP tools (still 156); this is packaging, CLI, and docs.

- **Claude Code plugin + marketplace.** New `.claude-plugin/marketplace.json`
  (repo root) and `dexe-plugin/` (`.claude-plugin/plugin.json` + `mcp.json` +
  the shipped skills). Users install in-session:

  ```
  /plugin marketplace add edward-arinin-web-dev/dexe-mcp
  /plugin install dexe@dexe-mcp
  ```

  The plugin registers the MCP server (launched via `npx -y dexe-mcp@0.15.0`,
  version pinned) and auto-discovers the governance skills — namespaced
  `dexe:<skill>`. Both manifests pass `claude plugin validate`.
- **Zero-config reads (server-side public-RPC fallback).** When no RPC is
  configured, `loadConfig()` seeds public BSC endpoints (chains 56 + 97, default
  **56**) so `dao_info` / `read_treasury` / etc. work out of the box — the plugin
  ships **no env**, so there is no `.claude.json`-shadow trap. Public dataseed
  nodes rate-limit and lack archive history: a startup banner + a
  `chain.publicRpcFallback` doctor advisory nudge users to set their own RPC.
  Opt out with `DEXE_DISABLE_PUBLIC_RPC=1`. `DexeConfig` gains
  `usingPublicRpcFallback`. (A private key set without an RPC now signs against
  the public fallback rather than erroring; guards still apply — set your own RPC
  for reliable broadcasting.)
- **Project `.env` reaches the server (writes path).** `src/index.ts` now loads
  the **project (cwd) `.env` first**, then the package-relative `.env`. This is
  what makes `/dexe-setup` (which edits the project `.env`) reach a server
  launched via `npx` from the plugin, whose package dir sits in the npx cache.
- **`npx dexe-mcp skills` — skills-only, no env interview.** New non-interactive
  subcommand (`--global` for `~/.claude/skills`), reusing `installSkills()`. And
  `init` now opens with a top-level choice — *just skills* / *full setup* /
  *both* (or `init --skills-only`) — so it never dives into the env wizard
  unasked. Fixes the reported "I only wanted the skills" onboarding surprise.
- **Skills relocated** to `dexe-plugin/skills/` (single source of truth for both
  the plugin and the CLI copy). `package.json` `files` updated accordingly.
- **Docs.** README leads with a no-terminal **Install in Claude Code** block;
  new [`docs/INSTALL.md`](docs/INSTALL.md) (non-technical, plugin-first);
  `SETUP.md` / `SKILLS.md` / `ENVIRONMENT.md` updated for the plugin path, the
  `skills` subcommand, the public-RPC fallback, and the project-`.env` load.

## 0.14.0 — 2026-07-04

### Persistent state + `dexe_context`

Phase 3 of the reliability/token plan: stop starting every session from zero.

- **`dexe_context` (new tool; core profile; +1 → 156 tools).** One read that
  orients an agent: signer + mode, active/configured chains, env readiness, and
  the persisted operational state — DAOs deployed and proposals broadcast in
  prior sessions — plus deposited voting power in the most recent DAO. Server
  `instructions` now say to call it first.
- **Persistent state store** (`src/lib/stateStore.ts`). Versioned JSON at
  `DEXE_STATE_PATH` (default `~/.dexe-mcp/state.json`), atomic write (temp +
  rename), tolerant load (missing/corrupt/newer → empty, never throws).
  `dexe_dao_create` auto-records the deployed DAO and `dexe_proposal_create`
  auto-records a broadcast proposal — both best-effort (a state-write error
  never breaks a broadcast).
- **`DEXE_STATE_PATH` env** added to `ENV_SPEC`, `loadConfig()`, `.env.example`,
  and `docs/ENVIRONMENT.md`. `dexe_doctor` gains a writable-path check for it.
- **Tests** — `tests/lib/stateStore.test.ts` (atomic write, dedupe, corrupt/
  version-mismatch tolerance, wallet labels); `gate.test.ts` updated to 156 and
  asserts `dexe_context` in the default profile.
- Skills updated to start with `dexe_context`.

## 0.13.0 — 2026-07-04

### Toolset profiles — slim default (BREAKING)

Phase 2 of the reliability/token plan: cut the per-session `tools/list` cost by
gating which tools register.

- **`DEXE_TOOLSETS` gating** (`src/tools/gate.ts`). Named profiles — `core`,
  `proposals`, `read`, `vote`, `governor`, `dev`, `full` — select which of the
  155 tools load. `TOOLSETS` maps each profile to an exact tool-name set; the
  union of the six named sets equals the full surface (asserted in tests), so
  every tool is reachable under some profile. Applied as a one-line proxy wrap
  in `registerAll()` — the 30+ register files are unchanged. A typo/unknown set
  name falls back to `full` (never silently strips).
- **BREAKING: default is now `core,proposals`** (~71 tools), not all 155.
  Measured `tools/list`: full **205 KB** → default **111 KB (−46%)**; the
  max-slim `DEXE_TOOLSETS=core` is **48 KB (−77%)**, viable because
  `dexe_dao_create` / `dexe_proposal_create` cover the common flows server-side.
  See [MIGRATION.md](docs/MIGRATION.md#012x--0130--slim-default-toolset-breaking).
- **`DEXE_TOOLSETS` env** added to `ENV_SPEC`, `loadConfig()`, `.env.example`,
  and `docs/ENVIRONMENT.md`. `dexe_doctor` now reports the active profile,
  loaded-tool count, and the `full` restore hint. Startup stderr banner states
  the active profile.
- **Expanded server `instructions`** (~700 chars): prefer the composite flow
  tools, approve UserKeeper not GovPool, testnet-first deploys, the toolsets
  hint, and the shipped-skills hint.
- **Tests** — `tests/tools/gate.test.ts`: per-profile resolution, union==155,
  every set-name is a real tool, default subset assertions, and a real
  in-memory `tools/list` size measurement.
- Note: the plan's "slim `dexe_compile` schema" item was moot — the current
  `dexe_compile` input schema is already a single field (the 11 KB/49-field
  figure was stale). The token win is the gating above.

## 0.12.0 — 2026-07-03

### Flow-first facade + preflight guards + shipped skills

Phase 1 of the flow-reliability plan: "create a DAO" / "create proposal X" is now
**one tool call** with server-side validation, and the recurring failure modes are
encoded as guards + installable skills instead of re-derived each session.

- **`dexe_dao_create` (new composite tool)** — one-call DAO deploy: uploads DAO
  profile metadata to IPFS, builds `PoolFactory.deployGovPool` (reusing the exact
  predicted-address wiring / settings auto-expand / executorDescription upload
  from `dexe_dao_build_deploy`, now extracted to a shared `buildDeployGovPool`),
  pre-flights the four silent-revert modes, then signs+broadcasts (or returns the
  payload). Validate on BSC testnet (chain 97). Tool count 154 → **155**.
- **`dexe_proposal_create` extended to catalog types** — `proposalType` now
  accepts `token_transfer`, `withdraw_treasury`, `change_voting_settings`,
  `add_expert`, `remove_expert`, `token_distribution`, `token_sale`, and
  `custom_abi` (inputs passed in `params`); the tool builds correct calldata +
  IPFS metadata server-side via a shared builder registry
  (`src/lib/proposalBuilders.ts`, byte-parity-tested). Any other catalog type
  returns an actionable error naming its dedicated `dexe_proposal_build_*` tool.
- **Preflight guard library** (`src/lib/preflight.ts`) — named checks with
  remediation for the 10 documented failure modes: canonical proposal-metadata
  zod shape, approve-UserKeeper-not-GovPool, deposited-power vs votingPower,
  locked-tokens-between-proposals, deploy cap>minted / LINEAR initData /
  non-zero userKeeper asset / mainnet treasury remainder, single-sourced
  ProposalState ordering, avatar-is-JPEG, off-chain type/quorum, blacklist
  recipient. Wired into `dexe_proposal_create` and `dexe_dao_create`.
- **Shipped skills** (`skills/` → published in the npm package) —
  `dexe-create-dao`, `dexe-create-proposal`, `dexe-vote-execute`, `dexe-otc`,
  `dexe-setup`: exact tool-sequence recipes with the relevant failure modes and
  the chain-97-first rule. `npx dexe-mcp init` now offers to install them into
  `./.claude/skills` (project) or `~/.claude/skills` (global), idempotently. New
  [`docs/SKILLS.md`](docs/SKILLS.md).
- **Tests** — `tests/lib/preflight.test.ts` (per-guard) and
  `tests/lib/proposalBuilders.test.ts` (calldata byte-parity + registry coverage).

## 0.11.1 — 2026-07-03

### OTC date clarity (UTC)

- **Human-readable UTC tier times** (`dexe_otc_buyer_status`,
  `dexe_otc_list_sales_for_dao`): both tools now emit `saleStartTimeUTC` and
  `saleEndTimeUTC` alongside the raw Unix `saleStartTime`/`saleEndTime`, e.g.
  `"2026-07-03 17:45:59 UTC"`. Raw seconds are unambiguous to machines but
  confuse people (and read as local time in some UIs); the explicit `UTC`
  suffix removes any doubt. Verified against the live frontend, which labels
  the same tier as "5:45 PM UTC". The `0` sentinel (unset time) renders as an
  empty string rather than a misleading 1970 epoch. New `src/lib/time.ts`
  helper `unixToUtc`, covered by `tests/lib/time.test.ts`. Additive only —
  existing raw fields are unchanged. No tool-count change (154 tools).

## 0.11.0 — 2026-07-03

### OTC contract/frontend alignment (audit 2026-07-03)

Cross-checked every OTC tool against `ITokenSaleProposal.sol` and the
app.dexe.io frontend (`investing-dashboard`). Four bugs fixed, one guard and
one compat gap closed:

- **Native-coin sentinel** (`dexe_otc_buyer_buy`,
  `dexe_vote_build_token_sale_buy`): the contract keys exchange rates by
  `Globals.sol::ETHEREUM_ADDRESS` (`0xEeee…EEeE`); the tools previously
  encoded the zero address, which reverts `TSP: incorrect token`. The zero
  address is still accepted as caller input but calldata now always carries
  `ETHEREUM_ADDRESS`; the low-level builder also auto-sets `value = amount`
  for native buys (contract requires `msg.value == amount`).
- **`getTierViews` decode ABI** (`dexe_otc_buyer_status`,
  `dexe_otc_list_sales_for_dao`): the contract returns the nested
  `TierView { tierInitParams, tierInfo, tierAdditionalInfo }`; the tools
  declared a flat pre-Bug-#25 layout that decoded garbage on live tiers.
  Both now share one canonical fragment (`TIER_VIEW_TUPLE`), and
  `list_sales_for_dao` gains real `totalSold` plus an `off` status from the
  tier's on-chain `isOff` flag.
- **Merkle proofs in `dexe_otc_buyer_status`**: supplied whitelists are now
  turned into proofs *before* the read and passed into
  `getUserViews(user, tierIds, proofs)` — previously empty proofs made
  `canParticipate` false for whitelisted users of merkle tiers. The response
  also surfaces the on-chain merkle root and a `rootMatchesOnchain` check.
- **Zero-address purchase token rejected** in the tier builders: such a tier
  is unbuyable on-chain; the error points at `ETHEREUM_ADDRESS`.
- **Merkle whitelist IPFS upload** in `dexe_otc_dao_open_sale`: app.dexe.io
  buyers regenerate proofs from the `{ list }` JSON behind the tier's merkle
  `uri`; tiers created with an empty uri were unbuyable through the frontend.
  The composite now auto-uploads the list (`ipfs://<cid>`, frontend
  `IpfsEntity.path` format) and reports it under `otc.merkleWhitelistUploads`.
- **Compat harness un-rotted**: the H-10 human-percent `vestingPercentage`
  change had broken `tests/compat` fixture replay unnoticed (the script was
  not in CI). Generator + fixture updated; `npm run test:compat` now runs in
  the CI build job.

## 0.10.0 — 2026-06-03

### Treasury-safety advisory (low-quorum governance check)

Low quorum reduces the participation required to pass a proposal, which is a
governance-safety risk for a DAO that holds treasury assets. The durable control
is an adequate on-chain quorum threshold configured per DAO; this release adds an
**advisory-only** layer in the MCP that flags treasury-moving proposals under a
low quorum so an operator/agent verifies the setting and stakeholder
participation before executing.

The MCP layer **never blocks** — it surfaces a clear alert and proceeds. It is
harm-reduction for a legit operator/agent configuring a DAO, not an access
control.

- **New** `src/lib/quorumRisk.ts` — pure logic: treasury-action classifier
  (approve/transfer/transferFrom/increaseAllowance/nft/native), quorum-pct math
  (1e27 scale), `judgeQuorum`/`quorumConcentration` verdicts, advisory strings.
- **New env** `DEXE_MIN_SAFE_QUORUM_PCT` (default 50) + `DEXE_TREASURY_GUARD`
  (`off`|`warn`, default `warn`; `warn` = advisories everywhere, `off` = silent).
- **DAO deploy** (`dexe_dao_build_deploy`), **`change_voting_settings`**, and the
  **treasury builders** (`withdraw_treasury`, `token_transfer`, `apply_to_dao`,
  `custom_abi`, `build_external`) attach a below-floor / treasury-risk advisory.
- **`dexe_proposal_vote_and_execute`** attaches a treasury-risk advisory to the
  execute step when the proposal moves treasury value and quorum is below the
  floor (or no controlling member voted For). It **executes regardless** — the
  alert is informational; fail-soft on read errors.
- **New tool** `dexe_proposal_risk_assess` (153 → **154**) — quorum %, treasury
  at risk, the indicative share of supply required to meet quorum, verdict
  (SAFE/CAUTION/DANGER) + recommendation, for an on-chain proposal or hypothetical
  actions.
- **Phase B** — founder/validator participation signal. **New**
  `src/lib/controllingVoters.ts` (`resolveControllingHoldersVotedFor`): enumerates
  the "controlling set" (validators ∪ top-N token holders by voting weight) via
  subgraph, then confirms each member's vote direction **on-chain** via
  `GovPool.getTotalVotes` (OR across Personal/Micropool/Delegated). Surfaced in
  `dexe_proposal_risk_assess` and the execute advisory as an informational flag
  when **no** controlling member voted For (even at healthy quorum). **New env**
  `DEXE_CONTROLLING_TOPN` (default 5). Subgraph + mainnet (56) only; off-chain/
  testnet/error ⇒ `null` (unknown). **Never blocks.**
- No `acknowledgeRisk` override anywhere — there is nothing to acknowledge; the
  guard does not block. Tool count unchanged (**154**).

## 0.9.0 — 2026-06-02

### Security hardening (red-team audit remediation)

Remediates the `dexe-mcp@0.7.2` red-team audit. The most severe finding was
guarded in 0.8.3; this release closes the remaining MCP-fixable findings. Each fix
shipped as its own PR with a locking regression test, CI green throughout.

#### Fixed — builders & numeric safety
- **H-8 / H-9** — amount/id fields are validated (`^[0-9]+$`) before `BigInt()`
  (`src/lib/amount.ts`), so empty/hex/negative values no longer silently
  mis-encode; documented the on-chain `from18Safe` 18-decimal normalization on
  the token-sale `buy` builders.
- **H-4** — `apply_to_dao`'s short-treasury branch transfers what the treasury
  holds (not the full amount) and mints the shortfall, so the proposal no longer
  reverts on execution.
- **H-10** — tier `vestingPercentage` is scaled by `PRECISION` (×1e25); raw
  values no longer silently disable vesting, and out-of-`[0,100]` is rejected.
- **W29** — OTC `buyer_buy` approves the exact amount, never `MAX_UINT256`.
- **W39** — `read_staking_info` ABI matches the deployed `IStakingProposal`
  (9-field `StakingInfoView`, 8-field `TierUserInfo`); a decode mismatch is
  surfaced, not silently emptied.

#### Fixed — disclosure, decode & data channels
- **W36** — RPC provider API keys are redacted from tool output and errors
  (`src/lib/redact.ts`); `get_config` masks the keyed RPC URL.
- **H-13 / W24** — attacker-controlled on-chain/IPFS strings are sanitized
  before rendering (`src/lib/sanitize.ts`): control chars escaped, NFKC
  normalized, non-ASCII flagged — defeats prompt-injection / newline-forgery /
  homoglyph spoofing.
- **Recursive decode** — `decode_calldata` / `decode_proposal` recursively
  unwrap nested `multicall` / `createProposal` / … and flag privileged selectors
  so a reviewer sees hidden inner calls.
- **W20** — `ipfs_fetch` verifies fetched bytes against the requested CID
  (raw/json codecs) and rejects a mismatch.
- **W21 / L-6** — the Graph API key is only sent as a Bearer to trusted
  `*.thegraph.com` hosts.

#### Fixed — signer, flow & infra
- **H-12** — broadcasts are serialized per chain (no nonce collision);
  `tx_status` distinguishes `not_found` from `pending`.
- **W10** — the composite flow verifies `govPool` against the canonical
  `PoolRegistry` and approves the exact deposit amount, not `MAX_UINT256`.
- **H-1 / H-2** — protocol bootstrap runs `npm install --ignore-scripts` and
  supports pinning the clone via `DEXE_PROTOCOL_REF`.
- **H-3** — `markdownToSlate` rejects input over a length cap
  (`DEXE_MAX_DESCRIPTION_LEN`, default 16384) before the super-linear parse.
- **L-1** — the Safe-TX propose path now applies the B6 (allowlist) + B7
  (value-cap) guards.

#### Added
- `dexe_proposal_vote_and_execute` gains a `dryRun` flag (preview without
  broadcasting), matching `dexe_proposal_create`.
- Protocol-property advisories (`src/lib/protocolAdvisories.ts`) surfaced in the
  `change_voting_settings`, `change_math_model`, and `custom_abi` previews.
- New env vars: `DEXE_PROTOCOL_REF`, `DEXE_MAX_DESCRIPTION_LEN`.

### Docs
- **`docs/SECURITY.md`** — security posture and remediation summary.

### Notes
- `list_gov_contract_types` PoolRegistry source path corrected to
  `contracts/factory/PoolRegistry.sol`.
- Verified non-bugs (no change): H-5 (`cap=0` already guarded as uncapped),
  H-7 (the `uniswap.json` timelock is the correct Uniswap Timelock).
- Tool surface unchanged: still **153 tools across 19 groups**.

## 0.8.3 — 2026-06-01

### Security: guardrail for privileged proposal-action selectors

Hardening from the `0.7.2` red-team audit. Certain `GovUserKeeper` `onlyOwner`
accounting functions are privileged and must never be encoded as a governance
proposal action. This release adds an MCP-side guard so the proposal builders
refuse to construct such actions. Defense-in-depth at the MCP layer.

### Added

- **`src/lib/dangerousSelectors.ts`** — denylist of the 12 `GovUserKeeper`
  `onlyOwner` accounting selectors (deposit / withdraw / delegate / undelegate,
  token + NFT + treasury variants) that must never be a proposal-action target.

### Changed

- **`dexe_proposal_build_custom_abi` and `dexe_proposal_build_external` now
  hard-refuse** (no override) any action whose calldata carries a denylisted
  selector. Defense-in-depth at the MCP layer — users move their own funds
  through the GovPool entrypoints, never via a proposal action.

### Notes

- Tool surface unchanged (no tools added/removed) — **153 tools / 19 groups**.
  Corrected a stale README count: the badge said `149` and the catalog
  header/group table said `152` (the table was missing `dexe_doctor`). All now
  read `153`. `docs/TOOLS.md` was already correct at 153.

## 0.8.2 — 2026-06-01

### Modify DAO profile — partial-update preservation + isMeta guard

Two fixes to `dexe_proposal_create`'s `modify_dao_profile` flow so the
round-trip to `app.dexe.io` actually renders.

### Fixed

- **`modify_dao_profile` no longer wipes unchanged fields.** The builder
  now fetches the current DAO metadata from IPFS (using
  `DEXE_IPFS_GATEWAY` / `DEXE_IPFS_GATEWAYS_FALLBACK`, with a public
  read-only fallback if neither is set) and merges the caller's inputs
  on top. Previously, passing only `newAvatarCID` would write empty
  strings for `daoName`, `websiteUrl`, `description`, and `[]` for
  `socialLinks` / `documents`, bricking the DAO header. Only fields the
  caller explicitly supplies are replaced now.
- **`isMeta` is forced to `false` for `daoProfileModification`** in the
  `custom` proposal path too. The frontend's profile-diff component
  (`useGovPoolProposalProfileModel.ts`) decodes the proposal's last
  action as a `createProposal` wrapper when `isMeta=true`. For the
  single-action `editDescriptionURL` of `modify_dao_profile`, that
  decode throws → catch → empty `tableData` → no "proposed changes"
  block rendered. Passing
  `proposalMetadataExtra: { isMeta: true, ... }` with
  `category: "daoProfileModification"` no longer silently breaks the
  diff UI.
- **Avatar URL field switched from 4everland to `dweb.link`** in
  `modify_dao_profile`'s emitted DAO metadata. Field is informational
  (frontend rebuilds the URL via `parseAvatarFromIpfsResponse`), but
  `dweb.link` resolves directory pins more reliably across regions.

### Notes

- These fixes are producer-side only. The Cloudflare R2 backing
  `ipfs-cache.dexe.io` will only populate `<descriptionCID>.jpeg` once
  the Go cacher (`ipfs-cache` service) successfully runs
  `cacheAvatar(descCid)` for the new metadata — verify by hitting
  `https://ipfs-cache.dexe.io/<descriptionCID>.jpeg` after the proposal
  executes. If it 404s persistently, the issue is in the Go cacher's
  loader/R2 chain, not in this MCP.

## 0.8.1 — 2026-05-30

### Full soft-fail migration

Extends the soft-fail behavior shipped in 0.8.0 (`dexe_read_*` and
`dexe_tx_send`) to **every** remaining tool that touched the throwing
`RpcProvider.requireProvider()` / `SignerManager.requireSigner()`
variants. Missing env now surfaces uniformly across the entire MCP tool
catalog as a structured error with paste-ready remediation hints —
never a thrown stack reaching the MCP transport.

### Changed

- 18 tool files migrated from the throwing variants to the soft
  `tryProvider` / `trySigner` siblings:
  - `src/tools/`: `dao.ts` (incl. the shared `requireBook` helper, now
    returning `EnvGuardResult<AddressBook>`), `daoDeploy.ts`, `flow.ts`,
    `gov.ts`, `inbox.ts`, `otc.ts`, `predict.ts`, `proposal.ts`,
    `safe.ts`, `simulate.ts`, `subgraph.ts`, `vote.ts`
  - `src/governor/tools/`: `extras.ts`, `read.ts`, `simulate.ts`
- The throwing `requireSigner` / `requireProvider` definitions stay in
  `src/lib/signer.ts` and `src/rpc.ts` for backward compatibility — no
  removed public API. Only the in-tree call sites moved.

### Added

- `tests/lib/soft-fail-migration.test.ts` — regression guard that
  asserts no direct `.requireProvider(` / `.requireSigner(` call exists
  in `src/tools/**` or `src/governor/**`. Catches the regression at
  test-run time if a future tool forgets the soft-fail pattern.

### Notes

- No env contract change. No new vars. No caller-side change required.
- Patch-level release because the failure-mode contract is identical to
  0.8.0's; just applied uniformly across the catalog.

## 0.8.0 — 2026-05-30

### Env onboarding overhaul

This release exists to make first-run setup fail-safe for new users
(human or AI assistant). Previously, when an env var was missing or
typoed, tools threw raw stacks and the assistant had no way to discover
which file to edit, which key was missing, or whether `.claude.json` was
shadowing `.env`. Now there is one diagnostic, one wizard, one skill,
and one schema that drives every check.

**Upgrade:** zero env changes required, no breaking renames or removals.
See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the 0.7.x → 0.8.0
guide and the documented behavior change in `dexe_read_*` /
`dexe_tx_send` error responses.

### Added

- **`dexe_doctor` tool + CLI.** New diagnostic that walks every
  recognized `DEXE_*` env var, runs reachability checks (RPC
  `eth_chainId` per chain, Pinata `testAuthentication`, IPFS gateway DNS
  lookup, subgraph `{__typename}` introspection, backend HEAD), and
  reports pass/warn/fail per check with paste-ready remediation hints.
  Network checks have a 3s hard timeout that downgrades to `warn` so
  offline laptops don't see all-red. Also runnable as
  `npx dexe-mcp doctor` (exit 0/1/2). See [`docs/DOCTOR.md`](docs/DOCTOR.md).
- **`npx dexe-mcp init` wizard.** Interactive onboarding via native
  `node:readline/promises`. Asks four questions (network, Pinata JWT,
  Graph API key, signer mode), writes `.env` at the repo root (merge or
  overwrite), and prints a `~/.claude.json` snippet for copy-paste.
  Validates the Pinata JWT against the live endpoint before writing.
  Defaults the signer mode to readonly; warns explicitly and double-confirms
  before storing a private key in plaintext. Never auto-edits
  `.claude.json`. No new dependencies.
- **Schema-driven env handling.** `src/env/schema.ts` (`ENV_SPEC`,
  `ENV_REGISTRY`) is now the canonical registry for every recognized
  `DEXE_*` var (category, doc, zod schema, enabled flows, secret flag).
  Consumed by the new parser, doctor, fail-soft guards, and the
  `/dexe-setup` skill. Drift guarded by `tests/env/schema.test.ts`
  against `.env.example`.
- **Startup self-diagnostic banner.** `src/env/loader.ts` reads `.env`
  raw bytes before `process.loadEnvFile()` and emits stderr warnings
  for: UTF-8 BOM, missing trailing newline, spaces around `=`, unknown
  `DEXE_*` keys, and host-env shadowing of `.env` values. Surfaces
  silent parse traps that previously made "I edited .env and nothing
  changed" hard to diagnose.
- **Fail-soft guard helpers.** New `src/lib/requireEnv.ts` (`requireEnv`,
  `hintFor`) generalizes the existing `requirePinata` pattern from
  `src/tools/ipfs.ts`. Added `SignerManager.trySigner` and
  `RpcProvider.tryProvider` siblings that return `{error, remediation}`
  instead of throwing — keeps the throwing variants for backward
  compatibility.
- **`/dexe-setup` skill** at `.claude/skills/dexe-setup/SKILL.md`. Calls
  `dexe_doctor`, parses the report, asks the user only for missing
  values, edits `.env` (never `.claude.json`), and tells the user to
  restart Claude Code. Caps at 3 doctor → fix → restart iterations.
  Hard rule: refuse to write `DEXE_PRIVATE_KEY` without explicit user
  opt-in; suggest WalletConnect first.
- **`docs/SETUP.md` + `docs/DOCTOR.md` + `docs/MIGRATION.md`.**
  Consolidated quickstart with three setup paths, the full check
  reference, and the per-version migration notes.
- **"For AI assistants" block in `CLAUDE.md`.** Tells future Claude:
  call `dexe_doctor` first; edit `.env` not `.claude.json`; restart is
  required after env changes; the `/dexe-setup` skill exists; point
  upgrading users at `docs/MIGRATION.md`.

### Changed

- **`src/tools/read.ts` and `src/tools/txSend.ts` hot handlers** migrated
  to the soft `tryProvider`/`trySigner` variants. Missing RPC or
  `DEXE_PRIVATE_KEY` now surfaces as a structured MCP error with fix
  instructions instead of a thrown stack. Other call sites of
  `requireProvider`/`requireSigner` keep their throwing behavior — they
  are migrated incrementally in 0.8.1.
- **`src/index.ts`** now dispatches `dexe-mcp doctor` and `dexe-mcp init`
  to their respective CLI entry points before opening the MCP stdio
  transport. No-arg invocation still starts the server as before. The
  env loader runs BEFORE the subcommand dispatch so the CLI sees the
  same env as the MCP server.
- **`docs/TOOLS.md`** bumped to 153 tools / 19 groups (added the
  Diagnostics group containing `dexe_doctor`).
- **`README.md` Quickstart** now leads with the wizard path
  (`init` + `doctor`) above the manual install instructions.

### Notes

- No removed APIs. `requireSigner`/`requireProvider` keep throwing so
  every existing call site (~17 outside read.ts and txSend.ts)
  continues to work; the migration is incremental.
- No new runtime dependencies. The wizard and doctor use only
  `node:readline/promises`, `node:dns/promises`, and native `fetch`.

## 0.7.2 — 2026-05-27

### Fixed

- **`dexe_gov_has_voted` reverted on every Bravo DAO (Uniswap, Compound).** Classic
  `GovernorBravoDelegate` does not expose `hasVoted(uint256, address)` — it exposes
  `getReceipt(proposalId, voter)` returning `Receipt{hasVoted, support, votes}`. The
  Bravo read ABI wrongly listed `hasVoted` and the tool called it unconditionally, so
  the call failed with `CALL_EXCEPTION`. The tool now family-branches: OZ reads
  `hasVoted`, Bravo reads `getReceipt(...).hasVoted`, and the response reports the
  `method` used. OZ (Optimism) was unaffected. Found via live verification of the
  governor adapter against mainnet/OP RPCs; verified live post-fix (Compound 374,
  Uniswap 75, Optimism).

## 0.7.1 — 2026-05-26

### Fixed

- **`dexe_gov_get_quorum` returned 0 for Optimism.** OP's modified Governor keys
  `quorum(uint256)` by *proposalId* (via its out-of-scope ProposalTypesConfigurator),
  not by block number, so the vanilla OZ `quorum(blockNumber)` call always returned
  0. Added a `quorumSource` config field; OP is now `"votable-supply"`, and
  `readQuorum` derives the canonical quorum as
  `votableSupply(block) * quorumNumerator / quorumDenominator` (verified live:
  ~22.9M OP = 76.3M votable supply × 30%). Bravo (`quorumVotes()`) and vanilla OZ
  (`quorum(blockNumber)`) paths are unchanged; the `method` field reports which was
  used. Found via live verification of the governor adapter against mainnet/OP RPCs.

## 0.7.0 — 2026-05-26

### WalletConnect signer mode — Phase B (C12)

Live relay session on top of Phase A's config. WalletConnect is now a working
keyless signer: `dexe_tx_send` forwards each tx to the operator's phone wallet,
which **signs and broadcasts** — the private key never enters the MCP process.

- **Dependency.** Added `@walletconnect/universal-provider` (^2.17.0). **Lazily
  imported** inside `src/lib/walletconnect.ts` — read-only / EOA / Safe
  deployments that never open a WC session pay no startup cost, and a missing
  install surfaces a clear error only on `dexe_wc_connect`.
- **`WalletConnectManager` (`src/lib/walletconnect.ts`).** Singleton holding the
  `UniversalProvider` + session: `connect` (returns the pairing URI, approval
  resolves in the background), `disconnect`, `sendTransaction` (per-tx approval
  timeout from `DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS`), CAIP-10 account parsing.
- **New tools `dexe_wc_connect` + `dexe_wc_disconnect`.** `dexe_wc_status` now
  reports live session state (`connected`, `connecting`, `account`, `chainId`,
  `topic`, `peerName`, `expiry`, `lastError`). +2 tools (150 → **152**); still
  19 groups.
- **`dexe_tx_send`.** Branches to the WalletConnect path when no hot key is set;
  the wallet returns the tx hash and `waitConfirmations` is honoured via a
  read-only RPC provider. Guards B6/B7/B9/B10 still run before forwarding.
- **`dexe_tx_status`.** Reworked to a read-only `JsonRpcProvider` so it no longer
  requires a signer — works in `walletconnect` and `readonly` modes.
- **Scope.** Only `dexe_tx_send` / `dexe_tx_status` route through WalletConnect;
  composite broadcast flows (`flow.ts` / OTC `sendOrCollect`) still require a hot
  key (per-step phone approval on dependent sequences is impractical) — deferred.
- **CJS/ESM interop fix.** `getProvider()` assumed `mod.default.init`, which threw
  `UniversalProvider.init is not a function` on the first live `dexe_wc_connect`
  (the published package is CJS; a dynamic import nests the class under varying
  keys). Now probes `mod.UniversalProvider` → `mod.default.UniversalProvider` →
  `mod.default.default` → `mod.default`, with a clear error if none exposes
  `init()`.
- **Tests.** `tests/walletconnect.test.ts` (8) — config gating, CAIP-10 parsing,
  no-session guards, and a regression guard asserting the real package resolves to
  a constructor with `init()`.
- **Gate cleared:** live phone-wallet round-trip on BSC testnet (chain 97) green —
  connect → QR → MetaMask mobile approval → `dexe_tx_send` 0-value self-send →
  status 1 → `dexe_wc_disconnect`.

### WalletConnect signer mode — Phase A (C12)

Plumbing for a fourth `signerMode`: `walletconnect`. Broadcast convenience
**without a hot key** — every tx is approved on the operator's phone wallet and
the private key never enters the MCP process. Closes the last security-hardening
roadmap item (C12). Phase A is **config-only**: no relay connection, no new
dependency (`@walletconnect/universal-provider` lands in Phase B / v0.7.0), so
the supply-chain surface is unchanged.

- **Config (`src/config.ts`).** Three new env vars parsed into `DexeConfig`:
  `DEXE_WALLETCONNECT_PROJECT_ID`, `DEXE_WALLETCONNECT_RELAY_URL` (default
  `wss://relay.walletconnect.com`), `DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS`
  (default `120000`, validated `> 0`).
- **`dexe_get_config`.** `signerMode` union extended to
  `readonly | eoa | safe | walletconnect`. Precedence: `safe` → `eoa` →
  `walletconnect` → `readonly` (WalletConnect wins only when no `DEXE_PRIVATE_KEY`
  is present). New `walletConnect` report block (`projectIdConfigured`,
  `relayUrl`, `approvalTimeoutMs`).
- **New tool `dexe_wc_status`** (`src/tools/walletconnectStatus.ts`). Read-only;
  reports the resolved WalletConnect config + whether `walletconnect` is the
  active mode. Opens no relay connection in Phase A. +1 tool (149 → 150), new
  "WalletConnect" group (18 → 19).
- **Docs.** `docs/WALLETCONNECT.md` (spec + phased plan), `docs/ENVIRONMENT.md`
  (3 vars), `SECURITY.md` (threat-model note), README + `docs/TOOLS.md` counts.

## 0.6.0 — 2026-05-26

### `gov` track

External OpenZeppelin Governor + Compound Bravo surface. **+18 tools, total 131 → 149. 17 → 18 groups.** Targets Uniswap, Compound, Optimism. Independent from the DeXe Protocol — no DeXe contract needs to be deployed on the target chain. Source plan: `research/06-execution-plan.md` (Option 1).

### New tools — `dexe_gov_*` (18)

**Read (5)** — `dexe_gov_list_governors`, `dexe_gov_get_proposal`, `dexe_gov_get_voting_power`, `dexe_gov_get_quorum`, `dexe_gov_get_proposal_threshold`. Family-agnostic readouts: Bravo's `proposals(uint256)` flat struct is mapped onto the OZ `{snapshot, deadline, votes}` shape; `bravoExtra` (`proposer`, `eta`, `canceled`, `executed`) surfaced when applicable. Voting-power routes by token type — `ERC20VotesComp` (UNI, COMP) hits `getPriorVotes` / `getCurrentVotes`; `ERC20Votes` (OP) hits `getPastVotes` / `getVotes`.

**Build (5)** — `dexe_gov_build_propose`, `dexe_gov_build_vote_cast`, `dexe_gov_build_queue`, `dexe_gov_build_execute`, `dexe_gov_build_delegate`. Version-branched encoders:
- OZ v4+ propose: `(targets, values, calldatas, description)`; queue/execute: `(…, descriptionHash)` — accepts raw description (auto-keccak'd) or pre-computed hash.
- Bravo propose: `(targets, values, signatures, calldatas, description)`; queue/execute: `(proposalId)` only.
- `castVote` / `castVoteWithReason` identical both families; `support`: 0=Against, 1=For, 2=Abstain.
- `delegate` is on the voting token, not the governor.

**Simulate (2)** — `dexe_gov_simulate_proposal` (single-block `eth_call` dry-run with `Error(string)` + `Panic(uint256)` decoding) and `dexe_gov_simulate_vote_impact` (pure projection: current tallies + quorum, project the post-vote state, report `{quorumMet, willPass}` with family-aware quorum semantics — Bravo counts `forVotes` only, OZ counts `for + abstain`).

**Extras (6)** — `dexe_gov_get_state` (single-call state lookup), `dexe_gov_has_voted` (per-account vote receipt), `dexe_gov_build_cancel` (family-aware cancel encoder), `dexe_gov_decode_calldata` (round-trip any Governor write calldata), `dexe_gov_hash_description` (pure keccak256 utility), `dexe_gov_hash_proposal` (OZ-only `hashProposal` preview — errors clearly on Bravo). Closes plan §2 metric #2 (`≥18 dexe_gov_* tools shipped`).

### New configs / fixtures

`src/governor/configs/` — Uniswap, Compound, Optimism. Each is one JSON. Adding a DAO is a config-only change.

### Tally parity harness

`tests/governor/parity.test.ts` — pulls the 10 most-recent proposals per Tier-1 DAO via Tally GraphQL, asserts on-chain `state()` matches the canonical-indexed Tally status. Live mode gated by `TALLY_API_KEY`; unit cases for the comparator run without network.

### Tests (gov)

60 governor unit tests green (encoder selector + roundtrip, family detection, isolation guard, fixture validity, Tally mapper). Plan §4.1 selector targets verified: OZ propose `0x7d5e81e2`, castVote `0x56781388`, delegate `0x5c19a95c`. Bravo propose selector derived from canonical 5-arg signature.

### Docs (gov)

`docs/GOVERNOR.md` (new). `docs/GOVERNOR_LAUNCH.md` (launch runbook). `docs/TOOLS.md` §17. README catalog row + tool count.

### Hardening (gov, post-audit)

Multi-agent audit pass before merge. No correctness or security blockers found; the following were tightened:
- **Generic per-chain RPC** — `config.ts` now registers any `DEXE_RPC_URL_<chainId>` env var, so the live Governor read/simulate tools can reach Ethereum (1) and Optimism (10) where the Tier-1 DAOs actually live. Documented in `docs/GOVERNOR.md` + `docs/ENVIRONMENT.md`.
- **Read-side input validation** — `dexe_gov_get_proposal` / `_get_voting_power` / `_get_state` / `_has_voted` now reject malformed `account` / `proposalId` at the schema layer instead of forwarding a cryptic RPC error.
- **Encoder guards** — OZ `queue`/`execute`/`cancel` now enforce target/value/calldata length parity (previously only `propose` did); all builders reject empty action sets and cap at `MAX_ACTIONS` (50).
- **Revert decoding** — `simulate_proposal` decodes `Panic(uint256)` codes to a human hint (overflow, div-by-zero, …) instead of raw bytes.
- **Testability** — vote-impact projection extracted to a pure `projectVoteImpact()`; `validateGovernorConfig` exported. New offline tests cover voting-power routing, Bravo/OZ proposal-struct mapping, family-branched quorum projection, encoder guards, `hashProposal` Bravo invariant, and the real config validator. Governor suite now 70+ unit tests.

## 0.5.9 — 2026-05-26

Security-hardening release: supply-chain CI, signer broadcast guards, and Safe{Wallet} multisig signing.

### Signer broadcast guards

`dexe_tx_send` **and every composite signer flow** (`dexe_proposal_create`,
`dexe_proposal_vote_and_execute`, and the OTC composites — all broadcast through
the shared `sendOrCollect` loop) now run `runBroadcastGuards()` (new
`src/lib/broadcastGuards.ts`) before `wallet.sendTransaction()`. Four opt-in
checks, chained in order; each is a no-op unless its env var is set, so calldata
mode and the default signer posture are unchanged. In every case the broadcast is
aborted **before any gas is spent** and the result carries `isError: true`.
`dexe_tx_send` returns the structured `{ status: "rejected", guard, reason }`
shape; composite flows abort with the guard's reason as error text. Closes
security-hardening roadmap B6/B7/B9/B10.

- **B6 — destination allowlist (`DEXE_SIGNER_ALLOWLIST`).** Comma-separated `to`
  addresses; broadcasts to anything off-list are rejected. Validated and
  lowercased at startup — an invalid address aborts startup.
- **B7 — value cap (`DEXE_SIGNER_MAX_VALUE_WEI`).** Rejects any broadcast whose
  `value` (wei) exceeds the cap.
- **B9 — auto-simulation (always on in single-shot signer mode).** Reuses
  `simulateCalldata` to `eth_call` the tx against live state; aborts with the
  decoded revert reason instead of paying gas for a doomed tx. Only a genuine
  contract revert (`CALL_EXCEPTION` / decodable returndata) aborts — a transport
  failure (timeout, 429) fails **open** so a flaky RPC can't wedge a valid
  broadcast. Skipped inside composite flows, whose steps are an ordered
  *dependent* sequence that can't be simulated against pre-sequence state
  (B6/B7/B10 still apply there).
- **B10 — rate limit (`DEXE_SIGNER_MAX_BROADCASTS_PER_MIN`).** Sliding 60s window,
  serialized with `p-limit(1)`; rejects with a retry hint once the cap is hit.

See `docs/ENVIRONMENT.md` §4 and `SECURITY.md` for the full config block.

### Safe{Wallet} multisig signing (Track C)

- **New `dexe_safe_*` tool family (+2, total 129 → 131; new "Safe multisig" group → 15 groups).** Adds a signer mode that **queues** a transaction in the [Safe Transaction Service](https://docs.safe.global/) for owners to co-sign and execute, instead of broadcasting it from a single EOA. Designed for clients who custody the DAO/treasury operator key in a Gnosis Safe.
  - **`dexe_safe_propose_tx`** — takes a `TxPayload` (`to`/`value`/`data`/`operation`) as produced by any `dexe_*_build_*` tool, reads the Safe's next `nonce()` on-chain (unless supplied), computes the EIP-712 `safeTxHash`, signs it with `DEXE_PRIVATE_KEY` (which must be a Safe owner), and assembles the create-multisig-transaction body. **`dryRun` defaults to `true`** — returns the full signed payload and the resolved POST target without sending. `dryRun=false` POSTs to the service (api.safe.global requires `DEXE_SAFE_API_KEY`). *Live POST validation is deferred pending a test Safe; build + dry-run paths are verified.*
  - **`dexe_safe_info`** — read-only: live Safe nonce / threshold / owners / singleton version, whether the configured signer is an owner, and which Safe Transaction Service endpoint this chain resolves to.
- **`src/lib/ethersProvider.ts`** — new Safe ethers layer: `SAFE_ABI` + `readSafeState`, the `SafeTx` EIP-712 type set + `computeSafeTxHash`, and the `chainId → api.safe.global/tx-service/<shortname>/api/v2` endpoint resolver (override via `DEXE_SAFE_TX_SERVICE_URL`).
- **`dexe_get_config`** now reports `signerMode` (`"readonly"` | `"eoa"` | `"safe"`) plus a `safe` block (service URL + API-key configured flags), so an agent can tell at session start whether writes broadcast directly or queue to a multisig.
- **New env vars** — `DEXE_SAFE_TX_SERVICE_URL` (override / required for chains without a hosted service, e.g. BSC testnet) and `DEXE_SAFE_API_KEY` (Bearer token for api.safe.global). See [`docs/SAFE.md`](docs/SAFE.md) and [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md). Closes security-hardening roadmap C13.

### Supply-chain hardening

- **npm provenance enabled.** New `.github/workflows/release.yml` triggered by `v*.*.*` tag push: runs typecheck + build + tests, verifies tag matches `package.json` version, then `npm publish --provenance --access public`. OIDC-signed attestation links every future tarball to the exact git commit and workflow run. Visible as a "Provenance" badge on npmjs.com. `publishConfig.provenance: true` is now baked into `package.json` so even manual `npm publish` (in an OIDC-enabled env) attaches an attestation. Requires repo secret `NPM_TOKEN`. Closes security-hardening roadmap A1.
- **OSSF Scorecard analysis.** New `.github/workflows/scorecard.yml` runs weekly (Sundays 04:00 UTC) and on push to `main`. Audits branch protection, token permissions, dependency hygiene, signed releases, and 15+ other checks. Publishes SARIF to GitHub code-scanning and a public score via OIDC to `api.securityscorecards.dev`. Badge usable at `https://api.securityscorecards.dev/projects/github.com/edward-arinin-web-dev/dexe-mcp/badge`.
- **Dependency Review on PRs.** New `.github/workflows/dependency-review.yml` runs on every PR touching deps. Fails the check on `high`-or-`critical` CVEs from GitHub Advisory Database, denies copyleft licenses (GPL/AGPL), and posts a PR comment when issues found. Blocks unsafe dep updates before merge.
- **`ci.yml` least-privilege.** Tightened top-level + job `permissions: contents: read` per Scorecard Token-Permissions check. Added `npm test` to PR/main pipeline (previously typecheck+build only). Closes security-hardening roadmap A4.
- **CodeQL static analysis.** New `.github/workflows/codeql.yml` runs the `security-extended` query suite against the `javascript-typescript` source on every PR/main push and weekly (Sundays 05:00 UTC). Catches prototype pollution, command injection, ReDoS, unsafe deserialization, path traversal, and other CWE patterns. Findings upload to GitHub code-scanning. Closes security-hardening roadmap A5.
- **CVE sweep after Dependabot activation.** Three new moderate CVEs surfaced when Dependency Graph was enabled on the repo. Resolved in this PR:
  - `esbuild >=0.25.0` added to `overrides` (GHSA-67mh-4wv8-2f99 — dev server SSRF; transitive through vite/vitest/tsx).
  - `ws >=8.20.1` added to `overrides` (GHSA-58qx-3vcg-4xpx — uninitialized memory disclosure; transitive through ethers).
  - `vitest` bumped from `^2.1.0` to `^3.0.0` in devDependencies — pulls in vite ≥6.4.2 which patches the path-traversal CVE (GHSA-4w7w-66w2-5vf9).
  - `npm audit` now reports **0 vulnerabilities** (both prod and dev).
- **`npm test` no-test-files tolerance.** Added `--passWithNoTests` to the `test` script so the CI/release pipeline doesn't fail on branches that don't yet have tests under their tree (e.g. this one — tests live on `governor-adapter`).
- **Lockfile integrity job.** New `verify-lockfile` job in `ci.yml` installs strictly from the committed `package-lock.json` via `npm ci` (which aborts if `package.json` and the lockfile are out of sync and never rewrites the lockfile), asserts the lockfile was not mutated (`git diff --exit-code package-lock.json`), and validates the full resolved tree with `npm ls --all`. Any drift — stale lockfile, hand-edit, or inconsistent override/peer resolution — fails the build before merge. Closes security-hardening roadmap A3.
- **Signed-tag enforcement on release.** `release.yml` now imports the maintainer's public key (repo secret `MAINTAINER_GPG_PUBLIC_KEY`) and runs `git verify-tag "$GITHUB_REF_NAME"` **before** the publish step. An unsigned tag, an invalid signature, or a tag from an unknown key aborts the release, so nothing reaches npm without a valid maintainer signature. Checkout switched to `fetch-depth: 0` + `fetch-tags: true` so the annotated tag object and its signature are available. Documented `git verify-tag` / `git tag -v` for consumers in `SECURITY.md` and `README.md`. Closes security-hardening roadmap A2. (GPG key generation is a separate maintainer step.)

## 0.5.8

DAO avatar pipeline — root-cause fix + three new composites.

### Avatar bug fixes (frontend rendering)

- **`dexe_ipfs_upload_file` now returns a CID v1 base32 string** (`bafy…`) as the primary `cid` field, with the original Pinata response preserved as `cidV0`. The DeXe frontend stores avatar URLs as `https://<cid>.ipfs.4everland.io/<file>`, and that subdomain gateway only resolves v1 — so the pre-0.5.8 server produced dead links every time an agent uploaded an avatar.
- **Image filenames are normalized to `.jpeg` for any `image/*` content type** (configurable via `normalizeImageExt: false`). Matches what `useCreateDAO` does in the frontend and what `parseAvatarFromIpfsResponse` expects when reading the profile back.
- **`dexe_ipfs_upload_dao_metadata` auto-converts any incoming `avatarCID` to v1 base32** before composing `avatarUrl`. Callers that previously passed in a v0 `Qm…` (which silently produced a dead link) now get a working URL.

### New tools (+3, total 126 → 129)

- **`dexe_ipfs_upload_avatar`** — one-shot composite. Takes base64 image bytes, normalizes the filename to `.jpeg`, pins, converts the CID to v1, and returns the exact `{avatarCID, avatarFileName, avatarUrl}` triple that `dexe_ipfs_upload_dao_metadata` and `dexe_ipfs_update_dao_metadata` accept. Removes a three-step manual chain.
- **`dexe_dao_generate_avatar`** — generates a deterministic placeholder. Initials of the DAO name over a hash-coloured gradient, emitted as plain SVG (no `<foreignObject>`, no JS) and pinned through Pinata. Same input always produces the same colours, so re-deploys keep the brand. No external image-generation provider involved.
- **`dexe_ipfs_update_dao_metadata`** — smart "modify DAO profile" helper. Fetches the current DAO descriptionURL JSON, applies only the fields you pass in `overrides` (avatar / name / website / description / socialLinks / documents), re-pins the merged result, and returns the new CID ready to feed into `dexe_proposal_build_modify_dao_profile.newDescriptionURL`. Eliminates the previous footgun where re-uploading metadata meant manually re-specifying every unchanged field — any forgotten field silently disappeared from the profile.

### Recommended modify-profile flow

```text
1. dexe_ipfs_upload_avatar        → {avatarCID, avatarFileName, avatarUrl}
   (or dexe_dao_generate_avatar)
2. dexe_ipfs_update_dao_metadata  → newDescriptionURL
3. dexe_proposal_build_modify_dao_profile → TxPayload
4. dexe_proposal_create           → broadcast
```

### Supply-chain hygiene

- **Closes 4 transitive `npm audit` findings** under `@modelcontextprotocol/sdk@1.29.0`:
  - `fast-uri` <=3.1.0 (high) — path-traversal + host-confusion (GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)
  - `hono` <4.12.18 (moderate) — six advisories, incl. JSX HTML/CSS injection, JWT validation, cache-key leakage
  - `ip-address` <=10.1.0 (moderate) — XSS in `Address6` HTML-emitting methods (GHSA-v2v4-37r5-5v8g)
  - `express-rate-limit` (moderate)
- Resolved via `package.json` `overrides`. `@modelcontextprotocol/sdk` pin bumped from `^1.0.0` → `^1.29.0`. No public-API change.
- **`SECURITY.md`** added — vuln-disclosure policy, scoped threat model, contact email. Now ships in the tarball alongside `LICENSE`.
- **`.github/FUNDING.yml`** added (GitHub sponsors link).

`npm audit --omit=dev` now reports **0 vulnerabilities**.

## 0.5.7

Last broadcast sweep: **57 / 57 green** on Polaris (BSC testnet 97), 2026-05-12.

### Swarm coverage — 41 → 57 scenarios

- New broadcast-lifecycle scenarios for the three v0.5.6 builder rewrites: `S52-withdraw-treasury-execute`, `S53-apply-to-dao-execute`, `S54-reward-multiplier-execute`. Each runs the wrapper builder → `dexe_proposal_create` custom flow on the swarm fixture DAO and asserts the proposal lands in Voting / SucceededFor / ExecutedFor. Validates the Bug #29 / #30 / #31 fixes end-to-end against on-chain state, not just calldata shape.
- New broadcast scenarios for the most-used proposal types: `S55-token-transfer-execute`, `S56-blacklist-execute`, `S57-add-expert-execute`. Same build → create → state pattern.
- Refreshed `S18-withdraw-treasury-build` to pass the now-required `token` argument; refreshed `S31-reward-multiplier-build` to use Polaris's `nftMultiplier` (replacing retired Glacier address) and PRECISION-scaled multipliers (`1.5x => 1.5e25`) per v0.5.6's stricter validator.
- Replaced retired Glacier fixture with fresh **Polaris** testnet DAO (LINEAR, 50% quorum, deployed 2026-05-12). Sentinel (validator chamber) unchanged. README updated.

### Swarm tooling

- **`scripts/swarm/preflight.ts` now counts deposited tokens alongside the wallet balance.** A wallet with funds locked behind in-flight proposals had `ERC20.balanceOf=0` even though its governance power was intact in UserKeeper; the old check aborted nightly runs on a non-issue. Each token row now also reads `UserKeeper.tokenBalance(user, Personal)` from the parallel DAO and adds the deposited surplus to the threshold check. Falls back to wallet-only when the helper call reverts.
- **`scripts/swarm/nightly.sh` sanitizes the SUMMARY_LINE before posting to public targets.** The orchestrator's machine-greppable summary line ends with the absolute report path, which leaks the operator's filesystem layout when the repo is public. Local stdout still gets the full line; webhook + GitHub-issue posts get a stripped variant (runId + N/M + mode + chainTag, no path).

### Multi-chain config (chain-mixup guard)

- New optional env vars `DEXE_RPC_URL_TESTNET` + `DEXE_RPC_URL_MAINNET` + `DEXE_DEFAULT_CHAIN_ID`. Configure one or both; the MCP can now route reads and broadcasts to whichever chain a tool call requests, without an MCP restart.
- Write/composite tools accept an optional `chainId` arg: `dexe_tx_send`, `dexe_tx_status`, `dexe_dao_build_deploy`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_otc_dao_open_sale`, `dexe_otc_buyer_buy`, `dexe_otc_buyer_claim_all`. Omitting the arg uses the default chain. Requesting a chain with no configured RPC fails fast with a clear error before any tx is built or signed.
- Legacy `DEXE_RPC_URL` + `DEXE_CHAIN_ID` still works and stacks with the new vars — the legacy entry registers as one more chain in the pool. When `DEXE_CHAIN_ID` is omitted, the chain id is best-effort inferred from the URL hostname.
- New `dexe_get_config` diagnostic tool: returns the resolved chain set, the default chain, signer status, and IPFS/subgraph configuration. Call it at session start to orient before any write.
- Provider and signer are now per-chain caches (`RpcProvider`, `SignerManager`) so multi-chain usage doesn't churn through new connections.

## 0.5.6

Three Stage A mainnet bug fixes — all surfaced on `DexeClientDemo`
(BSC `0xCAe3…5B41`) and tracked as bugs #29 / #30 / #31.

### Fixed

- **Bug #30 — `dexe_proposal_build_withdraw_treasury` emitted wrong
  selector.** Builder targeted `GovPool.withdraw(address,uint256,uint256[])`
  (selector `0xfb8c5ef0`), which is the user-deposit-withdraw function on
  GovPool, not a treasury transfer. `proposal_create` rejected it with
  `Gov: invalid internal data`. Rewritten to emit one external
  `ERC20.transfer(receiver, amount)` action per token and/or one
  `ERC721.transferFrom(govPool, receiver, tokenId)` action per NFT —
  treasury sits in the GovPool address as a regular ERC20/721 balance, so
  withdrawal is just a plain external token call. New schema: drop the
  single `(amount, nftIds)` shape; supply `token`+`amount` and/or
  `nftAddress`+`nftIds`. At least one must be non-empty.

- **Bug #29 — `apply_to_dao` / `token_transfer` / `withdraw_treasury` had
  no blacklist precheck.** `ERC20Gov.transfer` reverts on a blacklisted
  recipient, and a proposal that passes voting then fails `execute()` sits
  in `SucceededFor` permanently with no recovery. When `DEXE_RPC_URL` is
  set, the three builders now `isBlacklisted(receiver)` against the token
  before encoding and refuse to build with a clear error if the recipient
  is blacklisted. When the token isn't ERC20Gov (call reverts) or RPC is
  absent, the precheck soft-skips with a note in the result detail —
  build always proceeds. New helper: `src/lib/blacklist.ts`.

- **Bug #31 — `dexe_proposal_build_reward_multiplier` mint/change_token
  reverted silently.** `ERC721_MULTIPLIER_ABI` declared `duration` as
  `uint256`, but `ERC721Multiplier.mint(address,uint256,uint64,string)`
  uses `uint64`. ethers derives the selector from the canonical signature,
  so the wrong-typed arg produced a different selector → no-match →
  silent revert with no returndata when GovPool.execute called into the
  multiplier (the contract has no `MAX_MULTIPLIER` check, so the original
  scale-mismatch hypothesis was wrong). Fixed the ABI to `uint64
  duration`. Builder now also rejects `multiplier=0`, multiplier values
  below `PRECISION/100` (likely forgot the 1e25 scale), `duration > 2^64
  − 1`, and `duration=0` for mint. Tool description spells out
  `PRECISION = 1e25` and `duration = seconds (uint64)`.

## 0.5.5

Doc + RPC hygiene. Two issues surfaced after publishing 0.5.4:

### Fixed

- **Internal RPC URL leaked into examples.** Three files referenced
  `https://mbsc1.dexe.io/rpc`, an internal DeXe endpoint not intended for
  public traffic. Replaced with the canonical public BSC RPC
  `https://bsc-dataseed.binance.org` in:
  - `docs/ENVIRONMENT.md` (3 occurrences — quick-start block, env table
    example, BSC mainnet chain config)
  - `tests/swarm/README.md` (`SWARM_RPC_URL_MAINNET` example)
  - `tests/compat/FORM-GUIDE.md` (network-capture hint)
  - `.env.example` (2 occurrences — `DEXE_RPC_URL` core block,
    `SWARM_RPC_URL_MAINNET` swarm block)
  - `scripts/swarm/test-mainnet-deploy.mjs` + `test-offchain-mainnet.mjs`
    (now read `process.env.DEXE_RPC_URL` first, fall back to public BSC RPC)
  Existing installs that copy-pasted the snippet still work — both URLs
  serve BSC mainnet — but the public one carries no internal-infra hint.
- **README links broken on npmjs.com.** Relative links like
  `./docs/TOOLS.md` work on GitHub but npm does NOT resolve them against the
  repo URL — npm renders the README at the package home and a relative link
  resolves to a non-existent path on `npmjs.com`. Converted all in-README
  links to absolute GitHub URLs:
  `./docs/X.md` → `https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/X.md`
  Same pattern applied to the swarm-runbook + LICENSE links.

### Scope of exposure

Verified via `npm pack --dry-run`: the internal URL was **never shipped in
any npm tarball**. `package.json`'s `files` array only includes `dist/`,
`README.md`, `CHANGELOG.md`, `FUTURE.md`, and `.mcp.example.json` — all of
which used the public BSC RPC. The leak was confined to GitHub-only
artifacts (`docs/`, `tests/`, gitignored `.env.example` + swarm probe
scripts). No npm-deprecation needed.

### Notes

- Git history retains the original URL — full history rewrite via
  `git filter-repo` was considered and declined: rewrites every commit SHA,
  breaks PR refs and external clones, and the URL is an endpoint, not a
  credential. Forward-fix is sufficient.

## 0.5.4

Off-chain backend + DAO deploy hardening. Two latent bugs surfaced during
mainnet client-demo lifecycle on `0xCAe32Fa6e6D1C223Ed1047caA58F7fC0b2D65B41`
(BSC) — both fixed at the boundary so callers don't have to know.

### Fixed

- **`dexe_dao_build_deploy`** (`src/tools/daoDeploy.ts`) — pre-flight reject
  when `tokenParams.cap == mintedTotal` while creating a new gov token.
  ERC20Gov init reverted silently inside `_initGovPool` with the generic
  `Address: low-level delegate call failed`, hiding the real cause behind a
  10M-gas wasted tx. The validator now throws a clear message:
  `cap must be strictly greater than mintedTotal; pass cap=0 for uncapped, or
  cap > mintedTotal`. Tool description updated.
- **`dexe_proposal_build_offchain_single_option` / `_multi_option` /
  `_for_against`** (`src/tools/proposalBuildOffchain.ts`) — backend rejected
  every off-chain proposal with HTTP 400 `proposal type was not found` because
  the builders sent `attributes.type = String(Math.floor(Date.now()/1000))`
  (unix timestamp) instead of a registered template name. Constants now wired
  per voting type:
  - `default_single_option_type` for `voting_type=one_of`
  - `default_multi_option_type` for `voting_type=multiple_of`
  - `default_for_against_type` for `voting_type=for_against`
- **Off-chain quorum percentages** — same three builders. The backend stores
  `*_percent` as fractions (`0.5` = 50%), but the inputs accept whole-number
  percentages (`50` = 50%) for ergonomic parity with the frontend form.
  Boundary now divides by 100 once, via a new `pctToFraction` helper.

### Verified

- Smoke-tested all three off-chain builders: `outer.type` and
  `custom_parameters.type` carry the correct constants; quorum fractions match
  backend examples (live proposal #58 created end-to-end against
  `https://api.dexe.io`).
- DAO deploy: `cap == mintedTotal` rejected pre-flight with the new message;
  `cap > mintedTotal` and `cap == 0` (uncapped) pass the check.
- `tsc` clean, no project-test regressions.

## 0.5.3

`getProposals` ABI fix for the post-upgrade GovPool layout. On-chain
`GovPool.getProposals(offset, limit)` now returns a single `ProposalView[]`
array — not the legacy 5-tuple `(Proposal[], ValidatorProposal[], uint8[],
uint256[], uint256[])`. Every multicall-backed reader was decoding against
the old shape and surfacing as `getProposals reverted` on every live mainnet
DAO (DeXe Protocol, BOXY, Carib, HackenDAO, …). Verified live decode on 4
DAOs after the patch.

### Fixed

- `dexe_proposal_list` (`src/tools/proposal.ts`) — ABI string + decoder
  rewritten for the `ProposalView[]` shape. `requiredQuorum` now read
  per-view instead of from a parallel array.
- `dexe_user_inbox` (`src/tools/inbox.ts`) — same ABI swap; voting-state
  scan now indexes `views[i].proposal.core` / `views[i].proposalState`.
- `dexe_proposal_forecast` (`src/tools/predict.ts`) — same ABI swap;
  history mapping reads `views[i].proposal.core.{executed,votesFor,
  votesAgainst}`.
- `dexe_decode_proposal` (`src/tools/gov.ts`) — already correct (uses the
  artifact ABI loaded by `dexe_compile`), no change.

### Notes

- Validators' `ProposalCore` differs from gov `ProposalCore`:
  `(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter,
  uint128 quorum, uint256 votesFor, uint256 votesAgainst)`. Don't reuse the
  gov fragment when decoding `ExternalProposal`.

## 0.5.2

Subgraph auth fix. The Graph decentralized gateway now rejects requests
without `Authorization: Bearer <api-key>` — every subgraph-backed tool
(`dexe_read_dao_list`, `dexe_proposal_voters`, `dexe_user_inbox`, etc.) was
silently failing with HTTP 401 / "missing authorization header".

### Fixed

- `gqlRequest` (`src/lib/subgraph.ts`) now sends a Bearer token derived from
  (in priority order): explicit `apiKey` arg → `DEXE_GRAPH_API_KEY` env →
  auto-extracted from URL path (`/api/<key>/subgraphs/...`). Backward-compatible
  with the legacy URL shape — no env or call-site changes required for users
  whose key is already embedded in `DEXE_SUBGRAPH_*_URL`.
- HTTP error path now includes the gateway's response body (truncated to 200
  chars) so 401/403 reasons surface in the thrown message.

### Added

- New optional env var `DEXE_GRAPH_API_KEY` for the Bearer-only URL shape
  (`https://gateway.thegraph.com/api/subgraphs/id/<id>`). Documented in
  `.env.example`.
- Exported helper `extractGraphApiKey(endpoint)` for reuse.

## 0.5.1

OTC tier rate-scaling guardrails. Production incident on 2026-05-04: a sale
proposal shipped with `exchangeRates: ["1e17"]` for "0.10 USDT/HELIO" — the
on-chain formula is `saleAmount = purchaseAmount * PRECISION / rate` with
`PRECISION = 10^25` (see `contracts/core/Globals.sol`), so the tier promised
buyers `10^7` more sale tokens than the tier could provide. Buys reverted
with `TSP: insufficient sale token amount` and the tiers had to be
recovered via `offTiers + recover`.

### Added

- New optional tier field `purchaseRatios: string[]` — human decimal ratios
  (`"0.10"` = 0.10 purchase tokens per 1 sale token), auto-scaled with
  `parseUnits(r, 25)`. Mutually exclusive with `exchangeRates`.
- Exported `PRECISION_DECIMALS = 25` constant from `proposalBuildComplex`.

### Changed

- `tierSchema.exchangeRates` is now optional. The schema enforces via
  `.refine()` that exactly one of `exchangeRates` (raw 25-precision wei)
  or `purchaseRatios` (decimals) is provided.
- `buildTierTuple` normalizes both shapes into raw 25-precision
  `bigint[]` before encoding.

### Validation

- Raw `exchangeRates[i] < 10^18` now throws with a hint citing
  `PRECISION = 10^25` — catches the unscaled-ratio mistake at build time
  instead of on-chain. Existing fixtures (rates ≥ 1e18) remain
  byte-identical (verified via `npm run test:compat`).

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
