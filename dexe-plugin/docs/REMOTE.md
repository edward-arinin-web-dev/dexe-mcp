# Remote mode (`serve-http`), experimental

> **Experimental — do not expose publicly until the read-edition hardening
> lands.** Still pending:
> - a byte cap on IPFS fetches;
> - `maxItems` limits on array inputs;
> - a cap on tool response size;
> - scrubbing hostnames and keys from tool output;
> - a dedicated read server (`createReadServer`, step A9) instead of the
>   current read-filtered reuse of the full registration.
>
> Run it on loopback, a private network, or behind authentication until then.

`dexe-mcp serve-http` serves the read-only tools over MCP Streamable HTTP. Remote
clients such as Claude.ai custom connectors, ChatGPT developer mode and MCP
Inspector can then use them by URL. It is meant for operators hosting an
endpoint. On your own machine, keep using the stdio server (`npx dexe-mcp`).

Flags, env names and the served tool set may change between releases.

## What it serves

- The `read` tool profile, limited to tools in the read edition: chain,
  subgraph, IPFS and analytics reads. `tools/list` returns the exact list.
- Nothing that signs, broadcasts, uploads or builds transactions. No prompts,
  no doc resources.
- Stateless: every POST gets a fresh server instance. No sessions, no
  `Mcp-Session-Id`, no `listChanged`, no sticky routing, and replicas need no
  coordination. One JSON-RPC message per POST; batches get 400.
- No state on disk. `dexe_dao_report` runs without saving a snapshot, so
  `since` diffs have no baseline in this mode.
- Configured by **process env only**. `.env` files (working directory,
  `~/.dexe-mcp/.env`, `DEXE_ENV_FILE`) are never read. At startup the process
  env is cut down to an allowlist, which keeps:
  - the read data-source variables listed below;
  - `DEXE_HTTP_*`;
  - runtime basics such as `PATH`, `HOME`, `TMPDIR`, `TZ`, `NODE_*` and proxy/CA settings.

  Everything else is removed: signing keys, Pinata, WalletConnect and Safe keys,
  and unrelated secrets such as `AWS_*`. The startup log records only how many
  variables were removed (`removedEnvVars`), not their names.

## Data sources are required

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

## Run it

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
DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com npx dexe-mcp serve-http --host 0.0.0.0 --port 8080
```

The image:
- uses `node:22-slim`, pinned by digest, and has no npm at runtime;
- runs as the unprivileged `node` user;
- writes nothing to disk, so it works with `read_only: true`;
- has a `HEALTHCHECK` on `/healthz`.

## Endpoints

| Path | Method | Answer |
| --- | --- | --- |
| `/mcp` | POST | One MCP JSON-RPC message; answers in `application/json`. A JSON array (batch) gets 400 with code `-32600`. |
| `/mcp` | GET, DELETE | 405 (there is no SSE stream and no session) |
| `/mcp` | OPTIONS | CORS preflight, for allowlisted browser origins only |
| `/healthz` | GET | 200 while the process is up |
| `/readyz` | GET | 200 if one `eth_blockNumber` on the default chain answers within `DEXE_HTTP_READY_TIMEOUT_MS`, else 503. Cached for 5 s. |

Every response has an `X-Request-Id` header, and the access log records the same id.

## Environment (HTTP layer)

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
| `DEXE_HTTP_REQUEST_TIMEOUT_MS` | `120000` | Budget for the MCP work once the body is in. Over it: 504, and the request's server instance is closed so in-flight handlers are aborted. |
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
`DEXE_DEFAULT_CHAIN_ID`, `DEXE_RPC_TIMEOUT_MS`.

## Reverse proxy and TLS

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

## Rate-limit tuning

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

## Protocol versions

The server speaks the initialize-handshake revisions up to `2025-11-25`, in
stateless JSON mode. A request that announces `MCP-Protocol-Version: 2026-07-28`
gets 400 with JSON-RPC error `-32000` ("Unsupported protocol version"). That
code is not one of the 2026-07-28 error codes, so under the spec's
backward-compatibility rules a client that speaks both revisions falls back to
`initialize`. The official TypeScript SDK v2 client does this (version
negotiation `auto`). Clients that speak only 2026-07-28 cannot connect yet.

## Logs

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

## Verify

```sh
curl -s https://mcp.example.com/healthz
curl -s https://mcp.example.com/readyz
curl -s https://mcp.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The last command should answer with `"serverInfo":{"name":"dexe-mcp-read",…}`.

- **MCP Inspector:** run `npx @modelcontextprotocol/inspector`, choose the
  Streamable HTTP transport and enter `https://mcp.example.com/mcp`. If you use
  the Inspector's direct browser mode, add its origin to
  `DEXE_HTTP_ALLOWED_ORIGINS`.
- **Claude.ai:** Customize > Connectors > Add custom connector, URL
  `https://mcp.example.com/mcp`, no authentication.
- **ChatGPT:** Settings > Security and login > Developer mode, then create an
  app for the URL with no authentication.
