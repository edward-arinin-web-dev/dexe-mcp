# Migration guide

For users upgrading `dexe-mcp` between versions. Most upgrades are
no-action — this document calls out exactly when you need to change
something on your side.

---

## 0.27.0 → 0.28.0 — no action; opt-in agent keyring

Additive only. Tool count 163 → **165 tools**: `dexe_agents_list` +
`dexe_agents_fund` (both in the `vote` toolset, not the slim default). New
optional env: `DEXE_AGENT_PK_1..16` (extra hot keys for multi-persona/swarm
flows) and `DEXE_AGENT_FUND_MAX_WEI`. Every broadcast composite plus
`dexe_tx_send` gained an optional `signerKey` param — omitted, behavior is
byte-identical to 0.27.0 (primary `DEXE_PRIVATE_KEY` signs).

---

## 0.26.0 → 0.27.0 — no action; richer read outputs

Additive only. Tool count 161 → **163**: new `dexe_graph_query`
(free-form read-only GraphQL over the three DeXe subgraphs — entity reference
in `docs/GRAPH.md`) and `dexe_read_protocol_stats` (protocol-wide TVL /
proposals / DAO count + top-N leaderboard). Output-shape notes if you parse
tool results programmatically:

- `dexe_read_settings` now returns field-labeled objects (`earlyCompletion`,
  `duration`, `quorum`, … + derived `quorumPct`) instead of positional arrays.
- `dexe_read_dao_stats` downsamples to `maxPoints` (default 30) — pass a
  higher `maxPoints` if you consumed the full raw series.
- `dexe_user_inbox` claimableRewards items: `totalAmount` now includes voting
  + off-chain rewards (was static-only and wrong), `proposalIds` now contains
  REAL proposal ids, new `rewardTokens` / `offchainTotal` / `offchainTokens`.
- `dexe_read_delegation_map` `addresses` now takes plain wallet addresses
  (composite ids still accepted and normalized).

---

## 0.25.0 → 0.26.0 — no action; call `dexe_guide` first for multi-step work

Additive only. Tool count 160 → **161**: new `dexe_guide` (core toolset,
always visible) serves the protocol knowledge layer — flow plans, interview
questions with risk notes, and the gotcha corpus, resolved for your active
chain and session state. Agents should call it FIRST for any multi-step
request (create DAO / launch token economy / OTC / staking / distribution);
existing scripts are unaffected. `docs/PLAYBOOK.md` now contains GENERATED
sections rendered from `src/knowledge/` via `npm run gen:knowledge`.

---

## 0.24.2 → 0.25.0 — validator round now auto-drives (1 behavior change)

Tool count 159 → **160**: new `dexe_auth_login` (core) does the off-chain
nonce → sign → login dance inside the server when a signer is available
(hot key **or** a connected WalletConnect session) and returns
`{ accessToken, refreshToken, expiresIn }` — no more hand-writing key-extraction
code to sign the auth nonce. The manual `dexe_auth_request_nonce` /
`dexe_auth_login_request` tools still work as the no-signer fallback.

### The one migration-worthy change

- **`dexe_proposal_vote_and_execute` now drives the validator round.** For DAOs
  with validators, the tool used to stop at `WaitingForVotingTransfer` /
  `ValidatorVoting` and return a remedy string. It now auto-advances that stage
  (new `driveValidatorRound`, **default `true`**): it moves the proposal to
  validators and, when the signer is itself a validator, casts the validator vote
  and executes. Non-validator signers move the proposal and stop with a note.
  Pass `driveValidatorRound: false` to restore the old member-vote-only behavior.

Also additive (no action): `dexe_read_multicall`, `dexe_read_staking_info`, and
`dexe_read_delegation_map` gained a `chainId` param (they previously always hit
the default chain); `read_staking_info` also auto-resolves the StakingProposal
address from a `govPool`.

## 0.24.1 → 0.24.2 — DANGER advisories now block; fix your mainnet RPC

Guard/validation release. Two things can change scripted behavior; the rest is
additive.

- **Governance-safety advisories now BLOCK the flow.** `dexe_proposal_create`
  runs safety advisories on `change_voting_settings` / `new_proposal_type` /
  `enable_staking` builds. A **DANGER-level** advisory (e.g. quorum lowered into
  treasury-drain territory) now **stops the flow before any transaction** until
  you re-run with **`confirmRisky: true`**. CAUTION-level advisories only attach
  to the result (`governanceAdvisories`) and don't block. Scripts that create
  these proposal types must be ready to pass `confirmRisky: true`.
- **A treasury transfer to a blacklisted recipient is now refused before any
  transaction** (the old pre-send guard was dead — it probed the wrong chain and
  called a non-existent selector). If a transfer that "worked" before now errors,
  the recipient is on the token blacklist and the transfer would have reverted.

Also new (no action): `dexe_dao_create` accepts a `documents` array (external
DAO profile documents, previously dropped); editing settings via
`change_voting_settings` no longer wipes each entry's `executorDescription`.

### Env note — replace the default mainnet RPC

The previous `mbsc3.dexe.io` endpoint can return the **wrong `chainId`**. Set
`DEXE_RPC_URL_MAINNET` to a standard BSC dataseed for chain 56 (e.g.
`https://bsc-dataseed.binance.org`). Restart Claude Code after the change.

## 0.24.0 → 0.24.1 — playbook resource now really ships; vote/delegate calldata changed

Campaign fix batch. Tool count unchanged (159). Two things worth knowing:

- **The `dexe://playbook` MCP resource now exists in published builds.** `docs/`
  was missing from the npm `files` whitelist, so before this release the server
  advertised **no resources capability at all** (`resources/*` → `-32601`). After
  upgrading, the playbook resource and the doc-backed skills are actually present.
- **`vote` / `delegate` calldata is now `multicall([inner])`-wrapped.**
  SphereX-protected pools (every GovPool deployed since ~2026-07-06) revert a raw
  top-level `vote()` / `delegate()` with "SphereX error: disallowed tx pattern".
  `dexe_vote_build_vote` / `dexe_vote_build_delegate` now emit the frontend's
  `multicall([...])` shape; `dexe_proposal_vote_and_execute` bundles its
  deposit+vote the same way. **If you byte-compare vote/delegate payloads, expect
  the multicall wrapper.** `undelegate` stays raw (SphereX allows it).
  `dexe_vote_build_multicall` now also accepts a single-element batch (was min 2).

Also additive (no action): the BSC-**testnet** (97) `ContractsRegistry` is baked
into defaults, so zero-config reads / predict / deploy work on chain 97 (they
previously failed "No ContractsRegistry address known for chainId=97"); a
correction — `dexe_vote_build_erc20_approve` must approve the **GovUserKeeper**,
never the GovPool.

## 0.23.1 → 0.24.0 — plugin now launches via `node` (update the plugin)

**TL;DR.** If you use the Claude Code plugin, update it — the launch mechanism
changed. If you use the raw npm package, no action beyond the usual restart.

- **The plugin now ships a self-contained bundle launched by plain `node`**, not
  `npx -y dexe-mcp@…`. This clears the Windows **`-32000`** spawn failure of the
  npx launcher, drops the launch-time network fetch (the plugin runs offline with
  no `node_modules` on your machine), and **kills the stale-global-shadow trap**
  (see the 0.15.0 entry) since nothing runs `npx` anymore. To pick it up:

  ```
  /plugin marketplace update dexe-mcp
  /plugin update dexe@dexe-mcp
  ```

  then fully quit and reopen Claude Code.
- **Deploy builders now refuse a provably-reverting payload.** `dexe_dao_create`
  simulates the deploy via `eth_call` right before signing and **blocks the
  broadcast** on a provable revert (classified cause + fix, no gas spent);
  `dexe_dao_build_deploy` likewise won't emit a payload that would revert. Pass
  **`skipSimulation: true`** to `dexe_dao_build_deploy` as the deliberate bypass.
  An RPC transport failure only downgrades to a warning (fail-open), so this
  doesn't block you when the node is flaky.

## 0.23.0 → 0.23.1 — move config to `~/.dexe-mcp/.env` if the plugin saw no env

Fix release. The server now loads `.env` from a **cwd-independent** home
location — `~/.dexe-mcp/.env` (per-OS via `os.homedir()`) — in addition to the
project `.env`. This closes the bug where the Claude Code plugin, launched with
a working directory that isn't your project, never found your `.env` and ran
with zero `DEXE_*` config (`readonly` / `ipfsUploads:false`) on every OS.

- **If your setup already worked, do nothing.**
- **If the plugin showed no env** (`dexe_doctor` → only `state.path`, everything
  else missing): put your config at `~/.dexe-mcp/.env` — e.g.
  `~/.dexe-mcp/.env` on macOS/Linux, `C:\Users\<you>\.dexe-mcp\.env` on Windows.
  `npx dexe-mcp init` now writes there automatically for installed packages.
- New `DEXE_ENV_FILE` env var: absolute path to a `.env`, loaded first — for
  CI/containers that can inject one variable but not a working directory.
- For WalletConnect signing, leave `DEXE_PRIVATE_KEY` out of that file (a hot
  key takes precedence over WC).

Restart Claude Code after creating the file (env loads once at startup), and do
not `/mcp` reconnect or `/plugin` mid-session — that relaunches the server and
drops any live WalletConnect session.

---

## 0.22.x → 0.23.0 — no action

Additive only. `dexe_dao_create` SIMPLE mode accepts two new optional fields:
`minVotesTokens` (default `"1"`) and `earlyCompletion` (default `true`).
Omitting both reproduces 0.22.0 behavior exactly — min-votes = 1 token clamped
to the distributed supply, early completion on. Tool count unchanged
(160 / 19 groups).

---

## 0.21.x → 0.22.0 — composite-first everywhere (4 behavior changes)

**TL;DR.** Docs overhaul + reliability release. Tool count unchanged (160 / 19
groups, default `core,proposals` = 72). Four behavior changes can affect
scripts; everything else is additive. New quick map:
[`docs/PLAYBOOK.md`](./PLAYBOOK.md) (also the MCP resource `dexe://playbook`).

### The 4 migration-worthy changes

1. **`proposalType` is a strict enum.** `dexe_proposal_create` rejects unknown
   type strings **at validation time** with the list of valid types
   (previously an unknown type errored mid-flow, sometimes after a deposit
   landed). All 33 catalog types are now wired — if you routed some types to
   `dexe_proposal_build_*` because the composite refused them, you can send
   them through `dexe_proposal_create` directly. Internal validator types
   auto-route to `GovValidators.createInternalProposal`; off-chain types are
   rejected with exact backend-flow instructions.
2. **Reverted txs surface as failures.** A mined-but-reverted tx
   (`receipt.status === 0`) is now reported as a failure everywhere, including
   `dexe_tx_send` (`isError: true` + `reverted: true`). Scripts that treated
   any mined receipt as success must check `isError` / `reverted`.
3. **`depositFirst` default changed `false` → `'auto'`.**
   `dexe_proposal_vote_and_execute` now deposits exactly the missing amount
   from the wallet (approve UserKeeper → deposit → vote) when deposited power
   is short — i.e. it **may broadcast an approve + deposit you didn't ask
   for**. Pass `depositFirst: false` to restore the old never-deposit
   behavior.
4. **Invalid `.env` values fail fast at startup.** Every `DEXE_*` var is
   schema-validated at boot; an invalid value is a clear fatal naming the var.
   `dexe_doctor` already flagged these — now they block startup instead of
   failing later mid-tool.

### Also new (no action required)

- **Human-unit amounts everywhere.** A decimal string (`"12.5"`) is scaled by
  the token's real on-chain decimals; digits-only stays raw wei. OTC
  `dexe_otc_buyer_buy` additionally converts to the payment token's native
  decimals for the balance check + exact approve (fixes silent under-pay on
  <18-dec payment tokens).
- **19 read tools gained optional `chainId`** (proposal state/list/voters,
  vote power, the `dexe_read_*` family, decode, inbox, OTC reads, dao info /
  registry / predict, forecast) — read both chains in one session.
- **RPC retry + failover:** `DEXE_RPC_URL_MAINNET/_TESTNET/_<id>` accept
  comma-separated URL lists; transport failures rotate automatically.
- **Tx wait timeout:** `DEXE_TX_WAIT_TIMEOUT_MS` (default 180000) returns a
  check-`dexe_tx_status` error instead of hanging.
- **Composite failure ledger:** failed flows return `mode:'failed'` with
  `{failedStep, error, landedSteps, resume}` — fix the cause, re-run the same
  call, completed steps are skipped.
- New env vars `DEXE_MAX_DESCRIPTION_LEN`, `DEXE_PROTOCOL_REF`;
  `dexe_context` reports toolsets `{enabled, hidden, enableHint}`; the MCP
  handshake now reports the real package version (was hardcoded `0.1.5` —
  update anything that pinned on that); missing-Pinata errors are a numbered
  3-step guide.

---

## 0.20.x → 0.21.0 — one-call avatar updates + file-path uploads

**TL;DR.** No action required. Additive: the server now reads local image
files itself.

- **`newAvatarPath` on `dexe_proposal_create`** (modify_dao_profile) and
  **`avatarPath` on `dexe_dao_create`**: pass a local image path; the server
  reads, magic-byte-validates, pins, and wires the CID — one call, no base64
  through the conversation. Combining path and CID inputs errors.
- **`filePath` on `dexe_ipfs_upload_avatar`** (10 MB cap) **and
  `dexe_ipfs_upload_file`** (25 MB cap) as the preferred alternative to base64.
- `dexe_dao_create` honours `DEXE_IPFS_AVATAR_GATEWAY` (previously hardcoded
  dweb.link); by-reference `newAvatarCID` gets the same fetch-and-sniff gate
  as the other by-CID paths.

---

## 0.19.x → 0.20.0 — real JPEG avatars + magic-byte validation

**TL;DR.** One behavior change: avatar uploads now **reject non-raster bytes**
(SVG/HTML). If you pinned SVG avatars before, they were never renderable on
app.dexe.io anyway (bug #34).

- `dexe_dao_generate_avatar` renders a real JPEG (pixel initials over a
  hash-coloured gradient; deterministic per `daoName`).
- Every avatar upload path validates magic bytes: only JPEG/PNG/WebP/GIF pass.
  `dexe_ipfs_upload_avatar` pins with the *sniffed* MIME and returns
  `detectedFormat`. For generic (non-avatar) image attachments,
  `dexe_ipfs_upload_file` with `normalizeImageExt: false` is the escape hatch
  (e.g. a legitimate SVG logo).
- By-reference avatar CIDs (`avatarCID` on the metadata/dao tools) are fetched
  and sniffed too — confirmed non-raster bytes hard-block; an unreachable
  fresh pin proceeds with a warning.
- **Existing DAOs with an SVG avatar stay broken until rotated:** re-generate
  with 0.20.0+, then `modify_dao_profile` → vote + execute.

---

## 0.18.x → 0.19.0 — `dexe_dao_create` preview/confirm + coherence guards

**TL;DR.** Two behavior changes for scripted DAO deploys; interactive use just
gets safer.

- **Preview-then-confirm.** `dexe_dao_create` returns `mode: "preview"`
  (resolved config + safety proof) and only broadcasts on a call with
  `confirm: true`. Scripts that expected an immediate deploy must add
  `confirm: true`. New SIMPLE mode: pass `symbol` + `totalSupply` (+ optional
  `treasuryPercent`/`quorumPercent`/`voteModel`/`durationSeconds`) and the
  tool synthesizes a coherent, frontend-equivalent config; full `params`
  (ADVANCED) still works.
- **Deploys that would ship a broken DAO are now hard-blocked** (both
  `dexe_dao_create` and `dexe_dao_build_deploy`): unreachable quorum
  (`quorum% × supply > votable tokens`), `minVotesForVoting/Creating` above
  the largest recipient, settings out of contract bounds, the predicted
  govPool listed as a token recipient, and over-distribution
  (`sum(amounts) > mintedTotal`). If a previously "working" param set now
  errors, the deploy would have reverted or produced an ungovernable DAO.
- **Corrected rules** (verified live on mainnet): cap rule is
  `cap ≥ mintedTotal > 0` — `cap == minted` is a valid fixed supply, `cap = 0`
  reverts; a treasury **remainder is valid** (the contract mints
  `mintedTotal − sum(amounts)` to the DAO) — do not force them equal.
- **Mainnet deploys are supported** (the old "mainnet reverts" gating text was
  wrong); mainnet always requires `confirm: true`. Defaults: LINEAR vote
  model, 51% quorum. Since this release DAOs deployed by `dexe_dao_create`
  have the TokenSale + Distribution executors and all 5 settings groups
  auto-wired — OTC works right after deploy.

---

## 0.17.x → 0.18.0 — WalletConnect QR + hot-key warnings

**TL;DR.** No action required. Pairing takes zero copy-paste.

- **`dexe_wc_connect` renders a scannable QR** (terminal ASCII + `image/png`
  MCP content block) instead of a raw URI. The raw `uri` + a fallback URL are
  still in the JSON.
- **Auto-print on writes.** `dexe_tx_send` in WalletConnect mode with no
  session starts pairing and prints the QR instead of erroring; composite
  flows attach a live `pairing` QR to their build-mode response.
- **Hot keys are flagged "NOT SAFE" everywhere** — `dexe_tx_send` hot-key
  broadcasts carry a `safety` field, `dexe_get_config` reports
  `recommendedSigner: "walletconnect"`, `dexe_doctor` adds a `signer.hotKey`
  advisory. If you parse `dexe_tx_send` output strictly, tolerate the new
  field.
- `dexe_wc_connect` no longer refuses when `DEXE_PRIVATE_KEY` is set — it
  pairs and reminds you the hot key keeps signing precedence until removed.

---

## 0.16.x → 0.17.0 — zero-config public defaults

**TL;DR.** No action required. Reads + WalletConnect signing now work with no
`.env`. One behavior change to be aware of: `signerMode` reports `walletconnect`
(not `readonly`) by default.

### What changed

- **Reads work with zero config.** Backend, the three subgraphs, IPFS reads, and
  the WalletConnect project id now have baked public defaults (RPC fallback + the
  registry already did). Set the matching `DEXE_*` var to override any of them —
  your value always wins.
- **`signerMode` default is now `walletconnect`, not `readonly`** (when no
  `DEXE_PRIVATE_KEY` is set), because WalletConnect is available out of the box.
  Nothing signs until you run `dexe_wc_connect`; `dexe_context.signer.address`
  stays `null` until then. If you asserted `readonly` in scripts, update the
  expectation.
- **IPFS reads default to public gateways.** If you relied on `dexe_ipfs_fetch`
  erroring when no gateway was set, it now tries ipfs.io / dweb.link / cloudflare
  first. Restore the old behavior with `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1`.
- **Shared defaults are billable-shared.** The default Graph key + WC id ship
  publicly and are rate-limited. For production/heavy use set your own
  (`DEXE_SUBGRAPH_*_URL` / `DEXE_GRAPH_API_KEY`, `DEXE_WALLETCONNECT_PROJECT_ID`);
  `dexe_doctor` flags this via `env.sharedDefaults`.

### Action required

None. Optionally set your own RPC / Graph key / WC id / Pinata JWT via
`/dexe-setup` for reliability and to stop sharing the public defaults.

---

## 0.15.x → 0.16.0 — no action; backend-powered reads

Additive. Tool count 156 → **159**: `dexe_read_token_holders`,
`dexe_read_dao_stats`, and `dexe_read_nfts` (all in the **`read`** toolset — enable
with `DEXE_TOOLSETS=core,proposals,read` or `full`; they're not in the slim
default). `dexe_read_treasury` was rewritten **backend-first**: it now
auto-discovers every token and returns `usdPrice`/`usdValue`/`totalUsd` and a
`source: backend|rpc` field, and works on any address (not just GovPools). RPC
multicall is retained as the fallback for testnet 97, an explicit `tokens` list,
or when `DEXE_BACKEND_API_URL` is unset/unreachable. If you parsed the old
positional treasury output, read the new field-labeled shape.

## 0.14.x → 0.15.0 — install as a Claude Code plugin (+ zero-config reads)

**TL;DR.** No action for an existing `.env` setup. This release adds a
no-terminal install path and public-RPC fallback. One trap to know about if you
also have a global install (below).

- **One-command install, no JSON editing.** From inside Claude Code:

  ```
  /plugin marketplace add edward-arinin-web-dev/dexe-mcp
  /plugin install dexe@dexe-mcp
  ```

  Reads work with zero config; run `/dexe-setup` when you want to write. The
  governance skills install automatically, namespaced `dexe:<skill>`.
- **Zero-config reads.** With no RPC configured the server seeds public BSC
  endpoints (chains 56 + 97, default **56**), so `dao_info` / `read_treasury` /
  etc. work out of the box. Public dataseed nodes rate-limit and lack archive
  history — a doctor advisory (`chain.publicRpcFallback`) nudges you to set your
  own RPC. Opt out with **`DEXE_DISABLE_PUBLIC_RPC=1`**. (A private key set
  *without* an RPC now signs against the public fallback instead of erroring; set
  your own RPC for reliable broadcasting.)
- **`npx dexe-mcp skills`** — new skills-only subcommand (no env interview;
  `--global` targets `~/.claude/skills`). `init` now opens with a *skills / full /
  both* choice so it never dives into the env wizard unasked.

### Trap: a global `dexe-mcp` install shadows the pinned plugin version

Through 0.23.1 the plugin launched via `npx -y dexe-mcp@<version>`. If you *also*
ran `npm i -g dexe-mcp` at any point, **npx resolves to the stale global and
ignores the pinned `@version`** — so the plugin can silently run an old build
(observed running 0.14.0 forever: `readonly`, `ipfsUploads:false`, no config,
no restart fixes it). Fix: uninstall the global **using the same node that
launches the plugin**, then fully quit + reopen Claude Code:

```
npm uninstall -g dexe-mcp
```

Do **not** "fix" it by upgrading the global — it re-breaks on the next version
bump. (0.24.0's `node`-launched bundle removes this trap entirely.)

## 0.13.x → 0.14.0 — persistent state + `dexe_context`

**TL;DR.** No action required. New `dexe_context` tool (call it first each
session) + a persistent state file. Optional `DEXE_STATE_PATH` override.

### What changed

- **`dexe_context`** (new, in the `core` profile) returns your signer, active
  chain, env readiness, and the DAOs/proposals recorded in prior sessions.
- **Persistent state** is written to `~/.dexe-mcp/state.json` when you deploy a
  DAO (`dexe_dao_create`) or broadcast a proposal (`dexe_proposal_create`).
  Override the location with `DEXE_STATE_PATH`; `dexe_doctor` warns if the path
  isn't writable. Everything still works without persistence (it degrades
  silently). No secrets are stored — only DAO addresses, chain ids, tx hashes,
  and any wallet labels you set.

---

## 0.12.x → 0.13.0 — slim default toolset (BREAKING)

**TL;DR.** A default session now loads a slim subset (**72 tools** as of the
current 165-tool surface), not everything. If a tool
you scripted against is "missing", set `DEXE_TOOLSETS=full` to restore the old
behavior, or add the profile that owns it.

### What changed

- **`DEXE_TOOLSETS` gating.** The server registers only the tool profiles named
  in `DEXE_TOOLSETS` (comma list). **The default is now `core,proposals`** —
  previously every tool loaded unconditionally. This cuts `tools/list` from
  ~205 KB to ~111 KB (−46%). Profiles: `core`, `proposals`, `read`, `vote`,
  `governor`, `dev`, `full`. See [TOOLS.md § Toolset profiles](./TOOLS.md#toolset-profiles).

### Do I need to act?

- **Common flows (deploy DAO, create/vote/execute proposals, OTC, key deposits):**
  no action — they're in `core`/`proposals`.
- **Governor DAOs (`dexe_gov_*`):** add `governor` → `DEXE_TOOLSETS=core,proposals,governor`.
- **Delegation / staking / claims / NFT-multiplier (`dexe_vote_build_*` beyond
  the 5 key ones):** add `vote`.
- **Subgraph/extended reads, inbox, forecast, risk:** add `read`.
- **Solidity dev tooling, introspection, decode, simulate, merkle, Safe,
  `dexe_dao_build_deploy`:** add `dev`.
- **Want everything (old behavior):** `DEXE_TOOLSETS=full`.
- **Want the deepest cut:** `DEXE_TOOLSETS=core` (~48 KB / 33 tools) — the
  composites (`dexe_dao_create`, `dexe_proposal_create`) cover the common
  proposal types server-side.

Set it in `.env` (not `.claude.json`) and **restart Claude Code**. `dexe_doctor`
reports the active profile and the restore hint. A typo/unknown set name falls
back to `full` rather than silently stripping tools.

---

## 0.11.x → 0.12.0 — no action; composite flow tools + shipped skills arrive

Additive. Tool count 154 → **155**: new `dexe_dao_create` (one-call DAO deploy
with pre-flight guards) and `dexe_proposal_create` extended to build the common
catalog proposal types server-side — prefer these composites over hand-sequencing
`dexe_proposal_build_*` + IPFS + approve/deposit. The governance recipe skills
(`dexe-create-dao`, `dexe-create-proposal`, `dexe-vote-execute`, `dexe-otc`,
`dexe-setup`) now ship in the npm package; `npx dexe-mcp init` offers to install
them into `./.claude/skills` or `~/.claude/skills`.

## 0.10.x → 0.11.0 — OTC contract/frontend alignment

**TL;DR.** No env changes. Pull/update, restart Claude Code. If you script
against the OTC tools, read the three behavior changes below.

### What changed

- **Native BNB sentinel.** `dexe_otc_buyer_buy` and
  `dexe_vote_build_token_sale_buy` now emit the protocol's
  `ETHEREUM_ADDRESS` (`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`) in
  calldata for native purchases. The zero address is still accepted as
  *input* (aliased), but if you byte-compare payloads, expect `0xEeee…`.
  The low-level builder also auto-sets `value = amount` for native buys.
- **Zero-address purchase token now rejected** by
  `dexe_proposal_build_token_sale`/`_multi`/`dexe_otc_dao_open_sale` —
  previously accepted and produced an unbuyable tier. Use
  `ETHEREUM_ADDRESS` for native BNB.
- **Read-tool output extended.** `dexe_otc_list_sales_for_dao` now returns
  real `totalSold` (was `null`) and an `off` status;
  `dexe_otc_buyer_status` adds `totalSold`, `isOff`, `tierUri`,
  `onchainMerkleRoot`, `merkleUri`, and `merkle.rootMatchesOnchain`.
  These were previously decoding garbage against live tiers (flat vs
  nested `TierView` — fixed).
- **`dexe_otc_dao_open_sale`** auto-uploads merkle whitelists to IPFS
  (`{ "list": [...] }`, `ipfs://<cid>`) so app.dexe.io buyers can
  regenerate proofs. Needs `DEXE_PINATA_JWT`; warns and continues
  without it. `buildOnly: true` skips uploads as before.

---

## 0.8.1 → 0.10.0 — no action; new advisory layer + optional env

Additive/hardening across 0.9.0 (security remediation) and 0.10.0 (treasury
advisory). Nothing is required and nothing blocks. New **optional** env vars, all
with safe defaults:

- `DEXE_PROTOCOL_REF`, `DEXE_MAX_DESCRIPTION_LEN` (default 16384) — 0.9.0.
- `DEXE_MIN_SAFE_QUORUM_PCT` (default 50), `DEXE_TREASURY_GUARD` (`warn`|`off`,
  default `warn`), `DEXE_CONTROLLING_TOPN` (default 5) — 0.10.0's treasury-safety
  advisory, which **only warns, never blocks** (there is no `acknowledgeRisk` to
  pass). New read-only tool `dexe_proposal_risk_assess` (153 → **154**). Behavior
  hardening you don't need to act on: broadcasts are serialized per chain (no
  nonce collision) and approvals now use the exact amount, never `MAX_UINT256`.

## 0.7.x → 0.8.0 — env onboarding overhaul

**TL;DR.** No breaking env changes. Pull, restart Claude Code, optionally
run `npx dexe-mcp doctor`. Done.

### What changed

- **New diagnostic.** `dexe_doctor` MCP tool + `npx dexe-mcp doctor` CLI
  walk every recognized `DEXE_*` var, run RPC / Pinata / IPFS gateway /
  subgraph reachability checks, and return paste-ready remediation hints.
  See [`docs/DOCTOR.md`](./DOCTOR.md).
- **New wizard.** `npx dexe-mcp init` interactively writes a fresh `.env`
  and prints a `~/.claude.json` snippet for copy-paste. Optional — your
  existing `.env` continues to work.
- **New skill.** Repo-local `/dexe-setup` skill at
  `.claude/skills/dexe-setup/SKILL.md` walks an AI assistant through
  fixing a broken env. Skill is `.gitignored` (not shipped via npm); the
  manual equivalent lives in [`docs/SETUP.md`](./SETUP.md).
- **Startup banner.** The MCP server now logs to stderr at startup: the
  `.env` path it loaded, any parse warnings (UTF-8 BOM, missing trailing
  newline, spaces around `=`), unknown `DEXE_*` keys, and any
  `.claude.json` `env` block that is shadowing your `.env`.
- **Formal env schema.** [`src/env/schema.ts`](../src/env/schema.ts) is
  now the canonical registry for every recognized `DEXE_*` var
  (category, doc, zod validator, secret flag). The doctor reads from
  there.

### Behavior change worth knowing

In 0.7.x, `dexe_read_*` and `dexe_tx_send` threw a raw stack trace
when an env var (RPC URL, private key) was missing — the MCP host
surfaced this as `isError: true` with an opaque message.

In 0.8.0, those handlers return a **structured error response with
remediation hints**:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "No RPC configured for chainId=56...\nSet DEXE_RPC_URL_MAINNET in .env, then restart the MCP server."
  }]
}
```

- The MCP response shape is **unchanged** — still `{ content, isError: true }`.
- The error TEXT is new — now mentions the specific missing var by name
  and the required restart step.
- If you have a script that parses MCP error strings to detect missing
  env, the matchers should now look for the new format. For everyone
  else: no caller-side change required.

Other tool files (`dao.ts`, `flow.ts`, `inbox.ts`, `otc.ts`, etc.) still
throw on missing env in 0.8.0 — they will surface as MCP errors via the
existing handler-level try/catch wrappers. They are migrated to the new
structured-error pattern in **0.8.1** (see below).

### Env var inventory

**Zero removals, zero renames, zero stricter validation** between 0.7.2
and 0.8.0. Every var your `.env` had before continues to work.

The schema formally documents nine additional vars that 0.7.x already
consumed at the call sites but did not validate at startup —
`DEXE_BACKEND_API_URL`, `DEXE_GRAPH_API_KEY`, `DEXE_IPFS_AVATAR_GATEWAY`,
`DEXE_IPFS_GATEWAY`, `DEXE_IPFS_GATEWAYS_FALLBACK`,
`DEXE_PINATA_GATEWAY_TOKEN`, `DEXE_PROTOCOL_PATH`, `DEXE_SAFE_API_KEY`,
`DEXE_SAFE_TX_SERVICE_URL`. If you were setting these in your `.env`
already, they keep working unchanged. The doctor will now show them in
its presence checks.

### The `.env` precedence trap

`process.loadEnvFile()` does **not** override pre-set keys in
`process.env`. If you have the same `DEXE_*` key in BOTH your `.env`
file AND your `~/.claude.json` `mcpServers.dexe.env` block, the
`.claude.json` value wins and your `.env` edit silently does nothing.

The 0.8.0 startup banner explicitly warns when it detects this
collision, and `dexe_doctor` calls it out per key. Fix is either:

- Delete the duplicate from `.claude.json` (let `.env` be the source of
  truth), OR
- Update the value in `.claude.json` directly and ignore `.env` for
  that key.

Either way, **restart Claude Code** so the MCP server picks up the new
environment.

### Recommended upgrade flow

```sh
# 1. Pull the new version
npm install -g dexe-mcp@0.8.0

# 2. Restart Claude Code (quit + relaunch).

# 3. Verify.
npx dexe-mcp doctor
```

If the doctor reports any `fail`, follow its `remediation` hints. If
your `.env` was misconfigured before 0.8.0 (parse traps, shadowing) the
banner and doctor will now surface it explicitly — that is the
"discovery moment" the release is built around.

### If you want to start fresh

```sh
mv .env .env.backup    # if you have an existing one
npx dexe-mcp init      # interactive wizard
npx dexe-mcp doctor    # verify
```

The wizard validates your Pinata JWT against the live endpoint before
writing and defaults the signer mode to **readonly** — pick the privkey
or WalletConnect modes explicitly if you want broadcast capability.

---

## 0.8.0 → 0.8.1 — full soft-fail migration

**TL;DR.** No caller-side change. Tools that previously threw raw
stacks on missing env now return structured errors. Same pattern as
0.8.0 — extended to every remaining tool.

In 0.8.0, only `dexe_read_*` and `dexe_tx_send` were migrated to the
soft-fail pattern. The 0.8.1 release extends it to **18 tool files**
spanning every other `dexe_dao_*`, `dexe_flow_*`, `dexe_inbox_*`,
`dexe_otc_*`, `dexe_predict_*`, `dexe_proposal_*`, `dexe_safe_*`,
`dexe_sim_*`, `dexe_subgraph_*`, `dexe_vote_*` tool, and the external
governor surface (`dexe_gov_*`). A regression test at
`tests/lib/soft-fail-migration.test.ts` asserts no future tool
backslides.

No env contract change. No new env vars. Patch-level release because
the failure-mode contract is identical to 0.8.0's — just applied
uniformly across the catalog.

If you were relying on the throwing behavior to detect missing env
(unlikely — MCP clients never expose stacks anyway), update your
matcher to look for the structured remediation text.

---

## Earlier releases

See [`CHANGELOG.md`](../CHANGELOG.md) for the full per-release notes.
This document only highlights changes that need user action.
