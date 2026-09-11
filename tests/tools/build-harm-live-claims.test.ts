/**
 * The four live reproductions, re-run against the NEW code.
 *
 * Each case below was probed on 2026-09-11 against Quillbrook Wardens
 * (govPool 0x0fe0474aE9499F4b5da85617e5482Db83714da6b, chain 97) through the
 * SHIPPED 0.33.1 server, and each came back with no warning at all. The inputs
 * here are byte-for-byte the ones that were probed; the assertions are what the
 * same call returns now. Same tool, same arguments, different answer — that is
 * the whole work package in one file.
 *
 * Offline by construction (no `chains` map ⇒ no provider), so these never touch
 * the network: every claim below is decided from the emitted calldata.
 */
import { describe, it, expect } from "vitest";
import { callTool, warningsOf, textOf } from "./buildToolHarness.js";

// Live addresses, exactly as probed.
const GOVPOOL = "0x0fe0474aE9499F4b5da85617e5482Db83714da6b";
const SETTINGS = "0x0C1Ce12e73610a07f4FdF58e14D81dccDD8B7E59";
const USER_KEEPER = "0xaecD56D70f0A686302c41FB6988359980e39090C";
const GOV_TOKEN = "0xe70645259756186F03610c9432d7dE3b3f4Aab69";
const SALE = "0x1111111111111111111111111111111111111111";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("live claim 1 — change_voting_settings, quorum 150% on chain 97", () => {
  const args = {
    govSettings: SETTINGS,
    settingsIds: [],
    settings: [
      {
        earlyCompletion: true,
        delegatedVotingAllowed: false,
        validatorsVote: false,
        duration: "86400",
        durationValidators: "86400",
        quorum: "1500000000000000000000000000",
        quorumValidators: "510000000000000000000000000",
        minVotesForVoting: "1000000000000000000",
        minVotesForCreating: "1000000000000000000",
        executionDelay: "3600",
        rewardsInfo: { rewardToken: ZERO },
        executorDescription: "over-range quorum",
      },
    ],
  };

  it("0.33.1 returned actions + NO advisory key; 0.34.0 returns both bound and #36 warnings", async () => {
    const res = await callTool("dexe_proposal_build_change_voting_settings", { ...args, chainId: 97 });
    expect(res.isError).toBeFalsy();
    const codes = warningsOf(res).map((w) => w.code);
    expect(codes).toContain("settings.bounds");
    expect(codes).toContain("upstream.add-settings-chain");

    // The calldata is the one the live probe returned, byte for byte.
    const actions = res.structuredContent?.actions as { data: string }[];
    expect(actions[0]!.data.slice(0, 10)).toBe("0x6a11e769");

    const text = textOf(res);
    expect(text).toContain("GovSettings: invalid quorum value");
    expect(text).toContain("#36");
  });

  it("names the chain it assumed when the caller does not supply one", async () => {
    const res = await callTool("dexe_proposal_build_change_voting_settings", args);
    const trap = warningsOf(res).find((w) => w.code === "upstream.add-settings-chain")!;
    expect(trap.message.startsWith("chainId was not supplied; assumed 97 — ")).toBe(true);
    expect(trap.block).toBe("none");
  });
});

describe("live claim 2 — token_sale with vestingPercentage 50", () => {
  const tier = {
    name: "Seed",
    totalTokenProvided: "1000000000000000000000",
    saleStartTime: "1790000000",
    saleEndTime: "1800000000",
    saleTokenAddress: GOV_TOKEN,
    purchaseTokenAddresses: [NATIVE],
    purchaseRatios: ["0.10"],
    vestingSettings: {
      vestingPercentage: "50",
      vestingDuration: "2592000",
      cliffPeriod: "0",
      unlockStep: "86400",
    },
  };

  it("0.33.1 built the stranding tier silently; 0.34.0 refuses it before encoding", async () => {
    const res = await callTool("dexe_proposal_build_token_sale", { tokenSaleProposal: SALE, tier });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("REFUSED before building any calldata");
    expect(text).toContain("F15");
    expect(text).toContain("acknowledgeVestingBlocked: true");
  });

  it("the documented override still opens it, with the risk recorded", async () => {
    const res = await callTool("dexe_proposal_build_token_sale", {
      tokenSaleProposal: SALE,
      tier,
      acknowledgeVestingBlocked: true,
    });
    expect(res.isError).toBeFalsy();
    // The vesting field the live probe carried: 50 × 1e25.
    const actions = res.structuredContent?.actions as { data: string }[];
    expect(actions.some((a) => a.data.includes("19d971e4fe8401e740000000"))).toBe(true);
    expect(warningsOf(res).map((w) => w.code)).toContain("tier.vesting-blocked");
  });

  it("a 0% tier builds clean on every surface", async () => {
    const clean = { ...tier, vestingSettings: { vestingPercentage: "0" } };
    for (const [tool, args] of [
      ["dexe_proposal_build_token_sale", { tokenSaleProposal: SALE, tier: clean }],
      ["dexe_proposal_build_token_sale_multi", { tokenSaleProposal: SALE, tiers: [clean] }],
    ] as const) {
      const res = await callTool(tool, args as Record<string, unknown>);
      expect(res.isError, tool).toBeFalsy();
      expect(warningsOf(res).map((w) => w.code)).not.toContain("tier.vesting-blocked");
    }
  });
});

describe("live claim 3 — erc20_approve with spender = the GovPool", () => {
  it("0.33.1 returned the approve payload with no warning; 0.34.0 refuses when govPool is given", async () => {
    const res = await callTool("dexe_vote_build_erc20_approve", {
      token: GOV_TOKEN,
      spender: GOVPOOL,
      govPool: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/GovUserKeeper/);
  });

  it("the raw encode is still available — omit govPool", async () => {
    const res = await callTool("dexe_vote_build_erc20_approve", {
      token: GOV_TOKEN,
      spender: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent?.payload as { data: string };
    expect(payload.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("a TokenSaleProposal spender is NOT refused, even with govPool supplied", async () => {
    // The regression guard for checkApproveTarget's third branch: this is the
    // project's general ERC20 approve encoder, and the OTC buy path, the
    // DistributionProposal and the StakingProposal all approve a non-keeper.
    const res = await callTool("dexe_vote_build_erc20_approve", {
      token: GOV_TOKEN,
      spender: SALE,
      govPool: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(warningsOf(res).map((w) => w.code)).not.toContain("approve.target");
  });

  it("approving the UserKeeper — the correct call — is untouched", async () => {
    const res = await callTool("dexe_vote_build_erc20_approve", {
      token: GOV_TOKEN,
      spender: USER_KEEPER,
      govPool: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.warnings).toBeUndefined();
  });
});

describe("live claim 4 — blacklist the DAO's own UserKeeper and GovPool", () => {
  it("0.33.1 returned the calldata with ZERO warnings; 0.34.0 flags the self-harm", async () => {
    const res = await callTool("dexe_proposal_build_blacklist", {
      erc20Gov: GOV_TOKEN,
      govPool: GOVPOOL,
      addAddresses: [USER_KEEPER, GOVPOOL],
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    const w = warningsOf(res).find((x) => x.code === "blacklist.self-harm")!;
    expect(w).toBeDefined();
    expect(w.message).toContain("GovPool");
    expect(w.message).toContain("ERC20Gov._beforeTokenTransfer");
    // The calldata the live probe returned, unchanged.
    const actions = res.structuredContent?.actions as { data: string }[];
    expect(actions[0]!.data.slice(0, 10)).toBe("0xc997eb8d");
  });

  it("un-blacklisting the same addresses is never flagged — that is the cure", async () => {
    const res = await callTool("dexe_proposal_build_blacklist", {
      erc20Gov: GOV_TOKEN,
      govPool: GOVPOOL,
      removeAddresses: [USER_KEEPER, GOVPOOL],
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(warningsOf(res).map((w) => w.code)).not.toContain("blacklist.self-harm");
  });
});
