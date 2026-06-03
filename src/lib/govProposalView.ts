/**
 * Canonical IGovPool.getProposals fragment + a fail-soft ProposalView decoder.
 *
 * Shared by the flow execute-gate (src/tools/flow.ts) and the risk-assess tool
 * (src/tools/risk.ts) so the deeply-nested struct is declared and decoded in
 * exactly one place. The nested `validatorProposal`
 * (IGovValidators.ExternalProposal) MUST stay byte-exact with the deployed
 * contract or ethers decoding throws — verified against DeXe-Protocol
 * interfaces/gov/IGovPool.sol + interfaces/gov/validators/IGovValidators.sol.
 */

export const GET_PROPOSALS_FRAGMENT =
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst) proposal, tuple(tuple(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter, uint128 quorum, uint256 votesFor, uint256 votesAgainst) core) validatorProposal, uint8 proposalState, uint256 requiredQuorum, uint256 requiredValidatorsQuorum)[])";

export interface DecodedProposalView {
  actionsOnFor: { executor: string; value: string; data: string }[];
  actionsOnAgainst: { executor: string; value: string; data: string }[];
  /** settings.quorum — a fraction of 1e27 (pct × 1e25). */
  quorumRaw: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  /** getProposals' requiredQuorum view field — absolute token-weight. */
  requiredQuorum: bigint;
  proposalState: number;
  descriptionURL: string;
}

/**
 * Decode one element of the getProposals return (a ProposalView tuple). Returns
 * null on any structural surprise — callers fail soft rather than throw.
 */
export function decodeProposalView(view: unknown): DecodedProposalView | null {
  try {
    const v = view as unknown[];
    const proposal = v[0] as unknown[];
    const core = proposal[0] as unknown[];
    const settings = core[0] as unknown[];
    const mapActions = (raw: unknown) =>
      (raw as Array<[string, bigint, string]>).map((a) => ({
        executor: a[0],
        value: (a[1] as bigint).toString(),
        data: a[2],
      }));
    return {
      actionsOnFor: mapActions(proposal[2]),
      actionsOnAgainst: mapActions(proposal[3]),
      quorumRaw: settings[6] as bigint,
      votesFor: core[4] as bigint,
      votesAgainst: core[5] as bigint,
      requiredQuorum: v[3] as bigint,
      proposalState: Number(v[2]),
      descriptionURL: proposal[1] as string,
    };
  } catch {
    return null;
  }
}
