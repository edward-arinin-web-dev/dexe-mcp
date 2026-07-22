/**
 * Human-readable labels for the numeric enums the DeXe subgraphs return.
 *
 * Sources of truth:
 *  - interactions subgraph `Transaction.type` — mirrored by the frontend enum
 *    `TransactionGraphType` (investing-dashboard src/state/transactions/types.ts).
 *  - pools subgraph `DaoPoolProposalInteraction.interactionType` — mirrored by
 *    the frontend enum `ProposalInteractionType` (investing-dashboard
 *    src/consts/gov-pool.ts).
 *
 * Both enums are 1-based on the subgraph side.
 */
export const TRANSACTION_GRAPH_TYPE_NAMES: Record<string, string> = {
  "1": "UPDATED_USER_CREDENTIALS",
  "2": "USER_AGREED_TO_PRIVACY_POLICY",
  "3": "DAO_POOL_CREATED",
  "4": "DAO_POOL_PROPOSAL_CREATED",
  "5": "DAO_POOL_PROPOSAL_VOTED",
  "6": "DAO_POOL_PROPOSAL_VOTE_CANCELED",
  "7": "DAO_POOL_PROPOSAL_EXECUTED",
  "8": "DAO_POOL_DELEGATED",
  "9": "DAO_POOL_UNDELEGATED",
  "10": "DAO_POOL_DELEGATED_TREASURY",
  "11": "DAO_POOL_UNDELEGATED_TREASURY",
  "12": "DAO_POOL_REWARD_CLAIMED",
  "13": "DAO_POOL_VOTING_REWARD_CLAIMED",
  "14": "DAO_POOL_DEPOSITED",
  "15": "DAO_POOL_WITHDRAWN",
  "16": "DAO_POOL_MOVED_TO_VALIDATORS",
  "17": "DAO_POOL_OFFCHAIN_RESULTS_SAVED",
  "18": "DAO_VALIDATORS_VOTED",
  "19": "DAO_VALIDATORS_PROPOSAL_CREATED",
  "20": "DAO_VALIDATORS_PROPOSAL_EXECUTED",
};

export function transactionTypeLabels(types: readonly unknown[]): string[] {
  return types.map((t) => TRANSACTION_GRAPH_TYPE_NAMES[String(t)] ?? `UNKNOWN_${String(t)}`);
}

export const PROPOSAL_INTERACTION_TYPE_NAMES: Record<string, string> = {
  "1": "VOTE_FOR",
  "2": "VOTE_AGAINST",
  "3": "VOTE_CANCEL",
};

export function proposalInteractionLabel(t: unknown): string {
  return PROPOSAL_INTERACTION_TYPE_NAMES[String(t)] ?? `UNKNOWN_${String(t)}`;
}
