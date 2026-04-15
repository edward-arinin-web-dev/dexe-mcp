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
