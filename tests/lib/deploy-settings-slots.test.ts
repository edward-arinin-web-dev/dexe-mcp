import { describe, expect, it } from "vitest";
import {
  checkAllProposalSettings,
  formatSettingsSlotIssues,
  settingsSlotName,
  PROPOSAL_SETTINGS_SLOTS,
  type ProposalSettingsSlotView,
} from "../../src/lib/deployGuard.js";

/**
 * 0.33.0 finding E — the deploy coherence guards inspected `proposalSettings[0]`
 * and nothing else.
 *
 * `deployGovPool` takes FIVE settings entries, one per executor family
 * (default / internal / validators / distributionProposal / tokenSale). An
 * ADVANCED caller supplying five can ship a DAO whose default proposals work
 * while its internal, validator, distribution or token-sale proposals are
 * permanently un-passable — quorum above the votable supply, min-votes above
 * every holder, duration 0. Nothing can repair that DAO: repairing it means
 * passing a proposal under the settings that cannot pass.
 */

const SUPPLY = (1_000_000n * 10n ** 18n).toString();
const VOTABLE = (700_000n * 10n ** 18n).toString(); // 70% distributed, 30% treasury
const pct = (n: number) => (BigInt(Math.round(n * 100)) * 10n ** 23n).toString(); // n% at 1e25/pct

const okSlot: ProposalSettingsSlotView = {
  quorum: pct(51),
  quorumValidators: pct(51),
  duration: "86400",
  durationValidators: "86400",
  minVotesForVoting: (10n ** 18n).toString(),
  minVotesForCreating: (10n ** 18n).toString(),
};

const five = (overrides: Record<number, Partial<ProposalSettingsSlotView>> = {}) =>
  PROPOSAL_SETTINGS_SLOTS.map((_, i) => ({ ...okSlot, ...(overrides[i] ?? {}) }));

const run = (proposalSettings: ProposalSettingsSlotView[]) =>
  checkAllProposalSettings({
    proposalSettings,
    amounts: [VOTABLE],
    mintedTotal: SUPPLY,
    voteType: "LINEAR_VOTES",
    isTokenCreation: true,
  });

describe("checkAllProposalSettings — every slot, not just [0]", () => {
  it("names the five executor families in on-chain order", () => {
    expect(PROPOSAL_SETTINGS_SLOTS).toEqual([
      "default",
      "internal",
      "validators",
      "distributionProposal",
      "tokenSale",
    ]);
    expect(settingsSlotName(3)).toBe("distributionProposal");
    expect(settingsSlotName(9)).toBe("extra");
  });

  it("a coherent 5-slot config passes and reports one fact per slot", () => {
    const v = run(five());
    expect(v.issues).toEqual([]);
    expect(v.slots).toHaveLength(5);
    expect(v.votablePct).toBe(70);
    expect(v.slots.every((s) => s.reachable && s.marginOk && s.floorOk)).toBe(true);
  });

  // The regression itself: slot 0 is pristine in every one of these.
  for (const index of [1, 2, 3, 4]) {
    it(`catches an UNREACHABLE quorum hidden in slot ${index} (${settingsSlotName(index)})`, () => {
      const v = run(five({ [index]: { quorum: pct(90) } }));
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0]!.index).toBe(index);
      expect(v.issues[0]!.slot).toBe(settingsSlotName(index));
      expect(v.issues[0]!.check).toBe("deploy.quorum-reachable");
      expect(v.slots[index]!.reachable).toBe(false);
      expect(v.slots[0]!.reachable).toBe(true); // slot 0 was fine all along
    });
  }

  it("catches min-votes above every holder in a non-zero slot", () => {
    const v = run(five({ 2: { minVotesForCreating: (900_000n * 10n ** 18n).toString() } }));
    expect(v.issues.map((i) => [i.index, i.check])).toEqual([[2, "deploy.min-votes"]]);
    expect(v.issues[0]!.remediation).toContain("largest single recipient");
  });

  it("catches a zero duration (GovSettings init revert) in a non-zero slot", () => {
    const v = run(five({ 4: { duration: "0" } }));
    expect(v.issues.map((i) => [i.index, i.check])).toEqual([[4, "deploy.settings-bounds"]]);
  });

  it("catches a quorum that is reachable but needs implausible turnout", () => {
    // 70% quorum against a 70% votable share == 100% turnout, forever.
    const v = run(five({ 1: { quorum: pct(70) } }));
    expect(v.issues.map((i) => [i.index, i.check])).toEqual([[1, "deploy.quorum-margin"]]);
    expect(v.issues[0]!.remediation).toContain("internal");
    expect(v.slots[1]!.reachable).toBe(true);
    expect(v.slots[1]!.marginOk).toBe(false);
  });

  it("reports ONE cause per slot: an unreachable quorum is not also a margin complaint", () => {
    const v = run(five({ 3: { quorum: pct(95) } }));
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]!.check).toBe("deploy.quorum-reachable");
  });

  it("collects issues from several slots at once", () => {
    const v = run(five({ 1: { quorum: pct(90) }, 3: { duration: "0" } }));
    expect(v.issues.map((i) => i.index)).toEqual([1, 3]);
    expect(formatSettingsSlotIssues(v.issues)).toContain("proposalSettings[3] (distributionProposal)");
  });

  it("below-floor quorums become ONE advisory naming every slot, never a block", () => {
    const v = run(five({ 1: { quorum: pct(20) }, 2: { quorum: pct(20) } }));
    expect(v.issues).toEqual([]); // advisory, not a refusal
    expect(v.advisories).toHaveLength(1);
    expect(v.advisories[0]).toContain("[1] internal");
    expect(v.advisories[0]).toContain("[2] validators");
    expect(v.slots[1]!.floorOk).toBe(false);
  });

  it("accepts the pre-expansion single slot (deployGovPool expands 1 → 5)", () => {
    const v = run([okSlot]);
    expect(v.issues).toEqual([]);
    expect(v.slots).toHaveLength(1);
  });

  it("POLYNOMIAL slots are judged on vote POWER, not token count", () => {
    const v = checkAllProposalSettings({
      proposalSettings: five(),
      amounts: [VOTABLE],
      mintedTotal: SUPPLY,
      voteType: "POLYNOMIAL_VOTES",
      isTokenCreation: true,
    });
    expect(v.votablePct).toBe(70);
    expect(v.votablePowerPct).toBeLessThan(70); // the meritocratic curve cuts it
    expect(v.issues.every((i) => i.check === "deploy.quorum-reachable")).toBe(true);
  });

  it("an external gov token skips distribution-dependent checks (holders unknown)", () => {
    const v = checkAllProposalSettings({
      proposalSettings: five({ 1: { quorum: pct(99) } }),
      amounts: [],
      mintedTotal: "0",
      voteType: "LINEAR_VOTES",
      isTokenCreation: false,
    });
    expect(v.issues).toEqual([]);
    expect(v.slots.every((s) => s.marginOk)).toBe(true);
  });

  it("never throws on garbage numerics — it reports them", () => {
    const v = run(five({ 2: { quorum: "not-a-number" } }));
    expect(v.issues.map((i) => [i.index, i.check])).toEqual([[2, "deploy.settings-unparseable"]]);
  });
});
