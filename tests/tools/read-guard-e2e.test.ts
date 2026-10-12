import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * The read-tool guard end to end: a real server (registerAll, full profile)
 * behind an in-memory client, every upstream pointed at ONE local HTTP server
 * whose URLs carry secret-looking path segments — and which echoes them back,
 * the way a real 404 page or gateway error does.
 *
 * Covers the security review of #93: secrets/hosts in output (finding 4),
 * response size (3), IPFS JSON size (1), and abort propagation (6).
 */

const GRAPH_KEY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const SUBGRAPH_ID = "QmSubgraphDeployment0000000000000000000000000";
const BACKEND_SECRET = "sk-backend-0123456789abcdef";
const GATEWAY_TOKEN = "gwtoken-0123456789abcdef";
const RPC_KEY = "rpckey-0123456789abcdef0123";
const SECRETS = [GRAPH_KEY, SUBGRAPH_ID, BACKEND_SECRET, GATEWAY_TOKEN, RPC_KEY];

// raw-codec CID of the bytes `{}` would not match; use dag-pb (not hash-checked)
const CID_SMALL = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_BIG_JSON = "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";
const CID_HUGE = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";

type Mode = { subgraph: "echo404" | "rows"; topDelayMs: number };
const mode: Mode = { subgraph: "echo404", topDelayMs: 0 };
const hits: string[] = [];
/** Backend requests whose client hung up before the answer (an honoured abort). */
let closedEarly = 0;
let base = "";
let client: Client;
let server: McpServer;
const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "";
  hits.push(url);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.startsWith("/api/")) {
    if (mode.subgraph === "echo404") {
      // The gateway repeats the request path — key and all.
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`no deployment at ${url} (requested ${base}${url})`);
      return;
    }
    const rows = Array.from({ length: 100 }, (_v, i) => ({
      id: `0x${i.toString(16).padStart(40, "0")}`,
      name: `DAO ${i} ${"n".repeat(2_000)}`,
      votersCount: String(100 - i),
    }));
    json(200, { data: { daoPools: rows } });
    return;
  }
  if (url.startsWith(`/backend/${BACKEND_SECRET}/integrations/tracker/pools/gov/summary-stats/`)) {
    json(200, { data: { attributes: { tvl_usd: "1", tvl_dots: [] } } });
    return;
  }
  if (/^\/backend\/[^/]+\/integrations\/tracker\/\d+\/pools\/gov\/top/.test(url)) {
    const t = setTimeout(() => json(200, { data: [] }), mode.topDelayMs);
    res.on("close", () => {
      clearTimeout(t);
      if (!res.writableEnded) closedEarly++;
    });
    return;
  }
  if (url === `/gw/${GATEWAY_TOKEN}/ipfs/${CID_SMALL}`) {
    json(200, { name: "Glacier DAO", gateway: `${base}/gw/${GATEWAY_TOKEN}` });
    return;
  }
  if (url === `/gw/${GATEWAY_TOKEN}/ipfs/${CID_BIG_JSON}`) {
    // ~1.2 MB: under the 2 MB byte cap, far over the structured JSON cap.
    json(200, { proposals: Array.from({ length: 4_000 }, (_v, i) => ({ i, text: "p".repeat(280) })) });
    return;
  }
  if (url === `/gw/${GATEWAY_TOKEN}/ipfs/${CID_HUGE}`) {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => {
      while (!res.destroyed) if (!res.write(chunk)) return void res.once("drain", pump);
    };
    pump();
    return;
  }
  json(404, { error: `unknown ${url}` });
});

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DEXE_TOOLSETS",
  "DEXE_SUBGRAPH_POOLS_URL",
  "DEXE_SUBGRAPH_VALIDATORS_URL",
  "DEXE_SUBGRAPH_INTERACTIONS_URL",
  "DEXE_BACKEND_API_URL",
  "DEXE_IPFS_GATEWAY",
  "DEXE_RPC_URL_MAINNET",
  "DEXE_MAX_RESPONSE_BYTES",
  "DEXE_IPFS_MAX_BYTES",
];

beforeAll(async () => {
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const subgraph = `${base}/api/${GRAPH_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  Object.assign(process.env, {
    DEXE_TOOLSETS: "full",
    DEXE_SUBGRAPH_POOLS_URL: subgraph,
    DEXE_SUBGRAPH_VALIDATORS_URL: subgraph,
    DEXE_SUBGRAPH_INTERACTIONS_URL: subgraph,
    DEXE_BACKEND_API_URL: `${base}/backend/${BACKEND_SECRET}`,
    DEXE_IPFS_GATEWAY: `${base}/gw/${GATEWAY_TOKEN}`,
    DEXE_RPC_URL_MAINNET: `${base}/rpc/${RPC_KEY}`,
  });
  const config = await loadConfig();
  server = new McpServer({ name: "guard-e2e", version: "0.0.0" }, {});
  registerAll(server, config);
  client = new Client({ name: "guard-e2e-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  hits.length = 0;
  closedEarly = 0;
  mode.subgraph = "echo404";
  mode.topDelayMs = 0;
  delete process.env.DEXE_MAX_RESPONSE_BYTES;
});

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined) as Promise<Result>;
const wire = (r: Result) => JSON.stringify(r);
const noSecrets = (r: Result) => {
  const s = wire(r);
  return SECRETS.filter((x) => s.includes(x));
};

describe("no configured secret reaches a read result", () => {
  it("a subgraph 404 that echoes the keyed path is reported without the key", async () => {
    const r = await call("dexe_read_dao_list", { chainId: 56 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Subgraph HTTP 404");
    expect(r.content[0]!.text).toContain("gateway said:");
    expect(noSecrets(r)).toEqual([]);
  });

  it("dexe_ipfs_fetch names the gateway by host and scrubs the token from echoed content", async () => {
    const r = await call("dexe_ipfs_fetch", { cid: CID_SMALL });
    expect(r.isError).toBeFalsy();
    const host = new URL(base).host;
    expect(r.structuredContent!.gateway).toBe(host);
    expect(r.content[0]!.text).toContain(`via ${host} `);
    expect(noSecrets(r)).toEqual([]);
  });

  it("dexe_ipfs_cid_info prints scheme + host + /ipfs/<cid> only", async () => {
    const r = await call("dexe_ipfs_cid_info", { cid: CID_SMALL });
    expect(r.structuredContent!.gatewayUrls).toEqual([`${base}/ipfs/${CID_SMALL}`]);
    expect(noSecrets(r)).toEqual([]);
  });
});

describe("IPFS size limits through the tool", () => {
  it("a 1.2 MB JSON comes back summarized, flagged, with its real size", async () => {
    const r = await call("dexe_ipfs_fetch", { cid: CID_BIG_JSON });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.truncated).toBe(true);
    expect(r.structuredContent!.sizeBytes as number).toBeGreaterThan(1_000_000);
    expect(r.content[0]!.text).toContain("structuredContent.json is a summary");
    expect(Buffer.byteLength(wire(r))).toBeLessThan(256 * 1024);
  });

  it("an endless body stops at the byte cap with an actionable error", async () => {
    const r = await call("dexe_ipfs_fetch", { cid: CID_HUGE });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("IPFS content too large");
    expect(r.content[0]!.text).toContain("DEXE_IPFS_MAX_BYTES");
  });
});

describe("response-size cap", () => {
  it("a result over DEXE_MAX_RESPONSE_BYTES is cut to fit, with a corrected nextOffset", async () => {
    mode.subgraph = "rows";
    process.env.DEXE_MAX_RESPONSE_BYTES = "32768";
    const r = await call("dexe_read_dao_list", { chainId: 56, limit: 100, offset: 200 });
    expect(r.isError).toBeFalsy();
    expect(Buffer.byteLength(wire(r))).toBeLessThan(40 * 1024);
    const sc = r.structuredContent as { daoPools: unknown[]; returned: number; nextOffset: number; truncated: boolean };
    expect(sc.daoPools.length).toBeGreaterThan(0);
    expect(sc.daoPools.length).toBeLessThan(100);
    expect(sc.returned).toBe(sc.daoPools.length);
    expect(sc.truncated).toBe(true);
    expect(sc.nextOffset).toBe(200 + sc.daoPools.length);
    expect(r.content[0]!.text).toMatch(/^⚠ RESPONSE TRUNCATED/);
    expect(r.content[0]!.text).toContain(`offset: ${200 + sc.daoPools.length}`);
  });

  it("under the limit the same call is untouched", async () => {
    mode.subgraph = "rows";
    const r = await call("dexe_read_dao_list", { chainId: 56, limit: 100 });
    expect((r.structuredContent as { daoPools: unknown[] }).daoPools.length).toBe(100);
    expect(r.content[0]!.text).not.toContain("RESPONSE TRUNCATED");
  });
});

describe("fan-out and cancellation", () => {
  it("3,000 chainIds are rejected by the schema before any backend request", async () => {
    const r = await call("dexe_read_protocol_stats", { chainIds: Array.from({ length: 3_000 }, (_v, i) => i + 1) });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/chainIds/);
    expect(hits.filter((h) => h.startsWith("/backend"))).toEqual([]);
  });

  it("repeated chain ids are fetched once, a few at a time", async () => {
    const r = await call("dexe_read_protocol_stats", { chainIds: [56, 56, 56, 1, 1] });
    expect(r.isError).toBeFalsy();
    expect(hits.filter((h) => /\/pools\/gov\/top/.test(h)).length).toBe(2);
  });

  it("cancelling the call aborts the in-flight requests and starts none of the queued ones", async () => {
    mode.topDelayMs = 1_000;
    const ctrl = new AbortController();
    const pending = call("dexe_read_protocol_stats", { chainIds: [1, 2, 3, 4, 5, 6, 7, 8] }, ctrl.signal);
    await new Promise((r) => setTimeout(r, 300));
    const inFlight = hits.filter((h) => /\/pools\/gov\/top/.test(h)).length;
    ctrl.abort();
    await pending.catch(() => undefined);
    // Past the point where the first four would have answered and the
    // queued four would have started, had the abort been ignored.
    await new Promise((r) => setTimeout(r, 1_500));
    const after = hits.filter((h) => /\/pools\/gov\/top/.test(h)).length;
    expect(inFlight).toBe(4);
    expect(after).toBe(inFlight);
    expect(closedEarly).toBeGreaterThanOrEqual(4);
  });
});
