import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllChecks as runReadChecks, type RunCheckOpts } from "@dexe-network/dexe-mcp/core";
import { writeDoctorChecks } from "../../src/diag/writeChecks.js";
import { DEFAULTS, type DexeConfig } from "../../src/config.js";

/**
 * The doctor as the single server runs it: the read checks plus the write
 * checks (signer, Pinata, WalletConnect) it hands in.
 */
const runAllChecks = (opts: RunCheckOpts = {}) => runReadChecks({ ...opts, extraChecks: writeDoctorChecks() });

/**
 * Coverage for the doctor check suite. Mocks `global.fetch` to control HTTP
 * outcomes (success, error, timeout) without touching the network — so the
 * suite runs deterministically in CI.
 *
 * The presence checks read directly from `process.env`; each test snapshots
 * and restores the keys it touches.
 */

const ENV_KEYS_TO_RESET = [
  "DEXE_PINATA_JWT",
  // Without this the gateway check fires a real getaddrinfo (and, since 0.34.0,
  // a real HEAD through the fetch mock) on any dev box that has it set.
  "DEXE_IPFS_GATEWAY",
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
  "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
  "DEXE_PRIVATE_KEY",
];

describe("runAllChecks", () => {
  const original: Record<string, string | undefined> = {};
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_RESET) original[k] = process.env[k];
    // Snapshot-and-clear, not snapshot-only, for the gateway: every other key
    // here is set by the test that needs it, but a developer's real
    // DEXE_IPFS_GATEWAY would otherwise make this suite hit the network.
    delete process.env.DEXE_IPFS_GATEWAY;
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const k of ENV_KEYS_TO_RESET) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("emits a presence pass for every set env, and a fail for invalid values", async () => {
    process.env.DEXE_PRIVATE_KEY = "0x" + "a".repeat(64); // valid
    const results = await runAllChecks({ timeoutMs: 100 });
    const pk = results.find(r => r.id === "env.DEXE_PRIVATE_KEY");
    expect(pk?.status).toBe("pass");
    expect(pk?.message).toMatch(/redacted/);
  });

  it("flags an invalid hex private key as fail", async () => {
    process.env.DEXE_PRIVATE_KEY = "0xnotreal";
    const results = await runAllChecks({ timeoutMs: 100 });
    const pk = results.find(r => r.id === "env.DEXE_PRIVATE_KEY");
    expect(pk?.status).toBe("fail");
  });

  it("signer allowlist: rejects invalid addresses", async () => {
    process.env.DEXE_SIGNER_ALLOWLIST = "0xabc,0x" + "b".repeat(40);
    const results = await runAllChecks({ timeoutMs: 100 });
    const al = results.find(r => r.id === "signer.allowlist");
    expect(al?.status).toBe("fail");
  });

  it("signer allowlist: passes with valid addresses", async () => {
    process.env.DEXE_SIGNER_ALLOWLIST = "0x" + "a".repeat(40) + ",0x" + "b".repeat(40);
    const results = await runAllChecks({ timeoutMs: 100 });
    const al = results.find(r => r.id === "signer.allowlist");
    expect(al?.status).toBe("pass");
    expect(al?.message).toContain("2 addr(s) allowed");
  });

  it("signer max wei: rejects non-integer", async () => {
    process.env.DEXE_SIGNER_MAX_VALUE_WEI = "not-a-number";
    const results = await runAllChecks({ timeoutMs: 100 });
    const mv = results.find(r => r.id === "signer.maxValue");
    expect(mv?.status).toBe("fail");
  });

  it("Pinata check: HTTP 401 → fail with regeneration hint", async () => {
    process.env.DEXE_PINATA_JWT = "fake-jwt";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const results = await runAllChecks({ timeoutMs: 100 });
    const p = results.find(r => r.id === "pinata.jwt");
    expect(p?.status).toBe("fail");
    expect(p?.remediation).toContain("pinata.cloud/developers/api-keys");
  });

  it("Pinata check: HTTP 200 → pass", async () => {
    process.env.DEXE_PINATA_JWT = "fake-jwt";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const results = await runAllChecks({ timeoutMs: 100 });
    const p = results.find(r => r.id === "pinata.jwt");
    expect(p?.status).toBe("pass");
  });

  it("network check timeout downgrades to warn (not fail)", async () => {
    process.env.DEXE_PINATA_JWT = "fake-jwt";
    // fetch hangs until the abort signal fires; mock by simulating AbortError.
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted") as Error & { name?: string };
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });
    const results = await runAllChecks({ timeoutMs: 50 });
    const p = results.find(r => r.id === "pinata.jwt");
    expect(p?.status).toBe("warn");
    expect(p?.message).toMatch(/timed out/);
  });

  it("Pinata check is skipped when jwt is unset", async () => {
    delete process.env.DEXE_PINATA_JWT;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const results = await runAllChecks({ timeoutMs: 100 });
    expect(results.find(r => r.id === "pinata.jwt")).toBeUndefined();
    // Pinata endpoint must not be hit. (Subgraph + backend checks DO fire now —
    // they validate the baked public defaults even with no env set.)
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("api.pinata.cloud"))).toBe(false);
  });
});

/**
 * 0.30.4 — doctor's total cost must stay bounded no matter how many endpoints
 * are configured. 0.30.2 made the subgraph probe run per chain per kind, so the
 * fan-out now scales with configuration; without an overall ceiling a caller
 * asking for fast probes could still wait on the slowest one indefinitely.
 * This surfaced as a CI-only 5s test timeout, which is the mild version of the
 * user-facing failure: a doctor that hangs cannot diagnose the hang.
 */
describe("runAllChecks stays inside an overall network budget", () => {
  it("abandons the network phase rather than waiting on a blackhole", async () => {
    const realFetch = globalThis.fetch;
    // Never resolves — the shape a blackholing endpoint presents.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
    try {
      const started = Date.now();
      const results = await runAllChecks({ timeoutMs: 50, networkBudgetMs: 200 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(3000);
      // The synchronous checks still ran and are still reported.
      expect(results.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * The read/write split. `runAllChecks` runs the read checks; the write ones
 * (signer, Pinata, WalletConnect — src/diag/writeChecks.ts) come in as
 * `extraChecks`. With them added the report must read exactly as before the
 * split; without them a read-only doctor must not touch signing or pinning.
 */
describe("read checks alone, and with the write checks added", () => {
  const KEYS = ["DEXE_PINATA_JWT", "DEXE_IPFS_GATEWAY", "DEXE_SIGNER_ALLOWLIST", "DEXE_PRIVATE_KEY"];
  const original: Record<string, string | undefined> = {};
  let realFetch: typeof globalThis.fetch;
  let calledUrls: string[];

  // Every shared public default in use, a public-RPC fallback, no signer loaded.
  const config = {
    startupIssues: [],
    chains: new Map(),
    defaultChainId: 56,
    subgraphUrls: new Map([[56, { pools: DEFAULTS.subgraphPoolsUrl }]]),
    walletConnectProjectId: DEFAULTS.walletConnectProjectId,
    backendApiUrl: DEFAULTS.backendApiUrl,
    usingPublicRpcFallback: true,
    statePath: join(tmpdir(), "dexe-mcp-doctor-split-test", "state.json"),
    privateKey: undefined,
    agentKeys: {},
  } as unknown as DexeConfig;

  beforeEach(() => {
    for (const k of KEYS) original[k] = process.env[k];
    delete process.env.DEXE_IPFS_GATEWAY;
    delete process.env.DEXE_PRIVATE_KEY;
    process.env.DEXE_PINATA_JWT = "fake-jwt";
    process.env.DEXE_SIGNER_ALLOWLIST = "0x" + "a".repeat(40);
    realFetch = globalThis.fetch;
    calledUrls = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calledUrls.push(String(input));
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("with the write checks: the shared-defaults row reads exactly as before the split", async () => {
    const row = (await runAllChecks({ config, timeoutMs: 100 })).find((r) => r.id === "env.sharedDefaults");
    expect(row?.message).toBe(
      "Using shared public defaults for: subgraph (shared Graph API key), WalletConnect project id, backend API. " +
        "Fine for light use; rate-limited and billable-shared.",
    );
    expect(row?.remediation).toBe(
      "For production / heavy use set your own: your DEXE_SUBGRAPH_*_URL (with your Graph key, or DEXE_GRAPH_API_KEY) " +
        "and DEXE_WALLETCONNECT_PROJECT_ID. Run /dexe-setup for a guided walkthrough. See docs/ENVIRONMENT.md.",
    );
  });

  it("with the write checks: each write row lands where the single server always listed it", async () => {
    const ids = (await runAllChecks({ config, timeoutMs: 100 })).map((r) => r.id);
    const at = (id: string) => {
      expect(ids, `missing ${id}`).toContain(id);
      return ids.indexOf(id);
    };
    // Network phase: the Pinata probe sits between the RPC probes and the rest.
    expect(at("pinata.jwt")).toBeLessThan(at("backend.reachable"));
    // Config rows: after subgraph coverage, before the chain / shared-default / state rows.
    expect(at("subgraph.coverage")).toBeLessThan(at("signer.allowlist"));
    expect(at("signer.allowlist")).toBeLessThan(at("chain.publicRpcFallback"));
    expect(at("chain.publicRpcFallback")).toBeLessThan(at("env.sharedDefaults"));
    expect(at("env.sharedDefaults")).toBeLessThan(at("state.path"));
  });

  it("read checks alone: no signer, Pinata or WalletConnect rows, and Pinata is never called", async () => {
    const results = await runReadChecks({ config, timeoutMs: 100 });
    const writeRows = results.filter(
      (r) => r.id.startsWith("signer.") || r.id.startsWith("pinata.") || r.id === "chain.signerNeedsRpc",
    );
    expect(writeRows).toEqual([]);
    expect(calledUrls.some((u) => u.includes("api.pinata.cloud"))).toBe(false);
    const row = results.find((r) => r.id === "env.sharedDefaults");
    expect(row?.message).toBe(
      "Using shared public defaults for: subgraph (shared Graph API key), backend API. " +
        "Fine for light use; rate-limited and billable-shared.",
    );
    expect(row?.remediation).not.toMatch(/WALLETCONNECT/);
  });
});
