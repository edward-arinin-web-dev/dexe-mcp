import { describe, it, expect } from "vitest";
import { computeAgentShares, defaultApprovals, agentTreasuryGuarantees } from "../../src/lib/agentTreasury.js";
import { checkQuorumMargin } from "../../src/lib/quorumRisk.js";

function shares(n: number, k: number, q = 50) {
  const r = computeAgentShares(n, k, q);
  if (!r.ok) throw new Error(r.reason);
  return r.shares;
}

describe("computeAgentShares", () => {
  it("regression anchor: 2-of-3 at 50% → 25.5% per agent, 23.5% treasury", () => {
    const s = shares(3, 2);
    expect(s.shareBps).toBe(2550);
    expect(s.sharePct).toBe(25.5);
    expect(s.treasuryPct).toBe(23.5);
    expect(s.raisedForTurnout).toBe(false);
  });

  it("2-of-2: the turnout rule forces the share up to 31.25%", () => {
    const s = shares(2, 2);
    expect(s.shareBps).toBe(3125);
    expect(s.raisedForTurnout).toBe(true);
    expect(s.treasuryPct).toBe(37.5);
  });

  it("3-of-5, 3-of-4 and 5-of-9 at 50%", () => {
    expect(shares(5, 3)).toMatchObject({ shareBps: 1717, treasuryBps: 1415 });
    expect(shares(4, 3)).toMatchObject({ shareBps: 1717, treasuryBps: 3132 });
    expect(shares(9, 5)).toMatchObject({ shareBps: 1050, treasuryBps: 550 });
  });

  it("every result holds all four rules", () => {
    for (let n = 2; n <= 9; n++) {
      for (let k = 2; k <= n; k++) {
        for (const q of [50, 51, 60, 67]) {
          const r = computeAgentShares(n, k, q);
          if (!r.ok) continue;
          const { shareBps: s } = r.shares;
          const qBps = q * 100;
          expect(k * s).toBeGreaterThanOrEqual(qBps + 50); // k FOR passes, with margin
          expect((k - 1) * s).toBeLessThan(qBps); // k−1 FOR does not
          expect(n * s).toBeLessThanOrEqual(10000);
          expect(checkQuorumMargin({ quorumPct: q, votablePct: (n * s) / 100 }).ok).toBe(true);
        }
      }
    }
  });

  it("refuses k < 2 and k > n", () => {
    const a = computeAgentShares(3, 1, 50);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toContain("at least 2");
    const b = computeAgentShares(3, 4, 50);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.reason).toContain("cannot exceed");
  });

  it("refuses agent counts outside 2..9", () => {
    expect(computeAgentShares(1, 2, 50).ok).toBe(false);
    expect(computeAgentShares(10, 6, 50).ok).toBe(false);
  });

  it("refuses an impossible split with the reason", () => {
    // 2-of-3 at 90%: 2 agents need ≥ 45.5% each, 3 × 45.5% > 100%.
    const a = computeAgentShares(3, 2, 90);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toContain("exceeds 100%");
    // 9-of-9 at 50%: the turnout rule needs ≥ 6.95% each, 8 agents must stay < 6.25% each.
    const b = computeAgentShares(9, 9, 50);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.reason).toContain("turnout-margin rule");
  });

  it("default approvals is a strict majority", () => {
    expect([2, 3, 4, 5, 9].map(defaultApprovals)).toEqual([2, 2, 3, 3, 5]);
  });

  it("guarantees name the turnout-formula caveat and the human veto", () => {
    const g = agentTreasuryGuarantees(shares(3, 2), 1);
    expect(g.kForPasses).toContain("51%");
    expect(g.kMinusOneForDoesNot).toContain("25.5%");
    expect(g.quorumFormula).toContain("AGAINST vote also counts toward quorum");
    expect(g.humanVeto).toContain("either quorum formula");
  });
});
