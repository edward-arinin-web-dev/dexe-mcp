# Migration guide

For users upgrading `dexe-mcp` between versions. Most upgrades are
no-action — this document calls out exactly when you need to change
something on your side.

---

## 0.25.0 → 0.26.0 — no action; call `dexe_guide` first for multi-step work

Additive only. Tool count 160 → **161 tools**: new `dexe_guide` (core toolset,
always visible) serves the protocol knowledge layer — flow plans, interview
questions with risk notes, and the gotcha corpus, resolved for your active
chain and session state. Agents should call it FIRST for any multi-step
request (create DAO / launch token economy / OTC / staking / distribution);
existing scripts are unaffected. `docs/PLAYBOOK.md` now contains GENERATED
sections rendered from `src/knowledge/` via `npm run gen:knowledge`.

---

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
current 161-tool surface), not everything. If a tool
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
