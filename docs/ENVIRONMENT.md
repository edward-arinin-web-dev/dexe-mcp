# Environment variables — dexe-mcp

Reference for integrators configuring `dexe-mcp` in `.mcp.json`,
`claude_desktop_config.json`, or a custom MCP client.

The server self-loads `.env` from the directory containing `dist/index.js` via
`process.loadEnvFile()` ([`src/index.ts`](../src/index.ts)). You can either
populate that `.env` or pass vars through the MCP client's `env` block — both
work.

All vars are **optional**. A tool that needs a missing var fails with a
message naming exactly which var to set.

---

## 1. Quick start — minimum env block

Read-only operation against BSC mainnet (proposal lists, state reads, decode):

```env
DEXE_RPC_URL=https://mbsc1.dexe.io/rpc
DEXE_CHAIN_ID=56
DEXE_PINATA_JWT=<your-pinata-jwt>
DEXE_IPFS_GATEWAY=https://<your-subdomain>.mypinata.cloud
DEXE_SUBGRAPH_POOLS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<pools-id>
DEXE_SUBGRAPH_INTERACTIONS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<interactions-id>
```

That covers reads + IPFS fetch/upload + DAO/proposal/voter discovery. Adding
write tools (deploy, proposal builders, vote) does not require any new env
var — those tools return `TxPayload` calldata your wallet signs externally.

To enable in-server signing (optional, see §4): add `DEXE_PRIVATE_KEY`.

---

## 2. Full env reference

| Variable | Required for | Purpose | Example |
|----------|--------------|---------|---------|
| `DEXE_RPC_URL` | All on-chain reads, all builders that resolve helpers via registry, signer mode | JSON-RPC endpoint. Any EVM chain where DeXe is deployed. | `https://mbsc1.dexe.io/rpc` |
| `DEXE_CHAIN_ID` | Chain selection | Defaults to `56` (BSC mainnet). Must be a positive integer. | `56`, `97`, `1`, `137` |
| `DEXE_CONTRACTS_REGISTRY` | Custom chain / non-default registry | Override the `ContractsRegistry` root address. Defaults to the per-chain known address from `src/lib/addresses.ts`. | `0x...` |
| `DEXE_PINATA_JWT` | All `dexe_ipfs_upload_*` tools, auto-upload of `executorDescription` in `dexe_dao_build_deploy`, `dexe_proposal_create` flow | Pinata JWT for pinning JSON / files. | `eyJhbGciOi...` |
| `DEXE_IPFS_GATEWAY` | `dexe_ipfs_fetch`, any tool that re-reads metadata from IPFS | **Dedicated** gateway URL (Pinata bundles one with the JWT; Filebase / QuickNode / self-hosted also fine). Public gateways throttle and disagree on CIDs — not defaulted. | `https://my-sub.mypinata.cloud` |
| `DEXE_IPFS_GATEWAYS_FALLBACK` | `dexe_ipfs_fetch` (optional) | Comma-separated public gateways tried sequentially after the primary fails. Best-effort opt-in. | `https://dweb.link,https://ipfs.io` |
| `DEXE_SUBGRAPH_POOLS_URL` | `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`, `dexe_read_dao_experts`, `dexe_proposal_voters` | The Graph endpoint for the DeXe pools subgraph. | `https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<id>` |
| `DEXE_SUBGRAPH_VALIDATORS_URL` | `dexe_read_validator_list` | The Graph endpoint for the validators subgraph. | same shape |
| `DEXE_SUBGRAPH_INTERACTIONS_URL` | `dexe_read_user_activity`, `dexe_proposal_voters` (interactions composite ID lookup) | The Graph endpoint for the interactions subgraph. | same shape |
| `DEXE_BACKEND_API_URL` | `dexe_proposal_build_offchain*`, `dexe_offchain_build_*`, `dexe_auth_*` | DeXe backend root. | `https://api.dexe.io`, `https://api.beta.dexe.io` |
| `DEXE_PROTOCOL_PATH` | dev tooling (optional) | Use an existing DeXe-Protocol checkout instead of the auto-managed cache directory; disables auto clone/install. Must be a Hardhat project (`hardhat.config.{js,ts}`) with `node_modules/`. | `D:/dev/DeXe-Protocol` |
| `DEXE_FORK_BLOCK` | reserved (Phase B) | Pin a fork block for deterministic state reads. Non-negative integer. | `38123456` |
| `DEXE_PRIVATE_KEY` | `dexe_tx_send`, signed branch of `dexe_proposal_create` / `dexe_proposal_vote_and_execute` | 0x-prefixed 64-hex EOA key. Requires `DEXE_RPC_URL`. **Process-resident — see §4.** | `0xabc...` |
| `DEXE_PRIVACY_POLICY_HASH` | `dexe_vote_build_privacy_policy_*` (optional) | Default privacy-policy bytes32 hash. Otherwise read live from `UserRegistry.documentHash()`. | `0x...` |

Every var is read once during `loadConfig()` at startup or directly from
`process.env` inside the relevant tool. Changes require an MCP server restart.

---

## 3. Per-category requirements

Maps tool groups (from README / TOOLS.md) to the env vars each one actually
touches.

| Category | Tools | Required env |
|----------|-------|--------------|
| Dev tooling — compile/test/coverage/lint | `dexe_compile`, `dexe_test`, `dexe_coverage`, `dexe_lint` | `DEXE_PROTOCOL_PATH` (optional — auto-managed if unset) |
| Dev tooling — introspection | `dexe_list_contracts`, `dexe_get_abi`, `dexe_get_methods`, `dexe_get_selectors`, `dexe_find_selector`, `dexe_get_natspec`, `dexe_get_source` | (run `dexe_compile` first; reads artifacts) |
| Dev tooling — decode | `dexe_decode_calldata`, `dexe_list_gov_contract_types` | (artifacts only) |
| Dev tooling — decode (on-chain) | `dexe_decode_proposal` | `DEXE_RPC_URL` |
| DAO reads — on-chain multicall | `dexe_dao_info`, `dexe_dao_predict_addresses`, `dexe_dao_registry_lookup`, `dexe_proposal_state`, `dexe_proposal_list`, `dexe_vote_user_power`, `dexe_vote_get_votes`, `dexe_read_multicall`, `dexe_read_treasury`, `dexe_read_validators`, `dexe_read_settings`, `dexe_read_expert_status`, `dexe_read_gov_state`, `dexe_read_distribution_status`, `dexe_read_staking_info`, `dexe_read_token_sale_tiers`, `dexe_read_token_sale_user`, `dexe_read_privacy_policy_status` | `DEXE_RPC_URL`, `DEXE_CHAIN_ID`, `DEXE_CONTRACTS_REGISTRY` (fallback) |
| DAO reads — subgraph (pools) | `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`, `dexe_read_dao_experts` | `DEXE_SUBGRAPH_POOLS_URL` |
| DAO reads — subgraph (validators) | `dexe_read_validator_list` | `DEXE_SUBGRAPH_VALIDATORS_URL` |
| DAO reads — subgraph (interactions) | `dexe_read_user_activity`, `dexe_proposal_voters` | `DEXE_SUBGRAPH_INTERACTIONS_URL` (also `DEXE_SUBGRAPH_POOLS_URL` for pool address resolution in `dexe_proposal_voters`) |
| IPFS — uploads | `dexe_ipfs_upload_proposal_metadata`, `dexe_ipfs_upload_dao_metadata`, `dexe_ipfs_upload_file` | `DEXE_PINATA_JWT` |
| IPFS — read | `dexe_ipfs_fetch` | `DEXE_IPFS_GATEWAY` (and optionally `DEXE_IPFS_GATEWAYS_FALLBACK`) |
| IPFS — local | `dexe_ipfs_cid_info`, `dexe_ipfs_cid_for_json` | (none — pure compute) |
| DAO deploy | `dexe_dao_build_deploy` | `DEXE_RPC_URL` (for registry lookup of `PoolFactory` if not passed explicitly); `DEXE_PINATA_JWT` (optional — auto-uploads `executorDescription` JSONs when set) |
| Proposal builders — primitives | `dexe_proposal_build_external`, `dexe_proposal_build_internal`, `dexe_proposal_build_custom_abi`, `dexe_proposal_catalog` | (none for builders that don't resolve helpers) |
| Proposal builders — wrappers (external) | `dexe_proposal_build_token_transfer`, `_token_distribution`, `_token_sale`, `_token_sale_recover`, `_change_voting_settings`, `_manage_validators`, `_add_expert`, `_remove_expert`, `_withdraw_treasury`, `_delegate_to_expert`, `_revoke_from_expert`, `_create_staking_tier`, `_change_math_model`, `_modify_dao_profile`, `_blacklist`, `_reward_multiplier`, `_apply_to_dao`, `_new_proposal_type` | `DEXE_RPC_URL` (for helper-contract resolution where required by the builder) |
| Proposal builders — wrappers (internal validator) | `_change_validator_balances`, `_change_validator_settings`, `_monthly_withdraw`, `_offchain_internal_proposal` | `DEXE_RPC_URL` |
| Proposal builders — off-chain | `dexe_proposal_build_offchain*`, `dexe_offchain_build_vote`, `dexe_offchain_build_cancel_vote`, `dexe_auth_request_nonce`, `dexe_auth_login_request` | `DEXE_BACKEND_API_URL` |
| Vote / stake / execute / claim | `dexe_vote_build_*` (entire group) | (none — pure ABI encoding; chainId comes from `DEXE_CHAIN_ID`) |
| Composite flows | `dexe_proposal_create`, `dexe_proposal_vote_and_execute` | `DEXE_RPC_URL`, `DEXE_PINATA_JWT`; **either** `user` arg **or** `DEXE_PRIVATE_KEY` |
| Tx layer | `dexe_tx_send` | `DEXE_PRIVATE_KEY`, `DEXE_RPC_URL` |
| Tx layer (read) | `dexe_tx_status` | `DEXE_RPC_URL` |

When in doubt, run the tool with no env set — the error will name the missing
var.

---

## 4. Calldata mode vs signer mode

`dexe-mcp` defaults to **calldata mode**: every write tool returns a
`TxPayload`:

```json
{ "to": "0x...", "data": "0x...", "value": "0", "chainId": 56,
  "description": "GovPool.vote(...)" }
```

Your wallet (MetaMask, Safe, hardware, multisig, custom signer) signs and
broadcasts. No private key ever touches the MCP server.

**Signer mode** is opt-in by setting `DEXE_PRIVATE_KEY`. With a key configured:

- `dexe_tx_send` becomes callable (broadcasts arbitrary `TxPayload`s).
- `dexe_proposal_create` / `dexe_proposal_vote_and_execute` gain a signed
  branch — when `user` is omitted from the call, the configured wallet signs
  and broadcasts the prepared transactions end-to-end.
- All other write tools still return calldata; signing is opt-in **per call**.

**Security trade-off.** The key lives in the MCP server process for the
session lifetime. The MCP host (Claude Code, Claude Desktop, etc.) can
arbitrarily invoke any tool. Treat `DEXE_PRIVATE_KEY` like a hot wallet:

- Use a dedicated EOA, not a treasury key.
- Cap exposure (top up just-in-time funding).
- Never set `DEXE_PRIVATE_KEY` in a config file checked into git.
- Restart the server to rotate the key.

`DEXE_PRIVATE_KEY` requires `DEXE_RPC_URL` — startup fails fast otherwise.

---

## 5. Chain-specific config

### BSC mainnet (chain 56) — defaults

```env
DEXE_RPC_URL=https://mbsc1.dexe.io/rpc
DEXE_CHAIN_ID=56
```

`ContractsRegistry` resolves automatically; subgraph + DeXe backend exist.
Everything works out of the box.

### BSC testnet (chain 97)

```env
DEXE_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545
DEXE_CHAIN_ID=97
```

Caveats:

- **No DeXe subgraph on testnet.** `dexe_proposal_voters`,
  `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`,
  `dexe_read_dao_experts`, `dexe_read_validator_list`,
  `dexe_read_user_activity` will return empty / fail.
- **No DeXe backend on testnet.** All `dexe_proposal_build_offchain*`,
  `dexe_auth_*`, and `dexe_offchain_build_*` tools won't work.
- All on-chain reads, builders, deploys, votes, executes work normally.

### Other EVM chains

Need a `ContractsRegistry` deployment with the canonical DeXe address book
laid out (PoolFactory, GovPool implementation, Validators, UserRegistry,
etc.). Set:

```env
DEXE_RPC_URL=https://...
DEXE_CHAIN_ID=<id>
DEXE_CONTRACTS_REGISTRY=0x<your-registry>
```

Subgraph URLs only work if a DeXe subgraph is deployed for that chain.

---

## 6. IPFS configuration

### Why a dedicated gateway is required

Public gateways (`ipfs.io`, `dweb.link`, `cloudflare-ipfs.com`) throttle
aggressively, occasionally CID-disagree on freshly pinned content, and rate-
limit bursts. The MCP intentionally has **no public default** — `dexe_ipfs_fetch`
errors out unless you set one.

### Recommended: Pinata

Pinata bundles a JWT + a dedicated gateway subdomain:

```env
DEXE_PINATA_JWT=<jwt>
DEXE_IPFS_GATEWAY=https://my-sub.mypinata.cloud
```

The JWT is used for uploads; the gateway URL is used for reads. They are
independent — you can use Pinata for upload and a different gateway for read,
or vice versa.

### Alternatives

- **Filebase** — gateway URL of the form `https://<bucket>.<id>.s3.filebase.com/`.
- **QuickNode IPFS** — dedicated subdomain.
- **Self-hosted** (`go-ipfs` / `Kubo`) — point at the local HTTP gateway.

### Public fallback list

Best-effort fallback after the primary fails:

```env
DEXE_IPFS_GATEWAYS_FALLBACK=https://dweb.link,https://ipfs.io
```

The fetcher tries the primary first, then each fallback sequentially (not in
parallel — see [`src/lib/ipfs.ts`](../src/lib/ipfs.ts)).

---

## 7. Subgraph configuration

DeXe migrated from The Graph **Hosted Service / Studio** to the
**decentralized network**. Studio URLs are dead. Use the gateway form with
your API key embedded in the path:

```
https://gateway-arbitrum.network.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
```

A 401 response almost always means the API key is missing from the URL.

### Three subgraphs, three URLs

```env
DEXE_SUBGRAPH_POOLS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<pools-id>
DEXE_SUBGRAPH_VALIDATORS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<validators-id>
DEXE_SUBGRAPH_INTERACTIONS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<interactions-id>
```

Get current subgraph IDs from the DeXe team or
[`.env.example`](../.env.example) / project memory.

### Per-chain endpoints

The Graph network publishes per-chain subgraphs separately. BSC mainnet,
Ethereum mainnet, Sepolia, Polygon Amoy each have their own IDs. Switch IDs
when you switch `DEXE_CHAIN_ID`.

---

## 8. Swarm test harness envs

The swarm harness (`tests/swarm/`) uses a separate env block. Full setup
runbook: [`tests/swarm/README.md`](../tests/swarm/README.md). Brief callout:

| Variable | Purpose |
|----------|---------|
| `SWARM_CHAIN_ID` | `97` for testnet (default — contract scenarios), `56` for mainnet (subgraph + backend scenarios) |
| `SWARM_RPC_URL_TESTNET` | Falls back to `DEXE_RPC_URL` |
| `SWARM_RPC_URL_MAINNET` | Falls back to `DEXE_RPC_URL` |
| `SWARM_DAOS_TESTNET` / `SWARM_DAOS_MAINNET` | Per-chain DAO allowlist — preflight + fund + orchestrator reject anything else |
| `SWARM_TOKENS_TESTNET` / `SWARM_TOKENS_MAINNET` | Per-chain governance-token allowlist for `fund-pool.ts` |
| `AGENT_PK_1..8` | 8 role wallets (Proposer / Voters / Delegators / Validators / Expert) |
| `AGENT_FUNDER_PK` | Funder wallet — only sends to `AGENT_PK_*` addresses, only transfers tokens in `SWARM_TOKENS_*` |
| `SWARM_DAILY_BNB_BUDGET` | Cost guard. Default `0.05` BNB. Realistic 25-scenario sweep ≈ `0.008` BNB. |

Hard rules (cannot be relaxed in code): allowlist enforcement,
no-test-name DAO personas. See [`CLAUDE.md`](../CLAUDE.md) for the full
testing-strategy contract.

---

## 9. Common pitfalls

### `process.loadEnvFile()` quirks

The Node 21.7+ built-in parser is strict:

- **No spaces around `=`.** `FOO = bar` is invalid; use `FOO=bar`.
- **No trailing-newline-on-last-line bug** in older Node releases — make sure
  the file ends with a newline. Otherwise the last var silently disappears.
- **Quotes are literal.** `FOO="bar"` sets `FOO` to `"bar"` including the
  quotes. Don't quote unless the value actually needs quotes.
- **Comments only on their own line.** `FOO=bar # comment` keeps `bar #
  comment` as the value.

### MCP client env caching

Both Claude Code and Claude Desktop cache the MCP server's launch env. After
editing `.env` or the MCP `env` block:

- **Restart the MCP server.** In Claude Desktop: quit and relaunch the app.
  In Claude Code: `/mcp restart dexe` (or restart the Claude Code session).
- A live conversation will keep using the old env until the server process is
  recreated.

On Windows, Claude Code historically dropped most env vars from the
`settings.json` `env` block before spawning the server — that's why dexe-mcp
self-loads `.env` next to `dist/index.js`. If env vars seem to vanish, drop
them into that `.env` instead of the MCP client config.

### 401 on subgraph

Almost always means the API key isn't in the URL path. The decentralized
network requires it inline:

```
https://gateway-arbitrum.network.thegraph.com/api/<KEY>/subgraphs/id/<ID>
                                                ^^^^^ here, not as a header
```

### "Pinata gateway not configured" on reads

`DEXE_IPFS_GATEWAY` and `DEXE_PINATA_JWT` are independent. Setting only the
JWT lets you upload but not read — `dexe_ipfs_fetch` still needs the gateway
URL.

### `DEXE_PRIVATE_KEY` set, server fails to start

Startup aborts with `"DEXE_PRIVATE_KEY requires DEXE_RPC_URL to be set"`.
Signing needs an RPC endpoint to broadcast — set both or neither.

### "Set DEXE_CONTRACTS_REGISTRY or pick a supported chain"

Means the chain ID has no built-in registry address. Either switch to a
supported chain (BSC mainnet 56, others as deployed) or set
`DEXE_CONTRACTS_REGISTRY` explicitly.

---

## See also

- [`README.md`](../README.md) — install + quickstart
- [`TOOLS.md`](../TOOLS.md) — full per-tool catalog (if present)
- [`tests/swarm/README.md`](../tests/swarm/README.md) — swarm setup runbook
- [`src/config.ts`](../src/config.ts) — canonical env reader (single source of truth)
