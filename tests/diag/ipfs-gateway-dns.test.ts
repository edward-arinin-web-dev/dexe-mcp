import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIMED_OUT,
  interpretGatewayProbe,
  ipfsGatewayDnsCheck,
  type FetchOutcome,
  type GatewayProbeDeps,
} from "../../src/diag/checks.js";
import { gatewayHostname } from "../../src/tools/ipfs.js";

/**
 * D8-3 — the gateway check used `dns.resolve()`, which bypasses the OS resolver
 * and speaks UDP/53 directly to `dns.getServers()[0]`. On any machine with a
 * local stub (Windows DoH client, VPN split-DNS, pi-hole/NextDNS/AdGuard) that
 * fails for EVERY host — including example.com — while `dns.lookup`
 * (getaddrinfo, what fetch actually uses) and a live HTTPS request both
 * succeed. The result was a deterministic red row on a machine where every
 * IPFS read worked, blaming the user's hostname.
 *
 * Everything here is offline: probes are injected.
 */

const GATEWAY = "https://gateway.pinata.cloud";
const HOST = "gateway.pinata.cloud";

function deps(over: Partial<GatewayProbeDeps> = {}): GatewayProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: over.lookup ?? (async (h) => { calls.push(`lookup:${h}`); return [{ address: "1.2.3.4", family: 4 }]; }),
    httpHead:
      over.httpHead ??
      (async (u) => { calls.push(`head:${u}`); return { kind: "ok", status: 200, body: undefined }; }),
  };
}

const rejectsWith = (code: string) => async (h: string) => {
  const e = Object.assign(new Error(`query${code} ${h}`), { code });
  throw e;
};

describe("ipfsGatewayDnsCheck", () => {
  const original = process.env.DEXE_IPFS_GATEWAY;
  const originalDisable = process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK;
  const originalFallback = process.env.DEXE_IPFS_GATEWAYS_FALLBACK;

  beforeEach(() => {
    process.env.DEXE_IPFS_GATEWAY = GATEWAY;
    delete process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK;
    delete process.env.DEXE_IPFS_GATEWAYS_FALLBACK;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DEXE_IPFS_GATEWAY;
    else process.env.DEXE_IPFS_GATEWAY = original;
    if (originalDisable === undefined) delete process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK;
    else process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK = originalDisable;
    if (originalFallback === undefined) delete process.env.DEXE_IPFS_GATEWAYS_FALLBACK;
    else process.env.DEXE_IPFS_GATEWAYS_FALLBACK = originalFallback;
    vi.restoreAllMocks();
  });

  it("getaddrinfo resolves → pass, and the HTTPS probe is never issued", async () => {
    const d = deps();
    const r = await ipfsGatewayDnsCheck(50, d);
    expect(r?.status).toBe("pass");
    expect(r?.message).toMatch(/resolved/);
    expect(d.calls.filter((c) => c.startsWith("head:"))).toEqual([]);
  });

  /** THE regression test for the machine in the evidence. */
  it("resolver refuses the query but the gateway answers over HTTPS → pass, blaming the resolver", async () => {
    const d = deps({
      lookup: rejectsWith("ECONNREFUSED"),
      httpHead: async () => ({ kind: "ok", status: 401, body: undefined }),
    });
    const r = await ipfsGatewayDnsCheck(50, d);
    expect(r?.status).toBe("pass");
    expect(r?.message).toMatch(/reachable over HTTPS/);
    expect(r?.message).toMatch(/resolver/);
    expect(r?.message).toContain("HTTP 401");
    // It must NOT send the user to rewrite a correct hostname...
    expect(r?.message).not.toMatch(/Check the hostname/);
    // ...and a green row must carry no remediation, or it lands in
    // remediationSummary as if something were broken.
    expect(r?.remediation).toBeUndefined();
  });

  it("resolver refuses AND the gateway does not answer → warn, never fail", async () => {
    const d = deps({
      lookup: rejectsWith("ECONNREFUSED"),
      httpHead: async () => ({ kind: "error", error: "connect ECONNREFUSED" }),
    });
    const r = await ipfsGatewayDnsCheck(50, d);
    expect(r?.status).toBe("warn");
    expect(r?.remediation).toMatch(/No action needed/);
  });

  it("a real typo (NXDOMAIN, no HTTPS answer) still fails, with the mypinata hint", async () => {
    const d = deps({
      lookup: rejectsWith("ENOTFOUND"),
      httpHead: async () => ({ kind: "error", error: "getaddrinfo ENOTFOUND" }),
    });
    const r = await ipfsGatewayDnsCheck(50, d);
    expect(r?.status).toBe("fail");
    expect(r?.remediation).toMatch(/mypinata\.cloud/);
    expect(r?.remediation).toMatch(/restart/i);
    // The public fallback gateways are on by default, so reads keep working.
    expect(r?.remediation).toMatch(/fallback gateways/);
  });

  /** docs/DOCTOR.md's contract: a probe that TIMES OUT downgrades to warn. */
  it("both stages time out → warn", () => {
    const r = interpretGatewayProbe(HOST, TIMED_OUT, TIMED_OUT);
    expect(r.status).toBe("warn");
  });

  it("an HTTP stage that times out is also resolver-side, not a failure", () => {
    const r = interpretGatewayProbe(HOST, { code: "ECONNREFUSED" }, { kind: "timeout" });
    expect(r.status).toBe("warn");
  });

  it.each(["EREFUSED", "ESERVFAIL", "ETIMEOUT", "ECONNRESET"])(
    "%s is treated as a resolver-side refusal",
    (code) => {
      const r = interpretGatewayProbe(HOST, { code }, { kind: "error", error: "x" });
      expect(r.status).toBe("warn");
    },
  );

  // O1: the READ path deliberately accepts a scheme-less host (src/tools/ipfs.ts
  // normalize()), so doctor must not hard-FAIL a setting that works.
  it("a scheme-less DEXE_IPFS_GATEWAY is valid, not 'not a valid URL'", async () => {
    process.env.DEXE_IPFS_GATEWAY = HOST;
    const d = deps();
    const r = await ipfsGatewayDnsCheck(50, d);
    expect(r?.status).toBe("pass");
    expect(d.calls).toContain(`lookup:${HOST}`);
  });

  // Pins doctor's hostname rule against the read path's, so the two can't drift.
  it.each([
    "https://gateway.pinata.cloud",
    "gateway.pinata.cloud",
    "http://my-gw.example/",
    "MY-GW.Example",
  ])("agrees with the read path's gatewayHostname for %s", async (raw) => {
    process.env.DEXE_IPFS_GATEWAY = raw;
    const seen: string[] = [];
    const r = await ipfsGatewayDnsCheck(50, {
      lookup: async (h) => { seen.push(h); return []; },
      httpHead: async () => ({ kind: "ok", status: 200, body: undefined }),
    });
    expect(r?.status).toBe("pass");
    expect(seen[0]).toBe(gatewayHostname(raw));
  });

  it("an unparseable value keeps the hard fail", async () => {
    process.env.DEXE_IPFS_GATEWAY = "ht tp://%%%";
    const r = await ipfsGatewayDnsCheck(50, deps());
    expect(r?.status).toBe("fail");
    expect(r?.message).toMatch(/not a valid URL/);
  });

  it("unset DEXE_IPFS_GATEWAY skips the check and probes nothing", async () => {
    delete process.env.DEXE_IPFS_GATEWAY;
    const d = deps();
    expect(await ipfsGatewayDnsCheck(50, d)).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe("the getaddrinfo-bypassing call cannot come back", () => {
  it("src/diag/checks.ts imports lookup, not resolve, from node:dns/promises", () => {
    // Scoped to this one file on purpose: a repo-wide grep would also match the
    // bundled plugin artifact until it is rebundled, turning a guard into a red
    // CI gate on an unrelated step.
    const src = readFileSync(resolve(import.meta.dirname, "..", "..", "src", "diag", "checks.ts"), "utf8");
    const importLine = /import\s*\{([^}]*)\}\s*from\s*"node:dns\/promises"/.exec(src);
    expect(importLine, "checks.ts must import from node:dns/promises").not.toBeNull();
    expect(importLine![1]).toContain("lookup");
    expect(importLine![1]).not.toMatch(/\bresolve\b/);
    expect(src).not.toMatch(/\bdnsResolve\s*\(/);
  });
});

/** Type-only sanity: FetchOutcome is the shape stage 2 speaks. */
const _outcome: FetchOutcome = { kind: "ok", status: 200, body: undefined };
void _outcome;
