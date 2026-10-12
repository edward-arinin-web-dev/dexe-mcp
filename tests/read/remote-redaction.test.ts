import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadReadConfig } from "../../src/configRead.js";
import { resetAudienceForTests, setRemoteAudience } from "../../src/lib/audience.js";
import {
  collectEndpointLabels,
  createRemoteRedactor,
  stripEnvAdvice,
} from "../../src/lib/remoteLabels.js";
import { createReadServer, useRemoteFailureWording } from "../../src/read/server.js";
import { connectInMemory } from "../helpers/readEdition.js";

/**
 * Security review of #103, items 1 and 3: a REMOTE read server must not tell
 * an anonymous caller the operator's hosts — in errors, in degraded-section
 * reasons, in `dexe_ipfs_fetch`'s `gateway`, in the doctor — nor advise it to
 * set server variables or restart. The upstreams here are a mock on loopback
 * (127.0.0.1 = a private address) that echoes internal host names back, plus a
 * closed port for the RPC. The stdio server is checked against the same mock to
 * show its wording did not change.
 */

const CID_OK = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_BAD = "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB";
const GOV_POOL = "0x0000000000000000000000000000000000000001";

let mock: Server;
let port: number;
let closedPort: number;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DEXE_RPC_URL_MAINNET",
  "DEXE_RPC_URL_TESTNET",
  "DEXE_SUBGRAPH_POOLS_URL",
  "DEXE_SUBGRAPH_VALIDATORS_URL",
  "DEXE_SUBGRAPH_INTERACTIONS_URL",
  "DEXE_BACKEND_API_URL",
  "DEXE_IPFS_GATEWAY",
  "DEXE_IPFS_DISABLE_PUBLIC_FALLBACK",
  "DEXE_RPC_TIMEOUT_MS",
];

beforeAll(async () => {
  mock = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith(`/ipfs/${CID_OK}`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "Mock DAO", website: "https://dao.example.org/about" }));
      return;
    }
    // Upstreams that echo where they live — what a proxy error page does.
    res.writeHead(url.startsWith("/subgraphs/") ? 503 : 502, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "upstream subgraph-host.corp.example:8000 (10.0.0.9) unavailable" }] }));
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  port = (mock.address() as AddressInfo).port;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEXE_RPC_URL_MAINNET = `http://127.0.0.1:${closedPort}/rpc/0123456789abcdef0123`;
  process.env.DEXE_RPC_URL_TESTNET = `http://internal-rpc:${closedPort}`;
  for (const kind of ["POOLS", "VALIDATORS", "INTERACTIONS"]) {
    process.env[`DEXE_SUBGRAPH_${kind}_URL`] = `http://localhost:${port}/subgraphs/${kind.toLowerCase()}`;
  }
  process.env.DEXE_BACKEND_API_URL = `http://localhost:${port}/backend`;
  process.env.DEXE_IPFS_GATEWAY = `http://localhost:${port}`;
  process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK = "1";
  process.env.DEXE_RPC_TIMEOUT_MS = "2000";
});

afterAll(async () => {
  resetAudienceForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise<void>((r) => mock.close(() => r()));
});

async function call(remote: boolean, name: string, args: Record<string, unknown>) {
  const config = await loadReadConfig();
  const s = await connectInMemory(createReadServer(config, { remote, version: "0" }));
  try {
    return await s.client.callTool({ name, arguments: args });
  } finally {
    await s.close();
  }
}

/** Everything that would tell a remote caller where the operator's upstreams live. */
function leaks(result: unknown): string[] {
  const text = JSON.stringify(result);
  return [
    "127.0.0.1",
    "10.0.0.9",
    "localhost",
    "internal-rpc",
    "corp.example",
    `:${port}`,
    `:${closedPort}`,
    "0123456789abcdef0123",
  ].filter((s) => text.includes(s));
}

const ENV_ADVICE = /\bDEXE_[A-Z0-9_]+|\brestart\b|\.env\b|MCP env block/;

describe("the redactor", () => {
  const config = {
    chains: new Map([
      [56, { chainId: 56, rpcUrl: "https://bsc.rpc.corp.example/k", rpcUrls: ["https://bsc.rpc.corp.example/k"] }],
      [97, { chainId: 97, rpcUrl: "http://rpc:8545", rpcUrls: ["http://rpc:8545"] }],
    ]),
    subgraphUrls: new Map([[56, { pools: "https://graph.corp.example/p", validators: "https://graph.corp.example/v" }]]),
    backendApiUrl: "https://api.corp.example",
  } as never;
  const labels = collectEndpointLabels(config, ["https://gw.corp.example", "https://ipfs.io"]);
  const r = createRemoteRedactor(() => labels);

  it("labels every configured host, keeps the public IPFS gateways", () => {
    expect(Object.fromEntries(labels.map((l) => [l.host, l.label]))).toEqual({
      "bsc.rpc.corp.example": "rpc[56]",
      rpc: "rpc[97]",
      "graph.corp.example": "subgraph",
      "api.corp.example": "backend",
      "gw.corp.example": "ipfs-gateway#1",
    });
    expect(r.text("via https://bsc.rpc.corp.example/k/x?y=1 and bsc.rpc.corp.example:443", false)).toBe("via rpc[56] and rpc[56]");
    expect(r.text("fetch http://rpc:8545 failed; rpc:8545 refused", false)).toBe("fetch rpc[97] failed; rpc[97] refused");
    // a dotless host is never matched as a plain word
    expect(r.text("the rpc-flaky remedy: retry the RPC call", false)).toBe("the rpc-flaky remedy: retry the RPC call");
    expect(r.text("see https://ipfs.io/ipfs/Qm1", false)).toBe("see https://ipfs.io/ipfs/Qm1");
  });

  it("masks network-error peers and IPs everywhere; URLs and host:port only in errors", () => {
    expect(r.text("connect ECONNREFUSED 10.0.0.9:443", false)).toBe("connect ECONNREFUSED <upstream>");
    expect(r.text("getaddrinfo ENOTFOUND internal-rpc", false)).toBe("getaddrinfo ENOTFOUND <upstream>");
    expect(r.text("resolved 10.0.0.9 and [fd00::1]:80", false)).toBe("resolved <ip> and <ip>");
    expect(r.text("site https://dao.example.org/a", false)).toBe("site https://dao.example.org/a");
    expect(r.text("site https://dao.example.org/a via proxy.corp.example:8000", true)).toBe("site <url> via <host>");
    expect(r.text("pass chainId:56 or block:62000000", true)).toBe("pass chainId:56 or block:62000000");
  });

  it("stripEnvAdvice keeps what happened, drops the env remedy", () => {
    const out = stripEnvAdvice("No RPC configured for chainId=1. Set DEXE_RPC_URL_<chain> in .env and restart.");
    expect(out).toMatch(/^No RPC configured for chainId=1\./);
    expect(out).not.toMatch(ENV_ADVICE);
    expect(stripEnvAdvice("nothing to strip")).toBe("nothing to strip");
    // Tool names are not settings: a sentence naming one stays, with no operator note.
    const tools = "Chain 1 is not available here. Pass one dexe_get_config lists. Restart at page 1 with dexe_read_nfts.";
    expect(stripEnvAdvice(tools)).toBe(tools);
  });
});

describe("stdio (local) wording is unchanged", () => {
  it("names the gateway host and the env remedies", async () => {
    const ok = await call(false, "dexe_ipfs_fetch", { cid: CID_OK });
    expect((ok.structuredContent as { gateway: string }).gateway).toBe(`localhost:${port}`);
    const noChain = await call(false, "dexe_dao_info", { govPool: GOV_POOL, chainId: 1 });
    expect(JSON.stringify(noChain)).toMatch(/DEXE_RPC_URL_/);
  });
});

describe("remote", () => {
  beforeAll(() => {
    setRemoteAudience();
    useRemoteFailureWording();
  });

  it("dexe_ipfs_fetch: gateway is a label, the document's own links stay", async () => {
    const res = await call(true, "dexe_ipfs_fetch", { cid: CID_OK });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { gateway: string; json: { website: string } };
    expect(sc.gateway).toBe("ipfs-gateway#1");
    expect(sc.json.website).toBe("https://dao.example.org/about");
    expect(leaks(res)).toEqual([]);
  });

  it.each([
    ["dexe_ipfs_fetch", { cid: CID_BAD }],
    ["dexe_graph_query", { subgraph: "pools", query: "{ daoPools(first: 1) { id } }" }],
    ["dexe_read_protocol_stats", {}],
    ["dexe_dao_info", { govPool: GOV_POOL }],
    ["dexe_read_gov_state", { govPool: GOV_POOL, chainId: 97 }],
  ])("%s: an upstream failure names no host, IP, port or env remedy", async (name, args) => {
    const res = await call(true, name, args);
    expect(leaks(res), name).toEqual([]);
    expect(JSON.stringify(res), name).not.toMatch(ENV_ADVICE);
  });

  it("dexe_doctor names no host or address", async () => {
    const res = await call(true, "dexe_doctor", {});
    expect(leaks(res)).toEqual([]);
    expect(JSON.stringify(res)).not.toMatch(ENV_ADVICE);
  });

  it("an unserved chain or subgraph is 'not available on this server', not an env remedy", async () => {
    const noChain = await call(true, "dexe_dao_info", { govPool: GOV_POOL, chainId: 1 });
    expect(noChain.isError).toBe(true);
    expect(JSON.stringify(noChain)).toMatch(/not available on this server/);
    expect(JSON.stringify(noChain)).not.toMatch(ENV_ADVICE);
    // the pointer at a tool the caller CAN use survives the env-advice net
    expect(JSON.stringify(noChain)).toContain("dexe_get_config");
    expect(JSON.stringify(noChain)).not.toContain("set by its operator");
    const noIndexer = await call(true, "dexe_graph_query", { subgraph: "pools", query: "{ daoPools(first: 1) { id } }", chainId: 97 });
    expect(noIndexer.isError).toBe(true);
    expect(JSON.stringify(noIndexer)).toMatch(/not available on this server/);
    expect(JSON.stringify(noIndexer)).not.toMatch(ENV_ADVICE);
  });

  it("no gateway at all: IPFS reads are 'not available on this server'", async () => {
    const prev = process.env.DEXE_IPFS_GATEWAY;
    delete process.env.DEXE_IPFS_GATEWAY;
    try {
      const res = await call(true, "dexe_ipfs_fetch", { cid: CID_OK });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/not available on this server/);
      expect(JSON.stringify(res)).not.toMatch(ENV_ADVICE);
    } finally {
      process.env.DEXE_IPFS_GATEWAY = prev;
    }
  });

  it("no tool description names a server variable", async () => {
    const config = await loadReadConfig();
    const s = await connectInMemory(createReadServer(config, { remote: true, version: "0" }));
    try {
      const { tools } = await s.client.listTools();
      expect(tools.filter((t) => /\bDEXE_[A-Z0-9_]+/.test(JSON.stringify(t))).map((t) => t.name)).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
