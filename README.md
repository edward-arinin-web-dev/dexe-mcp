# dexe-mcp

![npm](https://img.shields.io/npm/v/dexe-mcp.svg)

MCP server that gives AI agents **full DeXe Protocol DAO operations coverage** — deploy DAOs, build any of the 33 proposal types the DeXe UI exposes, upload metadata to IPFS, stake/delegate/vote/execute/claim. Plus dev tooling: build/test/lint, contract introspection, ABI-aware calldata decoding.

**Writes return calldata.** No signer ever lives in the MCP — every write tool emits a ready-to-sign `{ to, data, value, chainId, description }` payload that the agent's wallet (MetaMask, Safe, hardware, etc.) signs and submits. No `PRIVATE_KEY` env var, ever.

**83 tools** across 8 groups. Call `dexe_proposal_catalog` at runtime for the full proposal-type map, or browse the [catalog](#tool-catalog) below.

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

## First run

The MCP server starts instantly. On the first build-tool call (`dexe_compile` / `dexe_test` / `dexe_lint`), dexe-mcp will automatically shallow-clone DeXe-Protocol into a platform cache directory and run `npm install` there once. If you prefer to reuse an existing checkout, set `DEXE_PROTOCOL_PATH` in the MCP `env` block and nothing will be cloned.

Most tools don't need the protocol checkout at all — read/proposal/vote/deploy builders only need an RPC URL. Only the dev-tooling group (`dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint`, and the introspection tools) depends on artifacts.

## Environment variables

All optional. Tools that need a missing variable fail with a clear message pointing at exactly what to set.

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

## Tool catalog

### Dev tooling (compile / test / introspect / decode)

| Tool | Description |
|------|-------------|
| `dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint` | Hardhat wrappers |
| `dexe_list_contracts`, `dexe_get_abi`, `dexe_get_methods`, `dexe_get_selectors`, `dexe_find_selector`, `dexe_get_natspec`, `dexe_get_source` | Contract introspection from compiled artifacts |
| `dexe_decode_calldata`, `dexe_decode_proposal`, `dexe_list_gov_contract_types` | ABI-aware calldata / proposal decoding |

### DAO reads (on-chain state via multicall + subgraph)

| Tool | Description |
|------|-------------|
| `dexe_dao_info` | DAO overview — helpers, NFT contracts, validator count |
| `dexe_dao_predict_addresses` | Predict CREATE2 addresses for a future DAO |
| `dexe_dao_registry_lookup` | Is this address a registered GovPool? |
| `dexe_proposal_state`, `dexe_proposal_list`, `dexe_proposal_voters` | Proposal reads (voters via subgraph) |
| `dexe_vote_user_power`, `dexe_vote_get_votes` | User staking + per-proposal vote info |
| `dexe_read_multicall` | Generic Multicall3 batched `eth_call` |
| `dexe_read_treasury`, `dexe_read_validators`, `dexe_read_settings`, `dexe_read_expert_status` | Canned live reads |
| `dexe_read_gov_state` | Aggregate gov-pool state (legacy helper) |

### IPFS

| Tool | Description |
|------|-------------|
| `dexe_ipfs_upload_proposal_metadata`, `dexe_ipfs_upload_dao_metadata`, `dexe_ipfs_upload_file` | Pinata uploads (requires `DEXE_PINATA_JWT`) |
| `dexe_ipfs_fetch` | Fetch by CID via configured dedicated gateway |
| `dexe_ipfs_cid_info` | Parse CID + v0↔v1 conversion + gateway URLs |
| `dexe_ipfs_cid_for_json` | Compute CIDv1 locally (no network) for dry-run flows |

### DAO deploy

| Tool | Description |
|------|-------------|
| `dexe_dao_build_deploy` | Encode `PoolFactory.deployGovPool(GovPoolDeployParams)` with full nested-struct input (settings / validators / userKeeper / token / votePower / verifier / BABT flag / descriptionURL / name). Auto-resolves PoolFactory via registry; optionally returns the predicted GovPool address |

### Proposals — primitives + catalog

| Tool | Description |
|------|-------------|
| `dexe_proposal_catalog` | Enumerate **all 33** proposal types with schemas, gating, metadata shape, and the MCP tool that handles each |
| `dexe_proposal_build_external` | Raw `GovPool.createProposal(url, actionsFor, actionsAgainst)` (+ `createProposalAndVote` variant) |
| `dexe_proposal_build_internal` | Raw `GovValidators.createInternalProposal(type, url, data)` |
| `dexe_proposal_build_custom_abi` | Encode any ABI call → one `ProposalAction` |
| `dexe_proposal_build_offchain` | Generic DeXe backend HTTP request builder |

### Proposal wrappers — external (on-chain)

Each returns `{ metadata, actions[] }` — upload the metadata via `dexe_ipfs_upload_proposal_metadata`, then feed actions into `dexe_proposal_build_external`:

`dexe_proposal_build_token_transfer`, `_token_distribution`, `_token_sale`, `_token_sale_recover`, `_change_voting_settings`, `_manage_validators`, `_add_expert`, `_remove_expert`, `_withdraw_treasury`, `_delegate_to_expert`, `_revoke_from_expert`, `_create_staking_tier`, `_change_math_model`, `_modify_dao_profile`, `_blacklist`, `_reward_multiplier`, `_apply_to_dao`, `_new_proposal_type` (also covers *Enable Staking*).

### Proposal wrappers — internal validator

Return `{ metadata, proposalType, data }` — compose with `dexe_proposal_build_internal`:

`dexe_proposal_build_change_validator_balances` (type 0), `_change_validator_settings` (type 1), `_monthly_withdraw` (type 2), `_offchain_internal_proposal` (type 3).

### Proposal wrappers — off-chain (DeXe backend)

`dexe_proposal_build_offchain_single_option`, `_offchain_multi_option`, `_offchain_for_against`, `_offchain_settings`.

Plus auth + vote helpers: `dexe_auth_request_nonce`, `dexe_auth_login_request`, `dexe_offchain_build_vote`, `dexe_offchain_build_cancel_vote`.

### Vote / stake / execute / claim (direct EOA writes)

| Tool | Description |
|------|-------------|
| `dexe_vote_build_erc20_approve` | ERC20 approve — prepend before `deposit` for ERC20-staking DAOs |
| `dexe_vote_build_deposit` | `GovPool.deposit(amount, nftIds)` — payable for native-coin DAOs |
| `dexe_vote_build_withdraw` | `GovPool.withdraw(receiver, amount, nftIds)` |
| `dexe_vote_build_delegate`, `_undelegate` | User-level delegation on `GovPool` |
| `dexe_vote_build_vote`, `_cancel_vote` | `GovPool.vote(pid, isFor, amount, nftIds)` / `cancelVote` |
| `dexe_vote_build_validator_vote`, `_validator_cancel_vote` | Validator voting (internal/external scope) |
| `dexe_vote_build_move_to_validators`, `_execute` | Proposal lifecycle |
| `dexe_vote_build_claim_rewards`, `_claim_micropool_rewards` | Reward claiming |
| `dexe_vote_build_multicall` | Atomic `GovPool.multicall(bytes[])` — batch any of the above into one tx |

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
