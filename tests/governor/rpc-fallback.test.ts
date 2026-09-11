import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonRpcProvider } from "ethers";
import { rpcTimeoutMs } from "../../src/rpc.js";
import { resolveGovernor, type GovernorConfig } from "../../src/governor/loader.js";
import {
  EXTRA_PUBLIC_RPC,
  governorProvider,
  governorReadError,
  resetGovernorProviderCache,
  rpcNote,
  type TryProviderLike,
} from "../../src/governor/rpc.js";

/**
 * Offline coverage for the governor-chain public RPC fallback.
 *
 * The Tier-1 fixtures live on chains 1 and 10; `PUBLIC_RPC_FALLBACK` in
 * src/config.ts covers only BSC 56/97 and is gated on "no chain configured at
 * all", so `DEXE_TOOLSETS=core,governor` used to be a guaranteed first-call
 * failure whose remediation named only the BSC env vars.
 *
 * No network here: `JsonRpcProvider` is lazy, so constructing one and reading
 * its connection does not dial anything.
 */

const uniswap = resolveGovernor("uniswap"); // chain 1
const optimism = resolveGovernor("optimism"); // chain 10

function failing(): TryProviderLike {
  return {
    tryProvider: () => ({ error: "No RPC configured for chainId=1.", remediation: "Set DEXE_RPC_URL_..." }),
  };
}

function succeeding(provider: JsonRpcProvider): TryProviderLike {
  return { tryProvider: () => ({ ok: provider }) };
}

const ORIGINAL_DISABLE = process.env.DEXE_DISABLE_PUBLIC_RPC;

beforeEach(() => {
  resetGovernorProviderCache();
  delete process.env.DEXE_DISABLE_PUBLIC_RPC;
});

afterEach(() => {
  if (ORIGINAL_DISABLE === undefined) delete process.env.DEXE_DISABLE_PUBLIC_RPC;
  else process.env.DEXE_DISABLE_PUBLIC_RPC = ORIGINAL_DISABLE;
  resetGovernorProviderCache();
});

describe("governorProvider — configured RPC always wins", () => {
  it("returns the caller's own provider instance unchanged", () => {
    const mine = { tag: "mine" } as unknown as JsonRpcProvider;
    const r = governorProvider(succeeding(mine), uniswap);
    expect("error" in r).toBe(false);
    expect((r as { ok: JsonRpcProvider }).ok).toBe(mine);
    expect((r as { fallback: boolean }).fallback).toBe(false);
    expect(rpcNote(r)).toEqual({});
  });
});

describe("governorProvider — public fallback for chains 1 and 10", () => {
  it("falls back to the archive-capable endpoint for chain 1", () => {
    const r = governorProvider(failing(), uniswap);
    expect("error" in r).toBe(false);
    const ok = r as { ok: JsonRpcProvider; fallback: true; note: string };
    expect(ok.fallback).toBe(true);
    expect(ok.ok._getConnection().url).toBe(EXTRA_PUBLIC_RPC[1]![0]);
    expect(ok.note).toContain("chain 1");
    expect(ok.note).toContain("DEXE_RPC_URL_1");
    expect(rpcNote(r)).toEqual({ rpc: ok.note });
  });

  it("falls back for chain 10 too, on its own endpoint", () => {
    const r = governorProvider(failing(), optimism) as { ok: JsonRpcProvider; fallback: true };
    expect(r.fallback).toBe(true);
    expect(r.ok._getConnection().url).toBe(EXTRA_PUBLIC_RPC[10]![0]);
  });

  it("bounds the connection timeout — no bare JsonRpcProvider, no 5-minute hang", () => {
    // A `new JsonRpcProvider(url)` gets ethers' 300s FetchRequest default, which
    // is the frozen-tool-call bug 0.30.4 shipped to kill. Going through
    // ResilientRpcProvider is what keeps the budget bounded.
    const r = governorProvider(failing(), uniswap) as { ok: JsonRpcProvider };
    expect(r.ok._getConnection().timeout).toBe(rpcTimeoutMs());
  });

  it("caches one provider per chain instead of leaking timers per call", () => {
    const rpc = failing();
    const a = governorProvider(rpc, uniswap) as { ok: JsonRpcProvider };
    const b = governorProvider(rpc, uniswap) as { ok: JsonRpcProvider };
    expect(a.ok).toBe(b.ok);
  });

  it("declares every governor chain, and only archive-verified endpoints", () => {
    for (const cfg of [uniswap, optimism]) {
      expect(EXTRA_PUBLIC_RPC[cfg.chainId]?.length ?? 0).toBeGreaterThan(0);
    }
    const all = Object.values(EXTRA_PUBLIC_RPC).flat();
    // eth.llamarpc.com serves HTML, not JSON-RPC (verified 2026-09-11) and was
    // the endpoint docs/GOVERNOR.md used to recommend.
    expect(all.some((u) => u.includes("llamarpc"))).toBe(false);
    for (const u of all) expect(u.startsWith("https://")).toBe(true);
  });
});

describe("governorProvider — error form", () => {
  it("refuses (never silently dials) when the fallback is switched off", () => {
    process.env.DEXE_DISABLE_PUBLIC_RPC = "1";
    const r = governorProvider(failing(), uniswap) as { error: string };
    expect(r.error).toContain("chain 1");
    expect(r.error).toContain("DEXE_RPC_URL_1");
    expect(r.error).toContain("DEXE_DISABLE_PUBLIC_RPC=1");
    expect(r.error).toContain("docs/GOVERNOR.md");
    expect(r.error).toContain(uniswap.governorAddress);
  });

  it("returns the error form for a chain with no built-in endpoint", () => {
    const polygon: GovernorConfig = { ...uniswap, id: "synthetic", chainId: 137 };
    const r = governorProvider(failing(), polygon);
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("chain 137");
  });

  it("does not tell a chain-1 user to set the BSC variables", () => {
    process.env.DEXE_DISABLE_PUBLIC_RPC = "1";
    const { error } = governorProvider(failing(), uniswap) as { error: string };
    // It may NAME them to say they do not apply, but must not present them as
    // the remedy — the pre-fix message led with DEXE_RPC_URL_MAINNET.
    expect(error.indexOf("DEXE_RPC_URL_1")).toBeLessThan(error.indexOf("DEXE_RPC_URL_MAINNET"));
    expect(error).toContain("do not cover chain 1");
  });
});

describe("governorReadError — archive refusal becomes advice", () => {
  it("maps the public endpoints' archive refusal to a per-chain remedy", () => {
    const e = new Error('server response 403 {"code":-32602,"message":"Archive requests require a personal token"}');
    const out = governorReadError(e, uniswap, true);
    expect(out).toContain("archive node");
    expect(out).toContain("DEXE_RPC_URL_1");
    expect(out).toContain("dexe_gov_get_state");
  });

  it("says which endpoint refused", () => {
    const e = new Error("missing trie node — state at block 1 is pruned");
    expect(governorReadError(e, optimism, true)).toContain("the public fallback endpoint");
    expect(governorReadError(e, optimism, false)).toContain("the configured endpoint");
  });

  it("leaves an ordinary revert alone (no archive advice bolted on)", () => {
    const e = Object.assign(new Error("execution reverted: GovernorBravo::state: invalid proposal id"), {
      code: "CALL_EXCEPTION",
    });
    const out = governorReadError(e, uniswap, false);
    expect(out).toContain("invalid proposal id");
    expect(out).not.toContain("archive node");
  });

  it("redacts — an API key in the endpoint URL never reaches the caller", () => {
    // ethers appends the full request URL to err.message on any non-2xx.
    const e = new Error("server response 429 (url=https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123)");
    expect(governorReadError(e, uniswap, false)).not.toContain("SECRETKEY123");
  });
});

describe("governor tools all route through the fallback", () => {
  // Static guard, in the style of tests/governor/isolation.test.ts: a new tool
  // added on the old `rpc.tryProvider` path would silently reintroduce the
  // first-call failure on chains 1 and 10.
  it("no src/governor/tools/*.ts calls rpc.tryProvider directly", () => {
    const root = resolve(__dirname, "..", "..", "src", "governor", "tools");
    for (const f of ["read.ts", "extras.ts", "simulate.ts", "build.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, `${f} must use governorProvider(rpc, cfg)`).not.toContain("rpc.tryProvider(");
    }
  });
});
