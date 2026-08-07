import { describe, expect, it } from "vitest";
import { checkQuorumMargin, QUORUM_TURNOUT_CEILING } from "../../src/lib/quorumRisk.js";
import {
  resolveQuorumSplit,
  synthesizeParams,
  computeSafetyProof,
  votablePowerPct,
  SAFE_DEFAULT_TREASURY_PCT,
  SAFE_DEFAULT_QUORUM_PCT,
  type SimpleConfig,
} from "../../src/tools/daoCreate.js";

/**
 * 0.33.0 finding D — reachability was checked with ZERO margin.
 *
 * The shipped SIMPLE default (49% treasury / 51% quorum) leaves 51% of supply
 * able to vote and demands 51% of supply to vote: 100.0% turnout of every
 * votable token, forever. It passed `checkQuorumReachable` because that rule is
 * `votable >= quorum`, and it produced DAOs that can never pass anything — a
 * state nothing can repair, because repairing quorum requires passing a
 * proposal under that quorum.
 */

const DEPLOYER = "0xdEADBEeF00000000000000000000000000000001";
const base: SimpleConfig = {
  daoName: "Aurora Collective",
  symbol: "AUR",
  totalSupply: "1000000",
  treasuryPercent: SAFE_DEFAULT_TREASURY_PCT,
  quorumPercent: SAFE_DEFAULT_QUORUM_PCT,
  voteModel: "LINEAR",
  durationSeconds: 86400,
  executionDelaySeconds: 0,
  minVotesTokens: "1",
  earlyCompletion: true,
};

describe("checkQuorumMargin", () => {
  it("the old 49/51 default needs 100% turnout — refused", () => {
    const m = checkQuorumMargin({ quorumPct: 51, votablePct: 51 });
    expect(m.requiredTurnoutPct).toBe(100);
    expect(m.ok).toBe(false);
    expect(m.remediation).toContain("100%");
    // both numeric ways out are quoted
    expect(m.maxQuorumPct).toBe(40.8); // 51 × 0.8
    expect(m.minVotablePct).toBe(63.75); // 51 ÷ 0.8
  });

  it("passes when the quorum leaves real headroom", () => {
    const m = checkQuorumMargin({ quorumPct: 51, votablePct: 70 });
    expect(m.requiredTurnoutPct).toBe(72.86);
    expect(m.ok).toBe(true);
    expect(m.remediation).toBeUndefined();
  });

  it("is inclusive exactly at the ceiling (no off-by-a-float refusal)", () => {
    // 40% quorum of a 50% votable share == 80.00% turnout == the ceiling
    const m = checkQuorumMargin({ quorumPct: 40, votablePct: 50 });
    expect(m.requiredTurnoutPct).toBe(80);
    expect(m.ok).toBe(true);
    expect(QUORUM_TURNOUT_CEILING).toBe(0.8);
  });

  it("honours an explicit ceiling override", () => {
    expect(checkQuorumMargin({ quorumPct: 51, votablePct: 70, ceiling: 0.6 }).ok).toBe(false);
    expect(checkQuorumMargin({ quorumPct: 51, votablePct: 70, ceiling: 1 }).ok).toBe(true);
  });

  it("unknown is never safe: a 0 or NaN votable share fails with a fix", () => {
    const zero = checkQuorumMargin({ quorumPct: 51, votablePct: 0 });
    expect(zero.ok).toBe(false);
    expect(zero.requiredTurnoutPct).toBeNull();
    expect(zero.remediation).toContain("can never pass a proposal");
    expect(checkQuorumMargin({ quorumPct: NaN, votablePct: 70 }).ok).toBe(false);
  });
});

describe("resolveQuorumSplit — SIMPLE mode must synthesize something governable", () => {
  it("both omitted → the safe default split, and that split PASSES the margin", () => {
    const s = resolveQuorumSplit({});
    expect(s.treasuryPercent).toBe(SAFE_DEFAULT_TREASURY_PCT);
    expect(s.quorumPercent).toBe(SAFE_DEFAULT_QUORUM_PCT);
    expect(s.error).toBeUndefined();
    expect(s.adjustments.length).toBeGreaterThan(0);
    const m = checkQuorumMargin({ quorumPct: s.quorumPercent, votablePct: 100 - s.treasuryPercent });
    expect(m.ok).toBe(true);
    // and it still clears the ≥50% treasury-safety floor
    expect(s.quorumPercent).toBeGreaterThanOrEqual(50);
  });

  it("the old 49/51 default is no longer what SIMPLE mode picks", () => {
    const s = resolveQuorumSplit({});
    expect([s.treasuryPercent, s.quorumPercent]).not.toEqual([49, 51]);
  });

  it("quorum given, treasury omitted → treasury shrunk until the margin holds", () => {
    const s = resolveQuorumSplit({ quorumPercent: 70 });
    // 70% quorum needs ≥87.5% votable → treasury ≤ 12.5%
    expect(s.treasuryPercent).toBe(12.5);
    expect(s.error).toBeUndefined();
    expect(checkQuorumMargin({ quorumPct: 70, votablePct: 100 - s.treasuryPercent }).ok).toBe(true);
    expect(s.adjustments.join(" ")).toContain("treasuryPercent");
  });

  it("quorum above the ceiling is impossible at ANY treasury share → refused, not fudged", () => {
    const s = resolveQuorumSplit({ quorumPercent: 90 });
    expect(s.error).toContain("cannot leave a participation margin");
    expect(s.error).toContain("80");
  });

  it("treasury given, quorum omitted → quorum capped to what the distribution can clear", () => {
    const s = resolveQuorumSplit({ treasuryPercent: 20 });
    expect(s.quorumPercent).toBe(SAFE_DEFAULT_QUORUM_PCT); // 51 fits under 80% of 80
    const tight = resolveQuorumSplit({ treasuryPercent: 37 });
    expect(tight.quorumPercent).toBe(50.4); // 63 × 0.8
    expect(tight.error).toBeUndefined();
    expect(tight.quorumPercent).toBeGreaterThanOrEqual(50);
  });

  it("a treasury share that cannot host ANY safe quorum is refused with the number to use", () => {
    const s = resolveQuorumSplit({ treasuryPercent: 49 });
    expect(s.error).toBeTruthy();
    expect(s.error).toContain("≤37.5"); // 100 − 50/0.8
    expect(s.error).toContain("confirmRisky");
  });

  it("an explicit pair is never silently rewritten", () => {
    const s = resolveQuorumSplit({ treasuryPercent: 49, quorumPercent: 51 });
    expect(s).toEqual({ treasuryPercent: 49, quorumPercent: 51, adjustments: [] });
  });

  it("POLYNOMIAL: refuses to invent a split whose quorum the curve can never clear", () => {
    // Meritocratic power tops out near 56% of supply even at 100% votable, so
    // no split holds a ≥50% quorum with margin. Refusing beats deploying a DAO
    // that looks fine and passes nothing.
    const s = resolveQuorumSplit({ voteModel: "POLYNOMIAL" });
    expect(s.error).toContain("voteModel");
    expect(s.error).toContain("LINEAR");
    expect(s.error).toContain("confirmRisky");
  });

  it("POLYNOMIAL: an explicitly low quorum still gets a power-aware treasury share", () => {
    const s = resolveQuorumSplit({ quorumPercent: 40, voteModel: "POLYNOMIAL" });
    expect(s.error).toBeUndefined();
    // sized off vote POWER, so it is strictly tighter than the LINEAR answer
    const linear = resolveQuorumSplit({ quorumPercent: 40, voteModel: "LINEAR" });
    expect(s.treasuryPercent).toBeLessThan(linear.treasuryPercent);
    expect(votablePowerPct(100 - s.treasuryPercent, "POLYNOMIAL") * 0.8).toBeGreaterThanOrEqual(40);
  });

  it("respects a custom floor (DEXE_MIN_SAFE_QUORUM_PCT)", () => {
    // floor 60 needs ≥75% votable → treasury 49 is refused even harder
    expect(resolveQuorumSplit({ treasuryPercent: 49, floorPct: 60 }).error).toContain("≤25");
    expect(resolveQuorumSplit({ treasuryPercent: 10, floorPct: 60 }).quorumPercent).toBe(51);
  });
});

describe("computeSafetyProof carries the margin verdict", () => {
  it("49/51 is reachable but NOT margin-ok — the exact gap finding D describes", () => {
    const p = computeSafetyProof(synthesizeParams({ ...base, treasuryPercent: 49, quorumPercent: 51 }, DEPLOYER));
    expect(p.reachable).toBe(true);
    expect(p.feasible).toBe(true); // the hard rule still passes
    expect(p.marginOk).toBe(false); // the new one does not
    expect(p.requiredTurnoutPct).toBe(100);
    expect(p.marginMessage).toContain("cannot fix itself");
  });

  it("the new default split is reachable AND margin-ok AND above the floor", () => {
    const p = computeSafetyProof(synthesizeParams(base, DEPLOYER));
    expect(p.reachable).toBe(true);
    expect(p.marginOk).toBe(true);
    expect(p.floorOk).toBe(true);
    expect(p.requiredTurnoutPct).toBe(72.86);
    expect(p.marginMessage).toBeUndefined();
  });

  it("POLYNOMIAL reports the meritocratic POWER share, not the raw token share", () => {
    const p = computeSafetyProof(synthesizeParams({ ...base, voteModel: "POLYNOMIAL" }, DEPLOYER));
    // The curve REDUCES a large holder's power: 70% of supply in one wallet is
    // worth far less than 70% of the vote. Reporting the token share here would
    // promise a quorum the DAO cannot actually reach.
    expect(p.votablePct).toBe(70);
    expect(p.reachablePct).toBeLessThan(70);
    expect(p.reachable).toBe(false); // 51% quorum is unreachable under the curve
  });

  it("an external gov token is exempt: its holders are unknown at deploy time", () => {
    const p = synthesizeParams(base, DEPLOYER);
    const external = {
      ...p,
      tokenParams: { ...p.tokenParams, name: "", symbol: "", users: [], amounts: [], cap: "0", mintedTotal: "0" },
      userKeeperParams: { ...p.userKeeperParams, tokenAddress: "0x1111111111111111111111111111111111111111" },
    };
    const proof = computeSafetyProof(external);
    expect(proof.isTokenCreation).toBe(false);
    expect(proof.marginOk).toBe(true);
    expect(proof.marginMessage).toBeUndefined();
  });
});
