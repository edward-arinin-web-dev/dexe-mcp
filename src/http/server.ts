import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { safeErrorMessage } from "../lib/redact.js";
import type { HttpServerOptions } from "./options.js";
import {
  TokenBucketLimiter,
  checkOrigin,
  hostAllowed,
  makeIpHasher,
  rateLimitKey,
  resolveClientIp,
} from "./security.js";
import { HTTP_DEFAULTS } from "./options.js";

/**
 * EXPERIMENTAL remote mode: MCP Streamable HTTP, stateless, JSON responses.
 *
 * One fresh McpServer + transport per POST, torn down when the response is
 * written. Nothing survives between requests except the injected factory's
 * own (public-data) caches, so there is no session store to leak one caller's
 * state to another and no affinity requirement behind a load balancer —
 * Claude.ai's connector backend is known to send consecutive requests of one
 * handshake from different nodes and never to echo `Mcp-Session-Id`.
 *
 * Protocol era: the v1 SDK serves the initialize-handshake revisions
 * (2024-11-05 … 2025-11-25). A request announcing a newer revision in
 * `MCP-Protocol-Version` (e.g. 2026-07-28) is answered 400 with a JSON-RPC
 * error whose code (-32000) is not one of the 2026-07-28 "modern" error codes,
 * which is exactly the signal the 2026-07-28 backward-compatibility rules tell
 * a dual-era client to fall back to `initialize` on. See docs/REMOTE.md.
 *
 * The server is the injected factory's business; this file only does HTTP:
 * routing, Host/Origin checks, CORS for allowlisted browser origins, body cap,
 * per-IP rate limit, a global in-flight cap, a per-request timeout, health
 * endpoints and a JSON access log that never contains bodies or raw IPs.
 */

export type McpServerFactory = () => McpServer | Promise<McpServer>;

export interface ReadinessResult {
  ready: boolean;
  /** Public, non-secret facts only (chain id, block number, a short reason). */
  detail: Record<string, unknown>;
}

export type ReadinessProbe = () => Promise<ReadinessResult>;

export interface HttpAppDeps {
  serverFactory: McpServerFactory;
  /** Backs `/readyz`. When absent, ready == healthy. */
  readiness?: ReadinessProbe;
  version: string;
  /** Access-log sink, one object per request. Default: a JSON line on stdout. */
  accessLog?: (entry: Record<string, unknown>) => void;
  /** Out-of-band failures (factory threw, response write failed). Default: stderr. */
  onError?: (context: string, err: unknown) => void;
  /** Injected for tests. */
  now?: () => number;
  ipHasher?: (ip: string) => string;
}

export interface HttpApp {
  readonly server: Server;
  /** Requests currently inside the MCP handler. */
  inflight(): number;
  /** Stop accepting, let in-flight requests finish (up to `graceMs`), then drop sockets. */
  close(graceMs?: number): Promise<void>;
}

export const MCP_PATH = "/mcp";

/** Request headers a browser client may send on the MCP endpoint (CORS preflight). */
const CORS_ALLOW_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
].join(", ");

/** Headers never copied into the web Request handed to the SDK. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te"]);

const RPC_METHOD_RE = /^[A-Za-z0-9_./-]{1,64}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PROTO_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** `application/json` with optional parameters, compared as a media type. */
function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const media = header.split(";")[0]!.trim().toLowerCase();
  return media === "application/json";
}

/**
 * This server only ever answers a POST with `application/json` (or 202). A
 * client that accepts JSON, or anything, is served even if it forgot to also
 * list `text/event-stream`; a client that accepts neither still gets the SDK's
 * 406.
 */
function normalizeAccept(header: string | undefined): string | undefined {
  if (header === undefined || header.trim() === "") return "application/json, text/event-stream";
  const h = header.toLowerCase();
  if (h.includes("application/json") && h.includes("text/event-stream")) return header;
  if (h.includes("application/json") || h.includes("*/*") || h.includes("application/*")) {
    return "application/json, text/event-stream";
  }
  return header;
}

function oneHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function cleanUa(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  // eslint-disable-next-line no-control-regex
  return ua.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}

/** What the access log says about the JSON-RPC payload: method and tool name only. */
function describeRpc(body: unknown): { rpc?: string; tool?: string } {
  if (Array.isArray(body)) return { rpc: `batch(${body.length})` };
  if (!body || typeof body !== "object") return {};
  const m = (body as { method?: unknown }).method;
  const out: { rpc?: string; tool?: string } = {};
  if (typeof m === "string" && RPC_METHOD_RE.test(m)) out.rpc = m;
  else if ("result" in body || "error" in body) out.rpc = "response";
  if (out.rpc === "tools/call") {
    const name = (body as { params?: { name?: unknown } }).params?.name;
    if (typeof name === "string" && TOOL_NAME_RE.test(name)) out.tool = name;
  }
  return out;
}

/**
 * A stateless server never sends `notifications/*\/list_changed` (there is no
 * stream to send them on, and every request gets a fresh, identical server),
 * so it must not advertise `listChanged: true`, which McpServer sets by
 * default. `getCapabilities` is private in the SDK typings, hence the narrow
 * cast; tests/http pins the outcome so an SDK change is noticed.
 */
function disableListChanged(mcp: McpServer): void {
  const low = mcp.server as unknown as {
    getCapabilities?: () => Record<string, { listChanged?: boolean } | undefined>;
    registerCapabilities: (c: Record<string, { listChanged: boolean }>) => void;
  };
  const caps = low.getCapabilities?.() ?? {};
  const patch: Record<string, { listChanged: boolean }> = {};
  for (const kind of ["tools", "prompts", "resources"]) {
    if (caps[kind]?.listChanged) patch[kind] = { listChanged: false };
  }
  if (Object.keys(patch).length > 0) low.registerCapabilities(patch);
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

/**
 * Read the request body up to `maxBytes` within `timeoutMs`. Rejects with
 * BodyTooLargeError past the cap and BodyTimeoutError past the deadline.
 */
function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    // A client that sends headers and then trickles (or never finishes) the
    // body is cut off here, long before Node's own requestTimeout.
    const timer = setTimeout(() => finish(new BodyTimeoutError()), timeoutMs);
    timer.unref();
    const finish = (err?: Error, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onErr);
      if (err) reject(err);
      else resolve(buf!);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        // Stop buffering; drain the rest so the 413 can still be written on
        // this connection (the response sets Connection: close anyway).
        req.resume();
        finish(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks));
    const onErr = (e: Error) => finish(e);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
  });
}

export function createHttpApp(opts: HttpServerOptions, deps: HttpAppDeps): HttpApp {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const hashIp = deps.ipHasher ?? makeIpHasher();
  const limiter = new TokenBucketLimiter(opts.rateLimit.perMinute, opts.rateLimit.burst, now);
  const writeLog =
    deps.accessLog ??
    ((entry: Record<string, unknown>) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    });
  const onError =
    deps.onError ??
    ((context: string, err: unknown) => {
      // Redacted: ethers puts the RPC URL (API key included) into error messages.
      const msg = safeErrorMessage(err);
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", context, msg })}\n`);
    });
  let inflight = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reqId = randomUUID();
    const t0 = now();
    const ip = resolveClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], opts.trustProxyHops);
    const log: Record<string, unknown> = {
      ts: new Date(t0).toISOString(),
      event: "http",
      reqId,
      method: req.method,
      path: undefined,
      ip: hashIp(ip),
    };
    const ua = cleanUa(oneHeader(req.headers["user-agent"]));
    if (ua) log.ua = ua;
    const proto = oneHeader(req.headers["mcp-protocol-version"]);
    if (proto && PROTO_RE.test(proto)) log.proto = proto;

    res.setHeader("X-Request-Id", reqId);
    res.once("close", () => {
      if (!opts.accessLog) return;
      log.status = res.statusCode;
      log.ms = now() - t0;
      if (!res.writableFinished) log.aborted = true;
      try {
        writeLog(log);
      } catch {
        // A broken log sink must never take a request down with it.
      }
    });

    const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      res.end(body);
    };
    const reject = (status: number, reason: string, message: string, headers?: Record<string, string>) => {
      log.reason = reason;
      send(status, jsonRpcError(-32000, message), headers);
    };

    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      path = "/";
    }
    log.path = path === MCP_PATH || path === "/healthz" || path === "/readyz" ? path : "other";

    // ── health ──────────────────────────────────────────────────────────────
    if (path === "/healthz" || path === "/readyz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(405, JSON.stringify({ error: "method not allowed" }), { Allow: "GET, HEAD" });
        return;
      }
      if (path === "/healthz") {
        send(200, JSON.stringify({ status: "ok", version: deps.version, uptimeS: Math.round((now() - startedAt) / 1000) }));
        return;
      }
      let result: ReadinessResult = { ready: true, detail: {} };
      if (deps.readiness) {
        try {
          result = await deps.readiness();
        } catch (err) {
          result = { ready: false, detail: { reason: "readiness probe failed" } };
          onError("readyz", err);
        }
      }
      send(result.ready ? 200 : 503, JSON.stringify({ status: result.ready ? "ready" : "not_ready", ...result.detail }));
      return;
    }

    if (path !== MCP_PATH) {
      send(404, JSON.stringify({ error: "not found", mcpEndpoint: MCP_PATH }));
      return;
    }

    // ── admission: Host, Origin ─────────────────────────────────────────────
    const hostHeader = oneHeader(req.headers.host);
    if (!hostAllowed(hostHeader, opts.allowedHosts)) {
      reject(403, "host", "Forbidden: Host header not allowed");
      return;
    }
    const originHeader = oneHeader(req.headers.origin);
    const origin = checkOrigin(originHeader, opts.allowedOrigins);
    if (origin === "rejected") {
      reject(403, "origin", "Forbidden: Origin not allowed");
      return;
    }
    if (origin === "allowed" && originHeader) {
      res.setHeader("Access-Control-Allow-Origin", originHeader);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no session to
      // terminate (DELETE). Both spec revisions say 405 for this shape.
      reject(405, "method", "Method Not Allowed: this endpoint is stateless and only accepts POST", {
        Allow: "POST, OPTIONS",
      });
      return;
    }

    // ── admission: rate limit, media type ───────────────────────────────────
    const decision = limiter.take(rateLimitKey(ip));
    if (!decision.allowed) {
      reject(429, "rate", "Too Many Requests: slow down and retry", {
        "Retry-After": String(decision.retryAfterSeconds),
      });
      return;
    }
    if (!isJsonContentType(oneHeader(req.headers["content-type"]))) {
      reject(415, "content-type", "Unsupported Media Type: Content-Type must be application/json");
      return;
    }

    // ── body ────────────────────────────────────────────────────────────────
    // Read BEFORE taking an in-flight slot: a client that opens a request and
    // trickles its body must cost nobody else a slot, only its own socket, and
    // only until the body deadline.
    let raw: Buffer;
    try {
      raw = await readBody(req, opts.maxBodyBytes, opts.bodyTimeoutMs);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        reject(413, "body", `Payload Too Large: request body must not exceed ${opts.maxBodyBytes} bytes`, {
          Connection: "close",
        });
        return;
      }
      if (err instanceof BodyTimeoutError) {
        res.once("finish", () => req.socket.destroy());
        reject(408, "body-timeout", `Request Timeout: the body did not arrive within ${opts.bodyTimeoutMs} ms`, {
          Connection: "close",
        });
        return;
      }
      onError("read-body", err);
      reject(400, "body", "Bad Request: the request body could not be read", { Connection: "close" });
      return;
    }
    log.bytesIn = raw.length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      log.reason = "parse";
      send(400, jsonRpcError(-32700, "Parse error: Invalid JSON"));
      return;
    }
    Object.assign(log, describeRpc(parsed));
    // JSON-RPC batches left the spec in 2025-06-18, and one POST carrying a
    // hundred tool calls would cost one rate-limit token. One message per POST.
    if (Array.isArray(parsed)) {
      log.reason = "batch";
      send(400, jsonRpcError(-32600, "Invalid Request: JSON-RPC batches are not supported; send one message per POST"));
      return;
    }

    // ── admission: global concurrency (complete requests only) ──────────────
    if (inflight >= opts.maxInflight) {
      reject(503, "inflight", "Service busy: too many requests in flight, retry shortly", { "Retry-After": "1" });
      return;
    }
    inflight++;
    let mcp: McpServer | undefined;
    let timer: NodeJS.Timeout | undefined;
    let tornDown = false;
    // Closing the per-request McpServer closes its transport, and the SDK then
    // aborts every in-flight handler's `extra.signal`: this is how a timeout or
    // a vanished client stops the work, not just the response.
    const tearDown = (): void => {
      if (tornDown || !mcp) return;
      tornDown = true;
      void mcp.close().catch(() => undefined);
    };
    try {
      // The SDK transport speaks web-standard Request/Response. Build that
      // Request ourselves (body already parsed) instead of going through the
      // Node adapter, so the headers the SDK sees are exactly the ones we
      // validated and normalised.
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const accept = normalizeAccept(oneHeader(req.headers.accept));
      if (accept) headers.set("accept", accept);
      let url: string;
      try {
        url = new URL(req.url ?? MCP_PATH, `http://${hostHeader || "localhost"}`).href;
      } catch {
        url = `http://localhost${MCP_PATH}`;
      }
      const webReq = new Request(url, { method: "POST", headers });

      try {
        mcp = await deps.serverFactory();
      } catch (err) {
        onError("server-factory", err);
        log.reason = "factory";
        send(500, jsonRpcError(-32603, "Internal error: the server could not be initialised"));
        return;
      }
      disableListChanged(mcp);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);

      // Client went away mid-call: abandon the work rather than finish it for
      // a dead socket.
      res.once("close", () => {
        if (!res.writableFinished) tearDown();
      });

      const timedOut = Symbol("timeout");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), opts.requestTimeoutMs);
        timer.unref();
      });
      const response = await Promise.race([transport.handleRequest(webReq, { parsedBody: parsed }), timeout]);
      if (response === timedOut) {
        log.reason = "timeout";
        tearDown();
        send(504, jsonRpcError(-32000, `Request timed out after ${opts.requestTimeoutMs} ms`));
        return;
      }

      if (res.destroyed) return;
      const outHeaders: Record<string, string> = { "Cache-Control": "no-store" };
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise<void>((r) => res.once("drain", r));
        }
      }
      res.end();
    } catch (err) {
      onError("mcp-request", err);
      log.reason = log.reason ?? "internal";
      send(500, jsonRpcError(-32603, "Internal error"));
    } finally {
      if (timer) clearTimeout(timer);
      inflight--;
      tearDown();
    }
  };

  // Timeouts, in the order a request meets them:
  //   headersTimeout   Node: complete headers within 15 s, else Node answers 408.
  //   bodyTimeoutMs    ours: complete body within DEXE_HTTP_BODY_TIMEOUT_MS of
  //                    the handler starting, else 408 (no in-flight slot held).
  //   requestTimeout   Node backstop for receiving the whole request; set just
  //                    above the two so it never pre-empts our JSON 408.
  //   requestTimeoutMs ours: MCP work after the body is in, else 504 and the
  //                    per-request server is torn down (handlers are aborted).
  //   keepAliveTimeout idle keep-alive sockets close after 65 s — above the
  //                    usual 60 s load-balancer idle timeout, so the LB closes
  //                    first (the classic cause of sporadic 502s otherwise).
  // connectionsCheckingInterval makes Node enforce the first and third within
  // ~1 s instead of its default 30 s sweep.
  const headersTimeout = HTTP_DEFAULTS.headersTimeoutMs;
  const server = createServer(
    {
      headersTimeout,
      requestTimeout: headersTimeout + opts.bodyTimeoutMs + 5_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => {
      handler(req, res).catch((err: unknown) => {
        onError("http-handler", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(jsonRpcError(-32603, "Internal error"));
        } else {
          res.destroy();
        }
      });
    },
  );
  server.keepAliveTimeout = 65_000;

  return {
    server,
    inflight: () => inflight,
    close(graceMs = 10_000): Promise<void> {
      return new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
