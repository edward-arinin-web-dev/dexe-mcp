/**
 * D3-1 — the regression this file pins is "the advisory was computed and then
 * dropped".
 *
 * 0.33.0 had four copy-pasted return helpers. Two of them put the advisory in
 * `content[].text` only, so a client reading `structuredContent` saw a clean
 * build for calldata the server had already flagged — measured live on
 * `dexe_proposal_build_token_transfer`, whose structuredContent was
 * `{metadata, actions, nextStep}` while `buildTimeTreasuryAdvisory` had in fact
 * matched the transfer.
 *
 * Two properties, asserted per surface:
 *   1. when a warning fires it is in `structuredContent.warnings` AND its text
 *      is in `content[0].text` — one channel can never say less than the other;
 *   2. each file's 0.33.0 channel (`advisories` / `governanceAdvisories`)
 *      SURVIVES alongside it. Merged, never replaced.
 */
import { describe, it, expect } from "vitest";
import { BuildWarningSchema } from "../../src/lib/buildWarning.js";
import { callTool, warningsOf, textOf } from "./buildToolHarness.js";

const GOVPOOL = "0x0fe0474aE9499F4b5da85617e5482Db83714da6b";
const SETTINGS = "0x0C1Ce12e73610a07f4FdF58e14D81dccDD8B7E59";
const TOKEN = "0xe70645259756186F03610c9432d7dE3b3f4Aab69";
const ZERO = "0x0000000000000000000000000000000000000000";

const SETTINGS_BAD = {
  earlyCompletion: true,
  delegatedVotingAllowed: false,
  validatorsVote: false,
  duration: "86400",
  durationValidators: "86400",
  executionDelay: "86400",
  quorum: "1500000000000000000000000000",
  quorumValidators: "510000000000000000000000000",
  minVotesForVoting: "1000000000000000000",
  minVotesForCreating: "1000000000000000000",
  rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
  executorDescription: "keep",
};

/** Surfaces that must expose `warnings` in BOTH channels when something fires. */
const SURFACES: { tool: string; args: Record<string, unknown>; legacyKey?: string }[] = [
  {
    tool: "dexe_proposal_build_change_voting_settings",
    args: { govSettings: SETTINGS, chainId: 97, settings: [SETTINGS_BAD] },
    legacyKey: "governanceAdvisories",
  },
  {
    tool: "dexe_proposal_build_new_proposal_type",
    args: { govSettings: SETTINGS, chainId: 97, settings: SETTINGS_BAD, executors: [TOKEN], newSettingId: "5" },
    legacyKey: "governanceAdvisories",
  },
  {
    tool: "dexe_proposal_build_external",
    args: {
      govPool: GOVPOOL,
      chainId: 97,
      descriptionURL: "QmTest",
      actionsOnFor: [{ executor: SETTINGS, value: "0", data: "0x6a11e769" }],
    },
  },
  {
    tool: "dexe_proposal_build_custom_abi",
    args: {
      target: TOKEN,
      signature: "function blacklist(address[] accounts, bool value)",
      method: "blacklist",
      args: [[TOKEN], true],
    },
  },
];

describe("every build surface puts a warning in BOTH channels", () => {
  for (const s of SURFACES) {
    it(`${s.tool}: structuredContent.warnings + the same text in content[0]`, async () => {
      const res = await callTool(s.tool, s.args);
      expect(res.isError).toBeFalsy();
      const warnings = warningsOf(res);
      expect(warnings.length, `${s.tool} produced no warnings — fixture is stale`).toBeGreaterThan(0);
      for (const w of warnings) expect(() => BuildWarningSchema.parse(w)).not.toThrow();

      const text = textOf(res);
      for (const w of warnings) {
        // The message, not a paraphrase: the two channels cannot disagree.
        expect(text, `${s.tool} text is missing ${w.code}`).toContain(w.message.slice(0, 60));
      }
    });

    if (s.legacyKey) {
      it(`${s.tool}: the 0.33.0 \`${s.legacyKey}\` channel still ships`, async () => {
        const res = await callTool(s.tool, s.args);
        const legacy = res.structuredContent?.[s.legacyKey!] as string[] | undefined;
        expect(legacy, `${s.legacyKey} was dropped — that is a breaking output change`).toBeDefined();
        expect(Array.isArray(legacy)).toBe(true);
        expect(legacy!.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("voteBuild keeps its declared `advisories` channel alongside `warnings`", () => {
  it("dexe_vote_build_token_sale_vesting_withdraw still emits advisories[{id,...}]", async () => {
    const res = await callTool("dexe_vote_build_token_sale_vesting_withdraw", {
      tokenSaleProposal: TOKEN,
      tierIds: ["1"],
      chainId: 97,
    });
    const advisories = res.structuredContent?.advisories as { id: string; severity: string }[] | undefined;
    expect(advisories, "the 0.33.0 advisories field was dropped").toBeDefined();
    expect(advisories!.map((a) => a.id)).toContain("F15");
  });

  it("a plain builder with nothing to say emits neither key", async () => {
    const res = await callTool("dexe_vote_build_deposit", {
      govPool: GOVPOOL,
      amount: "1000000000000000000",
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.warnings).toBeUndefined();
    expect(res.structuredContent?.advisories).toBeUndefined();
    expect(res.structuredContent?.payload).toBeDefined();
  });
});

describe("the layer annotates — it never perturbs calldata", () => {
  it("change_voting_settings emits byte-identical actions on 97 and 56", async () => {
    const args = { govSettings: SETTINGS, settings: [SETTINGS_BAD] };
    const a = await callTool("dexe_proposal_build_change_voting_settings", { ...args, chainId: 97 });
    const b = await callTool("dexe_proposal_build_change_voting_settings", { ...args, chainId: 56 });
    expect(a.structuredContent?.actions).toEqual(b.structuredContent?.actions);
    // …and only one of them carries the chain-keyed warning.
    expect(warningsOf(a).map((w) => w.code)).toContain("upstream.add-settings-chain");
    expect(warningsOf(b).map((w) => w.code)).not.toContain("upstream.add-settings-chain");
  });
});
