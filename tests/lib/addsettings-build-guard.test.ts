/**
 * HIGH-1 — `checkAddSettingsTrap` is on the production path.
 *
 * The guard shipped with a full DANGER advisory and zero production call sites:
 * `change_voting_settings` (no `settingsIds`) and `new_proposal_type` both
 * emitted selector 0x6a11e769 on chain 97 with `risk: undefined` and no mention
 * of #36, so a caller could pass a vote and only learn at execute that the
 * proposal was bricked — an unrecoverable, wasted governance cycle.
 *
 * These tests pin it to the ONE chokepoint every catalog builder funnels
 * through (`withUpstreamTrapGuard` around `PROPOSAL_BUILDERS`), and pin the two
 * properties that make the wiring trustworthy: it is chain-aware, and it is
 * selector-keyed (so a hand-rolled `custom_abi` action cannot slip past it).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ZeroAddress } from "ethers";
import { PROPOSAL_BUILDERS } from "../../src/lib/proposalBuilders.js";
import {
  ADD_SETTINGS_SELECTOR,
  isAddSettingsBlockedChain,
} from "../../src/lib/protocolAdvisories.js";
import { toSettingsTuple } from "../../src/tools/proposalBuildMore.js";

const GOVPOOL = "0x3333333333333333333333333333333333333333";
const SETTINGS = "0x8888888888888888888888888888888888888888";
const DIST = "0x6666666666666666666666666666666666666666";

/** No RPC → the on-chain prechecks degrade to no-ops; nothing here needs network. */
function depsFor(chainId: number) {
  return {
    ctx: { config: { rpcUrl: undefined, minSafeQuorumPct: 50 } } as never,
    govPool: GOVPOOL,
    chainId,
  };
}

const SETTINGS_INPUT = {
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
  rewardsInfo: {
    rewardToken: ZeroAddress,
    creationReward: "0",
    executionReward: "0",
    voteRewardsCoefficient: "0",
  },
  executorDescription: "keep",
};

/** The full addSettings signature — the same one the builders encode with. */
const ADD_SETTINGS_SIG =
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)";

function addSettingsAdvisories(advisories: string[] | undefined): string[] {
  return (advisories ?? []).filter((a) => a.includes("#36"));
}

async function buildChangeVotingSettings(chainId: number, settingsIds: string[] = []) {
  const b = PROPOSAL_BUILDERS.change_voting_settings!;
  return b.build(
    b.schema.parse({ govSettings: SETTINGS, settings: [SETTINGS_INPUT], settingsIds }),
    depsFor(chainId),
  );
}

async function buildNewProposalType(chainId: number) {
  const b = PROPOSAL_BUILDERS.new_proposal_type!;
  return b.build(
    b.schema.parse({
      govSettings: SETTINGS,
      settings: SETTINGS_INPUT,
      executors: [DIST],
      newSettingId: "5",
    }),
    depsFor(chainId),
  );
}

async function buildCustomAbiAddSettings(chainId: number) {
  const b = PROPOSAL_BUILDERS.custom_abi!;
  return b.build(
    b.schema.parse({
      target: SETTINGS,
      signature: ADD_SETTINGS_SIG,
      method: "addSettings",
      args: [[toSettingsTuple(SETTINGS_INPUT)]],
    }),
    depsFor(chainId),
  );
}

describe("#36 addSettings trap is pre-blocked at build time", () => {
  it("chain 97 is the blocked chain this suite is asserting against", () => {
    expect(isAddSettingsBlockedChain(97)).toBe(true);
    expect(isAddSettingsBlockedChain(56)).toBe(false);
  });

  it("change_voting_settings without settingsIds emits 0x6a11e769 and carries the #36 DANGER on 97", async () => {
    const out = await buildChangeVotingSettings(97);
    expect(out.actionsOnFor[0]!.data.slice(0, 10)).toBe(ADD_SETTINGS_SELECTOR);
    const hits = addSettingsAdvisories(out.advisories);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/DANGER/);
    expect(hits[0]).toMatch(/UPSTREAM PROTOCOL DEFECT/);
    expect(hits[0]).toMatch(/settingsIds/); // the remedy: editSettings instead
    expect(hits[0]).toMatch(/actionsOnFor\[0\]/); // says WHICH action carries it
    expect(out.risk).toBe("DANGER");
  });

  it("the same build on chain 56 carries no #36 advisory and is not DANGER", async () => {
    const out = await buildChangeVotingSettings(56);
    expect(out.actionsOnFor[0]!.data.slice(0, 10)).toBe(ADD_SETTINGS_SELECTOR);
    expect(addSettingsAdvisories(out.advisories)).toEqual([]);
    expect(out.risk).not.toBe("DANGER");
  });

  it("change_voting_settings WITH settingsIds (editSettings) is never flagged, even on 97", async () => {
    const out = await buildChangeVotingSettings(97, ["2"]);
    expect(out.actionsOnFor[0]!.data.slice(0, 10)).not.toBe(ADD_SETTINGS_SELECTOR);
    expect(addSettingsAdvisories(out.advisories)).toEqual([]);
    expect(out.risk).not.toBe("DANGER");
  });

  it("new_proposal_type carries the #36 DANGER on 97 but not on 56", async () => {
    const blocked = await buildNewProposalType(97);
    expect(blocked.actionsOnFor[0]!.data.slice(0, 10)).toBe(ADD_SETTINGS_SELECTOR);
    expect(addSettingsAdvisories(blocked.advisories)).toHaveLength(1);
    expect(blocked.risk).toBe("DANGER");

    const allowed = await buildNewProposalType(56);
    expect(addSettingsAdvisories(allowed.advisories)).toEqual([]);
    expect(allowed.risk).not.toBe("DANGER");
  });

  it("enable_staking (the new_proposal_type alias) is guarded too, and keeps object identity", async () => {
    expect(PROPOSAL_BUILDERS.enable_staking).toBe(PROPOSAL_BUILDERS.new_proposal_type);
    const b = PROPOSAL_BUILDERS.enable_staking!;
    const out = await b.build(
      b.schema.parse({
        govSettings: SETTINGS,
        settings: SETTINGS_INPUT,
        executors: [DIST],
        newSettingId: "5",
      }),
      depsFor(97),
    );
    expect(out.risk).toBe("DANGER");
    expect(addSettingsAdvisories(out.advisories)).toHaveLength(1);
  });

  it("a hand-rolled custom_abi action carrying the selector is caught (selector-keyed, not type-keyed)", async () => {
    const blocked = await buildCustomAbiAddSettings(97);
    expect(blocked.actionsOnFor[0]!.data.slice(0, 10)).toBe(ADD_SETTINGS_SELECTOR);
    expect(addSettingsAdvisories(blocked.advisories)).toHaveLength(1);
    expect(blocked.risk).toBe("DANGER");

    const allowed = await buildCustomAbiAddSettings(56);
    expect(addSettingsAdvisories(allowed.advisories)).toEqual([]);
    expect(allowed.risk).not.toBe("DANGER");
  });

  it("the guard annotates only — emitted calldata is byte-identical on 97 and 56", async () => {
    const pairs = await Promise.all([
      Promise.all([buildChangeVotingSettings(97), buildChangeVotingSettings(56)]),
      Promise.all([buildNewProposalType(97), buildNewProposalType(56)]),
      Promise.all([buildCustomAbiAddSettings(97), buildCustomAbiAddSettings(56)]),
    ]);
    for (const [blocked, allowed] of pairs) {
      expect(blocked.actionsOnFor).toEqual(allowed.actionsOnFor);
      expect(blocked.category).toBe(allowed.category);
      expect(blocked.metadataExtra).toEqual(allowed.metadataExtra);
    }
  });

  it("pre-existing governance advisories survive the escalation to DANGER", async () => {
    // executionDelay=0 is an independent CAUTION advisory from settingsAdvisories.
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    const out = await b.build(
      b.schema.parse({
        govSettings: SETTINGS,
        settings: [{ ...SETTINGS_INPUT, executionDelay: "0" }],
        settingsIds: [],
      }),
      depsFor(97),
    );
    expect(out.advisories!.some((a) => a.includes("executionDelay=0"))).toBe(true);
    expect(addSettingsAdvisories(out.advisories)).toHaveLength(1);
    // the worse of the two wins
    expect(out.risk).toBe("DANGER");
  });

  it("the guard is wired ONCE, on the registry — not repeated per builder", () => {
    // Drift pin. The failure this whole test file exists for was a guard with
    // zero call sites; the next-worst outcome is a guard re-added at N-1 of N
    // call sites. Both are caught here: the registry literal must be wrapped,
    // and `checkAddSettingsTrap` must appear exactly once in the module.
    const src = readFileSync(new URL("../../src/lib/proposalBuilders.ts", import.meta.url), "utf8");
    expect(src).toMatch(/PROPOSAL_BUILDERS[^=]*=\s*guardCatalog\(\{/);
    const calls = src.match(/checkAddSettingsTrap\(/g) ?? [];
    expect(calls, "one call site — the registry chokepoint").toHaveLength(1);
  });
});
