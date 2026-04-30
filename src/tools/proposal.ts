import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { proposalStateLabel } from "../lib/govEnums.js";
import { gqlRequest, PROPOSAL_INTERACTIONS_QUERY } from "../lib/subgraph.js";

const GOV_POOL_READ_ABI = [
  "function getProposalState(uint256 proposalId) view returns (uint8)",
  "function getProposalRequiredQuorum(uint256 proposalId) view returns (uint256)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)[] proposals, tuple(uint256 proposalId, uint256 executeAfter, uint256 quorum, uint256 rawVotesFor, uint256 rawVotesAgainst, bool executed, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings)[] validatorProposals, uint8[] proposalStates, uint256[] requiredQuorums, uint256[] requiredValidatorsQuorums)",
] as const;

export function registerProposalTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerProposalState(server, ctx, rpc);
  registerProposalList(server, ctx, rpc);
  registerProposalVoters(server, ctx);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function registerProposalState(server: McpServer, ctx: ToolContext, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_proposal_state",
    {
      title: "Live proposal state + required quorum",
      description:
        "Reads `getProposalState` and `getProposalRequiredQuorum` on a GovPool in one multicall. Returns named state (Voting, Defeated, SucceededFor, ExecutedFor, …) and the quorum threshold.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        proposalId: z.union([z.string(), z.number()]).describe("Proposal id (uint256)"),
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        state: z.string(),
        stateIndex: z.number(),
        requiredQuorum: z.string(),
      },
    },
    async ({ govPool, proposalId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      const id = BigInt(proposalId as string);
      try {
        const provider = rpc.requireProvider();
        const iface = new Interface(GOV_POOL_READ_ABI as unknown as string[]);
        const calls: Call[] = [
          { target: govPool, iface, method: "getProposalState", args: [id] },
          { target: govPool, iface, method: "getProposalRequiredQuorum", args: [id] },
        ];
        const [stateR, quorumR] = await multicall(provider, calls);
        if (!stateR?.success || !quorumR?.success) {
          return errorResult("Multicall failed — is govPool valid and proposalId known?");
        }
        const stateIndex = Number(stateR.value as bigint);
        const state = proposalStateLabel(stateIndex);
        const requiredQuorum = (quorumR.value as bigint).toString();
        const structured = {
          govPool,
          proposalId: id.toString(),
          state,
          stateIndex,
          requiredQuorum,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Proposal ${id} on ${govPool}: state=${state} (${stateIndex}), requiredQuorum=${requiredQuorum}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `proposal_state failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerProposalList(server: McpServer, ctx: ToolContext, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_proposal_list",
    {
      title: "List proposals on a GovPool",
      description:
        "Calls `GovPool.getProposals(offset, limit)` and returns a compact summary per proposal: id, descriptionURL, state, votesFor/Against, voteEnd, executed.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: {
        govPool: z.string(),
        offset: z.number(),
        limit: z.number(),
        proposals: z.array(
          z.object({
            proposalId: z.string(),
            descriptionURL: z.string(),
            state: z.string(),
            stateIndex: z.number(),
            votesFor: z.string(),
            votesAgainst: z.string(),
            voteEnd: z.string(),
            executed: z.boolean(),
            requiredQuorum: z.string(),
          }),
        ),
      },
    },
    async ({ govPool, offset = 0, limit = 20 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      try {
        const provider = rpc.requireProvider();
        const iface = new Interface(GOV_POOL_READ_ABI as unknown as string[]);
        const [res] = await multicall(provider, [
          {
            target: govPool,
            iface,
            method: "getProposals",
            args: [BigInt(offset), BigInt(limit)],
          },
        ]);
        if (!res?.success) return errorResult("getProposals reverted");
        const raw = res.value as unknown as {
          proposals: Array<{
            core: {
              voteEnd: bigint;
              executed: boolean;
              votesFor: bigint;
              votesAgainst: bigint;
            };
            descriptionURL: string;
          }>;
          proposalStates: number[] | bigint[];
          requiredQuorums: bigint[];
        };
        const proposals = raw.proposals.map((p, i) => {
          const idx = Number(raw.proposalStates[i] ?? 9);
          return {
            proposalId: String(offset + i + 1),
            descriptionURL: p.descriptionURL,
            state: proposalStateLabel(idx),
            stateIndex: idx,
            votesFor: p.core.votesFor.toString(),
            votesAgainst: p.core.votesAgainst.toString(),
            voteEnd: p.core.voteEnd.toString(),
            executed: p.core.executed,
            requiredQuorum: (raw.requiredQuorums[i] ?? 0n).toString(),
          };
        });
        const structured = { govPool, offset, limit, proposals };
        const text =
          `Proposals on ${govPool} [offset=${offset}, limit=${limit}] — ${proposals.length} returned\n` +
          proposals
            .map(
              (p) =>
                `  #${p.proposalId}  ${p.state.padEnd(22)}  for=${p.votesFor}  against=${p.votesAgainst}  ${p.executed ? "executed" : ""}`,
            )
            .join("\n");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `proposal_list failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerProposalVoters(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_voters",
    {
      title: "Voter list for a proposal (subgraph)",
      description:
        "Fetches voters from the DeXe interactions subgraph. Requires DEXE_SUBGRAPH_INTERACTIONS_URL env var. Paginated.",
      inputSchema: {
        govPool: z.string().describe("GovPool address (used as filter on `pool` field)"),
        proposalId: z.union([z.string(), z.number()]),
        first: z.number().int().min(1).max(200).default(50),
        skip: z.number().int().min(0).default(0),
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        voters: z.array(
          z.object({
            voter: z.string(),
            interactionType: z.string(),
            totalVote: z.string(),
            timestamp: z.string(),
            transactionHash: z.string(),
          }),
        ),
      },
    },
    async ({ govPool, proposalId, first = 50, skip = 0 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      const url = ctx.config.subgraphPoolsUrl;
      if (!url) {
        return errorResult(
          "DEXE_SUBGRAPH_POOLS_URL is not set. Add it to the MCP env block (The Graph endpoint for DeXe pools subgraph).",
        );
      }
      const id = BigInt(proposalId as string).toString();
      const num = Number(id);
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, num, true);
      const leHex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const compositeId = `${govPool.toLowerCase()}${leHex}`;
      try {
        const data = await gqlRequest<{
          proposalInteractions: Array<{
            id: string;
            hash: string;
            timestamp: string;
            interactionType: string;
            totalVote: string;
            voter: { id: string; voter: { id: string } };
          }>;
        }>(url, PROPOSAL_INTERACTIONS_QUERY, {
          proposalId: compositeId,
          first,
          skip,
        });
        const voters = data.proposalInteractions.map((pi) => ({
          voter: pi.voter?.voter?.id ?? pi.voter?.id ?? "",
          interactionType: pi.interactionType,
          totalVote: pi.totalVote,
          timestamp: pi.timestamp,
          transactionHash: pi.hash,
        }));
        const structured = { govPool, proposalId: id, voters };
        return {
          content: [
            {
              type: "text" as const,
              text: `Voters for proposal ${id} on ${govPool}: ${voters.length} returned (first=${first}, skip=${skip})`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `proposal_voters failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
