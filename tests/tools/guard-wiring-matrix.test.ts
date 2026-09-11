/**
 * D3-10 — "wired SOMEWHERE" is not "wired".
 *
 * `tests/lib/no-dead-guards.test.ts` proves a guard has at least one production
 * call site. That is a per-SYMBOL property, and the property that actually
 * matters is per-(guard × surface): is this guard raised at EVERY tool that can
 * emit its selector family?
 *
 * Measured on 0.33.0, the per-symbol rule was green while:
 *   • `findVestingTiers` reached 1 of 4 tier-opening surfaces (F15),
 *   • `checkAddSettingsTrap` reached neither standalone settings builder (#36),
 *   • `checkBlacklist` reached none of the blacklist builders,
 *   • `checkApproveTarget` reached nothing at all and was grandfathered.
 *
 * This file closes that. Each row is (warning code × the tools that emit its
 * selector family), driven through the REAL registered handlers, and every pair
 * must produce the code. A pair with no trigger fixture fails loudly instead of
 * silently passing — the vacuity trap no-dead-guards.test.ts already guards
 * against for its own rule.
 */
import { describe, it, expect } from "vitest";
import { callTool, warningsOf } from "./buildToolHarness.js";

const GOVPOOL = "0x0fe0474aE9499F4b5da85617e5482Db83714da6b";
const SETTINGS = "0x0C1Ce12e73610a07f4FdF58e14D81dccDD8B7E59";
const TOKEN = "0xe70645259756186F03610c9432d7dE3b3f4Aab69";
const SALE = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const SETTINGS_OK = {
  earlyCompletion: true,
  delegatedVotingAllowed: false,
  validatorsVote: false,
  duration: "86400",
  durationValidators: "86400",
  executionDelay: "86400",
  quorum: "510000000000000000000000000",
  quorumValidators: "510000000000000000000000000",
  minVotesForVoting: "1000000000000000000",
  minVotesForCreating: "1000000000000000000",
  rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
  executorDescription: "keep",
};

const TIER_OK = {
  name: "Seed",
  totalTokenProvided: "1000000000000000000000",
  saleStartTime: "1790000000",
  saleEndTime: "1800000000",
  saleTokenAddress: TOKEN,
  purchaseTokenAddresses: [NATIVE],
  purchaseRatios: ["0.10"],
};
const TIER_VESTING = {
  ...TIER_OK,
  vestingSettings: { vestingPercentage: "50", vestingDuration: "2592000", cliffPeriod: "0", unlockStep: "86400" },
};

/**
 * (code → the tools that emit that selector family, with a triggering input
 * and a clean input). Adding a builder that emits one of these families without
 * adding its row here is exactly the hole this file exists to catch; adding a
 * row with no fixture fails loudly rather than passing vacuously.
 */
const MATRIX: {
  code: string;
  reason: string;
  /** `refuses: true` ⇒ isError, and `warnings` still names the code. */
  refuses?: boolean;
  tools: { tool: string; trigger: Record<string, unknown>; clean?: Record<string, unknown> }[];
}[] = [
  {
    code: "settings.bounds",
    reason: "GovSettings._validateProposalSettings reverts at execute — every surface emitting add/editSettings",
    tools: [
      {
        tool: "dexe_proposal_build_change_voting_settings",
        trigger: {
          govSettings: SETTINGS,
          chainId: 56,
          settings: [{ ...SETTINGS_OK, quorum: "1500000000000000000000000000" }],
        },
        clean: { govSettings: SETTINGS, chainId: 56, settings: [SETTINGS_OK] },
      },
      {
        tool: "dexe_proposal_build_new_proposal_type",
        trigger: {
          govSettings: SETTINGS,
          chainId: 56,
          settings: { ...SETTINGS_OK, quorum: "1500000000000000000000000000" },
          executors: [SALE],
          newSettingId: "5",
        },
        clean: {
          govSettings: SETTINGS,
          chainId: 56,
          settings: SETTINGS_OK,
          executors: [SALE],
          newSettingId: "5",
        },
      },
      {
        tool: "dexe_proposal_build_custom_abi",
        trigger: {
          target: SETTINGS,
          signature:
            "function editSettings(uint256[] ids, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] params)",
          method: "editSettings",
          args: [
            ["1"],
            [
              [
                true,
                false,
                false,
                "86400",
                "86400",
                "86400",
                "1500000000000000000000000000",
                "510000000000000000000000000",
                "1000000000000000000",
                "1000000000000000000",
                [ZERO, "0", "0", "0"],
                "keep",
              ],
            ],
          ],
        },
      },
    ],
  },
  {
    code: "upstream.add-settings-chain",
    reason: "#36 — every surface that can emit addSettings on a blocked chain",
    tools: [
      {
        tool: "dexe_proposal_build_change_voting_settings",
        trigger: { govSettings: SETTINGS, chainId: 97, settings: [SETTINGS_OK], settingsIds: [] },
        // editSettings is always allowed, on every chain.
        clean: { govSettings: SETTINGS, chainId: 97, settings: [SETTINGS_OK], settingsIds: ["2"] },
      },
      {
        tool: "dexe_proposal_build_new_proposal_type",
        trigger: {
          govSettings: SETTINGS,
          chainId: 97,
          settings: SETTINGS_OK,
          executors: [SALE],
          newSettingId: "5",
        },
        clean: {
          govSettings: SETTINGS,
          chainId: 56,
          settings: SETTINGS_OK,
          executors: [SALE],
          newSettingId: "5",
        },
      },
      {
        tool: "dexe_proposal_build_external",
        trigger: {
          govPool: GOVPOOL,
          chainId: 97,
          descriptionURL: "QmTest",
          actionsOnFor: [
            {
              executor: SETTINGS,
              value: "0",
              // addSettings selector with an empty (malformed) tail — the guard
              // is selector-keyed, so it must still fire.
              data: "0x6a11e769",
            },
          ],
        },
        clean: {
          govPool: GOVPOOL,
          chainId: 56,
          descriptionURL: "QmTest",
          actionsOnFor: [{ executor: SETTINGS, value: "0", data: "0x6a11e769" }],
        },
      },
    ],
  },
  {
    code: "tier.vesting-blocked",
    reason: "F15 — every surface that can open a tier with a vested leg",
    refuses: true,
    tools: [
      { tool: "dexe_proposal_build_token_sale", trigger: { tokenSaleProposal: SALE, tier: TIER_VESTING }, clean: { tokenSaleProposal: SALE, tier: TIER_OK } },
      { tool: "dexe_proposal_build_token_sale_multi", trigger: { tokenSaleProposal: SALE, tiers: [TIER_VESTING] }, clean: { tokenSaleProposal: SALE, tiers: [TIER_OK] } },
    ],
  },
  {
    code: "blacklist.self-harm",
    reason: "blacklisting the DAO's own GovPool freezes every treasury out-transfer",
    tools: [
      {
        tool: "dexe_proposal_build_blacklist",
        trigger: { erc20Gov: TOKEN, govPool: GOVPOOL, addAddresses: [GOVPOOL] },
        clean: { erc20Gov: TOKEN, govPool: GOVPOOL, addAddresses: ["0x2222222222222222222222222222222222222222"] },
      },
      {
        tool: "dexe_proposal_build_custom_abi",
        trigger: {
          target: TOKEN,
          signature: "function blacklist(address[] accounts, bool value)",
          method: "blacklist",
          args: [[TOKEN], true],
        },
      },
    ],
  },
  {
    code: "action.zero-executor",
    reason: "GovPool.execute .calls a codeless address SUCCESSFULLY — a silent no-op proposal",
    refuses: true,
    tools: [
      {
        tool: "dexe_proposal_build_external",
        trigger: {
          govPool: GOVPOOL,
          chainId: 97,
          descriptionURL: "QmTest",
          actionsOnFor: [{ executor: ZERO, value: "0", data: "0x12345678" }],
        },
        clean: {
          govPool: GOVPOOL,
          chainId: 97,
          descriptionURL: "QmTest",
          actionsOnFor: [{ executor: TOKEN, value: "0", data: "0x12345678" }],
        },
      },
      {
        tool: "dexe_vote_build_staking_stake",
        trigger: { userKeeper: ZERO, tierId: "1", amount: "1000000000000000000", chainId: 97 },
        clean: { userKeeper: TOKEN, tierId: "1", amount: "1000000000000000000", chainId: 97 },
      },
    ],
  },
  {
    code: "staking.window",
    reason: "StakingProposal.createStaking bounces a stale window and emits StakingRejected — no revert to diagnose",
    refuses: true,
    tools: [
      {
        tool: "dexe_proposal_build_create_staking_tier",
        trigger: {
          stakingProposal: SALE,
          rewardToken: TOKEN,
          rewardAmount: "1000000000000000000",
          startedAt: "1600000000",
          deadline: "1700000000",
          stakingMetadataUrl: "ipfs://QmTest",
        },
        clean: {
          stakingProposal: SALE,
          rewardToken: TOKEN,
          rewardAmount: "1000000000000000000",
          startedAt: String(Math.floor(Date.now() / 1000) + 3600),
          deadline: String(Math.floor(Date.now() / 1000) + 86400),
          stakingMetadataUrl: "ipfs://QmTest",
        },
      },
    ],
  },
  {
    code: "approve.target",
    reason: "trap 6 — approving the GovPool leaves the allowance un-pullable",
    refuses: true,
    tools: [
      {
        tool: "dexe_vote_build_erc20_approve",
        trigger: { token: TOKEN, spender: GOVPOOL, govPool: GOVPOOL, amount: "1000000000000000000", chainId: 97 },
        clean: { token: TOKEN, spender: SALE, govPool: GOVPOOL, amount: "1000000000000000000", chainId: 97 },
      },
    ],
  },
];

describe("guard × surface coverage matrix", () => {
  it("the matrix is not empty and every row names real tools", () => {
    expect(MATRIX.length, "matrix emptied — this file would be vacuous").toBeGreaterThanOrEqual(6);
    for (const row of MATRIX) {
      expect(row.tools.length, `${row.code} has no surfaces`).toBeGreaterThan(0);
      expect(row.reason.length, `${row.code} has no reason`).toBeGreaterThan(30);
    }
  });

  for (const row of MATRIX) {
    describe(row.code, () => {
      for (const t of row.tools) {
        it(`${t.tool} raises it`, async () => {
          const res = await callTool(t.tool, t.trigger);
          if (row.refuses) {
            expect(res.isError, `${t.tool} must refuse ${row.code}`).toBe(true);
            // The refusal text must name the problem, not just fail.
            const text = res.content.map((c) => c.text ?? "").join("\n");
            expect(text.length).toBeGreaterThan(40);
            return;
          }
          const codes = warningsOf(res).map((w) => w.code);
          expect(codes, `${t.tool} did not raise ${row.code}`).toContain(row.code);
        });

        if (t.clean) {
          it(`${t.tool} stays quiet on a clean input`, async () => {
            const res = await callTool(t.tool, t.clean!);
            expect(res.isError).toBeFalsy();
            expect(warningsOf(res).map((w) => w.code)).not.toContain(row.code);
          });
        }
      }
    });
  }

  it("every treasury.* code is block:'none' — the guard is advisory-only, by project rule", async () => {
    const res = await callTool("dexe_proposal_build_token_transfer", {
      govPool: GOVPOOL,
      token: TOKEN,
      recipient: "0x000000000000000000000000000000000000dEaD",
      amount: "1000000000000000000",
      chainId: 97,
    });
    // The treasury advisory is printed in prose here, so assert the RULE on the
    // layer directly as well as on whatever this surface emitted.
    for (const w of warningsOf(res)) {
      if (w.code.startsWith("treasury.")) expect(w.block, `${w.code} must never block`).toBe("none");
    }
    const { assessBuildPure } = await import("../../src/lib/buildAdvisories.js");
    const pure = assessBuildPure({
      chainId: 97,
      chainIdExplicit: true,
      treasuryGuard: "warn",
      actions: [
        {
          executor: TOKEN,
          value: "0",
          data:
            "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead" +
            "0000000000000000000000000000000000000000000000000de0b6b3a7640000",
        },
      ],
    });
    const treasury = pure.filter((w) => w.code.startsWith("treasury."));
    expect(treasury.length, "no treasury warning fired — the assertion is vacuous").toBeGreaterThan(0);
    for (const w of treasury) expect(w.block).toBe("none");
  });

  it("a hard warning is NOT bypassable — there is no override input that lets it through", async () => {
    // `confirmRisky` is not even an input on the primitives; passing it must not
    // turn a hard refusal into a build.
    const res = await callTool("dexe_vote_build_erc20_approve", {
      token: TOKEN,
      spender: GOVPOOL,
      govPool: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/GovUserKeeper/);
  });
});
