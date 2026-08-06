import { describe, expect, it } from "vitest";
import { KNOWN_FAILURES, toActionableError } from "../../src/lib/errors.js";

/**
 * The actionable-error layer turns a caught throw into "what happened + what to
 * do next". Two things are worth pinning:
 *
 *  1. Classification — the real message strings the network layers throw must
 *     land on the right slug. These are copied from the throw sites
 *     (src/lib/subgraph.ts, src/lib/ipfs.ts, src/tools/read.ts, src/lib/txWait.ts),
 *     so a reworded throw that stops matching shows up here.
 *  2. Redaction — `toActionableError` runs through `safeErrorMessage`, so a
 *     keyed RPC URL in the raw text never reaches the caller (W36).
 *
 * Order matters in KNOWN_FAILURES (first match wins), which is why the
 * overlapping pairs below are asserted explicitly rather than by slug lookup.
 */

const slugOf = (raw: string) => toActionableError(new Error(raw)).slug;

describe("toActionableError classification", () => {
  it.each([
    // --- subgraph (src/lib/subgraph.ts) ---
    ["Subgraph HTTP 429 from https://gateway.thegraph.com/*** — rate-limited.", "subgraph-failed"],
    ["Subgraph HTTP 401 from https://gateway.thegraph.com/*** — rejected.", "subgraph-failed"],
    ["Subgraph HTTP 503 from https://gateway.thegraph.com/*** — gateway failing.", "subgraph-failed"],
    ["Subgraph errors: Type `daoPool` has no field `bogus`", "subgraph-failed"],
    ["Subgraph returned empty data", "subgraph-failed"],
    ["Subgraph request to https://gateway.thegraph.com/*** timed out after 8000ms", "subgraph-failed"],

    // --- DeXe backend (src/tools/read.ts) ---
    ["backend HTTP 502", "backend-failed"],
    ["backend HTTP 401 for /integrations/tracker/56/pools/gov/top", "backend-failed"],
    ["backend request timed out after 8000ms — usually transient, re-run the call", "backend-failed"],

    // --- Pinata (src/lib/ipfs.ts) ---
    ["Pinata auth failed: HTTP 401 {}", "pinata-failed"],
    ["Pinata pinJSON failed: HTTP 429 rate limited", "pinata-failed"],
    ["Pinata pinFile failed: HTTP 500 oops", "pinata-failed"],
    ["Pinata pinJSON timed out after 20000ms — IPFS upload timed out", "pinata-failed"],
    // Config problem, not a transient one — must beat `pinata-failed`.
    ["Pinata JWT is required", "pinata-missing"],
    ["DEXE_PINATA_JWT is required for IPFS uploads", "pinata-missing"],

    // --- timeouts (generic) ---
    ["RPC request timed out after 15000ms", "rpc-timeout"],
    ["connect ETIMEDOUT 104.18.0.1:443", "rpc-timeout"],
    ["AbortError: The operation was aborted", "rpc-timeout"],

    // --- pre-existing entries still classify ---
    ["insufficient funds for gas * price + value", "no-gas"],
    ["nonce too low", "nonce-conflict"],
    ["User rejected the request", "wallet-rejected"],
    ["execution reverted: Gov: low creating power", "onchain-revert"],
    ["SERVER_ERROR: bad response", "rpc-flaky"],
  ])("classifies %j as %s", (raw, slug) => {
    expect(slugOf(raw)).toBe(slug);
  });

  it("leaves the post-broadcast wait message unclassified", () => {
    // src/lib/txWait.ts already writes its own remediation, and it is the
    // opposite of the generic timeout advice: do NOT re-send, check first.
    // A generic "re-run it" remedy stapled underneath would invite a
    // double-execution, so this message must match nothing.
    const raw =
      "Transaction 0xabc was broadcast but not mined within 180s — it may still land. " +
      'Do NOT re-send blindly (risk of double-execution). Check it with dexe_tx_status {"txHash":"0xabc"}.';
    expect(slugOf(raw)).toBeUndefined();
  });

  it("prefixes the step and appends the remedy", () => {
    const a = toActionableError(new Error("Subgraph HTTP 500 from x"), "dexe_read_dao_list");
    expect(a.message).toContain("dexe_read_dao_list failed: ");
    expect(a.message).toContain("Next step:");
    // The "no data ≠ no rows" framing is the whole point of this entry.
    expect(a.message).toMatch(/NOT the same as/i);
  });

  it("keeps the redacted raw text even when nothing matches", () => {
    const a = toActionableError(new Error("something entirely new"), "step");
    expect(a.slug).toBeUndefined();
    expect(a.message).toBe("step failed: something entirely new");
  });
});

describe("toActionableError redaction", () => {
  it("strips the API key from a keyed RPC URL in the raw message", () => {
    // The exact shape ethers v6 appends on a non-2xx provider response.
    const err = new Error(
      'server response 429 Too Many Requests (request={ "url": "https://bsc-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY" }, code=SERVER_ERROR)',
    );
    const { message } = toActionableError(err, "dexe_read_treasury");
    expect(message).not.toContain("SUPER_SECRET_KEY");
    expect(message).toContain("https://bsc-mainnet.g.alchemy.com/***");
  });

  it("prefers ethers shortMessage over the URL-bearing message", () => {
    const err = Object.assign(new Error("verbose https://rpc.example.com/v2/KEY dump"), {
      shortMessage: "could not coalesce error",
    });
    expect(toActionableError(err).message).toBe("could not coalesce error");
  });
});

describe("KNOWN_FAILURES table", () => {
  it("has unique slugs", () => {
    const slugs = KNOWN_FAILURES.map((k) => k.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives every entry a non-empty what + remedy", () => {
    for (const k of KNOWN_FAILURES) {
      expect(k.what.length, k.slug).toBeGreaterThan(10);
      expect(k.remedy.length, k.slug).toBeGreaterThan(10);
    }
  });

  it("orders the specific network failures ahead of the generic rpc-flaky catch-all", () => {
    const at = (slug: string) => KNOWN_FAILURES.findIndex((k) => k.slug === slug);
    const flaky = at("rpc-flaky");
    for (const slug of ["pinata-missing", "pinata-failed", "subgraph-failed", "backend-failed", "rpc-timeout"]) {
      expect(at(slug), `${slug} must precede rpc-flaky`).toBeGreaterThanOrEqual(0);
      expect(at(slug), `${slug} must precede rpc-flaky`).toBeLessThan(flaky);
    }
  });
});
