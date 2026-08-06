import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  interpretSubgraphProbe,
  runAllChecks,
  subgraphCoverageCheck,
  SUBGRAPH_PROBE_QUERY,
  type FetchOutcome,
  type SubgraphProbeTarget,
} from "../../src/diag/checks.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.2 — doctor used to judge a subgraph on its HTTP status alone. The Graph
 * gateway answers a REJECTED query (dead subgraph id, unpaid or mismatched API
 * key, removed deployment) with HTTP 200 and the refusal in `errors`, so a
 * completely dead endpoint reported `pass` while every subgraph-backed read
 * failed — and the user went looking somewhere else entirely.
 */

const POOLS: SubgraphProbeTarget = {
  kind: "pools",
  chainId: 97,
  url: "https://gateway.thegraph.com/api/deadbeef/subgraphs/id/QmPools",
};

const ok = (body: unknown, status = 200): FetchOutcome => ({ kind: "ok", status, body });
const meta = (number: number, hasIndexingErrors = false) => ({
  data: { _meta: { block: { number }, hasIndexingErrors } },
});

describe("interpretSubgraphProbe", () => {
  it("HTTP 200 carrying GraphQL errors is a FAIL, not a pass", () => {
    const r = interpretSubgraphProbe(
      POOLS,
      ok({ errors: [{ message: "subgraph not found: QmPools" }] }),
    );
    expect(r.status).toBe("fail");
    // The gateway's own words — the user must not have to guess what refused.
    expect(r.message).toContain("subgraph not found: QmPools");
    expect(r.message).toContain("HTTP 200");
  });

  it("names the per-chain endpoint var and the DEXE_GRAPH_API_KEY override in remediation", () => {
    const r = interpretSubgraphProbe(POOLS, ok({ errors: [{ message: "bad indexers" }] }));
    expect(r.remediation).toContain("DEXE_SUBGRAPH_POOLS_URL_97");
    expect(r.remediation).toContain("DEXE_GRAPH_API_KEY");
    expect(r.remediation).toContain("OVERRIDES");
  });

  it("HTTP 200 with no `data` is a FAIL", () => {
    const r = interpretSubgraphProbe(POOLS, ok({ notGraphql: true }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("no `data`");
  });

  it("HTTP 200 with `data` but no `_meta` is a FAIL", () => {
    const r = interpretSubgraphProbe(POOLS, ok({ data: { _meta: null } }));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("_meta");
  });

  it("a healthy _meta body PASSES and reports the indexed block number", () => {
    const r = interpretSubgraphProbe(POOLS, ok(meta(48_123_456)));
    expect(r.status).toBe("pass");
    expect(r.message).toContain("48123456");
    expect(r.id).toBe("subgraph.pools.97.reachable");
  });

  it("labels each result with the chain the endpoint indexes", () => {
    const mainnet = interpretSubgraphProbe(
      { ...POOLS, chainId: 56, kind: "validators" },
      ok(meta(1)),
    );
    expect(mainnet.id).toBe("subgraph.validators.56.reachable");
    expect(mainnet.message).toContain("chain 56");
  });

  it("warns when the indexer reports hasIndexingErrors", () => {
    const r = interpretSubgraphProbe(POOLS, ok(meta(48_123_456, true)));
    expect(r.status).toBe("warn");
    expect(r.message).toContain("hasIndexingErrors=true");
  });

  it("warns when the subgraph is far behind the chain head, and quantifies it", () => {
    const r = interpretSubgraphProbe(POOLS, ok(meta(48_000_000)), {
      headBlock: 48_040_000n,
    });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("40000 block(s) behind head 48040000");
    expect(r.remediation).toContain("stale");
  });

  it("a small lag is reported but still passes", () => {
    const r = interpretSubgraphProbe(POOLS, ok(meta(48_039_990)), { headBlock: 48_040_000n });
    expect(r.status).toBe("pass");
    expect(r.message).toContain("10 block(s) behind head");
  });

  it("keeps block heights exact (no float rounding) and refuses unsafe integers", () => {
    const exact = interpretSubgraphProbe(POOLS, ok(meta(Number.MAX_SAFE_INTEGER - 1)));
    expect(exact.message).toContain(String(Number.MAX_SAFE_INTEGER - 1));
    const lost = interpretSubgraphProbe(
      POOLS,
      ok({ data: { _meta: { block: { number: 1e300 }, hasIndexingErrors: false } } }),
    );
    expect(lost.status).toBe("warn");
    expect(lost.message).toContain("unknown");
  });

  it("HTTP >= 400 fails and still surfaces the gateway message", () => {
    const r = interpretSubgraphProbe(POOLS, ok({ errors: [{ message: "auth error" }] }, 401));
    expect(r.status).toBe("fail");
    expect(r.message).toContain("HTTP 401");
    expect(r.message).toContain("auth error");
  });

  it("a timeout warns rather than failing — an offline laptop is not a broken endpoint", () => {
    const r = interpretSubgraphProbe(POOLS, { kind: "timeout" }, { timeoutMs: 3000 });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("timed out after 3000ms");
  });

  it("never leaks the API key embedded in the endpoint URL", () => {
    const r = interpretSubgraphProbe(POOLS, ok(meta(1)));
    expect(JSON.stringify(r)).not.toContain("deadbeef");
  });
});

// ─── wiring: runAllChecks probes every configured chain ────────────────────

function testConfig(subgraphUrls: DexeConfig["subgraphUrls"]): DexeConfig {
  return {
    chains: new Map(),
    defaultChainId: 97,
    startupIssues: [],
    statePath: join(tmpdir(), "dexe-mcp-doctor-test", "state.json"),
    subgraphUrls,
    subgraphChainId: 56,
    backendApiUrl: "https://backend.invalid",
    toolsets: ["core"],
  } as unknown as DexeConfig;
}

describe("subgraphCoverageCheck", () => {
  const full = { pools: "https://a", validators: "https://b", interactions: "https://c" };

  it("passes when the default chain has all three subgraphs", () => {
    const rs = subgraphCoverageCheck(testConfig(new Map([[97, full]])));
    expect(rs[0]!.status).toBe("pass");
    expect(rs[0]!.message).toContain("97");
  });

  it("warns when the DEFAULT chain has no indexer, and points at the chain that does", () => {
    const rs = subgraphCoverageCheck(testConfig(new Map([[56, full]])));
    expect(rs[0]!.status).toBe("warn");
    expect(rs[0]!.message).toContain("DEFAULT chain 97");
    expect(rs[0]!.remediation).toContain("chainId: 56");
    // The escape hatch that needs no subgraph at all.
    expect(rs[0]!.remediation).toContain("dexe_read_gov_state");
  });

  it("names the per-chain env var for each missing kind", () => {
    const rs = subgraphCoverageCheck(testConfig(new Map([[97, { pools: "https://a" }]])));
    expect(rs[0]!.status).toBe("warn");
    expect(rs[0]!.remediation).toContain("DEXE_SUBGRAPH_VALIDATORS_URL_97");
    expect(rs[0]!.remediation).toContain("DEXE_SUBGRAPH_INTERACTIONS_URL_97");
  });
});

describe("runAllChecks — per-chain subgraph probes", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("probes each configured chain's endpoints and fails the dead one only", async () => {
    const bodies: Record<string, unknown> = {
      "https://sg.invalid/pools-56": meta(48_000_000),
      "https://sg.invalid/pools-97": { errors: [{ message: "subgraph deployment removed" }] },
    };
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      const body = bodies[u] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const results = await runAllChecks({
      timeoutMs: 200,
      config: testConfig(
        new Map([
          [56, { pools: "https://sg.invalid/pools-56" }],
          [97, { pools: "https://sg.invalid/pools-97" }],
        ]),
      ),
    });

    const mainnet = results.find(r => r.id === "subgraph.pools.56.reachable");
    const testnet = results.find(r => r.id === "subgraph.pools.97.reachable");
    expect(mainnet?.status).toBe("pass");
    expect(testnet?.status).toBe("fail");
    expect(testnet?.message).toContain("subgraph deployment removed");
    // Both endpoints were actually contacted — no global "the subgraph" probe.
    expect(seen).toContain("https://sg.invalid/pools-56");
    expect(seen).toContain("https://sg.invalid/pools-97");
  });

  it("asks for _meta, not __typename — indexing lag has to be observable", async () => {
    const bodiesSent: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("sg.invalid")) bodiesSent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(meta(1)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    await runAllChecks({
      timeoutMs: 200,
      config: testConfig(new Map([[97, { pools: "https://sg.invalid/pools-97" }]])),
    });

    expect(bodiesSent).toHaveLength(1);
    expect(JSON.parse(bodiesSent[0]!).query).toBe(SUBGRAPH_PROBE_QUERY);
    expect(SUBGRAPH_PROBE_QUERY).toContain("hasIndexingErrors");
  });
});
