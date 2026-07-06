<p align="center">
  <a href="https://www.npmjs.com/package/dexe-mcp">
    <img src="./assets/hero.svg" alt="dexe-mcp" width="100%"/>
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dexe-mcp"><img alt="npm" src="https://img.shields.io/npm/v/dexe-mcp.svg?style=flat-square&labelColor=0b0f1e&color=9BB4FF"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/dexe-mcp.svg?style=flat-square&labelColor=0b0f1e&color=E07AFF"></a>
  <a href="https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dexe-mcp.svg?style=flat-square&labelColor=0b0f1e&color=FFC878"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP-compatible" src="https://img.shields.io/badge/MCP-compatible-9BB4FF?style=flat-square&labelColor=0b0f1e"></a>
</p>

# dexe-mcp

An MCP (Model Context Protocol) server for [DeXe Protocol](https://dexe.io) governance on BNB Chain, with an additional generic surface for OpenZeppelin and Compound-Bravo Governor DAOs (Uniswap, Compound, Optimism).

It exposes 159 typed tools in 19 groups: DAO deployment, all 33 DeXe proposal types, voting, delegation, execution, OTC token sales, treasury and subgraph reads, IPFS metadata, transaction simulation, and diagnostics. Any MCP client can use it — Claude Code, Claude Desktop, Cursor, or a custom agent.

Writes are calldata-first: tools return a `{ to, data, value, chainId }` payload for your own wallet to sign. Broadcasting from the server is opt-in, either through WalletConnect (transactions are approved on your phone; no key on disk) or a private key you explicitly configure.

<p align="center">
  <a href="#install-in-claude-code">Install</a> ·
  <a href="#quickstart-other-mcp-clients">Quickstart</a> ·
  <a href="#tool-catalog">Tool catalog</a> ·
  <a href="#environment-variables">Environment</a> ·
  <a href="https://github.com/edward-arinin-web-dev/dexe-mcp/tree/main/docs">Docs</a>
</p>

---

## Install in Claude Code

Two commands, typed inside Claude Code:

```
/plugin marketplace add edward-arinin-web-dev/dexe-mcp
/plugin install dexe@dexe-mcp
```

Then ask:

> "Show the treasury of `0x…` on BSC."

Reads work with no configuration: on-chain data, subgraphs, the DeXe backend, and IPFS all have public defaults, and WalletConnect signing is available immediately (`dexe_wc_connect`). The governance skills (create DAO, create proposal, vote and execute, OTC) install with the plugin.

To create DAOs or proposals, or to broadcast transactions, run `/dexe-setup` — it walks through the two keys that unlock those paths (a Pinata token for IPFS uploads, a signer) and writes them to `.env` for you.

Using Cursor, ChatGPT, another MCP client, or the terminal? See [docs/INSTALL.md](./docs/INSTALL.md).

## Quickstart (other MCP clients)

Reads need no environment at all. The steps below set up uploads and signing.

**Wizard path:**

```bash
npm install -g dexe-mcp
dexe-mcp init      # interactive setup: network, Pinata, signer mode
dexe-mcp doctor    # verifies RPC, Pinata, IPFS gateway, subgraph
```

`init` writes `.env` and prints a client-config snippet to paste. `doctor` checks every recognized `DEXE_*` variable and reports pass/warn/fail with remediation hints. Full runbook: [docs/SETUP.md](./docs/SETUP.md); check reference: [docs/DOCTOR.md](./docs/DOCTOR.md); upgrade notes: [docs/MIGRATION.md](./docs/MIGRATION.md).

**Manual path** — register with your MCP client (`.mcp.json`, `claude_desktop_config.json`, Cursor settings):

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp",
      "env": {
        "DEXE_RPC_URL_MAINNET": "https://bsc-dataseed.binance.org"
      }
    }
  }
}
```

The `env` block is optional — without it the server falls back to a public BSC RPC, which is rate-limited and suitable for evaluation; set your own endpoint for production use.

> **Windows:** if your MCP client can't resolve the `dexe-mcp` shim on PATH, point it at the script directly:
> `{ "command": "node", "args": ["<npm root -g>/dexe-mcp/dist/index.js"] }`

**Example calls:**

```jsonc
// Enumerate every proposal type the server can build
dexe_proposal_catalog({ category: "all", implementedOnly: true })

// Resolve a DAO's contract layout: settings/userKeeper/validators addresses,
// NFT contracts, metadata CID, validator count
dexe_dao_info({ govPool: "0x..." })

// Build a token-transfer proposal; returns ready-to-sign calldata
dexe_proposal_build_token_transfer({
  govPool:   "0x...",
  token:     "0x...",
  recipient: "0x...",
  amount:    "1000000000000000000"
})
```

Each write tool returns a `TxPayload` you pass to your wallet. To let the server broadcast instead, connect a wallet over WalletConnect (`dexe_wc_connect`) or set `DEXE_PRIVATE_KEY`; that enables the composite flows `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, and `dexe_tx_send`.

## Requirements

- Node.js ≥ 20 with a working `npm`.
- Git — only for the optional dev toolset (`dexe_compile` / `dexe_test` / `dexe_lint`), which shallow-clones DeXe-Protocol on first use. Set `DEXE_PROTOCOL_PATH` to use an existing checkout. Reads, builders, and deploys do not use it.

## Features

- DeXe governance coverage: the 33 proposal types (24 external, 4 internal validator, 5 off-chain), validator chamber, expert delegation, multi-tier OTC sales with merkle whitelists.
- Calldata-first key model: no private key is required for any build tool. Broadcasting is a separate, explicit opt-in.
- Zero-config reads: public RPC, subgraph, backend, and IPFS gateway defaults let read tools work out of the box.
- External Governor support: 18 `dexe_gov_*` tools read, build, simulate, and decode against OpenZeppelin and Bravo Governors; new DAOs are a config entry.
- Tested on-chain: a 59-scenario multi-agent harness exercises the builders against BSC-testnet fixture DAOs — build-only checks for all proposal types, full propose → vote → execute lifecycles for the broadcast paths.
- MIT-licensed, no telemetry, no hosted dependency — requests go only to endpoints you configure.

## Example applications

- A governance copilot that lists unvoted proposals across your DAOs (`dexe_user_inbox`), summarizes them, and drafts votes for you to sign.
- Proposal drafting from intent: "transfer 50k USDT from treasury to the dev fund" resolves to a builder call, pinned metadata, and one signable payload.
- Delegate agents that read every proposal, vote according to a written mandate, and record their reasoning.
- Treasury automation: recurring claims, vesting, and rebalancing executed as governance proposals.
- Pre-mainnet rehearsal: simulate a proposal (`dexe_sim_proposal`) or replay a parameter change on a testnet fixture DAO before it goes live.

## Tool catalog

159 tools in 19 groups. Full per-tool reference with required env vars: [docs/TOOLS.md](https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/TOOLS.md).

A default session loads the `core,proposals` profile (~72 tools) to keep the MCP tool list small. Set `DEXE_TOOLSETS=full` for everything, or add profiles (`read`, `vote`, `governor`, `dev`) as needed — see [Toolset profiles](https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/TOOLS.md#toolset-profiles). Call `dexe_context` first in a session: it returns the signer, active chain, env readiness, and DAOs/proposals recorded in prior sessions.

| Group | Tools | Summary |
|-------|-------|---------|
| Dev tooling | 4 | Hardhat lifecycle for the DeXe-Protocol workspace: `dexe_compile`, `_test`, `_coverage`, `_lint`. |
| Contract introspection | 10 | List contracts, fetch ABIs, look up selectors, read NatSpec and source, decode calldata and proposal payloads. |
| DAO reads | 30 | DAO info, proposal state/list/voters, voting power, treasury, settings, validators, staking, distributions, risk assessment, plus subgraph queries (DAO list, members, experts, delegation map, user activity). |
| IPFS | 9 | Pinata uploads for files, avatars, and DAO/proposal metadata; metadata updates; JPEG avatar generation; gateway-fallback fetch; local CID computation. |
| DAO deploy | 2 | `dexe_dao_create` (one-call composite with pre-flight revert guards) and `dexe_dao_build_deploy` (full `deployGovPool` struct encoder). |
| Proposal catalog and primitives | 5 | `dexe_proposal_catalog` plus generic `_build_external`, `_build_internal`, `_build_custom_abi`, `_build_offchain`. |
| External proposal wrappers | 20 | Named builders: token transfer/distribution/sale, treasury withdraw, validators, experts, staking tiers, blacklist, profile changes, voting settings, and more. |
| Internal validator wrappers | 4 | Validator-chamber proposals: balances, settings, monthly withdraw, off-chain internal. |
| Off-chain wrappers and auth | 8 | DeXe backend integration: SIWE login, off-chain proposal creation and voting. |
| Vote, stake, delegate, execute, claim builders | 26 | Direct EOA writes on `GovPool` and `Validators`: deposit, vote, delegate, execute, claim, staking, token-sale buy/claim, multicall. |
| Composite signing flows | 6 | `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_tx_send`, `dexe_tx_status`, `dexe_get_config`, `dexe_context`. |
| Merkle utility | 2 | `dexe_merkle_build` and `dexe_merkle_proof`, compatible with OZ `StandardMerkleTree`. |
| OTC composites | 4 | Open a multi-tier sale, check buyer status, buy (native or with merkle proof), claim vested payouts. [docs/OTC.md](./docs/OTC.md) |
| Safe multisig | 2 | Queue transactions in the Safe Transaction Service instead of broadcasting. [docs/SAFE.md](./docs/SAFE.md) |
| Simulator | 3 | `eth_call` preflight with decoded revert reasons: `_sim_calldata`, `_sim_proposal`, `_sim_buy`. [docs/SIMULATOR.md](./docs/SIMULATOR.md) |
| Multi-DAO inbox + forecast | 2 | Pending items across N DAOs (`dexe_user_inbox`) and quorum-projection pass-rate forecasts. [docs/INBOX.md](./docs/INBOX.md) |
| External Governor DAOs | 18 | `dexe_gov_*`: family-aware propose/vote/queue/execute/delegate, dry-runs, vote receipts, decoding for OZ and Bravo Governors. [docs/GOVERNOR.md](./docs/GOVERNOR.md) |
| WalletConnect | 3 | `dexe_wc_connect` (pairing QR), `dexe_wc_status`, `dexe_wc_disconnect`. Transactions sign on your phone. [docs/WALLETCONNECT.md](./docs/WALLETCONNECT.md) |
| Diagnostics | 1 | `dexe_doctor`: runs reachability checks across the configured environment and prints remediation hints. |

## Environment variables

No variable is required to start the server; tools that need a missing one fail with a message naming what to set. Full matrix: [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md).

| Variable | Used for | Notes |
|----------|----------|-------|
| `DEXE_RPC_URL_MAINNET` / `DEXE_RPC_URL_TESTNET` / `DEXE_RPC_URL_<chainId>` | all on-chain tools | Per-chain JSON-RPC endpoints. Without any, a public BSC RPC is used (rate-limited). `DEXE_RPC_URL` still works as a legacy single-chain alias. |
| `DEXE_DEFAULT_CHAIN_ID` | chain selection | Default `56` (BSC mainnet); `97` for testnet. |
| `DEXE_DISABLE_PUBLIC_RPC` | hardening | Set `1` to turn off the public RPC fallback. |
| `DEXE_PINATA_JWT` | IPFS uploads | Required for DAO/proposal creation (metadata pinning). |
| `DEXE_IPFS_GATEWAY` | IPFS reads | Dedicated gateway (Pinata, Filebase, self-hosted). Without one, public gateways (ipfs.io, dweb.link) are used. |
| `DEXE_PINATA_GATEWAY_TOKEN` | IPFS reads | Gateway key for restricted Pinata dedicated gateways. |
| `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK` | hardening | Set `1` to disable public gateway fallback. |
| `DEXE_WALLETCONNECT_PROJECT_ID` | WalletConnect signing | A shared default ships; set your own project ID for production use. |
| `DEXE_PRIVATE_KEY` | broadcast mode | Hot-key signing. Opt-in; prefer WalletConnect. Never required for build tools. |
| `DEXE_TOOLSETS` | tool gating | Comma list of profiles; default `core,proposals`. |
| `DEXE_SUBGRAPH_POOLS_URL` / `_VALIDATORS_URL` / `_INTERACTIONS_URL` | subgraph reads | The Graph endpoints; defaults target the decentralized network. |
| `DEXE_GRAPH_API_KEY` | subgraph reads | Only when the URL doesn't embed the key. |
| `DEXE_BACKEND_API_URL` | off-chain proposals | DeXe backend, e.g. `https://api.dexe.io`. |
| `DEXE_STATE_PATH` | persistence | Overrides the session-state file (`~/.dexe-mcp/state.json`). |
| `DEXE_PROTOCOL_PATH` | dev toolset | Existing DeXe-Protocol checkout; disables auto-clone. |

## Documentation

- [docs/PLAYBOOK.md](./docs/PLAYBOOK.md) — the AI playbook: intent → exact call, per-type params, error → remedy. Also served as the MCP resource `dexe://playbook`.
- [docs/TOOLS.md](./docs/TOOLS.md) — all 159 tools, grouped, with one-line descriptions and required env vars.
- [docs/USAGE.md](./docs/USAGE.md) — worked examples with copy-pasteable JSON.
- [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) — full env-var reference and common pitfalls.
- [docs/INSTALL.md](./docs/INSTALL.md) — install instructions per MCP client.
- [docs/SETUP.md](./docs/SETUP.md) / [docs/DOCTOR.md](./docs/DOCTOR.md) — setup wizard and diagnostic reference.
- [docs/SKILLS.md](./docs/SKILLS.md) — the Claude Code skills shipped with the package.
- [docs/GOVERNOR.md](./docs/GOVERNOR.md) — the external OZ/Bravo Governor surface.
- [docs/WALLETCONNECT.md](./docs/WALLETCONNECT.md) — phone-approved signing without a hot key.
- [docs/OTC.md](./docs/OTC.md) — multi-tier OTC sale flows for owners and buyers.
- [docs/PROFILE.md](./docs/PROFILE.md) — DAO profile and avatar pipeline.
- [docs/SIMULATOR.md](./docs/SIMULATOR.md) — preflight simulation with revert decoding.
- [docs/INBOX.md](./docs/INBOX.md) — cross-DAO inbox and proposal forecast.
- [docs/MIGRATION.md](./docs/MIGRATION.md) — per-version upgrade notes.

## Swarm test harness

[`tests/swarm/`](./tests/swarm) is a multi-agent harness that exercises the tool surface against real BSC-testnet DAOs: 59 JSON scenarios covering delegation chains, the validator chamber, build-only checks for every proposal type, OTC flows, and full broadcast lifecycles. The orchestrator resolves agent wallets and runs each step through an inline ethers dispatcher or the dexe-mcp stdio bridge.

```bash
npm run swarm:preflight                # per-wallet readiness table
npm run swarm:fund -- --confirm        # top up agent wallets from the funder
npm run swarm:run                      # full sweep
npm run swarm:run -- --scenarios=S00-reset --dry-run
```

Setup runbook: [tests/swarm/README.md](./tests/swarm/README.md) · scenario schema: [tests/swarm/scenarios/_schema.md](./tests/swarm/scenarios/_schema.md) · agent prompts: [tests/swarm/prompts/](./tests/swarm/prompts).

## Contributing

```bash
git clone https://github.com/edward-arinin-web-dev/dexe-mcp.git
cd dexe-mcp
npm install
npm run build
npm test
npm run dev          # watch mode
```

Issues, PRs, and proposal-type requests: [GitHub issues](https://github.com/edward-arinin-web-dev/dexe-mcp/issues).

## Security

See [SECURITY.md](./SECURITY.md) for the threat model, policy, and how to report a vulnerability. In short:

- Release tags are GPG-signed; `release.yml` runs `git verify-tag` before publishing. Verify locally with `git verify-tag <tag>` (e.g. `v0.19.0`) after importing the maintainer key.
- npm releases publish with `--provenance`; verify with `npm audit signatures`.
- CI installs strictly from the committed lockfile and fails on drift.
- CodeQL, OSSF Scorecard, and Dependency Review run on PRs and on a schedule.

## License

MIT. See [LICENSE](./LICENSE).

---

<p align="center">
  <sub>Independent open-source integration for the DeXe Protocol governance stack. Not affiliated with DeXe Network.</sub>
</p>
