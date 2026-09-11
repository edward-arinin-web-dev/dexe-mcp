import { describe, it, expect } from "vitest";
import { AGENT_PROTOCOL, GOTCHA_BY_ID } from "../../src/knowledge/index.js";
import { serverInstructions } from "../../src/instructions.js";
import { RESUME_SUMMARY } from "../../src/lib/resumeContract.js";
import { RESUME_RECHECKS } from "../../src/tools/flow.js";
import { KNOWN_FAILURES } from "../../src/lib/errors.js";
import { PinataClient } from "../../src/lib/ipfs.js";

/** The abort message, captured from the real deadline path rather than restated. */
const PINATA_TIMEOUT_MESSAGE = await (async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    })) as typeof globalThis.fetch;
  try {
    await new PinataClient("jwt-x", { pinJsonMs: 5 }).pinJson({ a: 1 });
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    globalThis.fetch = realFetch;
  }
})();

/**
 * D15-7 — the AMBIENT resume promise contradicted the shipped behaviour.
 *
 * 0.33.0 made approve/deposit/create/vote genuinely idempotent on re-run but
 * left `GovPool.execute` and the validator round as they were, and it left
 * `timeoutResume` telling the caller "DO NOT re-run this call yet". Meanwhile
 * the MCP handshake and `dexe_guide`'s AGENT_PROTOCOL — both read BEFORE any
 * failure — still promised a blanket "completed steps are skipped". An agent
 * holding both resolves the contradiction the cheap way: a second execute.
 *
 * These strings are ambient guidance, so the ban has to be literal. The
 * "contains the word execute" heuristic passes on the broken text (the
 * handshake already names `dexe_proposal_vote_and_execute` elsewhere).
 */
const BLANKET = [
  /completed steps are skipped/i,
  /earlier landed steps are skipped/i,
  /re-checks completed steps and skips them/i,
  /steps that already landed are skipped/i,
  /completed steps are detected on-chain and skipped/i,
];

const SURFACES: Array<[string, string]> = [
  ["the MCP handshake instructions", serverInstructions()],
  ["dexe_guide's AGENT_PROTOCOL", AGENT_PROTOCOL],
  ["RESUME_SUMMARY", RESUME_SUMMARY],
  ["the deposit-sequence gotcha", GOTCHA_BY_ID.get("deposit-sequence")!.text],
];

/**
 * The same promise reaches the agent from two more places that are NOT
 * standing instructions — the error→remedy table (rendered into
 * docs/PLAYBOOK.md by gen:knowledge) and the Pinata deadline message. Both are
 * read at the exact moment the agent decides whether to re-run.
 */
const REMEDY_SURFACES: Array<[string, string]> = [
  ...KNOWN_FAILURES.map((k) => [`the ${k.slug} remedy`, k.remedy] as [string, string]),
  ["the Pinata deadline message", PINATA_TIMEOUT_MESSAGE],
];

describe("no standing instruction promises a blanket resume skip", () => {
  for (const [label, text] of SURFACES) {
    it(label, () => {
      for (const re of BLANKET) {
        expect(
          re.test(text),
          `${label} promises an unqualified skip (${re}) — name what is NOT auto-skipped ` +
            `(GovPool.execute, the validator round) and route a timeout to dexe_tx_status`,
        ).toBe(false);
      }
    });
  }
});

describe("every resume surface routes a broadcast-then-failed step to dexe_tx_status", () => {
  for (const [label, text] of SURFACES) {
    it(label, () => {
      expect(text, `${label} never mentions dexe_tx_status`).toContain("dexe_tx_status");
    });
  }
});

describe("the one-line summary and the enumerated contract agree", () => {
  it("both name GovPool.execute as NOT auto-skipped", () => {
    for (const [label, text] of [
      ["RESUME_SUMMARY", RESUME_SUMMARY],
      ["RESUME_RECHECKS", RESUME_RECHECKS],
    ] as const) {
      expect(text, `${label} does not mention GovPool.execute`).toContain("GovPool.execute");
      expect(text, `${label} does not mention the validator round`).toMatch(/validator/i);
      expect(text, `${label} does not say those are NOT skipped`).toMatch(/\bNOT\b/);
    }
  });

  it("the four idempotent legs are enumerated, never generalized", () => {
    for (const leg of ["ERC20.approve", "GovPool.deposit", "createProposalAndVote", "GovPool.vote"]) {
      expect(RESUME_SUMMARY, `RESUME_SUMMARY omits ${leg}`).toContain(leg);
    }
  });
});

describe("no error remedy promises a blanket resume skip either", () => {
  for (const [label, text] of REMEDY_SURFACES) {
    it(label, () => {
      for (const re of BLANKET) {
        expect(
          re.test(text),
          `${label} promises an unqualified skip (${re}) — enumerate the legs instead`,
        ).toBe(false);
      }
    });
  }

  it("the Pinata deadline message was actually captured", () => {
    // Guards the harness itself: an empty string would pass every ban above.
    expect(PINATA_TIMEOUT_MESSAGE).toContain("no metadata was pinned");
  });
});
