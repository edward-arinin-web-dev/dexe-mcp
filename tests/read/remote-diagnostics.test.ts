import { describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../../src/diag/checks.js";

/**
 * A9 — what `dexe_doctor`, `dexe_context` and `dexe_get_config` tell an
 * anonymous caller of the remote read server: upstream health and the chain
 * set, never the host (env files, paths, which vars are set, rejected values,
 * the state path, start time) or the operator's endpoints. The doctor's checks
 * are stubbed with rows shaped like the real ones, so no network is touched.
 */

const ROWS: CheckResult[] = [
  { id: "startup.DEXE_RPC_URL_MAINNET", category: "rpc", status: "fail", message: "not a URL: s3cr3t-value", remediation: "Correct it in /home/op/.dexe-mcp/.env" },
  { id: "env.file", category: "process", status: "pass", message: "loaded /home/op/.dexe-mcp/.env — 3 key(s) applied", remediation: "Edit THIS file" },
  { id: "env.DEXE_GRAPH_API_KEY", category: "subgraph", status: "pass", message: "set (redacted)" },
  { id: "rpc.reachable.56", category: "rpc", status: "pass", message: "eth_chainId=56 (https://bsc-mainnet.nodereal.io/***)" },
  { id: "ipfs.gateway.dns", category: "ipfs", status: "pass", message: "resolved operator-gw.mypinata.cloud" },
  { id: "subgraph.pools.56", category: "subgraph", status: "warn", message: "https://gateway.thegraph.com/api/*** answered HTTP 429", remediation: "Set DEXE_SUBGRAPH_POOLS_URL in .env" },
  { id: "env.sharedDefaults", category: "core", status: "warn", message: "Using shared public defaults for: backend API.", remediation: "set your own" },
  { id: "state.path", category: "process", status: "pass", message: "writable (/home/op/.dexe-mcp/state.json)" },
];

vi.mock("../../src/diag/checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/diag/checks.js")>();
  return { ...actual, runAllChecks: vi.fn(async () => ROWS) };
});

const { loadReadConfig } = await import("../../src/configRead.js");
const { createReadServer } = await import("../../src/read/server.js");
const { redactEndpoints } = await import("../../src/tools/doctor.js");
const { connectInMemory } = await import("../helpers/readEdition.js");

async function call(remote: boolean, name: string) {
  const prev = process.env.DEXE_RPC_URL_MAINNET;
  process.env.DEXE_RPC_URL_MAINNET = "https://bsc-mainnet.nodereal.io/v1/0123456789abcdef0123456789abcdef";
  try {
    const config = await loadReadConfig();
    const s = await connectInMemory(createReadServer(config, { remote, version: "0" }));
    try {
      return await s.client.callTool({ name, arguments: {} });
    } finally {
      await s.close();
    }
  } finally {
    if (prev === undefined) delete process.env.DEXE_RPC_URL_MAINNET;
    else process.env.DEXE_RPC_URL_MAINNET = prev;
  }
}

const HOST_DETAIL = /\/home\/op|\.env\b|state\.json|s3cr3t|nodereal|mypinata|thegraph\.com|https?:\/\/|startupTime|uptime|envFile|candidatesTried/i;

describe("dexe_doctor, remote", () => {
  it("keeps the upstream rows, drops the host rows, every remediation and every hostname", async () => {
    const res = await call(true, "dexe_doctor");
    const sc = res.structuredContent as { checks: CheckResult[]; note: string; rejectedSettings: number; summary: { failures: number } };
    expect(sc.checks.map((c) => c.id)).toEqual(["rpc.reachable.56", "ipfs.gateway.dns", "subgraph.pools.56", "env.sharedDefaults"]);
    expect(sc.checks.every((c) => c.remediation === undefined)).toBe(true);
    expect(sc.rejectedSettings).toBe(0);
    expect(sc.note).toMatch(/operator/);
    // the dropped startup row was the only failure
    expect(sc.summary.failures).toBe(0);
    const text = JSON.stringify(res);
    expect(text).not.toMatch(HOST_DETAIL);
    expect(text).toContain("eth_chainId=56 (<endpoint>)");
  });

  it("the local (stdio) doctor keeps the full report", async () => {
    const res = await call(false, "dexe_doctor");
    const sc = res.structuredContent as { checks: CheckResult[]; envFile: unknown; startupTime: string };
    expect(sc.checks).toHaveLength(ROWS.length);
    expect(sc.envFile).toBeDefined();
    expect(sc.startupTime).toEqual(expect.any(String));
  });

  it("redactEndpoints masks URLs and bare hostnames, keeps everything else", () => {
    expect(redactEndpoints("RPC https://a.b.example/x timed out after 3000ms")).toBe("RPC <endpoint> timed out after 3000ms");
    expect(redactEndpoints("resolved dexe.mypinata.cloud")).toBe("resolved <host>");
    expect(redactEndpoints("eth_chainId=56 in configured=[56, 97]")).toBe("eth_chainId=56 in configured=[56, 97]");
  });
});

describe("dexe_context and dexe_get_config, remote", () => {
  it.each(["dexe_context", "dexe_get_config"])("%s names no endpoint host", async (name) => {
    const remote = JSON.stringify(await call(true, name));
    expect(remote).toContain("56");
    expect(remote).not.toMatch(/nodereal|rpcUrl|https?:\\\/\\\/|https?:\/\//);
    // the stdio server still shows the (masked) endpoint
    const local = JSON.stringify(await call(false, name));
    expect(local).toContain("bsc-mainnet.nodereal.io");
    expect(local).not.toContain("0123456789abcdef0123456789abcdef");
  });
});
