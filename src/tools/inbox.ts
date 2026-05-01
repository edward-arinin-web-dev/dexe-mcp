import { z } from "zod";
import { Interface, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { gqlRequest } from "../lib/subgraph.js";
import { proposalStateLabel } from "../lib/govEnums.js";

/**
 * dexe_user_inbox — multi-DAO attention aggregator.
 *
 * Per DAO, surfaces three kinds of pending items for `user`:
 *   1. unvotedProposal — proposal in Voting state where user has zero personal vote
 *   2. claimableRewards — proposals user voted on with a positive pendingRewards balance
 *   3. lockedDeposit — UserKeeper.tokenBalance(user, PersonalVote).balance > 0
 *      (i.e. tokens still parked in the DAO and reclaimable)
 *
 * When `daos` is omitted on mainnet, the pools subgraph is queried for DAOs
 * the user has a `voterInPool` row in (limit 50). On testnet (no subgraph),
 * `daos[]` is required.
 */

// ---------- ABI ----------

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)[] proposals, tuple(uint256 proposalId, uint256 executeAfter, uint256 quorum, uint256 rawVotesFor, uint256 rawVotesAgainst, bool executed, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings)[] validatorProposals, uint8[] proposalStates, uint256[] requiredQuorums, uint256[] requiredValidatorsQuorums)",
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 totalVoted, uint256 totalRawVoted, uint256 votesForNow, bool isVoteFor)",
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] tokens, uint256[] amounts, uint256[] proposalIds))",
]);

const USER_KEEPER_ABI = new Interface([
  "function tokenAddress() view returns (address)",
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
]);

// Tries to read pendingRewards using the canonical ABI; if the contract
// version doesn't expose it, we silently skip and only surface unvoted +
// lockedDeposit. The subgraph would be the next-best signal.
const PENDING_REWARDS_ABI = new Interface([
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] tokens, uint256[] amounts, uint256[] proposalIds) rewards)",
]);

// ---------- subgraph ----------

const USER_DAOS_QUERY = /* GraphQL */ `
  query UserDaos($user: String!, $first: Int!) {
    voterInPools(where: { voter_: { id: $user } }, first: $first) {
      pool {
        id
      }
    }
  }
`;

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function ok(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

interface PendingItem {
  dao: string;
  type: "unvotedProposal" | "claimableRewards" | "lockedDeposit";
  proposalId?: string;
  proposalIds?: string[];
  deadline?: string;
  totalAmount?: string;
  amount?: string;
  govToken?: string;
}

// ---------- register ----------

export function registerInboxTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_user_inbox",
    {
      title: "Multi-DAO attention aggregator",
      description:
        "Aggregates pending items across N DAOs for a user: unvoted proposals in Voting state, claimable rewards, and locked deposits. " +
        "Mainnet: omits `daos` to auto-discover via the pools subgraph (limit 50). Testnet: `daos[]` required (no subgraph). " +
        "Read-only.",
      inputSchema: {
        user: z.string().describe("User wallet address"),
        daos: z
          .array(z.string())
          .optional()
          .describe("Optional explicit DAO list. Required on testnet (chain 97)."),
        proposalScanLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Per-DAO recent-proposal scan window for unvoted/rewards detection"),
      },
    },
    async ({ user, daos, proposalScanLimit = 20 }) => {
      if (!isAddress(user)) return err(`Invalid user: ${user}`);
      const provider = rpc.requireProvider();
      const userAddr = getAddress(user);

      // ----- DAO list resolution -----
      let resolvedDaos: string[] = [];
      if (daos && daos.length > 0) {
        for (const d of daos) {
          if (!isAddress(d)) return err(`Invalid dao: ${d}`);
          resolvedDaos.push(getAddress(d));
        }
      } else {
        const url = ctx.config.subgraphPoolsUrl;
        if (!url) {
          return err(
            "No `daos` supplied and DEXE_SUBGRAPH_POOLS_URL is not set (testnet has no subgraph). Pass `daos: [...]` explicitly.",
          );
        }
        try {
          const data = await gqlRequest<{ voterInPools: { pool: { id: string } }[] }>(url, USER_DAOS_QUERY, {
            user: userAddr.toLowerCase(),
            first: 50,
          });
          resolvedDaos = data.voterInPools.map((v) => getAddress(v.pool.id));
        } catch (e) {
          return err(`Subgraph DAO discovery failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const pendingItems: PendingItem[] = [];
      let daosWithItems = 0;

      // ----- per-DAO scan -----
      for (const dao of resolvedDaos) {
        const items: PendingItem[] = [];
        try {
          // Step 1: fetch helpers + recent proposals in one multicall.
          const [helpersR, proposalsR] = await multicall(provider, [
            { target: dao, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [], allowFailure: true },
            {
              target: dao,
              iface: GOV_POOL_ABI,
              method: "getProposals",
              args: [0n, BigInt(proposalScanLimit)],
              allowFailure: true,
            },
          ]);

          if (!helpersR?.success) continue;
          const helpers = helpersR.value as unknown as { userKeeper: string };
          const userKeeper = helpers.userKeeper;

          // Step 2: read deposit balance + token address.
          const [tokenAddrR, balanceR] = await multicall(provider, [
            { target: userKeeper, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [], allowFailure: true },
            {
              target: userKeeper,
              iface: USER_KEEPER_ABI,
              method: "tokenBalance",
              args: [userAddr, 0],
              allowFailure: true,
            },
          ]);
          const govToken = tokenAddrR?.success ? (tokenAddrR.value as string) : undefined;
          if (balanceR?.success) {
            const bal = balanceR.value as unknown as { balance: bigint };
            if (bal.balance > 0n) {
              items.push({
                dao,
                type: "lockedDeposit",
                amount: bal.balance.toString(),
                govToken,
              });
            }
          }

          // Step 3: walk recent proposals for unvoted in Voting state, and for
          // claimable rewards on already-voted proposals.
          if (proposalsR?.success) {
            const raw = proposalsR.value as unknown as {
              proposals: { core: { voteEnd: bigint } }[];
              proposalStates: bigint[] | number[];
            };
            const proposalIds: string[] = [];
            const votingIds: { id: string; deadline: string }[] = [];
            for (let i = 0; i < raw.proposals.length; i++) {
              const id = String(i + 1);
              proposalIds.push(id);
              const stateIdx = Number(raw.proposalStates[i] ?? 9);
              const stateName = proposalStateLabel(stateIdx);
              if (stateName === "Voting" || stateName === "ValidatorVoting") {
                votingIds.push({ id, deadline: raw.proposals[i]!.core.voteEnd.toString() });
              }
            }

            // For each voting proposal, ask getTotalVotes → if voter has zero,
            // surface as unvoted.
            if (votingIds.length > 0) {
              const calls: Call[] = votingIds.map((p) => ({
                target: dao,
                iface: GOV_POOL_ABI,
                method: "getTotalVotes",
                args: [BigInt(p.id), userAddr, 0],
                allowFailure: true,
              }));
              const res = await multicall(provider, calls);
              for (let i = 0; i < votingIds.length; i++) {
                const r = res[i];
                if (!r?.success) continue;
                const v = r.value as unknown as { totalVoted: bigint };
                if (v.totalVoted === 0n) {
                  items.push({
                    dao,
                    type: "unvotedProposal",
                    proposalId: votingIds[i]!.id,
                    deadline: votingIds[i]!.deadline,
                  });
                }
              }
            }

            // Pending rewards across all scanned proposals (best-effort —
            // contracts that don't expose `getPendingRewards` will silently
            // produce an empty list).
            if (proposalIds.length > 0) {
              const [rewardsR] = await multicall(provider, [
                {
                  target: dao,
                  iface: PENDING_REWARDS_ABI,
                  method: "getPendingRewards",
                  args: [userAddr, proposalIds.map((s) => BigInt(s))],
                  allowFailure: true,
                },
              ]);
              if (rewardsR?.success) {
                const rw = rewardsR.value as unknown as {
                  rewards: { tokens: string[]; amounts: bigint[]; proposalIds: bigint[] };
                };
                const r = rw.rewards;
                if (r.amounts && r.amounts.length > 0) {
                  let total = 0n;
                  for (const a of r.amounts) total += a;
                  if (total > 0n) {
                    items.push({
                      dao,
                      type: "claimableRewards",
                      proposalIds: r.proposalIds.map((p) => p.toString()),
                      totalAmount: total.toString(),
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Best-effort per DAO — skip on failure, don't poison the inbox.
          continue;
        }

        if (items.length > 0) daosWithItems++;
        pendingItems.push(...items);
      }

      const criticalCount = pendingItems.filter((i) => i.type === "unvotedProposal").length;

      return ok({
        user: userAddr,
        pendingItems,
        summary: {
          totalDaos: resolvedDaos.length,
          daosWithItems,
          criticalCount,
        },
      });
    },
  );
}
