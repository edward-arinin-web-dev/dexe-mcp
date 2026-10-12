import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { readInstructions } from "../../src/instructions.js";
import { parseHttpOptions, type HttpServerOptions } from "../../src/http/options.js";
import { READ_SERVER_NAME, createReadServerFactory, type ReadServerFactory } from "../../src/read/server.js";
import {
  loadRemoteReadConfig,
  type RemoteReadConfig,
} from "../../src/http/remoteEnv.js";
import { createHttpApp, type HttpApp, type McpServerFactory } from "../../src/http/server.js";

/**
 * `serve-http` end to end: the read edition's server factory (src/read/server.ts,
 * pooled as the binary runs it) behind the real HTTP app on an ephemeral
 * loopback port, driven by the SDK's own Streamable HTTP client and by raw
 * requests where the test needs exact headers.
 */

// Hardhat's well-known test account #1 — public, never funded on a real chain.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

function baseOptions(overrides: Partial<HttpServerOptions> = {}): HttpServerOptions {
  const r = parseHttpOptions(["--port", "0"], { DEXE_HTTP_ALLOWED_ORIGINS: "https://allowed.example" });
  if (r.kind !== "options") throw new Error("bad base options");
  return { ...r.options, ...overrides };
}

async function start(
  factory: McpServerFactory,
  overrides: Partial<HttpServerOptions> = {},
  logs: Record<string, unknown>[] = [],
  releaseServer?: (s: McpServer) => void,
): Promise<{ app: HttpApp; port: number }> {
  const app = createHttpApp(baseOptions(overrides), {
    serverFactory: factory,
    releaseServer,
    version: "0.0.0-test",
    accessLog: (e) => logs.push(e),
    onError: () => undefined,
    readiness: async () => ({ ready: true, detail: { chainId: 56, blockNumber: 1 } }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { app, port: (app.server.address() as AddressInfo).port };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => any;
}

/** node:http, not fetch: fetch will not let a test set Host or stream a chunked body. */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer[] } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/mcp", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (Array.isArray(opts.body)) for (const c of opts.body) req.write(c);
    else if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("serve-http with the read edition's server factory", () => {
  const savedEnv = { ...process.env };
  let operatorStateDir: string;
  let remote: RemoteReadConfig;
  let toolNames: () => string[];
  let factory: ReadServerFactory;
  let app: HttpApp;
  let port: number;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    operatorStateDir = mkdtempSync(join(tmpdir(), "dexe-http-state-"));
    process.env.DEXE_STATE_PATH = join(operatorStateDir, "state.json");
    process.env.DEXE_PRIVATE_KEY = TEST_KEY;
    process.env.DEXE_PINATA_JWT = "test-jwt";
    process.env.DEXE_SAFE_API_KEY = "planted-safe-key";
    process.env.FOO_SECRET = "planted-foo";
    process.env.DEXE_TOOLSETS = "full";
    remote = await loadRemoteReadConfig();
    factory = createReadServerFactory(remote.config, { remote: true, version: "0.0.0-test" });
    toolNames = factory.toolNames;
    ({ app, port } = await start(factory.acquire, {}, logs, factory.release));
  });

  afterAll(async () => {
    await app?.close(100);
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    rmSync(operatorStateDir, { recursive: true, force: true });
  });

  it("reduces the env to the read allowlist before config loads", () => {
    expect(remote.removedEnvCount).toBeGreaterThanOrEqual(4);
    for (const k of ["DEXE_PRIVATE_KEY", "DEXE_PINATA_JWT", "DEXE_SAFE_API_KEY", "FOO_SECRET"]) {
      expect(process.env[k], k).toBeUndefined();
    }
    expect(JSON.stringify(remote.config)).not.toMatch(/planted-safe-key|planted-foo|test-jwt|59c6995e/);
    // The read config has no signer fields at all, and DEXE_TOOLSETS /
    // DEXE_STATE_PATH were scrubbed: neither means anything to this server.
    expect(Object.keys(remote.config)).not.toEqual(expect.arrayContaining(["privateKey"]));
    expect(remote.config.toolsets).toEqual([]);
    expect(process.env.DEXE_STATE_PATH).toBeUndefined();
    // the config banner is kept for ops, and the read loader has nothing to say about signing
    expect(remote.configNotes.some((l) => /chains:/.test(l))).toBe(true);
    expect(remote.configNotes.filter((l) => /WalletConnect|signing/i.test(l))).toEqual([]);
  });

  it("initialize + tools/list + tools/call through the SDK Streamable HTTP client", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      expect(client.getServerVersion()?.name).toBe(READ_SERVER_NAME);
      expect(client.getInstructions()).toBe(readInstructions());

      const caps = client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      // stateless: no stream to deliver list_changed on, so it is not advertised
      expect(caps?.tools?.listChanged).not.toBe(true);
      expect(caps?.resources?.listChanged).not.toBe(true);
      expect(caps?.prompts, "no prompts: the write-flow prompts are the write edition's").toBeUndefined();

      // The read resources: graph schema, the read tool catalog, the read playbook.
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(["dexe://graph-schema", "dexe://playbook", "dexe://tools"]);
      for (const r of resources) {
        const body = await client.readResource({ uri: r.uri });
        const text = body.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
        expect(text.length, r.uri).toBeGreaterThan(200);
        for (const w of WRITE_TOOLS) expect(text, `${r.uri} names ${w}`).not.toMatch(new RegExp(`\\b${w}\\b`));
        // Remote wording: a caller cannot edit this server's .env.
        if (r.uri === "dexe://playbook") expect(text).not.toMatch(/\.env/);
      }

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(toolNames());
      expect(names).toEqual([...READ_TOOLS].sort());
      const read = new Set(READ_TOOLS);
      expect(names.filter((n) => !read.has(n)), "served but not in READ_TOOLS").toEqual([]);
      expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual([]);

      const res = await client.callTool({ name: "dexe_ipfs_cid_info", arguments: { cid: TEST_CID } });
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { version?: number }).version).toBe(0);

      // A write tool is simply not there.
      const denied = await client.callTool({ name: "dexe_tx_send", arguments: {} });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("the remote handshake instructions name no write tool", () => {
    for (const w of WRITE_TOOLS) expect(readInstructions()).not.toMatch(new RegExp(`\\b${w}\\b`));
  });

  it("serves every request from a pooled server: one built for serial traffic", () => {
    // initialize, tools/list and tools/call above all went through the pool.
    expect(factory.built()).toBe(1);
  });

  it("a reused server does not carry the previous caller's initialize", async () => {
    const first = await raw(port, {
      headers: JSON_HEADERS,
      body: rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: { sampling: {} },
        clientInfo: { name: "caller-a", version: "1" },
      }),
    });
    expect(first.status).toBe(200);
    await settle();
    const s = factory.acquire();
    try {
      expect(s.server.getClientVersion()).toBeUndefined();
      expect(s.server.getClientCapabilities()).toBeUndefined();
    } finally {
      factory.release(s);
    }
  });

  // dexe_doctor's remote form is pinned without a network in tests/read/remote-diagnostics.test.ts.
  it("remote orientation tools name no host, path or env file", async () => {
    for (const name of ["dexe_context", "dexe_get_config"]) {
      const r = await raw(port, {
        headers: { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25" },
        body: rpc("tools/call", { name, arguments: {} }),
      });
      expect(r.status, name).toBe(200);
      const text = JSON.stringify(r.json().result);
      expect(text, name).not.toMatch(/https?:\/\//);
      expect(text, name).not.toMatch(/dataseed|bnbchain|thegraph|api\.dexe\.io/i);
      expect(text, name).not.toMatch(/\.env\b|envFile|statePath|state\.json|startupTime|DEXE_[A-Z_]+_KEY/);
      expect(text, name).not.toContain(operatorStateDir.replace(/\\/g, "\\\\"));
    }
  }, 30_000);

  it("answers GET and DELETE on /mcp with 405 (stateless: no SSE stream, no session)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await raw(port, { method, headers: { accept: "text/event-stream" } });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("POST, OPTIONS");
      expect(r.json().error.code).toBe(-32000);
    }
  });

  it("never mints a session id", async () => {
    const r = await raw(port, {
      headers: JSON_HEADERS,
      body: rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    expect(r.json().result.protocolVersion).toBe("2025-11-25");
  });

  it("serves a legacy request without a prior initialize (per-request server)", async () => {
    const r = await raw(port, {
      headers: { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25" },
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.json().result.tools.length).toBe(toolNames().length);
  });

  it("serves a client that accepts only application/json (responses are always JSON here)", async () => {
    const r = await raw(port, {
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-11-25" },
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(200);
    const html = await raw(port, {
      headers: { "content-type": "application/json", accept: "text/html", "mcp-protocol-version": "2025-11-25" },
      body: rpc("tools/list"),
    });
    expect(html.status).toBe(406);
  });

  describe("2026-07-28-style stateless requests (what SDK v1 does with them)", () => {
    const modern = (method: string, extraParams: Record<string, unknown> = {}) => ({
      headers: { ...JSON_HEADERS, "mcp-protocol-version": "2026-07-28", "mcp-method": method },
      body: rpc(method, {
        ...extraParams,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      }),
    });

    // The v1 transport rejects the unknown revision with 400 and code -32000.
    // -32000 is NOT one of the 2026-07-28 modern error codes (-32020..-32022),
    // which is the spec's signal for a dual-era client to fall back to
    // `initialize`. Pinned so an SDK bump that changes this is noticed.
    it.each(["server/discover", "tools/list"])("%s → 400, non-modern error code (fallback signal)", async (m) => {
      const r = await raw(port, modern(m));
      expect(r.status).toBe(400);
      const err = r.json().error;
      expect(err.code).toBe(-32000);
      expect(err.message).toMatch(/Unsupported protocol version: 2026-07-28/);
    });
  });

  it("Origin: absent passes, foreign is 403, allowlisted passes with CORS headers", async () => {
    const body = rpc("tools/list");
    const headers = { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25" };
    const foreign = await raw(port, { headers: { ...headers, origin: "https://evil.example" }, body });
    expect(foreign.status).toBe(403);
    const ok = await raw(port, { headers: { ...headers, origin: "https://allowed.example" }, body });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://allowed.example");
    const pre = await raw(port, {
      method: "OPTIONS",
      headers: { origin: "https://allowed.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toMatch(/mcp-protocol-version/);
  });

  it("Host: a name outside the allowlist is 403 (DNS-rebinding guard)", async () => {
    const r = await raw(port, {
      headers: { ...JSON_HEADERS, host: "rebind.evil.example", "mcp-protocol-version": "2025-11-25" },
      body: rpc("tools/list"),
    });
    expect(r.status).toBe(403);
    expect(r.json().error.message).toMatch(/Host/);
  });

  it("health endpoints answer without MCP headers", async () => {
    const h = await raw(port, { method: "GET", path: "/healthz" });
    expect(h.status).toBe(200);
    expect(h.json()).toMatchObject({ status: "ok", version: "0.0.0-test" });
    const ready = await raw(port, { method: "GET", path: "/readyz" });
    expect(ready.status).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", chainId: 56 });
    expect((await raw(port, { method: "GET", path: "/nope" })).status).toBe(404);
  });

  it("rejects JSON-RPC batches with a JSON-RPC error instead of running them", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dexe_ipfs_cid_info", arguments: { cid: TEST_CID } } },
    ]);
    const r = await raw(port, { headers: { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25" }, body: batch });
    expect(r.status).toBe(400);
    expect(r.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(r.json().error.message).toMatch(/batch/i);
  });

  it("wrong media type is 415, broken JSON is 400", async () => {
    const t = await raw(port, { headers: { "content-type": "text/plain" }, body: "{}" });
    expect(t.status).toBe(415);
    const j = await raw(port, { headers: JSON_HEADERS, body: "{not json" });
    expect(j.status).toBe(400);
    expect(j.json().error.code).toBe(-32700);
  });

  it("access log: one JSON line per request, hashed IP, method + tool name, no arguments", async () => {
    await settle();
    const call = logs.find((e) => e.rpc === "tools/call" && e.tool === "dexe_ipfs_cid_info");
    expect(call).toMatchObject({ event: "http", path: "/mcp", status: 200, method: "POST" });
    expect(call?.ip).toMatch(/^[0-9a-f]{12}$/);
    const all = JSON.stringify(logs);
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toContain(TEST_CID);
    expect(logs.some((e) => e.reason === "origin" && e.status === 403)).toBe(true);
  });

  it("writes no state: the operator's DEXE_STATE_PATH dir is still empty", () => {
    expect(readdirSync(operatorStateDir)).toEqual([]);
  });
});

describe("serve-http limits", () => {
  const tinyFactory: McpServerFactory = () => {
    const s = new McpServer({ name: "tiny", version: "0" });
    s.registerTool("ping", { description: "pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    return s;
  };
  const call = (port: number, extra: Record<string, string> = {}) =>
    raw(port, {
      headers: { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25", ...extra },
      body: rpc("tools/call", { name: "ping", arguments: {} }),
    });

  it("body over the cap is 413 — declared Content-Length and chunked", async () => {
    const { app, port } = await start(tinyFactory, { maxBodyBytes: 1024 });
    try {
      const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(2048) } });
      const declared = await raw(port, { headers: JSON_HEADERS, body: big });
      expect(declared.status).toBe(413);
      const chunked = await raw(port, {
        headers: JSON_HEADERS,
        body: [Buffer.from(big.slice(0, 900)), Buffer.from(big.slice(900))],
      });
      expect(chunked.status).toBe(413);
      expect((await call(port)).status).toBe(200);
    } finally {
      await app.close(100);
    }
  });

  it("per-IP rate limit answers 429 with Retry-After", async () => {
    const { app, port } = await start(tinyFactory, { rateLimit: { perMinute: 60, burst: 3 } });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await call(port)).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const limited = await call(port);
      expect(limited.headers["retry-after"]).toBe("1");
      // health is never rate limited
      expect((await raw(port, { method: "GET", path: "/healthz" })).status).toBe(200);
    } finally {
      await app.close(100);
    }
  });

  it("ignores a spoofed X-Forwarded-For unless proxies are trusted", async () => {
    const { app, port } = await start(tinyFactory, { rateLimit: { perMinute: 60, burst: 1 } });
    try {
      expect((await call(port, { "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
      expect((await call(port, { "x-forwarded-for": "2.2.2.2" })).status).toBe(429);
    } finally {
      await app.close(100);
    }
    const trusted = await start(tinyFactory, { rateLimit: { perMinute: 60, burst: 1 }, trustProxyHops: 1 });
    try {
      expect((await call(trusted.port, { "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
      expect((await call(trusted.port, { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
      expect((await call(trusted.port, { "x-forwarded-for": "2.2.2.2" })).status).toBe(429);
    } finally {
      await trusted.app.close(100);
    }
  });

  it("global in-flight cap answers 503; the held request still completes", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow: McpServerFactory = () => {
      const s = new McpServer({ name: "slow", version: "0" });
      s.registerTool("ping", { description: "waits" }, async () => {
        await held;
        return { content: [{ type: "text", text: "late pong" }] };
      });
      return s;
    };
    const { app, port } = await start(slow, { maxInflight: 1 });
    try {
      const first = call(port);
      await settle();
      expect(app.inflight()).toBe(1);
      const second = await call(port);
      expect(second.status).toBe(503);
      release();
      const done = await first;
      expect(done.status).toBe(200);
      expect(done.json().result.content[0].text).toBe("late pong");
    } finally {
      await app.close(100);
    }
  });

  it("a request past its budget is 504, the handler's abort signal fires, and the slot is released", async () => {
    let aborted = false;
    const never: McpServerFactory = () => {
      const s = new McpServer({ name: "never", version: "0" });
      s.registerTool(
        "ping",
        { description: "hangs until aborted" },
        // no inputSchema → the SDK passes `extra` as the only argument
        (extra) =>
          new Promise((resolve) => {
            extra.signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ content: [] });
            });
          }),
      );
      return s;
    };
    const { app, port } = await start(never, { requestTimeoutMs: 1000 });
    try {
      const r = await call(port);
      expect(r.status).toBe(504);
      await settle();
      expect(aborted, "per-request server torn down → SDK aborts extra.signal").toBe(true);
      expect(app.inflight()).toBe(0);
    } finally {
      await app.close(100);
    }
  });

  /** Headers plus part of the body, then silence: the slow-body attack shape. */
  function partialBody(port: number): Promise<RawResponse> {
    const body = rpc("tools/call", { name: "ping", arguments: {} });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/mcp",
          headers: { ...JSON_HEADERS, "mcp-protocol-version": "2025-11-25", "content-length": String(body.length) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
          });
        },
      );
      req.on("error", reject);
      req.write(body.slice(0, 10)); // never finished
    });
  }

  it("slow partial bodies hold no in-flight slot and are cut off with 408", async () => {
    const { app, port } = await start(tinyFactory, { maxInflight: 2, bodyTimeoutMs: 400 });
    try {
      const slow = [partialBody(port), partialBody(port), partialBody(port)];
      await settle();
      expect(app.inflight(), "trickling bodies must not occupy slots").toBe(0);
      expect((await call(port)).status, "a complete request still gets through").toBe(200);
      const t0 = Date.now();
      const results = await Promise.all(slow);
      expect(results.map((r) => r.status)).toEqual([408, 408, 408]);
      expect(results[0]!.json().error.message).toMatch(/did not arrive within 400 ms/);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await app.close(100);
    }
  });

  it("IPv6 clients share a bucket per /64 (ports stripped from X-Forwarded-For)", async () => {
    const { app, port } = await start(tinyFactory, { rateLimit: { perMinute: 60, burst: 1 }, trustProxyHops: 1 });
    try {
      expect((await call(port, { "x-forwarded-for": "2001:db8:1:2::a" })).status).toBe(200);
      expect((await call(port, { "x-forwarded-for": "[2001:db8:1:2::b]:5555" })).status).toBe(429);
      expect((await call(port, { "x-forwarded-for": "2001:db8:1:3::a" })).status).toBe(200);
      expect((await call(port, { "x-forwarded-for": "9.9.9.9:1000" })).status).toBe(200);
      expect((await call(port, { "x-forwarded-for": "9.9.9.9:2000" })).status).toBe(429);
    } finally {
      await app.close(100);
    }
  });
});
