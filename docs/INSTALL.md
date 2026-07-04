# Install dexe-mcp

Pick the path that matches how you use AI. Most people want **Path A**.

- **[Path A — Claude Code plugin](#path-a--claude-code-plugin-easiest)** — two lines inside Claude, no terminal.
- **[Path B — other MCP clients](#path-b--cursor-chatgpt-and-other-mcp-clients)** — Cursor, ChatGPT, custom agents.
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
- add the governance **skills** — ready-made recipes for *create a DAO*, *create a proposal*, *vote and execute*, and *OTC sales*.

Now just ask, in plain English:

> *"Show the treasury of `0x…` on BSC."*
> *"List the open proposals for this DAO."*

The first time the tools start, Claude may take ~10–30 seconds to download the server. After that it's instant.

**Updating later:** when a new version ships, type `/plugin marketplace update` then `/plugin install dexe@dexe-mcp` again.

---

## Path B — Cursor, ChatGPT, and other MCP clients

These clients don't support Claude Code plugins yet, so you register the server once. You need [Node.js 20+](https://nodejs.org) installed.

**1. Install:**

```sh
npm install -g dexe-mcp
```

**2. Add it to your client's MCP config** (`.mcp.json`, `claude_desktop_config.json`, Cursor's MCP settings, etc.). For reads, no env is required:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp"
    }
  }
}
```

**3. Add the skills** (optional — the recipe shortcuts):

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
