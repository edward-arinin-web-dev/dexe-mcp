import { describe, it, expect } from "vitest";
import {
  classifyProposalCreateResult,
  resumeCapture,
} from "../../scripts/swarm/proposalCreateResult.js";

// Imports the pure module only — scripts/swarm/orchestrator.ts self-executes.

describe("classifyProposalCreateResult", () => {
  const table: Array<[string, unknown, string]> = [
    ["payloads → broadcast", { mode: "payloads", steps: [{ label: "a", skipped: false }] }, "broadcast"],
    ["executed → passthrough", { mode: "executed", steps: [] }, "passthrough"],
    // S59-proposal-create-token-transfer-dry asserts created.mode == 'dryRun'
    ["dryRun → passthrough", { mode: "dryRun", steps: [], proposalMetadataCID: "bafy" }, "passthrough"],
    ["already-created → resume", { mode: "already-created", proposalId: "7" }, "resume"],
    ["blocked-risky → defer", { mode: "blocked-risky", risk: "DANGER" }, "defer"],
    ["an unknown future mode → defer, not throw", { mode: "blocked-something-new" }, "defer"],
  ];

  for (const [name, body, kind] of table) {
    it(name, () => {
      expect(classifyProposalCreateResult(body).kind).toBe(kind);
    });
  }

  it("keeps the steps array by reference on the broadcast path", () => {
    const steps = [{ label: "GovPool.createProposalAndVote", skipped: false }];
    const v = classifyProposalCreateResult({ mode: "payloads", steps });
    if (v.kind !== "broadcast") throw new Error("expected broadcast");
    expect(v.steps).toBe(steps);
  });

  it("a refusal never classifies as broadcast — so nothing can be signed", () => {
    for (const body of [
      { mode: "blocked-risky", governanceAdvisories: ["⚠ DANGER — UPSTREAM PROTOCOL DEFECT #36"] },
      { mode: "already-created", proposalId: "3" },
      { mode: "dryRun", steps: [{ label: "x", skipped: false, payload: { to: "0x", data: "0x", value: "0", chainId: 97 } }] },
    ]) {
      expect(classifyProposalCreateResult(body).kind).not.toBe("broadcast");
    }
  });

  it("puts the advisory text into the defer reason so the report says why", () => {
    const v = classifyProposalCreateResult({
      mode: "blocked-risky",
      risk: "DANGER",
      governanceAdvisories: ["⚠ DANGER — UPSTREAM PROTOCOL DEFECT #36 … 0x6a11e769 …"],
    });
    if (v.kind !== "defer") throw new Error("expected defer");
    expect(v.reason).toContain("blocked-risky");
    expect(v.reason).toContain("#36");
  });

  it("throws only when there is no mode at all, naming the server-version hint", () => {
    for (const bad of [{}, null, undefined, "not json", [1, 2]]) {
      expect(() => classifyProposalCreateResult(bad)).toThrow(
        /returned no mode — server older than 0\.30/,
      );
    }
  });
});

describe("resumeCapture", () => {
  it("adds proposalIdNum so downstream {{cap.proposalIdNum}} still resolves", () => {
    const cap = resumeCapture({ mode: "already-created", proposalId: "7", proposalState: "Voting" });
    expect(cap.proposalId).toBe("7");
    expect(cap.proposalIdNum).toBe(7);
    expect(cap.txHashes).toEqual([]);
    expect(cap.proposalState).toBe("Voting");
  });

  it("omits proposalIdNum rather than emitting NaN when the id is unusable", () => {
    const cap = resumeCapture({ mode: "already-created" });
    expect(cap.proposalId).toBe("");
    expect("proposalIdNum" in cap).toBe(false);
  });
});
