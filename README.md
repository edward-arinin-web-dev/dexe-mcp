# dexe-mcp

![npm](https://img.shields.io/npm/v/dexe-mcp.svg)

MCP server for Claude Code / Antigravity that wraps the [DeXe Protocol](https://github.com/dexe-network/DeXe-Protocol) Hardhat codebase with build/test, contract introspection, and governance-domain tools.

## Prerequisites

- **Node.js >= 20**
- **Git** (the server auto-clones DeXe-Protocol on first run)

## Quick start

Add this to your project's `.mcp.json` (or your MCP client config):

```json
{
  "mcpServers": {
    "dexe": {
      "command": "npx",
      "args": ["-y", "dexe-mcp"]
    }
  }
}
```

Restart your MCP client. On first launch, `dexe-mcp` will automatically:

1. Clone `dexe-network/DeXe-Protocol` to a local cache directory (~200 MB, shallow clone)
2. Run `npm install` in the checkout

Subsequent launches are instant. No manual setup needed.

### Advanced: custom checkout path

If you already have a DeXe-Protocol checkout or want to control its location:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "npx",
      "args": ["-y", "dexe-mcp"],
      "env": {
        "DEXE_PROTOCOL_PATH": "/absolute/path/to/your/DeXe-Protocol"
      }
    }
  }
}
```

## First run

Before introspection tools work, run `dexe_compile` once per session to populate `DeXe-Protocol/artifacts/`. You will get a clear "artifacts not found" error otherwise.

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
| `DEXE_PROTOCOL_PATH` | no | Override the auto-managed DeXe-Protocol checkout path |
| `DEXE_RPC_URL` | no | JSON-RPC endpoint for `dexe_decode_proposal` and `dexe_read_gov_state` |
| `DEXE_FORK_BLOCK` | no | Pin the fork to a specific block (Phase B) |

## Troubleshooting

### "Hardhat artifacts not found — run dexe_compile first"

Introspection tools require compiled artifacts. Run `dexe_compile` once after the initial setup to populate them.

### "Failed to clone DeXe-Protocol"

Make sure `git` is installed and available on your PATH, and that you have internet access. The server clones from `https://github.com/dexe-network/DeXe-Protocol.git`.

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
