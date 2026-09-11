import { describe, it, expect } from "vitest";
import { buildTierTuple, type TierSpec } from "../../src/tools/proposalBuildComplex.js";
import { PROPOSAL_BUILDERS } from "../../src/lib/proposalBuilders.js";
import { assertStakingWindow } from "../../src/lib/buildAdvisories.js";
import { callTool, textOf } from "../tools/buildToolHarness.js";

/**
 * Time-window guards (eval-run finding, 2026-07-23): a weak model guessed
 * Jan-2024 timestamps in 2026 — StakingProposal SILENTLY rejected the tier
 * (execute status 1, StakingRejected event, no tier), and TokenSaleProposal
 * created a dead-on-arrival sale (only start<=end is validated on-chain).
 * Both builders must refuse past end-times BEFORE any transaction.
 */

const NOW = Math.floor(Date.now() / 1000);
const STAKING = "0x88Fa477722c546B5Ec7d62E21574e576d264E642";
const TOKEN = "0xf5f4f1692a9A133bd6C8A71a1b28b2f1399e0459";

function tier(overrides: Partial<TierSpec>): TierSpec {
  return {
    name: "Public Sale",
    description: "",
    totalTokenProvided: "1000000000000000000000",
    saleStartTime: String(NOW + 3600),
    saleEndTime: String(NOW + 7 * 86400),
    claimLockDuration: "0",
    saleTokenAddress: TOKEN,
    purchaseTokenAddresses: ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"],
    purchaseRatios: ["0.10"],
    minAllocationPerUser: "0",
    maxAllocationPerUser: "0",
    vestingSettings: { vestingPercentage: "0", vestingDuration: "0", cliffPeriod: "0", unlockStep: "0" },
    participation: [],
    ...overrides,
  } as TierSpec;
}

describe("OTC tier time guards (buildTierTuple)", () => {
  it("accepts a future window", () => {
    expect(() => buildTierTuple(tier({}))).not.toThrow();
  });

  it("refuses saleEndTime in the past (dead-on-arrival tier)", () => {
    expect(() =>
      buildTierTuple(tier({ saleStartTime: "1704067200", saleEndTime: "1704672000" })),
    ).toThrow(/PAST|dead-on-arrival/i);
  });

  it("refuses saleStartTime after saleEndTime", () => {
    expect(() =>
      buildTierTuple(tier({ saleStartTime: String(NOW + 7200), saleEndTime: String(NOW + 3600) })),
    ).toThrow(/after saleEndTime/);
  });

  it("allows an already-open window (start in the past, end in the future)", () => {
    expect(() =>
      buildTierTuple(tier({ saleStartTime: String(NOW - 3600), saleEndTime: String(NOW + 86400) })),
    ).not.toThrow();
  });
});

describe("create_staking_tier time guards", () => {
  const builder = PROPOSAL_BUILDERS["create_staking_tier"]!;
  const deps = { govPool: "0xa56BE71aAe8Abe3D1DE8446F4E63D9a6392d57B8", chainId: 56 } as never;

  function args(overrides: Record<string, string>) {
    return {
      stakingProposal: STAKING, // explicit → no RPC resolve needed
      rewardToken: TOKEN,
      rewardAmount: "10000000000000000000000",
      startedAt: String(NOW + 3600),
      deadline: String(NOW + 30 * 86400),
      stakingMetadataUrl: "ipfs://QmTest",
      isNative: false,
      ...overrides,
    };
  }

  it("accepts a future deadline", async () => {
    await expect(builder.build(args({}), deps)).resolves.toBeTruthy();
  });

  it("refuses a deadline in the past (silent on-chain rejection)", async () => {
    await expect(
      builder.build(args({ startedAt: "1704067200", deadline: "1705276800" }), deps),
    ).rejects.toThrow(/SILENTLY reject|PAST/i);
  });

  it("refuses startedAt >= deadline", async () => {
    await expect(
      builder.build(args({ startedAt: String(NOW + 7200), deadline: String(NOW + 3600) }), deps),
    ).rejects.toThrow(/before deadline|Invalid settings/i);
  });
});

/**
 * 0.34.0 — the same guard, at the OTHER call site.
 *
 * The block above proves the CATALOG builder refuses a stale staking window.
 * The standalone `dexe_proposal_build_create_staking_tier` re-implements the
 * encode and went straight to `encodeFunctionData` with no time check at all,
 * so the exact params `dexe_proposal_create` rejects built clean there — the
 * per-symbol "is this guard wired" rule cannot see a split like that, which is
 * why the rule is now per-(guard × surface).
 */
describe("assertStakingWindow — one guard, shared by both call sites", () => {
  it("accepts a future window and refuses the two stale shapes", () => {
    expect(() => assertStakingWindow(String(NOW + 3600), String(NOW + 86400))).not.toThrow();
    expect(() => assertStakingWindow(String(NOW + 7200), String(NOW + 3600))).toThrow(
      /SP: Invalid settings/,
    );
    expect(() => assertStakingWindow("1704067200", "1705276800")).toThrow(/SILENTLY reject/);
  });

  it("refuses a non-numeric timestamp instead of throwing a raw BigInt SyntaxError", () => {
    expect(() => assertStakingWindow("tomorrow", String(NOW + 86400))).toThrow(
      /unix timestamps in SECONDS/,
    );
  });
});

describe("the STANDALONE create_staking_tier builder runs the same guard", () => {
  function toolArgs(startedAt: string, deadline: string) {
    return {
      stakingProposal: STAKING,
      rewardToken: TOKEN,
      rewardAmount: "10000000000000000000000",
      startedAt,
      deadline,
      stakingMetadataUrl: "ipfs://QmTest",
    };
  }

  it("refuses a past deadline — it did not, before 0.34.0", async () => {
    const res = await callTool(
      "dexe_proposal_build_create_staking_tier",
      toolArgs("1704067200", "1705276800"),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/SILENTLY reject/);
    expect(textOf(res)).toMatch(/no tier is created/);
  });

  it("refuses an inverted window", async () => {
    const res = await callTool(
      "dexe_proposal_build_create_staking_tier",
      toolArgs(String(NOW + 7200), String(NOW + 3600)),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/SP: Invalid settings/);
  });

  it("a valid future window still builds, byte-identically to the catalog builder", async () => {
    const builder2 = PROPOSAL_BUILDERS["create_staking_tier"]!;
    const built = await builder2.build(
      {
        stakingProposal: STAKING,
        rewardToken: TOKEN,
        rewardAmount: "10000000000000000000000",
        startedAt: String(NOW + 3600),
        deadline: String(NOW + 30 * 86400),
        stakingMetadataUrl: "ipfs://QmTest",
        isNative: false,
      },
      { govPool: "0xa56BE71aAe8Abe3D1DE8446F4E63D9a6392d57B8", chainId: 56 } as never,
    );
    const res = await callTool(
      "dexe_proposal_build_create_staking_tier",
      toolArgs(String(NOW + 3600), String(NOW + 30 * 86400)),
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.actions).toEqual(
      built.actionsOnFor.map((a) => ({ executor: a.executor, value: a.value ?? "0", data: a.data })),
    );
  });
});
