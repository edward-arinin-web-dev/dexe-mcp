# Remote mode (`serve-http`), experimental

`dexe-mcp serve-http` serves the read-only tools over MCP Streamable HTTP, so
remote clients can use them by URL: Claude.ai custom connectors, ChatGPT
developer mode, MCP Inspector. It is for operators who host a public endpoint.
If you run dexe-mcp on your own machine, keep using the stdio server
(`npx dexe-mcp`).

**Experimental.** Flags, env names and the served tool set may change between
releases.

## What it serves

- The `read` tool profile, limited to tools in the read edition: chain,
  subgraph, IPFS and analytics reads. `tools/list` returns the exact list.
- Nothing that signs, broadcasts, uploads or builds transactions. No prompts,
  no doc resources.
- Stateless: every POST gets a fresh server instance. No sessions, no
  `Mcp-Session-Id`, no sticky routing, and replicas need no coordination.
- No state on disk. `dexe_dao_report` runs without saving a snapshot, so
  `since` diffs have no baseline in this mode.
- Configured by **process env only**. `.env` files (working directory,
  `~/.dexe-mcp/.env`, `DEXE_ENV_FILE`) are not read. Signing keys, keyring,
  Pinata JWT, WalletConnect and Safe keys are removed from the environment at
  startup. The startup log lists their names (`ignoredWriteSideEnv`).

## Run it

Docker:

```sh
docker build -t dexe-mcp-read .
docker run -d --name dexe-mcp-read --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com \
  -e DEXE_HTTP_TRUST_PROXY=1 \
  -e DEXE_RPC_URL_MAINNET=https://your-bsc-rpc \
  dexe-mcp-read
```

Compose: copy `docker-compose.example.yml`, edit it, then `docker compose up -d --build`.

Without Docker (Node 20.12 or later):

```sh
DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com npx dexe-mcp serve-http --host 0.0.0.0 --port 8080
```

The image runs as the unprivileged `node` user, writes nothing to disk (it
works with `read_only: true`), and has a `HEALTHCHECK` on `/healthz`.

## Endpoints

| Path | Method | Answer |
| --- | --- | --- |
| `/mcp` | POST | MCP JSON-RPC, `application/json` responses |
| `/mcp` | GET, DELETE | 405 (there is no SSE stream and no session) |
| `/mcp` | OPTIONS | CORS preflight, for allowlisted browser origins only |
| `/healthz` | GET | 200 while the process is up |
| `/readyz` | GET | 200 if one `eth_blockNumber` on the default chain answers within `DEXE_HTTP_READY_TIMEOUT_MS`, else 503. Cached for 5 s. |

Every response has an `X-Request-Id` header, and the access log records the same id.

## Environment

HTTP layer (process env; `--port` and `--host` override `PORT` and `DEXE_HTTP_HOST`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. 0 lets the OS pick one; the startup log shows which. |
| `DEXE_HTTP_HOST` | `127.0.0.1` (image: `0.0.0.0`) | Bind address. |
| `DEXE_HTTP_ALLOWED_HOSTS` | loopback names | Comma-separated hostnames the `Host` header may carry (port is ignored). **Required** off loopback: the server will not start without it. `*` turns the check off. |
| `DEXE_HTTP_ALLOWED_ORIGINS` | none | Exact browser origins, e.g. `https://inspector.example.com`. A request without an `Origin` header always passes; Claude.ai, ChatGPT, SDK clients and curl send none. A present, unlisted origin gets 403. `*` allows any origin. |
| `DEXE_HTTP_TRUST_PROXY` | off | How many reverse-proxy hops to trust for `X-Forwarded-For` (`true` = 1). Leave it off when nothing sits in front: clients can forge the header. |
| `DEXE_HTTP_MAX_BODY_BYTES` | `262144` | Request body cap; larger bodies get 413. |
| `DEXE_HTTP_RATE_LIMIT_PER_MIN` | `300` | Sustained requests per minute per client IP; 0 turns it off. Over it: 429 with `Retry-After`. |
| `DEXE_HTTP_RATE_LIMIT_BURST` | `60` | Requests one IP may send back to back. |
| `DEXE_HTTP_MAX_INFLIGHT` | `32` | Concurrent MCP requests across all clients; over it: 503 with `Retry-After: 1`. |
| `DEXE_HTTP_REQUEST_TIMEOUT_MS` | `120000` | Budget per MCP request; over it: 504. |
| `DEXE_HTTP_READY_TIMEOUT_MS` | `3000` | Budget for the `/readyz` RPC probe. |
| `DEXE_HTTP_ACCESS_LOG` | on | `0` turns the access log off. |

Data sources use the same variables as stdio mode (see [ENVIRONMENT.md](ENVIRONMENT.md)):
`DEXE_RPC_URL_MAINNET`, `DEXE_RPC_URL_TESTNET`, `DEXE_GRAPH_API_KEY`,
`DEXE_SUBGRAPH_*`, `DEXE_IPFS_GATEWAY`, `DEXE_DISABLE_PUBLIC_RPC`. Without
them, the server falls back to shared public endpoints. Those are rate-limited
and shared by every user of this server, so set your own for production.

## Reverse proxy and TLS

The server speaks plain HTTP. Terminate TLS in front of it.

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;                 # must match DEXE_HTTP_ALLOWED_HOSTS
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 130s;                      # above DEXE_HTTP_REQUEST_TIMEOUT_MS
    client_max_body_size 256k;
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

The limit is per client IP and kept in memory per process. Claude.ai and
ChatGPT call the server from their own backends, so many end users arrive
from a few addresses, and consecutive requests from one session can come from
different addresses. Connecting takes a handful of requests (the SDK client
sends `initialize`, `notifications/initialized`, a `GET` answered 405 and
`tools/list`; dual-era clients first probe `server/discover`), then one per
tool call. If those backends hit 429 during a connect, users see "couldn't
reach the server". Start generous (the defaults, or higher), watch for
`"reason":"rate"` in the access log, and enforce per-user fairness at the
proxy if you need it. `DEXE_HTTP_MAX_INFLIGHT` is the backstop that protects
your RPC and subgraph quotas.

## Protocol versions

The server speaks the initialize-handshake revisions up to `2025-11-25`, in
stateless JSON mode. A request that announces `MCP-Protocol-Version: 2026-07-28`
gets 400 with JSON-RPC error `-32000` ("Unsupported protocol version"). That
error code is not one of the 2026-07-28 error codes, so under the spec's
backward-compatibility rules a client that speaks both revisions falls back to
`initialize`. The official TypeScript SDK v2 client does this (version
negotiation `auto`). Clients that speak only 2026-07-28 cannot connect yet.

## Logs

JSON lines. Startup, config notes and errors go to stderr. The access log
goes to stdout:

```json
{"ts":"…","event":"http","reqId":"…","method":"POST","path":"/mcp","ip":"3f9a1c0b7d2e","ua":"…","proto":"2025-11-25","bytesIn":131,"rpc":"tools/call","tool":"dexe_read_treasury","status":200,"ms":412}
```

Access log entries never contain request or response bodies, tool arguments,
or raw IP addresses. `ip` is a salted hash, and the salt changes on every
restart. Rejections carry a `reason`: `host`, `origin`, `method`, `rate`,
`inflight`, `content-type`, `body`, `parse`, `timeout`.

## Verify

```sh
curl -s https://mcp.example.com/healthz
curl -s https://mcp.example.com/readyz
curl -s https://mcp.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The last command should answer with `"serverInfo":{"name":"dexe-mcp-read",…}`.

- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, choose transport
  Streamable HTTP and enter `https://mcp.example.com/mcp`. If you use the
  Inspector's direct browser mode, add its origin to `DEXE_HTTP_ALLOWED_ORIGINS`.
- **Claude.ai:** Customize > Connectors > Add custom connector, URL
  `https://mcp.example.com/mcp`, no authentication.
- **ChatGPT:** Settings > Security and login > Developer mode, then create an
  app for the URL with no authentication.
