import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAllChecks, startupIssueChecks } from "../../src/diag/checks.js";
import { DEFAULTS, loadConfig, type DexeConfig, type StartupIssue } from "../../src/config.js";

/**
 * 0.30.2 / L3 — doctor groups its rows by category, and the category comes from
 * ENV_REGISTRY. The per-chain families (DEXE_SUBGRAPH_<KIND>_URL_<chainId>,
 * DEXE_RPC_URL_<chainId>) carry an open-ended suffix and so cannot be enumerated
 * there — they fell through to "process", filing a rejected subgraph endpoint
 * under the internals section instead of next to the subgraph rows the user is
 * reading to work out why their reads stopped.
 *
 * L2 companion: the shared-Graph-key advisory is keyed off chain 56's slot, not
 * the flat alias, so retargeting DEXE_SUBGRAPH_CHAIN_ID cannot silence it.
 */

function configWith(startupIssues: StartupIssue[]): DexeConfig {
  return { startupIssues } as unknown as DexeConfig;
}

const issue = (key: string): StartupIssue => ({
  key,
  message: `Invalid ${key}=nope`,
  fallback: "that endpoint is ignored",
});

function categoryOf(key: string): string | undefined {
  return startupIssueChecks(configWith([issue(key)]))[0]?.category;
}

describe("startup-issue categories for the dynamic per-chain families", () => {
  it("files a per-chain subgraph var under subgraph, not process", () => {
    expect(categoryOf("DEXE_SUBGRAPH_POOLS_URL_97")).toBe("subgraph");
    expect(categoryOf("DEXE_SUBGRAPH_VALIDATORS_URL_56")).toBe("subgraph");
    expect(categoryOf("DEXE_SUBGRAPH_INTERACTIONS_URL_1")).toBe("subgraph");
  });

  it("files a per-chain RPC var under rpc", () => {
    expect(categoryOf("DEXE_RPC_URL_10")).toBe("rpc");
  });

  it("still reads the registry category for the unsuffixed vars", () => {
    expect(categoryOf("DEXE_SUBGRAPH_POOLS_URL")).toBe("subgraph");
    expect(categoryOf("DEXE_SUBGRAPH_CHAIN_ID")).toBe("subgraph");
  });

  it("keeps the signer family and the genuine unknowns where they were", () => {
    expect(categoryOf("DEXE_AGENT_PK_*")).toBe("signer");
    expect(categoryOf("DEXE_SIGNER_MAX_VALUE_WEI")).toBe("signer");
    expect(categoryOf("DEXE_SOMETHING_UNRECOGNIZED")).toBe("process");
  });

  it("a near-miss name is not mistaken for the per-chain family", () => {
    // The suffix must be a plain chain id — `_TESTNET` is a different var that
    // does not exist, i.e. a typo, and typos belong in the unknown bucket.
    expect(categoryOf("DEXE_SUBGRAPH_POOLS_URL_TESTNET")).toBe("process");
  });
});

describe("a rejected per-chain endpoint reaches doctor in the subgraph section", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DEXE_SUBGRAPH_")) saved.set(k, process.env[k]);
    }
    for (const k of saved.keys()) delete process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DEXE_SUBGRAPH_")) delete process.env[k];
    }
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v;
    }
    saved.clear();
  });

  it("end to end: loadConfig degrades it, startupIssueChecks categorizes it", async () => {
    process.env.DEXE_SUBGRAPH_POOLS_URL_97 = "pools.example";
    const config = await loadConfig();
    const row = startupIssueChecks(config).find(r => r.id === "startup.DEXE_SUBGRAPH_POOLS_URL_97");
    expect(row?.status).toBe("fail");
    expect(row?.category).toBe("subgraph");
  });
});

// ─── L2 companion: the shared-defaults advisory survives a retarget ─────────

describe("sharedDefaultsCheck reads chain 56's slot, not the flat alias", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { _meta: { block: { number: 1 }, hasIndexingErrors: false } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** Config as `loadConfig` builds it when DEXE_SUBGRAPH_CHAIN_ID names a chain
   *  with no unsuffixed URLs: flat aliases empty, chain 56 still on the baked
   *  (shared-key) endpoints. */
  const retargeted = (pools56: string): DexeConfig =>
    ({
      chains: new Map(),
      defaultChainId: 97,
      startupIssues: [],
      statePath: join(tmpdir(), "dexe-mcp-doctor-test", "state.json"),
      subgraphUrls: new Map([[56, { pools: pools56 }]]),
      subgraphChainId: 97,
      subgraphPoolsUrl: undefined,
      backendApiUrl: "https://backend.invalid",
      toolsets: ["core"],
    }) as unknown as DexeConfig;

  it("warns while chain 56 still runs on the baked endpoint", async () => {
    const results = await runAllChecks({
      timeoutMs: 200,
      config: retargeted(DEFAULTS.subgraphPoolsUrl),
    });
    const row = results.find(r => r.id === "env.sharedDefaults");
    expect(row?.status).toBe("warn");
    expect(row?.message).toContain("subgraph");
  });

  it("stays quiet about the subgraph once chain 56 has the operator's own endpoint", async () => {
    const results = await runAllChecks({
      timeoutMs: 200,
      config: retargeted("https://indexer.example/mainnet/pools"),
    });
    const row = results.find(r => r.id === "env.sharedDefaults");
    expect(row?.message ?? "").not.toContain("subgraph");
  });
});
