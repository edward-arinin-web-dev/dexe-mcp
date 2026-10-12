# The read-only edition: `dexe-mcp-read`

> **Pre-release until the connector-directory submission.** The server is
> built for anonymous callers — read code only, no state, redacted
> diagnostics, hardened tools ([Tool-level limits](#tool-level-limits)) — but
> flags and env names may still change. Two things are not done yet:
> clients that speak only the stateless protocol revision 2026-07-28 cannot
> connect ([Protocol versions](#protocol-versions)), and the Claude.ai custom
> connector has not yet been verified against a live deployment.

`dexe-mcp-read` is the read edition of dexe-mcp: the 54 tools that only read
DeXe DAO data — DAO profiles and settings, treasury, proposals and their state,
votes and voters, members, token holders, delegation, validators and experts,
token sales, staking, protocol statistics — plus the external
OpenZeppelin/Compound Governor reads. It ships in the `dexe-mcp` package next
to the full server and runs two ways:

| | Command | For |
| --- | --- | --- |
| stdio | `dexe-mcp-read` | your own MCP host (Claude Code, Claude Desktop, Cursor, …) |
| HTTP | `dexe-mcp-read serve-http` | operators hosting an endpoint for remote clients (Claude.ai custom connectors, ChatGPT developer mode, MCP Inspector) |

What makes it read-only is what it is built from, not a filter: it registers
the read tools from read modules only, and none of the code that signs,
broadcasts, pins to IPFS or builds calldata is loaded into its process (a
test walks its import graph, and another records every module the built
binary loads). It never constructs a wallet. It speaks as `dexe-mcp-read` in
the MCP handshake, with instructions that describe reads only.

## Use it locally (stdio)

```bash
claude mcp add dexe-read -- npx -y -p dexe-mcp dexe-mcp-read
```

Claude Desktop (`claude_desktop_config.json`) or any client that takes the
same shape:

```json
{
  "mcpServers": {
    "dexe-read": { "command": "npx", "args": ["-y", "-p", "dexe-mcp", "dexe-mcp-read"] }
  }
}
```

- Works with zero configuration (public BSC RPC, subgraph endpoints, the DeXe
  backend and IPFS gateways are built in); `dexe_doctor` says what your own
  endpoints or Graph key would improve.
- Reads `.env` once at startup from the same places as `dexe-mcp`
  (`$DEXE_ENV_FILE`, `./.env`, `~/.dexe-mcp/.env`), so a file you already have
  keeps working. Signing keys, agent keys, the Pinata JWT, WalletConnect and
  Safe settings in it are ignored and removed from the process.
- Keeps nothing between calls: no `state.json`, no `reports.json`. So
  `dexe_dao_report` takes an explicit `since` (ISO time, Unix seconds or
  `block:<n>`); `since: "last"` needs the full server, which stores runs.
- `DEXE_TOOLSETS` means nothing here: all 54 tools are always served.
- Resources: `dexe://graph-schema` (subgraph entities), `dexe://tools` (this
  server's tool catalog, rendered from what it registered) and
  `dexe://playbook` (reading topics, pitfalls, and the error → remedy table
  for read failures).

Want to also build and send transactions? That is the full server,
`dexe-mcp` ([README](https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/README.md)).

## Host it (`serve-http`)

`dexe-mcp-read serve-http` serves the same 54 tools over MCP Streamable HTTP.
(`dexe-mcp serve-http` starts this same server in a child process, so the
HTTP process never carries the full server's code either.)

- Stateless: no sessions, no `Mcp-Session-Id`, no `listChanged`, no sticky
  routing, and replicas need no coordination. One JSON-RPC message per POST;
  batches get 400. Server instances are pooled: one that finished a request
  serves the next on a fresh transport, after forgetting the previous
  caller's `initialize`. A request costs about 1 ms of server CPU
  (`initialize`, a `tools/list` of the 54 tools from a cache, a local tool
  call), against 8–11 ms when every request built its own server.
- Nothing on disk, nothing remembered between requests.
- Diagnostics are redacted: `dexe_doctor` reports upstream health only (no env
  files or paths, which variables are set, rejected values, start time,
  endpoint hostnames, or remediation the caller cannot act on);
  `dexe_context` and `dexe_get_config` name no endpoint host. Error remedies
  never ask the caller to edit a `.env`.
- Configured by **process env only**. `.env` files (working directory,
  `~/.dexe-mcp/.env`, `DEXE_ENV_FILE`) are never read. At startup the process
  env is cut down to an allowlist, which keeps:
  - the read data-source variables listed below;
  - `DEXE_HTTP_*` and `DEXE_DEBUG`;
  - runtime basics such as `PATH`, `HOME`, `TMPDIR`, `TZ`, `NODE_*` and proxy/CA settings.

  Everything else is removed: signing keys, Pinata, WalletConnect and Safe keys,
  and unrelated secrets such as `AWS_*`. The startup log records only how many
  variables were removed (`removedEnvVars`), not their names.

### Data sources are required

The package ships zero-config defaults so that local installs work out of the
box: public BSC RPCs, subgraph URLs that embed a shared Graph API key, and the
default DeXe backend. Every install shares them. A public server on these
defaults would spend everyone's quota and a billable key, so **`serve-http`
refuses to start on them**. The error message names the variables to set:

| Set | Replaces |
| --- | --- |
| `DEXE_RPC_URL_MAINNET` (and `DEXE_RPC_URL_TESTNET` for chain 97) | public BSC RPC fallback |
| `DEXE_SUBGRAPH_POOLS_URL`, `DEXE_SUBGRAPH_VALIDATORS_URL`, `DEXE_SUBGRAPH_INTERACTIONS_URL` | subgraph URLs carrying the shipped Graph key. Use URLs with your own key; a separate `DEXE_GRAPH_API_KEY` does not replace a key that is embedded in the URL. |
| `DEXE_BACKEND_API_URL` | the default backend. Setting it explicitly, even to `https://api.dexe.io`, counts as the operator's choice. |

`DEXE_HTTP_ALLOW_SHARED_DEFAULTS=1` starts the server anyway, logs a
`shared_defaults` warning, and is for **local testing only**. Also recommended:
`DEXE_IPFS_GATEWAY`, pointing at a dedicated gateway (the fallback is the free
public gateways).

### Run it

Docker, with the variables above in an env file that stays out of the image:

```sh
docker build -t dexe-mcp-read .
docker run -d --name dexe-mcp-read --restart unless-stopped \
  -p 127.0.0.1:8080:8080 --env-file ./remote.env \
  -e DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com -e DEXE_HTTP_TRUST_PROXY=1 \
  dexe-mcp-read
```

Compose: copy `docker-compose.example.yml`, fill in the endpoints, then run `docker compose up -d --build`.

Without Docker (Node 20.12 or later), with the data-source variables exported:

```sh
DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com npx -y -p dexe-mcp dexe-mcp-read serve-http --host 0.0.0.0 --port 8080
```

The image:
- runs ONE file: the read binary bundled with its five runtime packages (MCP
  SDK, ethers, zod, multiformats, p-limit) by `scripts/bundle-read.mjs`. No
  `node_modules`, none of the full server's code or dependencies
  (WalletConnect, markdown, process spawning). 330 MB, of which nearly all is
  the `node:22-slim` base; the previous image, which carried every production
  dependency, was 537 MB;
- uses `node:22-slim`, pinned by digest, and has no npm at runtime;
- runs as the unprivileged `node` user;
- writes nothing to disk, so it works with `read_only: true`;
- has a `HEALTHCHECK` on `/healthz`.

### Endpoints

| Path | Method | Answer |
| --- | --- | --- |
| `/mcp` | POST | One MCP JSON-RPC message; answers in `application/json`. A JSON array (batch) gets 400 with code `-32600`. |
| `/mcp` | GET, DELETE | 405 (there is no SSE stream and no session) |
| `/mcp` | OPTIONS | CORS preflight, for allowlisted browser origins only |
| `/healthz` | GET | 200 while the process is up |
| `/readyz` | GET | 200 if one `eth_blockNumber` on the default chain answers within `DEXE_HTTP_READY_TIMEOUT_MS`, else 503. Cached for 5 s. |

Every response has an `X-Request-Id` header, and the access log records the same id.

### Environment (HTTP layer)

Process env only. `--port` and `--host` override `PORT` and `DEXE_HTTP_HOST`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. 0 lets the OS pick one; the startup log shows which. |
| `DEXE_HTTP_HOST` | `127.0.0.1` (image: `0.0.0.0`) | Bind address. |
| `DEXE_HTTP_ALLOWED_HOSTS` | loopback names | Comma-separated hostnames the `Host` header may carry (port is ignored). **Required** off loopback: the server will not start without it. `*` turns the check off. |
| `DEXE_HTTP_ALLOWED_ORIGINS` | none | Exact browser origins, e.g. `https://inspector.example.com`. A request without an `Origin` header always passes; Claude.ai, ChatGPT, SDK clients and curl send none. A present, unlisted origin gets 403. `*` allows any origin. |
| `DEXE_HTTP_TRUST_PROXY` | off | How many reverse-proxy hops to trust for `X-Forwarded-For` (`true` = 1). Ports and brackets in entries are ignored. Leave it off when nothing sits in front: clients can forge the header. |
| `DEXE_HTTP_MAX_BODY_BYTES` | `262144` | Request body cap; larger bodies get 413. |
| `DEXE_HTTP_BODY_TIMEOUT_MS` | `10000` | Time to receive the body once the headers are in; past it, 408 and the connection closes. |
| `DEXE_HTTP_RATE_LIMIT_PER_MIN` | `300` | Sustained requests per minute per client IPv4 address or IPv6 /64; 0 turns it off. Over it: 429 with `Retry-After`. |
| `DEXE_HTTP_RATE_LIMIT_BURST` | `60` | Requests one client may send back to back. |
| `DEXE_HTTP_MAX_INFLIGHT` | `32` | Concurrent MCP requests with a complete body, across all clients; over it: 503 with `Retry-After: 1`. |
| `DEXE_HTTP_REQUEST_TIMEOUT_MS` | `120000` | Budget for the MCP work once the body is in. Over it: 504, and the request's transport is closed so in-flight handlers are aborted. |
| `DEXE_HTTP_READY_TIMEOUT_MS` | `3000` | Budget for the `/readyz` RPC probe. |
| `DEXE_HTTP_ACCESS_LOG` | on | `0` turns the access log off. |
| `DEXE_HTTP_ALLOW_SHARED_DEFAULTS` | off | `1` = start on the shared built-in endpoints. Local testing only. |

Timeouts, in the order a request meets them:
1. Headers must arrive within 15 s. Node answers 408 otherwise.
2. The body must arrive within `DEXE_HTTP_BODY_TIMEOUT_MS`.
3. The MCP work then has `DEXE_HTTP_REQUEST_TIMEOUT_MS`.

A request takes an in-flight slot only once its body is complete, so slow
uploads cannot lock other clients out. Idle keep-alive connections close after
65 s, which is longer than the usual 60 s load-balancer idle timeout.

Data-source variables use the same names as stdio mode (see
[ENVIRONMENT.md](ENVIRONMENT.md)): `DEXE_RPC_URL_*`, `DEXE_SUBGRAPH_*`,
`DEXE_GRAPH_API_KEY`, `DEXE_BACKEND_API_URL`, `DEXE_IPFS_GATEWAY`,
`DEXE_IPFS_GATEWAYS_FALLBACK`, `DEXE_PINATA_GATEWAY_TOKEN`,
`DEXE_DEFAULT_CHAIN_ID`, `DEXE_RPC_TIMEOUT_MS`, and the limits
`DEXE_IPFS_MAX_BYTES` and `DEXE_MAX_RESPONSE_BYTES` (see
[Tool-level limits](#tool-level-limits)).

### Tool-level limits

Every read tool has these limits, on stdio and over HTTP alike:

| Limit | Default | Set with | What happens past it |
| --- | --- | --- | --- |
| IPFS body | 2 MB | `DEXE_IPFS_MAX_BYTES` | The body is streamed and the fetch stops at the limit with an error. No other gateway is asked for the same CID. `dexe_ipfs_fetch` also summarizes parsed JSON over 128 KB (`truncated: true`, `sizeBytes` is the real size). |
| Tool result | 256 KB | `DEXE_MAX_RESPONSE_BYTES` | Rows are dropped from the end and long strings shortened until the result fits. The first line says `RESPONSE TRUNCATED`, what was cut and how to get the rest. Offset-paged tools report a corrected `returned` and `nextOffset`. |
| Array inputs | per tool (for example 8 `chainIds`, 100 `calls`, 50 `daos`) | not configurable | Schema validation rejects the call before any upstream request. |
| Third-party strings in `structuredContent` | 16,000 characters each | not configurable | The string is cut with a marker. Hex data is never cut. |
| Subgraph and backend JSON | 16 MB | not configurable | The call fails with a hint to request fewer rows. |

Tool results and errors never contain the configured RPC, subgraph, backend or
gateway URLs or keys. A last-pass scrub replaces any of them, even one echoed
back by an upstream, with a masked form such as `https://host/***`.
IPFS gateways are named by host only.

When a request is cancelled or hits `DEXE_HTTP_REQUEST_TIMEOUT_MS`, the tool
stops: in-flight IPFS, subgraph and backend requests are aborted, and no
further upstream calls are made.

### Reverse proxy and TLS

The server speaks plain HTTP. Terminate TLS in front of it.

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;                 # must match DEXE_HTTP_ALLOWED_HOSTS
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 130s;                      # above DEXE_HTTP_REQUEST_TIMEOUT_MS
    client_max_body_size 256k;
    client_body_timeout 10s;
}
location = /healthz { proxy_pass http://127.0.0.1:8080; }
location = /readyz  { proxy_pass http://127.0.0.1:8080; }
```

- Forward the original `Host`, or add the upstream name to `DEXE_HTTP_ALLOWED_HOSTS`.
- With one proxy in front, set `DEXE_HTTP_TRUST_PROXY=1`. Otherwise every
  client shares the proxy's IP and one rate-limit bucket.
- Serve `/mcp` at the URL you register, without redirects. Claude drops
  credentials on a cross-host redirect and reports a connection error.
- Publish an IPv4 `A` record. Claude.ai connectors connect over IPv4 only.
- Do not let a WAF or bot filter answer 403 or 429 to the AI clients'
  backends. Claude.ai connects from Anthropic's published egress range
  (see <https://platform.claude.com/docs/en/api/ip-addresses>).

### Rate-limit tuning

The limit is kept in memory per process, and each IPv4 address or IPv6 /64 is
one bucket. Claude.ai and ChatGPT call the server from their own backends, so
many end users arrive from a few addresses, and consecutive requests from one
session can come from different addresses. Connecting takes a handful of
requests. The SDK client sends `initialize`, `notifications/initialized`, a
`GET` (answered 405) and `tools/list`, and dual-era clients first probe
`server/discover`. After that, each tool call is one request. If those backends
get a 429 while connecting, users see "couldn't reach the server".

Start with generous limits (the defaults or higher) and watch the access log
for `"reason":"rate"`. If you need per-user fairness, enforce it at the proxy.
`DEXE_HTTP_MAX_INFLIGHT` is the backstop that protects your RPC and subgraph
quotas.

### Protocol versions

The server speaks the initialize-handshake revisions up to `2025-11-25`, in
stateless JSON mode. A request that announces `MCP-Protocol-Version: 2026-07-28`
gets 400 with JSON-RPC error `-32000` ("Unsupported protocol version"). That
code is not one of the 2026-07-28 error codes, so under the spec's
backward-compatibility rules a client that speaks both revisions falls back to
`initialize`. The official TypeScript SDK v2 client does this (version
negotiation `auto`). Clients that speak only 2026-07-28 cannot connect yet.

### Logs

Logs are JSON lines. Startup, config notes and errors go to stderr. The access
log goes to stdout:

```json
{"ts":"…","event":"http","reqId":"…","method":"POST","path":"/mcp","ip":"3f9a1c0b7d2e","ua":"…","proto":"2025-11-25","bytesIn":131,"rpc":"tools/call","tool":"dexe_read_treasury","status":200,"ms":412}
```

Access log entries never contain request or response bodies, tool arguments,
or raw IP addresses. `ip` is a salted hash, and the salt changes on every
restart. Rejected requests carry a `reason`: `host`, `origin`, `method`,
`rate`, `content-type`, `body`, `body-timeout`, `parse`, `batch`, `inflight`,
`timeout`.

### Verify

```sh
curl -s https://mcp.example.com/healthz
curl -s https://mcp.example.com/readyz
curl -s https://mcp.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The last command should answer with `"serverInfo":{"name":"dexe-mcp-read",…}`, and a
`tools/list` with 54 tools.

- **MCP Inspector:** run `npx @modelcontextprotocol/inspector`, choose the
  Streamable HTTP transport and enter `https://mcp.example.com/mcp`. If you use
  the Inspector's direct browser mode, add its origin to
  `DEXE_HTTP_ALLOWED_ORIGINS`.
- **Claude.ai:** Customize > Connectors > Add custom connector, URL
  `https://mcp.example.com/mcp`, no authentication.
- **ChatGPT:** Settings > Security and login > Developer mode, then create an
  app for the URL with no authentication.
