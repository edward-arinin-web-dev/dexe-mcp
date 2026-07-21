import { describe, expect, it } from "vitest";
import { computeQuorumFloorAdvisory, computeRewardEconomicsAdvisory } from "../../src/tools/daoDeploy.js";

// 10^25 = 1% on the protocol's 10^27 percentage scale.
const pct = (n: number) => (BigInt(n) * 10n ** 25n).toString();

describe("computeQuorumFloorAdvisory (F1)", () => {
  it("warns on a low DAO settings quorum", () => {
    const w = computeQuorumFloorAdvisory([{ quorum: pct(30) }], 50);
    expect(w).toContain("proposalSettings[0] quorum=30%");
    expect(w).toContain("safe floor");
  });

  it("is silent at/above the floor", () => {
    expect(computeQuorumFloorAdvisory([{ quorum: pct(50) }, { quorum: pct(51) }], 50)).toBe("");
  });

  it("F1: the signature no longer accepts validator params — only proposalSettings are swept", () => {
    // The validator chamber (quorum = % of hand-picked validator token supply)
    // is exempt by construction: callers pass expandedSettings only. A 30%
    // validator quorum therefore can no longer trip the treasury-floor text.
    const w = computeQuorumFloorAdvisory([{ quorum: pct(51) }], 50);
    expect(w).toBe("");
    expect(computeQuorumFloorAdvisory.length).toBe(2);
  });
});

describe("computeRewardEconomicsAdvisory (F10)", () => {
  const zero = { rewardsInfo: { creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" } };

  it("silent when every settings entry has zero rewards", () => {
    expect(computeRewardEconomicsAdvisory([zero, zero, {}])).toBe("");
  });

  it("flags a vote-rewards coefficient with the commission / mint / 5-ids facts", () => {
    const w = computeRewardEconomicsAdvisory([
      zero,
      { rewardsInfo: { creationReward: "0", executionReward: "0", voteRewardsCoefficient: (10n ** 25n).toString() } },
    ]);
    expect(w).toContain("settings[1]");
    expect(w).toContain("voteCoeff ×1");
    expect(w).toContain("30% commission");
    expect(w).toContain("MINTS");
    expect(w).toContain("pays 0");
    expect(w).toContain("ALL five");
    expect(w).toContain("[reward-economics advisory]");
  });

  it("flags flat creation/execution rewards too", () => {
    const w = computeRewardEconomicsAdvisory([
      { rewardsInfo: { creationReward: "1000000000000000000", executionReward: "0", voteRewardsCoefficient: "0" } },
    ]);
    expect(w).toContain("settings[0]");
    expect(w).not.toContain("voteCoeff");
  });
});
