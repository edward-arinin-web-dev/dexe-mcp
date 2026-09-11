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

describe("a DETERMINISTIC indexer fault is not a transient one", () => {
  /**
   * Forwarded from WP-F. The orphan-relation fault reaches this table as
   * `Subgraph errors: Null value resolved for non-null field \`voter\``, which
   * `subgraph-failed` claimed — and that remedy opens with "Re-run once
   * (429/5xx/timeouts are usually transient)". Retrying is the one thing that
   * cannot help: the indexer never populated the relation, GraphQL non-null
   * propagation annihilates the whole document, and every attempt returns the
   * identical error.
   */

  it.each([
    "Subgraph errors: Null value resolved for non-null field `voter`",
    "Subgraph errors: Null value resolved for non-null field `voter` (×31 occurrences)",
    "Subgraph errors: bad indexers: internal error resolving VoterInPool.delegatee: expected prefetched result, but found nothing",
  ])("classifies %s as subgraph-orphan-relation", (raw) => {
    expect(slugOf(raw)).toBe("subgraph-orphan-relation");
  });

  it("precedes subgraph-failed — otherwise the generic remedy claims it first", () => {
    const at = (slug: string) => KNOWN_FAILURES.findIndex((k) => k.slug === slug);
    expect(at("subgraph-orphan-relation")).toBeGreaterThanOrEqual(0);
    expect(at("subgraph-orphan-relation")).toBeLessThan(at("subgraph-failed"));
  });

  it("tells the caller NOT to retry, and names the tools that answer anyway", () => {
    const hit = KNOWN_FAILURES.find((k) => k.slug === "subgraph-orphan-relation")!;
    expect(hit.remedy).toMatch(/Do NOT retry/i);
    expect(hit.remedy).toContain("dexe_read_dao_members");
    expect(hit.remedy).toContain("dexe_proposal_list");
    // And the thing a wrong read of this fault costs: an empty answer read as
    // "the DAO has none".
    expect(hit.what).toMatch(/NOT 'the DAO has none'|NOT "the DAO has none"/);
  });

  it("an ordinary subgraph failure is still transient", () => {
    expect(slugOf("Subgraph HTTP 503 from https://gateway.thegraph.com/*** — gateway failing.")).toBe(
      "subgraph-failed",
    );
  });
});

describe("a rejected page cursor is the caller's argument, not an outage", () => {
  /**
   * Forwarded from WP-F. `backendGetJson` deliberately phrases the 400 without
   * the literal "backend HTTP 400" so it cannot fall through to
   * `backend-failed`, whose every clause ("wait and retry", "a 401 means the
   * Bearer token expired") is wrong for a deterministic refusal of an argument
   * the caller supplied.
   */

  it("classifies the 400 as backend-page-token-rejected", () => {
    expect(
      slugOf(
        "DeXe backend rejected the request: HTTP 400 (bad request) for /integrations/api-proxy-cache/56/token-holders-balances/0xabc",
      ),
    ).toBe("backend-page-token-rejected");
  });

  it("precedes backend-failed", () => {
    const at = (slug: string) => KNOWN_FAILURES.findIndex((k) => k.slug === slug);
    expect(at("backend-page-token-rejected")).toBeGreaterThanOrEqual(0);
    expect(at("backend-page-token-rejected")).toBeLessThan(at("backend-failed"));
  });

  it("says how to recover the listing instead of telling the caller to wait", () => {
    const hit = KNOWN_FAILURES.find((k) => k.slug === "backend-page-token-rejected")!;
    expect(hit.remedy).toMatch(/Do NOT retry with the same pageToken/i);
    expect(hit.remedy).toContain("nextPageToken");
    expect(hit.remedy).not.toMatch(/wait and retry/i);
  });

  it("a 5xx is still the generic backend failure", () => {
    expect(slugOf("backend HTTP 503 for /integrations/api-proxy-cache/56/nfts-by-wallet/0xabc")).toBe(
      "backend-failed",
    );
  });
});

describe("no remedy promises a blanket resume skip", () => {
  /**
   * D15-7. 0.33.0 made approve/deposit/create/vote genuinely idempotent and
   * left execute and the validator round as they were — but four remedies here
   * still told the agent that "completed steps are skipped", which is the
   * sentence that turns a timed-out execute into a double execute.
   */
  const BLANKET = [
    /completed steps are skipped/i,
    /earlier landed steps are skipped/i,
    /re-checks completed steps and skips them/i,
    /the flow ledger skips the steps that already landed/i,
  ];

  for (const k of KNOWN_FAILURES) {
    it(`${k.slug}`, () => {
      for (const re of BLANKET) {
        expect(re.test(k.remedy), `${k.slug} promises an unqualified skip (${re})`).toBe(false);
      }
    });
  }

  it.each(["nonce-conflict", "pinata-failed", "rpc-flaky", "onchain-revert"])(
    "%s enumerates the legs and routes a broadcast to dexe_tx_status or dexe_proposal_state",
    (slug) => {
      const hit = KNOWN_FAILURES.find((k) => k.slug === slug)!;
      expect(hit.remedy).toMatch(/createProposalAndVote/);
      expect(hit.remedy).toMatch(/dexe_tx_status|dexe_proposal_state/);
    },
  );

  it.each(["nonce-conflict", "rpc-flaky", "onchain-revert"])(
    "%s also names what is NOT auto-skipped",
    (slug) => {
      // pinata-failed is excluded on purpose: it fires before any transaction
      // exists, so naming the execute leg there would be noise, not guidance.
      const hit = KNOWN_FAILURES.find((k) => k.slug === slug)!;
      expect(hit.remedy).toMatch(/GovPool\.execute/);
      expect(hit.remedy).toMatch(/\bNOT\b|are not/);
    },
  );
});
