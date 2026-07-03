# Migration guide

For users upgrading `dexe-mcp` between versions. Most upgrades are
no-action — this document calls out exactly when you need to change
something on your side.

---

## 0.12.x → 0.13.0 — slim default toolset (BREAKING)

**TL;DR.** A default session now loads **~71 tools**, not all 155. If a tool
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
