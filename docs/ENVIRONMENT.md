# Environment variables — dexe-mcp

Reference for integrators configuring `dexe-mcp` in `.mcp.json`,
`claude_desktop_config.json`, or a custom MCP client.

The server self-loads `.env` via `process.loadEnvFile()`
([`src/index.ts`](../src/index.ts)), searching **cwd-independent** locations so
it works even when an MCP host launches it from an arbitrary directory (as the
Claude Code plugin does). It loads each of these that exists, in order — the
first file wins per key, and vars already in the process environment (e.g. the
MCP client's `env` block) beat all files:

1. `$DEXE_ENV_FILE` — an absolute path you set in the real environment.
2. `<cwd>/.env` — the working directory (convenient when run from the repo).
3. `~/.dexe-mcp/.env` — the **universal home config** (per-OS via `os.homedir()`;
   the same directory as `state.json`). Put your config here for plugin/`npx`
   use — it loads from any folder on macOS, Linux, and Windows.
4. `<pkgdir>/.env` — the installed package directory (npx cache; rarely present).

So you can populate any of those files, or pass vars through the MCP client's
`env` block — all work.

All vars are **optional**. A tool that needs a missing var fails with a
message naming exactly which var to set.

## What works with zero config (baked defaults, since 0.17.0)

`dexe-mcp` ships public defaults so a fresh install is useful immediately —
**reads and WalletConnect signing work with no `.env` at all.** Every default is
overridable: set the matching var and your value wins.

| Surface | Baked default | Override with |
|---------|---------------|---------------|
| On-chain RPC | Public BSC nodes, chains 56 + 97 (default 56) | `DEXE_RPC_URL_MAINNET` / `_TESTNET` (or `DEXE_DISABLE_PUBLIC_RPC=1`) |
| ContractsRegistry (56 + 97) | canonical address (same deterministic deploy on both chains) | `DEXE_CONTRACTS_REGISTRY` |
| Subgraph reads (**chain 56 only**) | shared DeXe gateway URLs (The Graph decentralized network, key in path) | `DEXE_SUBGRAPH_*_URL` (+ `DEXE_GRAPH_API_KEY`); other chains need `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` |
| Backend API | `https://api.dexe.io` | `DEXE_BACKEND_API_URL` |
| IPFS reads | public gateways (ipfs.io, dweb.link, cloudflare) | `DEXE_IPFS_GATEWAY` (or `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1`) |
| Signing | WalletConnect (shared project id) — connect via `dexe_wc_connect` | `DEXE_WALLETCONNECT_PROJECT_ID` (your own) or `DEXE_PRIVATE_KEY` |

**Not defaulted — you must provide:**

- `DEXE_PINATA_JWT` — IPFS *uploads* (creating DAOs/proposals pin metadata).
  Reads don't need it. This is the only hard blocker for the create flows.
- `DEXE_PRIVATE_KEY` — hot-key signing (opt-in; WalletConnect is the safer default).

**Shared defaults are billable-shared / rate-limited.** The default Graph API
key and WalletConnect project id ship publicly; fine for light use, but heavy
users should set their own. `dexe_doctor` flags this via the `env.sharedDefaults`
advisory, and `dexe_context.env.usingSharedDefaults` lists which surfaces are on
the shared defaults in the current session. Operators publishing their own fork
should **rotate** these keys — see [§8 Subgraph configuration](#8-subgraph-configuration).

> **For AI assistants and new users.** If a tool reports an env-related
> failure, **call `dexe_doctor` first** — it walks every recognized var,
> checks RPC / Pinata / subgraph reachability, and returns paste-ready
> remediation hints. The canonical schema lives in
> [`src/env/schema.ts`](../src/env/schema.ts); `dexe_doctor` reads from
> there, so the schema is the source of truth and this document tracks it.
> Env edits go in `.env` at the repo root (or the MCP host's `env` block —
> see the precedence note below). After any change, **restart Claude Code**
> (`process.loadEnvFile()` runs once at startup, and the host env block
> SHADOWS `.env` for any key set in both).

---

## 1. Quick start — minimum env block

> **Reads need zero env.** With no RPC configured the server falls back to
> public BSC endpoints (chains 56 + 97, default **56**), so on-chain reads work
> out of the box — this is what powers the Claude Code plugin's zero-setup
> install. Public dataseed nodes rate-limit and lack archive history; set your
> own RPC below for anything serious, or `DEXE_DISABLE_PUBLIC_RPC=1` to turn the
> fallback off. Everything in this section is about going *beyond* free reads.

Read-only operation against BSC mainnet (proposal lists, state reads, decode):

```env
DEXE_RPC_URL=https://bsc-dataseed.bnbchain.org
DEXE_CHAIN_ID=56
DEXE_PINATA_JWT=<your-pinata-jwt>
DEXE_IPFS_GATEWAY=https://<your-subdomain>.mypinata.cloud
DEXE_SUBGRAPH_POOLS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<pools-id>
DEXE_SUBGRAPH_INTERACTIONS_URL=https://gateway-arbitrum.network.thegraph.com/api/<key>/subgraphs/id/<interactions-id>
```

### Multi-chain mode (testnet + mainnet without restart)

If you want the MCP to broadcast on both BSC testnet and BSC mainnet from the same session, use the new per-chain RPC vars instead. Pass `chainId` to write tools (`dexe_tx_send`, `dexe_dao_build_deploy`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_otc_*`) to pick which chain to act on; omit it to use the default.

Both vars are **optional** — configure only the chain(s) you need. The MCP refuses to broadcast on a chain that doesn't have an RPC configured.

```env
# Configure both, or just one. Testnet alone:
DEXE_RPC_URL_TESTNET=https://data-seed-prebsc-1-s1.binance.org:8545

# Or mainnet alone:
DEXE_RPC_URL_MAINNET=https://bsc-dataseed.bnbchain.org

# When both are set, testnet is the default. Override with:
DEXE_DEFAULT_CHAIN_ID=56
```

Legacy `DEXE_RPC_URL` + `DEXE_CHAIN_ID` still works and stacks with the new vars; the legacy entry registers as one more chain in the pool.

Call `dexe_get_config` at session start to see which chains the server resolved and which one is the default.

That covers reads + IPFS fetch/upload + DAO/proposal/voter discovery. Adding
write tools (deploy, proposal builders, vote) does not require any new env
var — those tools return `TxPayload` calldata your wallet signs externally.

To enable in-server signing (optional, see §4): add `DEXE_PRIVATE_KEY`.

---

## 2. Full env reference

| Variable | Required for | Purpose | Example |
|----------|--------------|---------|---------|
| `DEXE_RPC_URL` | Single-chain legacy mode | JSON-RPC endpoint. Registers as the chain inferred from the URL hostname (or `DEXE_CHAIN_ID` when set). | `https://bsc-dataseed.bnbchain.org` |
| `DEXE_CHAIN_ID` | Single-chain legacy mode | Chain id paired with `DEXE_RPC_URL`. Optional — best-effort inferred from the hostname when omitted. | `56`, `97`, `1`, `137` |
| `DEXE_RPC_URL_TESTNET` | Multi-chain mode (testnet) | RPC for chain 97 (BSC testnet). Optional — set when you want the MCP to broadcast on testnet without restart. Accepts a **comma-separated fallback list** — the first URL is primary, the rest rotate automatically on transport failures. | `https://data-seed-prebsc-1-s1.binance.org:8545` |
| `DEXE_RPC_URL_MAINNET` | Multi-chain mode (mainnet) | RPC for chain 56 (BSC mainnet). Optional — set when you want to broadcast on mainnet without restart. Accepts a **comma-separated fallback list** (first = primary, rest rotate on transport failures). | `https://bsc-dataseed.bnbchain.org` |
| `DEXE_RPC_URL_<chainId>` | Generic per-chain RPC | RPC for any chain by numeric id. Registered automatically. Needed for the external Governor DAOs — Ethereum (`DEXE_RPC_URL_1`) and Optimism (`DEXE_RPC_URL_10`). Coexists with the BSC vars. Comma-separated fallback lists work here too. | `DEXE_RPC_URL_1=https://eth.llamarpc.com` |
| `DEXE_DEFAULT_CHAIN_ID` | Multi-chain mode (default selection) | Which configured chain is used when a tool call omits `chainId`. Defaults to testnet when both are configured explicitly; the zero-config public fallback defaults to mainnet (56). | `97`, `56` |
| `DEXE_TX_WAIT_TIMEOUT_MS` | Broadcast reliability (optional) | Max milliseconds to wait for a broadcast tx to mine before returning a check-with-`dexe_tx_status` error (the MCP request never hangs on a stuck tx). Default `180000` (3 min). | `180000`, `300000` |
| `DEXE_DISABLE_PUBLIC_RPC` | Zero-config read fallback | Set to `1` to disable the built-in public BSC RPC fallback that activates when **no** RPC is configured. Unset (default) = fallback on (chains 56 + 97, default 56). | `1` |
| `DEXE_CONTRACTS_REGISTRY` | Custom chain / non-default registry | Override the `ContractsRegistry` root address. Defaults to the per-chain known address from `src/lib/addresses.ts`. | `0x...` |
| `DEXE_PINATA_JWT` | All `dexe_ipfs_upload_*` tools, auto-upload of `executorDescription` in `dexe_dao_build_deploy`, `dexe_proposal_create` flow | Pinata JWT for pinning JSON / files. | `eyJhbGciOi...` |
| `DEXE_MAX_DESCRIPTION_LEN` | proposal/DAO metadata (optional) | Max characters accepted for proposal/DAO description markdown before conversion — guards the IPFS payload size. Over-limit descriptions error with a shorten-or-upload-as-file hint. Default `20000`. | `20000`, `50000` |
| `DEXE_IPFS_GATEWAY` | Reliability (optional) | Override the default public read gateways with a **dedicated** one (Pinata bundles one with the JWT; Filebase / QuickNode / self-hosted also fine). Reads default to public gateways since 0.17.0; set this for anything beyond light use. | `https://my-sub.mypinata.cloud` |
| `DEXE_IPFS_GATEWAYS_FALLBACK` | `dexe_ipfs_fetch` (optional) | Extra comma-separated public gateways appended to the list, tried sequentially. | `https://dweb.link,https://ipfs.io` |
| `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK` | opt-out (optional) | Set to `1` to disable the built-in public IPFS read-gateway default. Reads then require `DEXE_IPFS_GATEWAY`. | `1` |
| `DEXE_SUBGRAPH_POOLS_URL` | Optional override, **chain `DEXE_SUBGRAPH_CHAIN_ID` only** | Pools subgraph endpoint. **Defaults** to the shared DeXe gateway URL (BSC mainnet); set your own for heavy use. Used by `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`, `dexe_read_dao_experts`, `dexe_proposal_voters`. | `https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>` |
| `DEXE_SUBGRAPH_VALIDATORS_URL` | Optional override, same chain scoping | Validators subgraph. Defaults to the shared DeXe URL. Used by `dexe_read_validator_list`. | same shape |
| `DEXE_SUBGRAPH_INTERACTIONS_URL` | Optional override, same chain scoping | Interactions subgraph. Defaults to the shared DeXe URL. Used by `dexe_read_user_activity`. | same shape |
| `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` | Any chain other than `DEXE_SUBGRAPH_CHAIN_ID` | Per-chain endpoint — `KIND` is `POOLS` \| `VALIDATORS` \| `INTERACTIONS`. Highest precedence for that chain; the only way to serve a chain the unsuffixed vars don't cover. | `DEXE_SUBGRAPH_POOLS_URL_97=https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>` |
| `DEXE_SUBGRAPH_CHAIN_ID` | Own endpoints that don't index BSC mainnet | Which chain the three unsuffixed vars above (and the baked defaults) index. Default `56`. Setting it wrong files your endpoints under a chain nobody asked about. | `56`, `97` |
| `DEXE_GRAPH_API_KEY` | Bearer-only subgraph URLs | The Graph API key sent as `Authorization: Bearer`. Not needed with the default URLs (key is embedded in the path). Sent only to `*.thegraph.com` hosts, or back to the URL it was extracted from. | `abc123...` |
| `DEXE_BACKEND_API_URL` | Optional override | DeXe backend root. **Defaults** to `https://api.dexe.io`. Used by `dexe_read_treasury`/holders/stats, `dexe_proposal_build_offchain*`, `dexe_offchain_build_*`, `dexe_auth_*`. | `https://api.dexe.io`, `https://api.beta.dexe.io` |
| `DEXE_PROTOCOL_PATH` | dev tooling (optional) | Use an existing DeXe-Protocol checkout instead of the auto-managed cache directory; disables auto clone/install. Must be a Hardhat project (`hardhat.config.{js,ts}`) with `node_modules/`. | `D:/dev/DeXe-Protocol` |
| `DEXE_PROTOCOL_REF` | dev tooling (optional) | Git ref (branch/tag/commit) checked out for the auto-managed DeXe-Protocol clone. Default: the pinned release the MCP ships with. Ignored when `DEXE_PROTOCOL_PATH` points at your own checkout. | `master`, `v1.2.0`, a commit SHA |
| `DEXE_FORK_BLOCK` | reserved (Phase B) | Pin a fork block for deterministic state reads. Non-negative integer. | `38123456` |
| `DEXE_MIN_SAFE_QUORUM_PCT` | treasury-safety advisory | Minimum safe quorum percent (0–100). Proposals/DAOs whose quorum is below this are **flagged** in advisories (`dexe_proposal_vote_and_execute`, `dexe_proposal_risk_assess`, `dexe_dao_build_deploy`, treasury builders). **Advisory only — never blocks.** Default `50` (recommends 51%+). | `50`, `51`, `66` |
| `DEXE_TREASURY_GUARD` | treasury-safety advisory | Posture: `off` \| `warn`. `warn` (default) = advisories/alerts everywhere (build, deploy, execute, risk_assess); `off` = silent. **Advisory only — it never blocks.** The durable control is an adequate on-chain quorum threshold configured per DAO. | `warn`, `off` |
| `DEXE_CONTROLLING_TOPN` | treasury-safety advisory | Top-N token holders (by voting weight) in the "controlling set" alongside validators. `dexe_proposal_risk_assess` and the execute advisory **flag** a treasury proposal where **no** controlling member voted For (even at healthy quorum). Needs a **pools _and_ validators** endpoint for the chain being analyzed (chain 56 out of the box; other chains via `DEXE_SUBGRAPH_<KIND>_URL_<chainId>`) — an unindexed chain yields *unknown*, never another chain's controlling set. **Informational, never blocks.** Positive integer, default `5`. | `5`, `3`, `10` |
| `DEXE_TOOLSETS` | tool gating (`tools/list` size) | Comma list of tool profiles to register: `core`, `proposals`, `read`, `vote`, `governor`, `dev`, or `full`. **Default `core,proposals`** (74 tools) — a breaking slim from the old all-tools default (full = 165 tools). `full` or any unknown name loads everything. `dexe_doctor` reports the active set; restart Claude Code after editing. See [TOOLS.md § Toolset profiles](./TOOLS.md#toolset-profiles). | `core,proposals`, `full`, `core,proposals,vote,read` |
| `DEXE_STATE_PATH` | `dexe_context` persistence | Override path for the persistent operational-state JSON (DAOs deployed and proposals broadcast, surfaced by `dexe_context` across sessions). Default `~/.dexe-mcp/state.json`. Must be in a writable directory — `dexe_doctor` warns if not. Tools still work without persistence. | `~/.dexe-mcp/state.json`, `/data/dexe-state.json` |
| `DEXE_ENV_FILE` | env-file location | Absolute path to a `.env` loaded **first**, before the default cwd/home search. For CI/containers/hosts that can inject one variable but not a working directory. Must be set in the real process environment (it is read before any file loads), not inside a `.env`. | `/etc/dexe/prod.env`, `C:\config\dexe.env` |
| `DEXE_PRIVATE_KEY` | `dexe_tx_send`, signed branch of `dexe_proposal_create` / `dexe_proposal_vote_and_execute` | 0x-prefixed 64-hex EOA key. Requires `DEXE_RPC_URL`. **Process-resident — see §4.** | `0xabc...` |
| `DEXE_AGENT_PK_1` … `DEXE_AGENT_PK_16` | agent keyring (v0.28, optional) | Extra hot EOA keys for multi-persona/swarm flows. Selected per call via `signerKey: "agent<n>"` (or the address) on `dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, and the OTC buyer composites. The primary key stays the default — agent keys are never used implicitly. Same RPC requirement and plaintext-on-disk caveats as `DEXE_PRIVATE_KEY`; per-signer nonce queues let distinct agents broadcast concurrently. `dexe_agents_list` shows the roster. **Alias (0.29):** the swarm naming `AGENT_PK_1..16` is read as a fallback (the `DEXE_`-prefixed var wins if both are set). | `0xabc...` |
| `DEXE_AGENT_FUNDER_PK` (alias `AGENT_FUNDER_PK`) | agent keyring (0.29, optional) | Gas-funder wallet, keyring slot `funder` — usable as `signerKey:"funder"` anywhere and as `source:'funder'` on `dexe_agents_fund`. | `0xabc...` |
| `DEXE_AGENT_FUND_MAX_WEI` | `dexe_agents_fund` (optional) | Per-agent cap (wei) on a single funding transfer from the primary signer to a keyring wallet. Default 0.1 native when unset. Recipients are hard-restricted to keyring addresses regardless of this cap. | `100000000000000000` |
| `DEXE_SIGNER_ALLOWLIST` | `dexe_tx_send` (signer mode, optional) | **B6 guard.** Comma-separated destination addresses; `dexe_tx_send` rejects any `to` not on the list. Unset = no restriction. Validated + lowercased at startup; invalid address aborts startup. | `0xAbc...,0xDef...` |
| `DEXE_SIGNER_MAX_VALUE_WEI` | `dexe_tx_send` (signer mode, optional) | **B7 guard.** Hard cap on the `value` (wei) of any single broadcast; over-cap is rejected. Unset = no cap. | `100000000000000000` (0.1 BNB) |
| `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | `dexe_tx_send` (signer mode, optional) | **B10 guard.** Max broadcasts per rolling 60s window across the process; over-limit is rejected with a retry hint. Unset = no limit. | `10` |
| `DEXE_WALLETCONNECT_PROJECT_ID` | WalletConnect signer mode (C12) | Free project id from <https://cloud.reown.com>. **Defaults** to a shared project id, so `signerMode` is `walletconnect` (not `readonly`) out of the box when `DEXE_PRIVATE_KEY` is absent — connect via `dexe_wc_connect`. Set your own to stop sharing the default. Hot key wins when both are set. | `abc123...` |
| `DEXE_WALLETCONNECT_RELAY_URL` | WalletConnect (optional) | Override the relay websocket. | `wss://relay.walletconnect.com` (default) |
| `DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS` | WalletConnect (optional) | Per-tx phone-approval timeout; over-timeout returns `{status:'timeout'}` instead of hanging the MCP request. Validated `> 0`. | `120000` (default) |
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
| DAO reads — subgraph (pools) | `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`, `dexe_read_dao_experts`, `dexe_proposal_voters` | `DEXE_SUBGRAPH_POOLS_URL` for chain 56 · `DEXE_SUBGRAPH_POOLS_URL_<chainId>` for any other |
| DAO reads — subgraph (validators) | `dexe_read_validator_list` | `DEXE_SUBGRAPH_VALIDATORS_URL` / `..._URL_<chainId>` |
| DAO reads — subgraph (interactions) | `dexe_read_user_activity` | `DEXE_SUBGRAPH_INTERACTIONS_URL` / `..._URL_<chainId>` |
| DAO reads — subgraph (any) | `dexe_graph_query` | the var for the `subgraph` argument + `chainId` of the call |
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

### Signer broadcast guards (opt-in)

In signer mode, `dexe_tx_send` runs four guards before
`wallet.sendTransaction()`. Each is a no-op unless its env var is set, so they
narrow the blast radius of a compromised/confused MCP host without changing the
default posture. They run in order; the first failure rejects the broadcast
(JSON `{ status: "rejected", guard, reason }`, no gas spent):

| Guard | Env var | Effect |
|-------|---------|--------|
| **B6** destination allowlist | `DEXE_SIGNER_ALLOWLIST` | Rejects any `to` not on the comma-separated list. Confines the signer to known contracts. **List the GovPool _and_ its governance token** — deposit-requiring flows broadcast an `ERC20.approve` whose `to` is the **token** (UserKeeper is only the `spender` argument, never a `to`), so an allowlist missing the token rejects the approve step. |
| **B7** value cap | `DEXE_SIGNER_MAX_VALUE_WEI` | Rejects `value` above the cap. Bounds native-token outflow per tx. |
| **B9** auto-simulation | _(always on in signer mode)_ | `eth_call` preflight against live state; aborts with the decoded revert reason instead of paying gas for a doomed tx. |
| **B10** rate limit | `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | Rejects once N broadcasts have landed in the trailing 60s. Caps drain rate under a runaway loop. |

Recommended signer-mode block for a single-DAO operator:

```jsonc
"DEXE_SIGNER_ALLOWLIST": "0x<govPool>,0x<govToken>",
"DEXE_SIGNER_MAX_VALUE_WEI": "100000000000000000",  // 0.1 BNB
"DEXE_SIGNER_MAX_BROADCASTS_PER_MIN": "10"
```

`DEXE_PRIVATE_KEY` requires an RPC. When the zero-config public-RPC fallback is active (no RPC configured), the key signs against public BSC endpoints — set your own `DEXE_RPC_URL_MAINNET` / `DEXE_RPC_URL_TESTNET` for reliable broadcasting. If you additionally set `DEXE_DISABLE_PUBLIC_RPC=1` with a key but no RPC, startup fails fast.

---

## 5. Chain-specific config

### BSC mainnet (chain 56) — defaults

```env
DEXE_RPC_URL=https://bsc-dataseed.bnbchain.org
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

- **No DeXe subgraph on testnet.** `dexe_proposal_voters`, `dexe_graph_query`,
  `dexe_read_dao_list`, `dexe_read_dao_members`, `dexe_read_delegation_map`,
  `dexe_read_dao_experts`, `dexe_read_validator_list`,
  `dexe_read_user_activity` **refuse** the read: chain 97 has no endpoint, and
  since 0.30.2 they error with the var to set (`DEXE_SUBGRAPH_<KIND>_URL_97`)
  plus the on-chain alternatives, rather than silently answering from the
  mainnet index. Point them at your own testnet indexer to enable them.
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

## 6. Safe{Wallet} multisig signing (the `dexe_safe_*` tools)

When the operator key is custodied in a Gnosis Safe, the `dexe_safe_*` tools
**queue** a transaction in the Safe Transaction Service for owners to co-sign,
instead of broadcasting from a single EOA. See [`SAFE.md`](./SAFE.md) for the
full flow.

| Var | When required | What it does |
|-----|---------------|--------------|
| `DEXE_PRIVATE_KEY` | to sign a proposal | The signing EOA. Must be one of the Safe's owners or the service rejects the proposal. |
| `DEXE_SAFE_TX_SERVICE_URL` | chains without a hosted service, or self-hosted | Overrides the auto-resolved endpoint. Point it at the service base ending in `/api/v2`, e.g. `https://api.safe.global/tx-service/bnb/api/v2`. **Required for BSC testnet (97)** — no hosted Safe service exists there. |
| `DEXE_SAFE_API_KEY` | live POST to `api.safe.global` | Bearer token for the hosted Safe Transaction Service. Not needed when `dryRun=true` or when `DEXE_SAFE_TX_SERVICE_URL` points at a service that doesn't require auth. |

Endpoint resolution: with no override, `chainId` maps to
`https://api.safe.global/tx-service/<shortname>/api/v2` (eth, bnb, matic, base,
arb1, sep, …). `DEXE_SAFE_TX_SERVICE_URL` always wins when set.

`dexe_get_config` reports the effective `signerMode`:

- `readonly` — no `DEXE_PRIVATE_KEY`; tools return unsigned `TxPayload`s only.
- `eoa` — key set, no Safe service; `dexe_tx_send` broadcasts directly.
- `safe` — key set **and** `DEXE_SAFE_TX_SERVICE_URL` set; `dexe_safe_*` can
  queue to the multisig.
- `walletconnect` — **no** `DEXE_PRIVATE_KEY`, but `DEXE_WALLETCONNECT_PROJECT_ID`
  set; broadcasts are forwarded to the operator's phone wallet for approval (no
  hot key). Precedence: `safe` → `eoa` → `walletconnect` → `readonly`. Phase A is
  config-only — see [`WALLETCONNECT.md`](./WALLETCONNECT.md).

---

## 7. IPFS configuration

### Why a dedicated gateway is recommended

Since 0.17.0, IPFS reads default to a chain of public gateways (`ipfs.io`,
`dweb.link`, `cloudflare-ipfs.com`) so `dexe_ipfs_fetch` works with zero config.
But public gateways throttle aggressively, occasionally CID-disagree on freshly
pinned content, and rate-limit bursts — so for anything beyond light use set a
**dedicated** gateway via `DEXE_IPFS_GATEWAY`. When all gateways are the shared
public ones and a fetch fails, the error nudges you to configure a dedicated
one. Disable the public default entirely with `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1`
(reads then require `DEXE_IPFS_GATEWAY`).

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

## 8. Subgraph configuration

**Subgraph reads work with no config** — they default to shared DeXe endpoints
on The Graph's decentralized network (key embedded in the URL path). You only
set these vars to use your **own** Graph key (recommended for heavy use, since
the shared key is rate-limited and billable-shared).

DeXe migrated from The Graph **Hosted Service / Studio** to the **decentralized
network**. Studio URLs are dead. Use the gateway form (modern host
`gateway.thegraph.com`; the older `gateway-arbitrum.network.thegraph.com` still
resolves) with your API key embedded in the path:

```
https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
```

A 401 response almost always means the API key is missing from the URL.

### Rotating the shared default keys (fork operators)

If you publish your own fork, the baked default Graph key + WalletConnect project
id in `src/config.ts` (`DEFAULTS`) ship publicly. Replace them with your own, or
rotate them if abused — anyone can otherwise spend against your Graph query
budget. Light first-party use is fine on the shared defaults.

### Three subgraphs, three URLs

```env
DEXE_SUBGRAPH_POOLS_URL=https://gateway.thegraph.com/api/<key>/subgraphs/id/<pools-id>
DEXE_SUBGRAPH_VALIDATORS_URL=https://gateway.thegraph.com/api/<key>/subgraphs/id/<validators-id>
DEXE_SUBGRAPH_INTERACTIONS_URL=https://gateway.thegraph.com/api/<key>/subgraphs/id/<interactions-id>
```

Get current subgraph IDs from the DeXe team or
[`.env.example`](../.env.example) / project memory.

### One endpoint indexes one chain (0.30.2)

A subgraph is deployed against a single network, so an endpoint is only a
correct answer for the chain it indexes. Every subgraph-backed tool therefore
takes `chainId` and resolves its endpoint per *(kind, chain)*:

| # | Source | Covers |
|---|--------|--------|
| 1 | `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` | that chain — wins outright |
| 2 | `DEXE_SUBGRAPH_<KIND>_URL` | the chain named by `DEXE_SUBGRAPH_CHAIN_ID` (default `56`), and **only** that chain |
| 3 | baked default | chain `56` (BSC mainnet), and only chain `56` |

**There is no cross-chain fallback, ever.** A chain that matches none of the
three has no endpoint, and the read **fails** with a message naming
`DEXE_SUBGRAPH_<KIND>_URL_<thatChain>` and the on-chain alternatives
(`dexe_read_gov_state`, `dexe_proposal_list`, `dexe_read_multicall`). Answering
a testnet caller with mainnet rows is worse than not answering: it looks like a
successful read, so an agent acts on it. Every response carries
`indexedChainId` — the chain the rows actually came from — so the payload states
its own provenance.

`dexe_get_config` shows exactly what resolved, under `subgraph`:
`chainsCovered` (chains with any endpoint), `byKind` (chains per subgraph),
`missingForDefaultChain` (kinds the default chain cannot answer), and
`unsuffixedVarsChainId` (the chain your unsuffixed vars were filed under).

### Per-chain endpoints

The Graph publishes per-chain subgraphs separately — BSC mainnet, Ethereum
mainnet, Sepolia, Polygon Amoy each have their own subgraph IDs. File each one
under the chain it indexes rather than swapping a single var:

```env
# BSC mainnet (56) — covered by the unsuffixed vars / baked defaults already.
# Your own BSC testnet indexer (there is no public DeXe subgraph on 97):
DEXE_SUBGRAPH_POOLS_URL_97=https://gateway.thegraph.com/api/<key>/subgraphs/id/<pools-id-97>
DEXE_SUBGRAPH_VALIDATORS_URL_97=https://gateway.thegraph.com/api/<key>/subgraphs/id/<validators-id-97>
DEXE_SUBGRAPH_INTERACTIONS_URL_97=https://gateway.thegraph.com/api/<key>/subgraphs/id/<interactions-id-97>
```

If **all** your endpoints index one non-mainnet chain, you can keep using the
unsuffixed vars and declare the chain once:

```env
DEXE_SUBGRAPH_CHAIN_ID=97
DEXE_SUBGRAPH_POOLS_URL=https://gateway.thegraph.com/api/<key>/subgraphs/id/<pools-id-97>
```

That files those endpoints under chain 97, so a chain-97 read finds them and a
chain-56 read never does. Chain 56 keeps resolving to the **baked mainnet
defaults** (they are seeded per-chain, not overwritten) — override them with
`DEXE_SUBGRAPH_<KIND>_URL_56` if you want your own mainnet endpoints too.

---

## 9. Swarm test harness envs

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

## 10. Common pitfalls

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

### "No DeXe `<kind>` subgraph is configured for chain N"

New in 0.30.2, and usually not a misconfiguration: chain N genuinely has no
indexer (BSC testnet has none published). Before 0.30.2 the same call returned
BSC **mainnet** rows labelled as chain N's. Three ways forward, in the order the
error itself suggests: pass `chainId: 56` if mainnet is what you meant; read
chain N on-chain instead (`dexe_read_gov_state`, `dexe_proposal_list`,
`dexe_read_multicall` — no subgraph needed); or set
`DEXE_SUBGRAPH_<KIND>_URL_<N>` to your own indexer and restart.

### "Pinata gateway not configured" on reads

`DEXE_IPFS_GATEWAY` and `DEXE_PINATA_JWT` are independent. Setting only the
JWT lets you upload but not read — `dexe_ipfs_fetch` still needs the gateway
URL.

### `DEXE_PRIVATE_KEY` set, server fails to start

Startup aborts with `"DEXE_PRIVATE_KEY requires DEXE_RPC_URL to be set"`.
Signing needs an RPC endpoint to broadcast — set both or neither.

### "Set DEXE_CONTRACTS_REGISTRY or pick a supported chain"

Means the chain ID has no built-in registry address. Either switch to a
supported chain (BSC mainnet 56 or BSC testnet 97 — both baked in) or set
`DEXE_CONTRACTS_REGISTRY` explicitly.

---

## See also

- [`README.md`](../README.md) — install + quickstart
- [`TOOLS.md`](../TOOLS.md) — full per-tool catalog (if present)
- [`tests/swarm/README.md`](../tests/swarm/README.md) — swarm setup runbook
- [`src/config.ts`](../src/config.ts) — canonical env reader (single source of truth)
