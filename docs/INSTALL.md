# Install dexe-mcp

Pick the path that matches how you use AI. Most people want **Path A**.

- **[Path A — Claude Code plugin](#path-a--claude-code-plugin-easiest)** — two lines inside Claude, no terminal.
- **[Path B — other MCP clients](#path-b--cursor-claude-desktop-and-other-local-mcp-clients)** — Cursor, Claude Desktop, VS Code, custom agents.
- **[Path C — manual / Windows](#path-c--manual--windows-fallback)** — for tricky setups.
- **[When you need writes](#when-you-need-writes)** — creating DAOs/proposals or broadcasting.

Reads (looking at DAOs, treasuries, proposals) work with **zero configuration** — no keys, no RPC, nothing to fill in. You only add anything when you want to *write* to the chain.

---

## Path A — Claude Code plugin (easiest)

If you use **Claude Code**, this is all you do. Type these two lines into Claude (they start with `/`):

```
/plugin marketplace add edward-arinin-web-dev/dexe-mcp
/plugin install dexe@dexe-mcp
```

That's it. Claude will:

- connect the DeXe tools automatically (nothing to install, no config file to edit), and
- add the governance **skills** — ready-made recipes for *create a DAO*, *create a proposal*, *vote and execute*, *OTC sales*, *DAO reports*, and more.

Now just ask, in plain English:

> *"Show the treasury of `0x…` on BSC."*
> *"List the open proposals for this DAO."*

The tools appear as soon as Claude restarts — the plugin ships the server itself, so there is nothing to download. If you do not see the `dexe_*` tools, quit and relaunch Claude Code, then run `dexe_doctor`.

**Updating later:** when a new version ships, type `/plugin marketplace update` then `/plugin install dexe@dexe-mcp` again.

---

## Path B — Cursor, Claude Desktop, and other local MCP clients

These clients don't support Claude Code plugins yet, so you register the server once.

> **stdio only.** `dexe-mcp` runs as a local process on your machine and talks to the client over stdio — it never opens a network port. A client that only accepts a *remote* MCP **URL** (ChatGPT connectors and other hosted-only integrations) cannot connect to it directly. Use a client that can launch a local command: Claude Code, Claude Desktop, Cursor, VS Code, or your own agent.

You need [Node.js 20.12 or newer](https://nodejs.org) — the server reads your `.env` with `process.loadEnvFile`, which landed in 20.12, and `engines` requires `>=20.12.0`. Check with `node -v`.

**One rule before you copy anything:** pick ONE launcher and stick to it. `npx` fetches the package on demand; a global install is a fixed local copy. If `dexe-mcp` is installed globally, then `npx dexe-mcp@<version>` silently runs the stale global copy instead of the version you asked for. Check with `npx -y dexe-mcp@latest doctor` (the banner names the version that actually ran); fix with `npm uninstall -g dexe-mcp` **using the same node/npm the client launches**, then fully quit and reopen the client.

### B1 — Claude Code (CLI, no plugin)

```sh
claude mcp add dexe -s user -- npx -y dexe-mcp@latest
```

One line on every OS. `-s user` registers it for **every** project — local scope is the default, and it makes the server appear to vanish the moment you open another project. Verify with `claude mcp list`.

### B2 — Claude Desktop

Config file:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dexe": {
      "command": "npx",
      "args": ["-y", "dexe-mcp@latest"]
    }
  }
}
```

On **Windows**, `npx` spawns a `.cmd` shim and can exceed the client's MCP startup window (symptom: "server failed to start", or JSON-RPC `-32000`). Install once and point at the file instead:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "node",
      "args": ["<npm root -g>\\dexe-mcp\\dist\\index.js"]
    }
  }
}
```

Run `npm install -g dexe-mcp`, then `npm root -g` for the absolute path to substitute.

### B3 — Cursor

`Settings → MCP → Add new global MCP server`, or edit the file directly:

- `~/.cursor/mcp.json` — every project
- `<project>/.cursor/mcp.json` — this project only

Same JSON as B2, and the same Windows `node` + `dist/index.js` fallback.

### B4 — Codex CLI

```sh
codex mcp add dexe -- npx -y dexe-mcp@latest
```

Or edit `~/.codex/config.toml` by hand — note the **UNDERSCORE**; `mcp-servers` with a hyphen is silently ignored:

```toml
[mcp_servers.dexe]
command = "npx"
args = ["-y", "dexe-mcp@latest"]
startup_timeout_sec = 60
```

### B5 — Any other stdio MCP client

The B2 JSON is the portable shape. [`.mcp.example.json`](../.mcp.example.json) in the package is the same file with every optional env var annotated.

### Prefer a fixed local install?

```sh
npm install -g dexe-mcp
```

Then use `"command": "dexe-mcp"` (or the `node` + `dist/index.js` form on Windows) instead of `npx`. Same rule as above: once it is installed globally, do **not** also launch it through `npx dexe-mcp@<version>` — the global copy wins and the pinned version never runs.

### Add the skills (optional — the recipe shortcuts)

```sh
npx dexe-mcp skills          # into this project (./.claude/skills)
npx dexe-mcp skills --global # into every project (~/.claude/skills)
```

This copies the skills only — it does **not** ask you any setup questions.

---

## Path C — manual / Windows fallback

If your client can't find the `dexe-mcp` command on your `PATH` (common on Windows), point it at the installed file directly:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "node",
      "args": ["<npm root -g>/dexe-mcp/dist/index.js"]
    }
  }
}
```

Run `npm root -g` in a terminal to get the absolute path to substitute for `<npm root -g>`.

---

## Checking the install from a terminal

```sh
dexe-mcp --help      # or -h, or `help` — prints usage and exits 0
dexe-mcp --version   # prints the version and exits 0
```

Both print and exit without loading any env, so they work on a machine with no configuration at all. An unknown command exits `2` and names the valid subcommands (`doctor`, `init`, `skills`).

---

## When you need writes

Reading is free and needs nothing. To **create DAOs, draft proposals, upload metadata, or broadcast transactions**, you add a couple of values.

**Easiest — inside Claude Code:** type

```
/dexe-setup
```

Claude checks what's missing, asks you only for what it needs, writes it to a `.env` file for you, and tells you when to restart. It defaults to the safest **read-only** signer mode and will suggest a phone-wallet (WalletConnect) before ever storing a raw key.

**What the values are, if you're curious:**

| You want to… | You provide |
|---|---|
| Upload proposal/DAO metadata to IPFS | a **Pinata token** (`DEXE_PINATA_JWT`) — free at [pinata.cloud](https://pinata.cloud) |
| Broadcast transactions from the server | a **wallet** — a phone wallet via WalletConnect (recommended) or, as a last resort, a private key |
| A faster / private RPC | your own `DEXE_RPC_URL_MAINNET` (the built-in public one rate-limits) |

Full reference: [ENVIRONMENT.md](./ENVIRONMENT.md). Setup runbook and gotchas: [SETUP.md](./SETUP.md).

> **Note on keys:** by default the server never signs anything — it hands you an unsigned transaction and your own wallet approves it. Keys only enter the picture if *you* opt in.
