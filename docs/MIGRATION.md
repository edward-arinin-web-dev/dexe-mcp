# Migration guide

For users upgrading `dexe-mcp` between versions. Most upgrades are
no-action — this document calls out exactly when you need to change
something on your side.

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
soft-fail pattern. The 0.8.1 release extends it to every other
`dexe_dao_*`, `dexe_flow_*`, `dexe_inbox_*`, `dexe_otc_*`,
`dexe_predict_*`, `dexe_safe_*`, `dexe_sim_*` tool, and the external
governor surface (`dexe_gov_*`).

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
