# Setup — dexe-mcp

This is the consolidated quickstart. The full env reference lives in
[`ENVIRONMENT.md`](./ENVIRONMENT.md); the diagnostic reference is in
[`DOCTOR.md`](./DOCTOR.md).

There are four paths to a working setup. Pick one. For a friendlier,
non-technical walkthrough see [`INSTALL.md`](./INSTALL.md).

---

## Path A — Claude Code plugin (no terminal, recommended)

Inside Claude Code, type:

```
/plugin marketplace add edward-arinin-web-dev/dexe-mcp
/plugin install dexe@dexe-mcp
```

This registers the MCP server and installs the governance skills — no npm,
no `.claude.json` editing. **Reads work immediately** (the server falls back
to public BSC RPC when no RPC is configured). For writes, type `/dexe-setup`
(Path D) and Claude adds the missing keys for you.

Update later with `/plugin marketplace update` then `/plugin install dexe@dexe-mcp`.

---

## Path B — `npx dexe-mcp init` (for other MCP clients)

```sh
npm install -g dexe-mcp        # or: npm install dexe-mcp
npx dexe-mcp init              # interactive wizard
npx dexe-mcp doctor            # verify
```

The wizard asks four questions (network, Pinata JWT, Graph key, signer mode),
writes `.env` at the repo root, and prints a `~/.claude.json` snippet for
copy-paste. It validates the Pinata JWT against the live endpoint before
writing, and warns explicitly before storing a private key in plaintext.

After `init`:

1. Paste the printed snippet into your `~/.claude.json` under `mcpServers`.
2. Restart Claude Code (quit and relaunch — `process.loadEnvFile()` runs
   once at MCP startup).
3. Run `npx dexe-mcp doctor` again to confirm everything reaches green.

---

## Path C — manual `.env` edit

Copy `.env.example` to `.env` and fill in the values you need.

> Reads no longer require any env: with no RPC configured the server falls
> back to public BSC endpoints (chains 56 + 97, default 56). Set your own
> `DEXE_RPC_URL_MAINNET` for reliability, or `DEXE_DISABLE_PUBLIC_RPC=1` to
> turn the fallback off. The canonical
schema for every recognized env var lives at
[`src/env/schema.ts`](../src/env/schema.ts) — every key has a category,
one-line doc, and zod validator. The doctor reads from there.

Minimum env block for read-only against BSC testnet:

```env
DEXE_RPC_URL_TESTNET=https://data-seed-prebsc-1-s1.bnbchain.org:8545
DEXE_DEFAULT_CHAIN_ID=97
```

Add IPFS uploads:

```env
DEXE_PINATA_JWT=<your-pinata-jwt>
DEXE_IPFS_GATEWAY=https://gateway.pinata.cloud
```

Add subgraph reads:

```env
DEXE_SUBGRAPH_POOLS_URL=https://gateway.thegraph.com/api/subgraphs/id/<pools-id>
DEXE_SUBGRAPH_VALIDATORS_URL=https://gateway.thegraph.com/api/subgraphs/id/<validators-id>
DEXE_SUBGRAPH_INTERACTIONS_URL=https://gateway.thegraph.com/api/subgraphs/id/<interactions-id>
DEXE_GRAPH_API_KEY=<your-graph-api-key>
```

Run `npx dexe-mcp doctor` to verify each leg.

---

## Path D — `/dexe-setup` (from inside Claude Code)

If you're already in a Claude Code session and tools are failing, type
`/dexe-setup`. The skill calls `dexe_doctor`, parses the report, asks you
only for the missing values, edits `.env`, then prompts you to restart
Claude Code and re-runs the doctor. It iterates up to three times.

The skill defaults to **readonly signer mode** for safety. If you ask it
to enable broadcast, it will suggest WalletConnect before falling back to
a plaintext `DEXE_PRIVATE_KEY`.

---

## Common gotchas

### `.env` vs `.claude.json` env block

`process.loadEnvFile()` does **not** override pre-set `process.env` keys.
If you set `DEXE_PINATA_JWT` in BOTH `.env` AND your `~/.claude.json`
`mcpServers.dexe.env` block, the `.claude.json` value wins and your `.env`
edit appears to do nothing.

The doctor surfaces this collision — look for the `env.DEXE_*` checks and
the startup banner warning about shadowing. Remove the duplicate from one
of the two files.

### Trailing newline on `.env`

Node's `process.loadEnvFile` silently drops the last line of a file that
does not end with `\n`. The startup banner warns about this. The wizard's
output always ends with `\n`. If you hand-edited `.env` and a single value
went missing, check the trailing newline first.

### Spaces around `=`

`KEY = value` (with spaces around `=`) parses as `KEY` mapped to `" value"`
on some Node versions. Use `KEY=value`. The startup banner warns on this.

### UTF-8 BOM

Windows editors sometimes save with a UTF-8 byte-order mark. Node's
`loadEnvFile` may misparse the first key. Re-save without BOM. The startup
banner warns on this.

### After editing `.env`, restart Claude Code

The MCP server reads env ONCE at startup. Saving `.env` mid-session does
nothing until the next launch. `Ctrl+R` in Claude Code rebuilds the
session (or quit and relaunch).

---

## What `dexe_doctor` checks

See [`DOCTOR.md`](./DOCTOR.md) for the full check reference. Summary:

- Env presence and validation for every recognized `DEXE_*` key
- RPC reachability per configured chain (`eth_chainId`)
- Pinata `testAuthentication` (when `DEXE_PINATA_JWT` is set)
- IPFS gateway DNS lookup
- Subgraph reachability (`{ __typename }` introspection)
- Signer broadcast-guard config (allowlist, max value, rate limit)
- Chain consistency (default chain in configured set; signer needs RPC)
- Public-RPC fallback advisory (raised when no RPC is configured and the
  built-in BSC fallback is in use)

Status legend:

- `pass` — check succeeded
- `warn` — non-fatal (timeout, optional var unset). Doctor does not fail on
  warnings. Network timeouts always downgrade to `warn` so an offline
  laptop or corporate VPN does not produce all-red output.
- `fail` — needs your attention. Each fail carries a `remediation` field
  with a paste-ready fix instruction.
