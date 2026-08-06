/**
 * Controlling-holder participation signal for the treasury-safety advisory.
 *
 * Resolves whether at least one member of a DAO's "controlling set" voted For a
 * given proposal. The controlling set (a product decision) is:
 *   validators ∪ top-N token holders by voting weight.
 * "Voted For" is lenient: ≥1 member among the For-voters ⇒ `true`.
 *
 * Posture: **fail-soft, never throws.** A chain with no DeXe subgraph, an empty
 * set, or any subgraph/RPC error ⇒ `null` (unknown). Informational only — a
 * `false` (set non-empty, nobody voted For) adds an advisory note; it never
 * blocks. We only return `false` when we positively enumerated the set AND
 * confirmed no member voted For on-chain.
 *
 * The set is always enumerated from the index of the chain being analyzed
 * (`resolveSubgraphUrl`). A controlling set borrowed from another chain would
 * score this DAO against strangers — and, being fail-soft, would do it silently.
 *
 * The set is enumerated via subgraph (cheap, but untrusted for vote direction);
 * each member's vote direction is then confirmed ON-CHAIN via
 * `GovPool.getTotalVotes` (authoritative). We OR across PersonalVote /
 * MicropoolVote / DelegatedVote so a member who voted via delegation or a
 * micropool is not mistaken for a non-voter.
 */
import { Interface, type JsonRpcProvider } from "ethers";
import { multicall, type Call } from "./multicall.js";
import { gqlRequest, resolveSubgraphUrl } from "./subgraph.js";
import type { DexeConfig } from "../config.js";

/**
 * Identical to the fragment in src/tools/vote.ts / src/tools/inbox.ts. Kept
 * local + exported so the unit test can assert ethers parses it (ethers
 * silently drops malformed fragments — see govProposalView Phase-A gotcha).
 */
export const GET_TOTAL_VOTES_FRAGMENT =
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 voterRawVoted, bool isVoteFor)";

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
async function fetchValidators(url: string, pool: string): Promise<string[]> {
  try {
    const data = await gqlRequest<{ validatorInPools: { validatorAddress: string | null }[] }>(
      url,
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
async function fetchTopHolders(url: string, pool: string, topN: number): Promise<string[]> {
  try {
    const data = await gqlRequest<{
      voterInPools: { receivedDelegation: string | null; voter: { id: string | null; totalVotes: string | null } | null }[];
    }>(url, DAO_MEMBERS_QUERY, { poolId: pool, offset: 0, limit: 50 });
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
 *   - `null`  — cannot determine (chain not indexed / empty set / error).
 * Never throws. `chainId` is the chain being analyzed and selects the index;
 * it is not a filter applied after the fact.
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

  // Gate: does an index exist FOR THIS CHAIN? The previous gate asked
  // `chainId === 56` and then read the flat cfg.subgraph*Url fields — a pairing
  // that only held while those fields were unconditionally BSC mainnet.
  // DEXE_SUBGRAPH_CHAIN_ID can now file them under any chain, so the two halves
  // could disagree and this advisory would score a chain-56 proposal against a
  // chain-97 controlling set, silently (the function is fail-soft, so nothing
  // would surface). Resolve per chain instead; an unindexed chain is `null`
  // (unknown), never another chain's members.
  //
  // Both endpoints are required, as before: a half-enumerated set is a weaker
  // basis for the `false` verdict that adds the advisory note.
  let validatorsUrl: string;
  let poolsUrl: string;
  try {
    validatorsUrl = resolveSubgraphUrl(cfg, "validators", chainId).url;
    poolsUrl = resolveSubgraphUrl(cfg, "pools", chainId).url;
  } catch {
    // resolveSubgraphUrl throws actionable remediation for a tool to surface;
    // here it is one input to a risk check, so it degrades to unknown rather
    // than aborting the whole assessment.
    return null;
  }

  const pool = govPool.toLowerCase();

  // Enumerate each source independently — a transient failure of one source
  // only shrinks the set, which can only make `false` LESS likely (the safe
  // direction: fewer wrongful refuses).
  const [validators, holders] = await Promise.all([
    fetchValidators(validatorsUrl, pool),
    fetchTopHolders(poolsUrl, pool, topN),
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
      // getTotalVotes returns [rawVotesFor, rawVotesAgainst, voterRawVoted, isVoteFor]
      // — the first two are PROPOSAL-level totals; the voter's stake is [2].
      const v = r.value as unknown as [bigint, bigint, bigint, boolean];
      if (v[2] > 0n && v[3] === true) return true;
    }
    return false; // set non-empty, confirmed nobody voted For
  } catch {
    return null; // RPC/decoding failure ⇒ unknown, never a refuse
  }
}
