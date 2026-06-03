/**
 * Controlling-holder participation signal for the treasury-safety advisory.
 *
 * Resolves whether at least one member of a DAO's "controlling set" voted For a
 * given proposal. The controlling set (a product decision) is:
 *   validators ∪ top-N token holders by voting weight.
 * "Voted For" is lenient: ≥1 member among the For-voters ⇒ `true`.
 *
 * Posture: **fail-soft, never throws.** Any missing subgraph, non-mainnet chain,
 * empty set, or subgraph/RPC error ⇒ `null` (unknown). Informational only — a
 * `false` (set non-empty, nobody voted For) adds an advisory note; it never
 * blocks. We only return `false` when we positively enumerated the set AND
 * confirmed no member voted For on-chain.
 *
 * The set is enumerated via subgraph (cheap, but untrusted for vote direction);
 * each member's vote direction is then confirmed ON-CHAIN via
 * `GovPool.getTotalVotes` (authoritative). We OR across PersonalVote /
 * MicropoolVote / DelegatedVote so a member who voted via delegation or a
 * micropool is not mistaken for a non-voter.
 */
import { Interface, type JsonRpcProvider } from "ethers";
import { multicall, type Call } from "./multicall.js";
import { gqlRequest } from "./subgraph.js";
import type { DexeConfig } from "../config.js";

/**
 * Identical to the fragment in src/tools/vote.ts / src/tools/inbox.ts. Kept
 * local + exported so the unit test can assert ethers parses it (ethers
 * silently drops malformed fragments — see govProposalView Phase-A gotcha).
 */
export const GET_TOTAL_VOTES_FRAGMENT =
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 totalVoted, uint256 totalRawVoted, uint256 votesForNow, bool isVoteFor)";

/** PersonalVote=0, MicropoolVote=1, DelegatedVote=2 (TreasuryVote=3 omitted). */
const VOTE_TYPES = [0, 1, 2] as const;

/** Default top-N token holders when neither arg nor config overrides it. */
const DEFAULT_TOP_N = 5;

/** Trimmed from src/tools/subgraph.ts VALIDATORS_QUERY (fields we need only). */
const VALIDATORS_QUERY = /* GraphQL */ `
  query getDaoPoolValidators($offset: Int!, $limit: Int!, $address: String!) {
    validatorInPools(
      skip: $offset
      first: $limit
      orderBy: balance
      orderDirection: desc
      where: { pool: $address }
    ) {
      validatorAddress
    }
  }
`;

/** Trimmed from src/tools/subgraph.ts DAO_MEMBERS_QUERY (fields we need only). */
const DAO_MEMBERS_QUERY = /* GraphQL */ `
  query getVotersInPool($poolId: String!, $offset: Int!, $limit: Int!) {
    voterInPools(skip: $offset, first: $limit, where: { pool: $poolId }) {
      receivedDelegation
      voter {
        id
        totalVotes
      }
    }
  }
`;

function toBig(s: string | null | undefined): bigint {
  try {
    return s ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
}

/** Validator addresses for `pool` (lowercased). Fail-soft → []. */
async function fetchValidators(cfg: DexeConfig, pool: string): Promise<string[]> {
  try {
    const data = await gqlRequest<{ validatorInPools: { validatorAddress: string | null }[] }>(
      cfg.subgraphValidatorsUrl!,
      VALIDATORS_QUERY,
      { offset: 0, limit: 100, address: pool },
    );
    return (data.validatorInPools ?? [])
      .map((v) => v.validatorAddress?.toLowerCase())
      .filter((a): a is string => !!a);
  } catch {
    return [];
  }
}

/** Top-N holders by (totalVotes + receivedDelegation), lowercased. Fail-soft → []. */
async function fetchTopHolders(cfg: DexeConfig, pool: string, topN: number): Promise<string[]> {
  try {
    const data = await gqlRequest<{
      voterInPools: { receivedDelegation: string | null; voter: { id: string | null; totalVotes: string | null } | null }[];
    }>(cfg.subgraphPoolsUrl!, DAO_MEMBERS_QUERY, { poolId: pool, offset: 0, limit: 50 });
    const weighted = (data.voterInPools ?? [])
      .map((r) => ({
        addr: r.voter?.id?.toLowerCase(),
        weight: toBig(r.voter?.totalVotes) + toBig(r.receivedDelegation),
      }))
      .filter((x): x is { addr: string; weight: bigint } => !!x.addr);
    weighted.sort((a, b) => (a.weight < b.weight ? 1 : a.weight > b.weight ? -1 : 0));
    return weighted.slice(0, Math.max(0, topN)).map((x) => x.addr);
  } catch {
    return [];
  }
}

/**
 * Did ≥1 controlling-set member vote For proposal `proposalId`?
 *   - `true`  — at least one member voted For (any vote type).
 *   - `false` — set was enumerated, non-empty, and NONE voted For.
 *   - `null`  — cannot determine (no subgraph / non-mainnet / empty set / error).
 * Never throws.
 */
export async function resolveControllingHoldersVotedFor(args: {
  provider: JsonRpcProvider;
  govPool: string;
  proposalId: number;
  cfg: DexeConfig;
  chainId: number;
  topN?: number;
}): Promise<boolean | null> {
  const { provider, govPool, proposalId, cfg, chainId } = args;
  const topN = args.topN ?? cfg.controllingTopN ?? DEFAULT_TOP_N;

  // Gate: subgraph exists only on mainnet (56). Testnet (97) ⇒ unknown.
  if (chainId !== 56) return null;
  if (!cfg.subgraphValidatorsUrl || !cfg.subgraphPoolsUrl) return null;

  const pool = govPool.toLowerCase();

  // Enumerate each source independently — a transient failure of one source
  // only shrinks the set, which can only make `false` LESS likely (the safe
  // direction: fewer wrongful refuses).
  const [validators, holders] = await Promise.all([
    fetchValidators(cfg, pool),
    fetchTopHolders(cfg, pool, topN),
  ]);
  const members = [...new Set([...validators, ...holders])];
  if (members.length === 0) return null;

  try {
    const iface = new Interface([GET_TOTAL_VOTES_FRAGMENT]);
    const calls: Call[] = [];
    for (const member of members) {
      for (const vt of VOTE_TYPES) {
        calls.push({
          target: govPool,
          iface,
          method: "getTotalVotes",
          args: [proposalId, member, vt],
          allowFailure: true,
        });
      }
    }
    const results = await multicall(provider, calls);
    for (const r of results) {
      if (!r.success || r.value == null) continue;
      // getTotalVotes returns a 4-tuple: [totalVoted, totalRawVoted, votesForNow, isVoteFor]
      const v = r.value as unknown as [bigint, bigint, bigint, boolean];
      if (v[2] > 0n && v[3] === true) return true;
    }
    return false; // set non-empty, confirmed nobody voted For
  } catch {
    return null; // RPC/decoding failure ⇒ unknown, never a refuse
  }
}
