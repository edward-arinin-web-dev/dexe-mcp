import { Contract, type JsonRpcProvider } from "ethers";
import type { GovernorConfig } from "./loader.js";

/**
 * Read surfaces for the two Governor families we target.
 *
 * - **OZ v4 / v5** (Optimism, post-2022 OZ Governor deploys): `state`,
 *   `proposalSnapshot`, `proposalDeadline`, `proposalVotes`, `quorum(uint256)`,
 *   `proposalThreshold`, etc.
 * - **Bravo v3** (Uniswap, Compound): `state`, `proposals(uint256)` returning a
 *   flat struct, `quorumVotes()` (fixed quorum, no per-block snapshot),
 *   `proposalThreshold`. No `proposalSnapshot` / `proposalDeadline` /
 *   `quorum(blockNumber)`.
 *
 * The canonical `ProposalState` enum order is identical across both families.
 */

export const GOVERNOR_OZ_READ_ABI = [
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

export const GOVERNOR_BRAVO_READ_ABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposals(uint256 proposalId) view returns (uint256 id, address proposer, uint256 eta, uint256 startBlock, uint256 endBlock, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bool canceled, bool executed)",
  "function proposalThreshold() view returns (uint256)",
  "function quorumVotes() view returns (uint256)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function name() view returns (string)",
] as const;

export const IVOTES_ABI = [
  "function getVotes(address account) view returns (uint256)",
  "function getPastVotes(address account, uint256 blockNumber) view returns (uint256)",
  "function delegates(address account) view returns (address)",
] as const;

/**
 * IERC20 + ERC20Votes hybrid. Bravo voting tokens (COMP, UNI) implement the
 * Compound-style getter `getPriorVotes(address, uint256)`. We surface it as a
 * fallback when `getPastVotes` reverts on a Bravo-era token.
 */
export const IVOTES_COMP_ABI = [
  "function getCurrentVotes(address account) view returns (uint96)",
  "function getPriorVotes(address account, uint256 blockNumber) view returns (uint96)",
  "function delegates(address account) view returns (address)",
] as const;

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

export function isBravo(cfg: GovernorConfig): boolean {
  return cfg.governorVersion === "bravo-v3";
}

export function governorContract(provider: JsonRpcProvider, cfg: GovernorConfig): Contract {
  const abi = isBravo(cfg) ? GOVERNOR_BRAVO_READ_ABI : GOVERNOR_OZ_READ_ABI;
  return new Contract(cfg.governorAddress, abi as unknown as string[], provider);
}

export function votesContract(provider: JsonRpcProvider, cfg: GovernorConfig): Contract {
  return new Contract(cfg.votingToken.address, IVOTES_ABI as unknown as string[], provider);
}

export interface ProposalReadout {
  state: { index: number; name: string };
  snapshotBlock: string;
  deadlineBlock: string;
  votes: { against: string; for: string; abstain: string };
  bravoExtra?: {
    proposer: string;
    eta: string;
    canceled: boolean;
    executed: boolean;
  };
}

/**
 * Family-agnostic proposal read. Maps Bravo's `proposals(uint256)` struct onto
 * the OZ-style {snapshot, deadline, votes} shape so callers don't branch.
 */
export async function readProposal(
  c: Contract,
  cfg: GovernorConfig,
  proposalId: bigint,
): Promise<ProposalReadout> {
  const stateIdx = Number(await c.getFunction("state").staticCall(proposalId));
  if (isBravo(cfg)) {
    const p: any = await c.getFunction("proposals").staticCall(proposalId);
    return {
      state: { index: stateIdx, name: stateName(stateIdx) },
      snapshotBlock: p.startBlock.toString(),
      deadlineBlock: p.endBlock.toString(),
      votes: {
        against: p.againstVotes.toString(),
        for: p.forVotes.toString(),
        abstain: p.abstainVotes.toString(),
      },
      bravoExtra: {
        proposer: p.proposer,
        eta: p.eta.toString(),
        canceled: p.canceled,
        executed: p.executed,
      },
    };
  }
  const [snapshot, deadline, votes] = await Promise.all([
    c.getFunction("proposalSnapshot").staticCall(proposalId),
    c.getFunction("proposalDeadline").staticCall(proposalId),
    c.getFunction("proposalVotes").staticCall(proposalId),
  ]);
  return {
    state: { index: stateIdx, name: stateName(stateIdx) },
    snapshotBlock: snapshot.toString(),
    deadlineBlock: deadline.toString(),
    votes: {
      against: votes[0].toString(),
      for: votes[1].toString(),
      abstain: votes[2].toString(),
    },
  };
}

/**
 * Returns the active quorum value. For OZ v4+ this is `quorum(blockNumber)`;
 * for Bravo it's the fixed `quorumVotes()` (blockNumber is ignored, surfaced
 * as `latest` in the response).
 */
export async function readQuorum(
  c: Contract,
  cfg: GovernorConfig,
  blockNumber: number,
): Promise<{ quorum: bigint; method: "quorum(blockNumber)" | "quorumVotes()" }> {
  if (isBravo(cfg)) {
    const q: bigint = await c.getFunction("quorumVotes").staticCall();
    return { quorum: q, method: "quorumVotes()" };
  }
  const q: bigint = await c.getFunction("quorum").staticCall(blockNumber);
  return { quorum: q, method: "quorum(blockNumber)" };
}
