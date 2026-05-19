import { Contract, type JsonRpcProvider } from "ethers";
import type { GovernorConfig } from "./loader.js";

/**
 * OZ Governor v4 + Bravo + v5 read surface. Subset adequate for W1 read tools.
 * Bravo and OZ v4 share these signatures; v5 keeps them as well.
 *
 * Note: getActions / proposalProposer aren't on every Governor version — gated
 * by governorVersion when added later.
 */
export const GOVERNOR_READ_ABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)",
  "function proposalThreshold() view returns (uint256)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
] as const;

export const IVOTES_ABI = [
  "function getVotes(address account) view returns (uint256)",
  "function getPastVotes(address account, uint256 blockNumber) view returns (uint256)",
  "function delegates(address account) view returns (address)",
] as const;

/**
 * OZ Governor canonical ProposalState enum order. Identical on Bravo. Index
 * matches `state()` return value.
 */
export const PROPOSAL_STATE: readonly string[] = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;

export function stateName(stateIndex: number): string {
  return PROPOSAL_STATE[stateIndex] ?? `Unknown(${stateIndex})`;
}

export function governorContract(provider: JsonRpcProvider, cfg: GovernorConfig): Contract {
  return new Contract(cfg.governorAddress, GOVERNOR_READ_ABI, provider);
}

export function votesContract(provider: JsonRpcProvider, cfg: GovernorConfig): Contract {
  return new Contract(cfg.votingToken.address, IVOTES_ABI, provider);
}
