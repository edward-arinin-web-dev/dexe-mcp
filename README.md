# dexe-mcp

![npm](https://img.shields.io/npm/v/dexe-mcp.svg)

MCP server that gives AI agents **full DeXe Protocol DAO operations coverage** — deploy DAOs, build any of the 33 proposal types the DeXe UI exposes, upload metadata to IPFS, stake/delegate/vote/execute/claim. Plus dev tooling: build/test/lint, contract introspection, ABI-aware calldata decoding.

**Two write modes, calldata-default.** Every write tool returns a ready-to-sign `TxPayload = { to, data, value, chainId, description }` that the agent's wallet (MetaMask, Safe, hardware, etc.) signs and submits — no key in the MCP. Power users who *want* the server to sign and broadcast can opt in by setting `DEXE_PRIVATE_KEY`; that unlocks `dexe_tx_send`, `dexe_tx_status`, and the auto-broadcast branch of `dexe_proposal_create` / `dexe_proposal_vote_and_execute`. Default stays calldata-only.

**125 tools** across 14 groups. Call `dexe_proposal_catalog` at runtime for the full proposal-type map, or browse the [catalog](#tool-catalog) below.

> **End-to-end coverage.** Every proposal-builder tool ships with a swarm-test scenario that exercises it on BSC testnet. Latest pass: **41/41 scenarios green**, ~200 broadcasts validated against two fixture DAOs (Glacier 50%-quorum + Sentinel 5%-quorum-with-validators). See [Swarm test harness](#swarm-test-harness) below.

## Prerequisites

- **Node.js ≥ 20** with a working `npm` (`node --version` and `npm --version` must both succeed).
- **Git** — only needed the first time a build tool runs, to clone DeXe-Protocol. Skippable if you point `DEXE_PROTOCOL_PATH` at an existing checkout.

## Install

```bash
npm install -g dexe-mcp
```

Register the server with your MCP client (`.mcp.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp"
    }
  }
}
```

If your client can't spawn the bare `dexe-mcp` command directly (a known issue with some MCP clients on Windows when PATH-shim resolution is involved), point it at the installed script via Node:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "node",
      "args": ["<output of `npm root -g`>/dexe-mcp/dist/index.js"]
    }
  }
}
```

Run `npm root -g` to resolve the path on your machine. Restart the MCP client and the `dexe_*` tools will appear.

## Quickstart

Minimum config to get **read-only** access to a BSC mainnet DAO:

```json
{
  "mcpServers": {
    "dexe": {
      "command": "dexe-mcp",
      "env": {
        "DEXE_RPC_URL": "https://bsc-dataseed.binance.org",
        "DEXE_CHAIN_ID": "56"
      }
    }
  }
}
```

Add `DEXE_PINATA_JWT` for IPFS uploads, `DEXE_BACKEND_API_URL` for off-chain proposals, and per-chain subgraph URLs for `dexe_proposal_voters` and the DAO-list reads. Full matrix → [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md).

Three first-call examples (full set in [`docs/USAGE.md`](./docs/USAGE.md)):

```jsonc
// 1) discover available proposal types
dexe_proposal_catalog({ category: "all", implementedOnly: true })

// 2) read a DAO
dexe_dao_info({ govPool: "0x..." })

// 3) build a token-transfer proposal (calldata only)
dexe_proposal_build_token_transfer({
  govPool: "0x...",
  token:   "0x...",
  recipient: "0x...",
  amount: "1000000000000000000"
})
```

## First run

The MCP server starts instantly. On the first build-tool call (`dexe_compile` / `dexe_test` / `dexe_lint`), dexe-mcp will automatically shallow-clone DeXe-Protocol into a platform cache directory and run `npm install` there once. If you prefer to reuse an existing checkout, set `DEXE_PROTOCOL_PATH` in the MCP `env` block and nothing will be cloned.

Most tools don't need the protocol checkout at all — read/proposal/vote/deploy builders only need an RPC URL. Only the dev-tooling group (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`, and the introspection tools) depends on artifacts.

## Environment variables

All optional. Tools that need a missing variable fail with a clear message pointing at exactly what to set. Full matrix + per-tool requirements → [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md).

| Variable | Required for | Purpose |
|----------|--------------|---------|
| `DEXE_PROTOCOL_PATH` | dev tooling (optional) | Use an existing DeXe-Protocol checkout; disables auto clone/install |
| `DEXE_RPC_URL` | reads / predict / deploy | JSON-RPC endpoint (BSC or any EVM chain where DeXe is deployed) |
| `DEXE_CHAIN_ID` | reads | Defaults to `56` (BSC mainnet). Override for other chains |
| `DEXE_CONTRACTS_REGISTRY` | reads (optional) | Override the ContractsRegistry root; defaults to the known per-chain address |
| `DEXE_PINATA_JWT` | IPFS uploads | Pinata JWT for pinning proposal/DAO metadata |
| `DEXE_IPFS_GATEWAY` | IPFS fetch | **Dedicated** gateway URL (Pinata provides one alongside your JWT; Filebase / Quicknode / self-hosted also work). Public gateways are unreliable and NOT defaulted |
| `DEXE_IPFS_GATEWAYS_FALLBACK` | IPFS fetch (optional) | Comma-separated public gateways tried sequentially after the primary |
| `DEXE_SUBGRAPH_INTERACTIONS_URL` | `dexe_proposal_voters` | The Graph endpoint for the DeXe interactions subgraph |
| `DEXE_SUBGRAPH_POOLS_URL`, `DEXE_SUBGRAPH_VALIDATORS_URL` | reserved | Additional subgraph endpoints for future tools |
| `DEXE_BACKEND_API_URL` | off-chain proposals | DeXe backend (e.g. `https://api.dexe.io`) |

## Documentation

Full docs in [`docs/`](./docs):

- [`docs/TOOLS.md`](./docs/TOOLS.md) — complete catalog of all 125 tools, organized by category, with one-line descriptions and required envs per tool.
- [`docs/USAGE.md`](./docs/USAGE.md) — 10 worked examples (deploy DAO, create proposals, vote, delegate, validator chamber, decode calldata, off-chain proposals, multicall batching). Copy-pasteable JSON.
- [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md) — full env-var reference: minimum block to get started, per-category requirements, calldata vs signer mode, chain-specific config, IPFS gateway rationale, subgraph migration, swarm harness envs, common pitfalls.

## Tool surface (high-level)

| Group | Tools | What |
|-------|-------|------|
| Dev tooling | 4 | Hardhat wrappers: `dexe_compile`, `_test`, `_coverage`, `_lint` |
| Contract introspection | 10 | `_list_contracts`, `_get_abi`, `_get_methods`, `_get_selectors`, `_find_selector`, `_get_natspec`, `_get_source`, `_decode_calldata`, `_decode_proposal`, `_list_gov_contract_types` |
| DAO reads | 25 | `_dao_info`, `_dao_predict_addresses`, `_dao_registry_lookup`, `_proposal_state/_list/_voters`, `_vote_user_power/_get_votes`, `_read_*` family |
| IPFS | 6 | Pinata uploads, gateway fetch, CID computation |
| DAO deploy | 1 | `dexe_dao_build_deploy` (encodes `PoolFactory.deployGovPool` with full nested struct + predicted addr wiring) |
| Proposal catalog + primitives | 5 | `dexe_proposal_catalog` enumerates **all 33** types; primitives: `_build_external`, `_build_internal`, `_build_custom_abi`, `_build_offchain` |
| External proposal wrappers | 20 | Token transfer / distribution / sale (single + multi-tier), treasury withdraw, validators, experts, staking tier, math model, blacklist, reward multiplier, apply to DAO, modify profile, change voting settings, new proposal type, addToWhitelist, etc. |
| Internal validator wrappers | 4 | `_change_validator_balances`, `_change_validator_settings`, `_monthly_withdraw`, `_offchain_internal_proposal` |
| Off-chain backend | 8 | `_offchain_single_option/_multi_option/_for_against/_settings`, auth flow (`_auth_request_nonce`, `_auth_login_request`), `_offchain_build_vote/_cancel_vote` |
| Vote / stake / delegate / execute / claim | 16 | `_vote_build_*` family — every direct EOA write on GovPool / Validators |
| Composite signing flows | 4 | `_proposal_create`, `_proposal_vote_and_execute`, `_tx_send`, `_tx_status` (all opt-in via `DEXE_PRIVATE_KEY`) |
| Subgraph reads | 7 | DAO list, members, experts, user activity, delegation map, distribution status, OTC sale tiers per DAO (decentralized network endpoints + RPC fallback) |
| Merkle utility | 2 | `dexe_merkle_build`, `dexe_merkle_proof` — OZ `StandardMerkleTree`-compatible (sorted-pair commutative keccak, double-hash leaf) |
| OTC composites | 4 | `dexe_otc_dao_open_sale`, `_buyer_status`, `_buyer_buy`, `_buyer_claim_all` — full project-owner + buyer flows over `TokenSaleProposal`. See [`docs/OTC.md`](./docs/OTC.md) |
| Simulator | 3 | `dexe_sim_calldata`, `_sim_proposal`, `_sim_buy` — `eth_call`-based preflight with revert-reason decoding. See [`docs/SIMULATOR.md`](./docs/SIMULATOR.md) |
| Multi-DAO inbox + forecast | 2 | `dexe_user_inbox` — pending items across N DAOs (unvoted proposals, claimable rewards, locked deposits). `_proposal_forecast` — pass-rate prediction with quorum projection + risk flags. See [`docs/INBOX.md`](./docs/INBOX.md) |

Total: **125**. Per-tool descriptions, args, return shapes → [`docs/TOOLS.md`](./docs/TOOLS.md).

## Swarm test harness

`tests/swarm/` is a multi-agent DAO testing harness that exercises every dexe-mcp
tool against real BSC-testnet DAOs. Scenarios are JSON specs; the orchestrator
loads them, resolves agent wallets, and runs each step through either an inline
ethers dispatcher or the dexe-mcp stdio bridge.

**41 scenarios shipped** covering:

- Reset + delegation chains (S00, S01, S06, S14)
- Validator chamber pass / veto / full lifecycle (S02, S03, S07)
- Read-only snapshots: expert state, participation, validators, cross-DAO,
  catalog, multi-proposal state, user activity (S04, S05, S09, S10, S11, S13, S15)
- Cancel-vote, decode-and-introspect (S08, S12)
- Build-only sanity for every proposal type in `dexe_proposal_catalog`
  (token transfer, blacklist, withdraw treasury, apply to dao, token
  distribution, token sale + recover, manage validators, change validator
  balances/settings, monthly withdraw, add/remove expert (local + global),
  delegate/revoke from expert, reward multiplier (4 modes), change voting
  settings, new proposal type, change math model, custom ABI, manual calldata,
  create staking tier, off-chain validator + for/against + settings) (S16–S40)

```bash
# 1) generate 9 wallets (8 agents + funder), fund the funder from your wallet
# 2) deploy fixture DAOs via dexe_dao_build_deploy (one 50% quorum + one with validators)
# 3) configure SWARM_DAOS_TESTNET / SWARM_TOKENS_TESTNET / SWARM_RPC_URL_TESTNET
npm run swarm:preflight                # red/green table per wallet
npm run swarm:fund -- --confirm        # broadcast top-ups from funder
npm run swarm:run                      # full sweep, all scenarios
npm run swarm:run -- --scenarios=S00-reset,S01-delegation-chain-3hop --dry-run
```

Setup runbook: [`tests/swarm/README.md`](tests/swarm/README.md).
Scenario schema: [`tests/swarm/scenarios/_schema.md`](tests/swarm/scenarios/_schema.md).
Per-role agent prompts: `tests/swarm/prompts/`.

## Contributing

```bash
git clone https://github.com/edward-arinin-web-dev/dexe-mcp.git
cd dexe-mcp
npm install
npm run build
npm run typecheck
npm run dev          # watch mode
```

## License

MIT. See [LICENSE](./LICENSE).
