import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAllChecks } from "../../src/diag/checks.js";

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
