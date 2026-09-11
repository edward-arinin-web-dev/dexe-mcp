/**
 * Mirror of `IGovPool.ProposalState` (contracts/interfaces/gov/IGovPool.sol).
 * Order must match the Solidity enum exactly.
 */
export const PROPOSAL_STATE_NAMES = [
  "Voting",
  "WaitingForVotingTransfer",
  "ValidatorVoting",
  "Defeated",
  "SucceededFor",
  "SucceededAgainst",
  "Locked",
  "ExecutedFor",
  "ExecutedAgainst",
  "Undefined",
] as const;

export type ProposalStateName = (typeof PROPOSAL_STATE_NAMES)[number];

export function proposalStateLabel(n: bigint | number): ProposalStateName {
  const i = typeof n === "bigint" ? Number(n) : n;
  return PROPOSAL_STATE_NAMES[i] ?? "Undefined";
}

/**
 * Has this proposal's FOR side won yet?
 *
 *  - `passedFor` — settled in favour of the For actions.
 *  - `notPassed` — settled and the For side did not win (defeated outright, or
 *    the Against side carried it).
 *  - `pending`   — no settled For/Against outcome yet, so the proposal belongs
 *    in NO pass-rate denominator.
 *
 * The enum alone cannot answer "was quorum reached": `Defeated` has three
 * producers in GovPoolView.sol — the genuine quorum miss at :108-110, the
 * quorum-reached-but-Against-won-with-no-actions case at :94-99, and a
 * validators-tier defeat at :142-143 — so this classifier deliberately answers
 * the narrower question the pass-rate has always asked. Use a proposal's
 * `executeAfter > 0` (GovPoolVote.sol:249-261) when you need quorum itself.
 *
 * `WaitingForVotingTransfer`, `ValidatorVoting` and `Locked` are post-quorum but
 * NOT settled: Locked resolves through `_proposalStateBasedOnVoteResults`
 * (GovPoolView.sol:206-223) and can still land on SucceededAgainst, and
 * ValidatorVoting can still become Defeated (:142-143). They are pending, not
 * passed.
 */
export type ProposalOutcome = "passedFor" | "notPassed" | "pending";

const PASSED_FOR_STATES = new Set<ProposalStateName>(["SucceededFor", "ExecutedFor"]);

const NOT_PASSED_STATES = new Set<ProposalStateName>([
  "Defeated",
  "SucceededAgainst",
  "ExecutedAgainst",
]);

export function proposalOutcome(state: ProposalStateName): ProposalOutcome {
  if (PASSED_FOR_STATES.has(state)) return "passedFor";
  if (NOT_PASSED_STATES.has(state)) return "notPassed";
  return "pending";
}

/** Mirror of `IGovPool.VoteType`. */
export const VOTE_TYPE_NAMES = [
  "PersonalVote",
  "MicropoolVote",
  "DelegatedVote",
  "TreasuryVote",
] as const;

export type VoteTypeName = (typeof VOTE_TYPE_NAMES)[number];

export function voteTypeFromString(s: string): number {
  const i = VOTE_TYPE_NAMES.indexOf(s as VoteTypeName);
  if (i < 0) {
    throw new Error(
      `Unknown voteType "${s}". Valid: ${VOTE_TYPE_NAMES.join(", ")}`,
    );
  }
  return i;
}
