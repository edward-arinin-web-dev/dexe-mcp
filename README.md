# dexe-mcp

![npm](https://img.shields.io/npm/v/dexe-mcp.svg)

MCP server for Claude Code / Antigravity that wraps the [DeXe Protocol](https://github.com/dexe-network/DeXe-Protocol) Hardhat codebase with build/test, contract introspection, and governance-domain tools.

## Prerequisites

- **Node.js >= 20** with a working `npm`. Verify before continuing:

  ```bash
  node --version    # should print v20.x or higher
  npm --version     # MUST print a version, not "command not found"
  ```

  If `npm --version` fails, you have a stripped Node install (a bare `node.exe` without the rest of the toolchain — common on Windows when `C:\Program Files\nodejs\node.exe` was placed manually). Install Node from <https://nodejs.org> or via [nvm](https://github.com/nvm-sh/nvm) / [nvm-windows](https://github.com/coreybutler/nvm-windows) and retry. Without npm, `npm install -g dexe-mcp` silently does nothing.

- **Git** — only needed on first run, to clone DeXe-Protocol. If you already have a local checkout, point `DEXE_PROTOCOL_PATH` at it and git is optional.

## Install

### 1. Install the package globally

```bash
npm install -g dexe-mcp
```

Verify the install landed by asking npm where it put it:

```bash
npm root -g
# Mac/Linux:  /usr/local/lib/node_modules       (or ~/.nvm/versions/node/vXX.X.X/lib/node_modules)
# Windows:    C:\Users\<you>\AppData\Roaming\nvm\<version>\node_modules
#             (or C:\Users\<you>\AppData\Roaming\npm\node_modules for non-nvm)
```

Note the output — you'll need it for the Windows install step below. The package lives at `<npm-root>/dexe-mcp/dist/index.js`.

### 2. Register the MCP server

#### Mac / Linux

Bare command works because Unix `exec` resolves PATH directly:

```bash
claude mcp add dexe -- dexe-mcp
```

Or in JSON (`.mcp.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp"
    }
  }
}
```

#### Windows — recommended: absolute path to `node` + `dist/index.js`

On Windows, `dexe-mcp` is installed as a `.cmd` shim that many MCP clients (including Claude Code as of this writing) fail to spawn cleanly over stdio. The **absolute-path** form bypasses shim resolution entirely and is the known-good recipe:

```bash
claude mcp add dexe -- "C:\Program Files\nodejs\node.exe" "C:\Users\<you>\AppData\Roaming\nvm\<version>\node_modules\dexe-mcp\dist\index.js"
```

Substitute `<you>` and `<version>` (or use whatever `npm root -g` printed above). In JSON:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/Users/<you>/AppData/Roaming/nvm/<version>/node_modules/dexe-mcp/dist/index.js"]
    }
  }
}
```

This works because:
- No PATH dependency — every argument is an absolute path
- No `.cmd` / `.ps1` shim in the chain, so `CreateProcess` semantics don't trip over missing extensions
- `dexe-mcp` internally invokes `npm`/`hardhat` via `process.execPath`, so it uses whichever Node you pointed at and does not need npm on the spawned process PATH

<details>
<summary>Alternative: <code>cmd /c dexe-mcp</code> (not recommended — often unreliable with Claude Code)</summary>

```json
{
  "mcpServers": {
    "dexe": {
      "command": "cmd",
      "args": ["/c", "dexe-mcp"]
    }
  }
}
```

Use only if the absolute-path form is inconvenient. End-to-end testing showed this can pass a direct stdio check but fail to complete the MCP handshake when spawned by Claude Code.
</details>

### 3. Verify the install (optional but recommended)

Before wiring the server into your MCP client, confirm the binary can actually speak MCP over stdio. On any OS:

```bash
# Send a minimal initialize request, expect a capabilities JSON back.
echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}" | dexe-mcp
```

On Windows if the above hangs, try instead:

```bash
echo {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}} | node "C:\Users\<you>\AppData\Roaming\nvm\<version>\node_modules\dexe-mcp\dist\index.js"
```

A healthy response starts with a single stderr line (`[dexe-mcp] connected on stdio. …`) and a stdout JSON blob containing `"serverInfo":{"name":"dexe-mcp"}`. If you see that, the server is fine and any "failed to connect" from your MCP client is purely a client-side spawn/config problem, not a bug in dexe-mcp.

### 4. Restart your MCP client

On the first build-tool call (e.g. `dexe_compile`), `dexe-mcp` will automatically:

1. Shallow-clone `dexe-network/DeXe-Protocol` into a platform cache directory (~200 MB)
2. Run `npm install` in that checkout (a few minutes, one time)

The MCP server itself starts instantly — the heavy work is deferred until you actually need it. Cache locations:

| OS | Path |
|----|------|
| Windows | `%LOCALAPPDATA%\dexe-mcp\DeXe-Protocol` |
| macOS | `~/Library/Caches/dexe-mcp/DeXe-Protocol` |
| Linux | `$XDG_CACHE_HOME/dexe-mcp/DeXe-Protocol` (or `~/.cache/dexe-mcp/DeXe-Protocol`) |

### Advanced: existing DeXe-Protocol checkout

If you already have a DeXe-Protocol clone you want to reuse (and have run `npm install` there at least once), set `DEXE_PROTOCOL_PATH`:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp",
      "env": {
        "DEXE_PROTOCOL_PATH": "/absolute/path/to/your/DeXe-Protocol"
      }
    }
  }
}
```

With this set, dexe-mcp will **not** clone or install anything — it trusts the path you gave it. On Windows, wrap `command` with `cmd /c` as above.

### Dev mode (working on dexe-mcp itself)

Clone this repo, build, and point the MCP command at the local `dist/index.js`:

```bash
git clone https://github.com/edward-arinin-web-dev/dexe-mcp.git
cd dexe-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "dexe": {
      "command": "node",
      "args": ["/absolute/path/to/dexe-mcp/dist/index.js"],
      "env": {
        "DEXE_PROTOCOL_PATH": "/absolute/path/to/DeXe-Protocol"
      }
    }
  }
}
```

## First run

Before introspection tools work, run `dexe_compile` once per session to populate `DeXe-Protocol/artifacts/`. You will get a clear "artifacts not found" error otherwise. On a brand-new install the first `dexe_compile` also triggers the clone + `npm install` steps described above.

## Tool catalog

### Build / test

| Tool | Description |
|------|-------------|
| `dexe_compile` | Compile all contracts via Hardhat |
| `dexe_test` | Run the test suite (optional grep filter) |
| `dexe_coverage` | Run tests with solidity-coverage |
| `dexe_lint` | Lint Solidity sources with solhint |

### Contract introspection

| Tool | Description |
|------|-------------|
| `dexe_list_contracts` | List all compiled contracts (filter by name/kind) |
| `dexe_get_abi` | Get the full ABI for a contract |
| `dexe_get_methods` | Enumerate read (view/pure) and write (nonpayable/payable) methods with structured inputs/outputs and `internalType` — for generating TypeScript interfaces |
| `dexe_get_selectors` | List function selectors for a contract |
| `dexe_find_selector` | Reverse-lookup: selector hex to function signature |
| `dexe_get_natspec` | Read NatSpec documentation for a contract |
| `dexe_get_source` | Read Solidity source code for a contract |

### Governance domain

| Tool | Description |
|------|-------------|
| `dexe_decode_calldata` | Decode arbitrary calldata against contract ABI |
| `dexe_decode_proposal` | Fetch and decode a full on-chain proposal |
| `dexe_read_gov_state` | Read governance pool state from chain |
| `dexe_list_gov_contract_types` | List known governance contract type names |

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEXE_PROTOCOL_PATH` | no | Use an existing DeXe-Protocol checkout; disables auto clone/install |
| `DEXE_RPC_URL` | no | JSON-RPC endpoint for `dexe_decode_proposal` and `dexe_read_gov_state` |
| `DEXE_FORK_BLOCK` | no | Pin the fork to a specific block (Phase B) |

## Troubleshooting

### "`git` is not on PATH"

Install git from <https://git-scm.com/downloads> and restart your MCP client. Alternatively, clone DeXe-Protocol manually and set `DEXE_PROTOCOL_PATH` to skip the clone step entirely.

### "`npm install` failed inside DeXe-Protocol"

Usually means your Node install lacks a bundled `npm` (e.g. a stripped `node.exe` dropped on PATH without the rest of the install). Reinstall Node from <https://nodejs.org> or via nvm / nvm-windows and retry. dexe-mcp invokes npm via `process.execPath` so it uses whichever Node is running it — it does not need `npm` on the spawn PATH.

### "Failed to connect" in Claude Code (Windows)

Run the direct stdio test from the "Verify the install" section first. If that prints a clean `serverInfo` response, the server is fine and the problem is in how your client is spawning it.

The fix is almost always to switch to the **absolute-path** registration:

```bash
claude mcp remove dexe
claude mcp add dexe -- "C:\Program Files\nodejs\node.exe" "C:\Users\<you>\AppData\Roaming\nvm\<version>\node_modules\dexe-mcp\dist\index.js"
```

Bare `dexe-mcp` and `cmd /c dexe-mcp` both rely on shim resolution that Claude Code's `CreateProcess`-based spawn does not always handle. The absolute-path form has zero shim resolution.

### `npm install -g dexe-mcp` reported success but `dexe-mcp` is nowhere to be found

You're almost certainly on a stripped Node install whose `npm` silently no-ops. Check with `npm --version` — if it fails, install Node properly (see Prerequisites). If it prints a version, check `npm root -g` and look inside that directory; the package should be at `<npm-root>/dexe-mcp`.

### "Hardhat artifacts not found — run dexe_compile first"

Introspection tools require compiled artifacts. Run `dexe_compile` once after the initial setup to populate them.

### "DEXE_PROTOCOL_PATH=… is missing node_modules"

You pointed `DEXE_PROTOCOL_PATH` at a checkout that hasn't been installed yet. `cd` into it and run `npm install` once, then retry.

### "DEXE_RPC_URL is not set"

The governance tools `dexe_decode_proposal` and `dexe_read_gov_state` require an Ethereum JSON-RPC endpoint. Add `DEXE_RPC_URL` to your MCP env config.

## Contributing

```bash
git clone https://github.com/edward-arinin-web-dev/dexe-mcp.git
cd dexe-mcp
npm install
npm run build
npm run typecheck
npm run dev          # watch mode
```

## Roadmap

Phase B (`dexe_simulate_vote` + Hardhat fork management) is planned for v0.2.0. See [FUTURE.md](./FUTURE.md) for all deferred features.

## License

MIT. See [LICENSE](./LICENSE).
