import { describe, it, expect } from "vitest";
import {
  PROPOSAL_STATE_NAMES,
  proposalOutcome,
  type ProposalOutcome,
  type ProposalStateName,
} from "../../src/lib/govEnums.js";

/**
 * D1-4 — a proposal that is still being voted on is not a failure.
 *
 * `dexe_proposal_forecast` divided "ExecutedFor + SucceededFor" by EVERY row in
 * the window, so the newest proposal (which is very often still `Voting`,
 * because the window ends at latestProposalId) dragged the rate down and could
 * fire a false `voterApathy` on a DAO where nothing had been decided yet.
 *
 * The classifier deliberately answers "did the FOR side win", not "was quorum
 * reached": `Defeated` has three producers in GovPoolView.sol — the genuine
 * quorum miss (:108-110), quorum reached but Against won with no actions
 * (:94-99), and a validators-tier defeat (:142-143) — so the state enum alone
 * cannot carry a quorum claim.
 */

const EXPECTED: Record<ProposalStateName, ProposalOutcome> = {
  // Still open — no settled For/Against result.
  Voting: "pending",
  // Post-quorum but unsettled: Locked resolves through
  // _proposalStateBasedOnVoteResults (GovPoolView.sol:206-223) and can still
  // land on SucceededAgainst; ValidatorVoting can still become Defeated.
  WaitingForVotingTransfer: "pending",
  ValidatorVoting: "pending",
  Locked: "pending",
  // Not a real proposal — never in the pass-rate denominator.
  Undefined: "pending",
  // Settled, For side won.
  SucceededFor: "passedFor",
  ExecutedFor: "passedFor",
  // Settled, For side did not win.
  Defeated: "notPassed",
  SucceededAgainst: "notPassed",
  ExecutedAgainst: "notPassed",
};

describe("proposalOutcome", () => {
  it.each(PROPOSAL_STATE_NAMES.map((n) => [n, EXPECTED[n]] as const))(
    "%s → %s",
    (state, expected) => {
      expect(proposalOutcome(state)).toBe(expected);
    },
  );

  it("classifies every protocol state — a future enum entry fails loudly", () => {
    // If IGovPool.ProposalState grows a member, PROPOSAL_STATE_NAMES grows with
    // it and this table stops covering it, rather than silently defaulting.
    expect(Object.keys(EXPECTED).sort()).toEqual([...PROPOSAL_STATE_NAMES].sort());
    for (const n of PROPOSAL_STATE_NAMES) {
      expect(["passedFor", "notPassed", "pending"]).toContain(proposalOutcome(n));
    }
  });

  it("an Against win is never counted as a pass", () => {
    // The field is called historicalPassRate; flipping Against-wins onto the
    // success side would silently change what 1.0 means.
    expect(proposalOutcome("ExecutedAgainst")).toBe("notPassed");
    expect(proposalOutcome("SucceededAgainst")).toBe("notPassed");
  });
});
