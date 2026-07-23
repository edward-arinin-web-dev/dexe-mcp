import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { gqlRequest } from "../lib/subgraph.js";
import { proposalStateLabel } from "../lib/govEnums.js";
import { chainIdParam } from "../lib/params.js";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * dexe_proposal_forecast — predictive pass-rate based on historical proposals.
 *
 * Reads the latest 10 proposals on the DAO via getProposals + their final
 * states, computes pass-rate + average For-vote weight, and returns a
 * recommendation. Mainnet only — testnet has no subgraph and historical
 * data is too sparse to forecast usefully.
 *
 * The "subgraph" requirement here is loose: this tool primarily runs over
 * RPC (multicall on getProposals) so it actually works on testnet too, but
 * we keep the documented mainnet-only contract. To opt-in on testnet, call
 * with `forceRpcOnly: true`.
 */

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function latestProposalId() view returns (uint256)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst) proposal, tuple(tuple(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter, uint128 quorum, uint256 votesFor, uint256 votesAgainst) core) validatorProposal, uint8 proposalState, uint256 requiredQuorum, uint256 requiredValidatorsQuorum)[])",
]);

const GOV_SETTINGS_ABI = new Interface([
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
]);

// Subgraph fallback for daos with proposalCount > on-chain getProposals
// reasonable cap. Same shape as the pools subgraph proposals entity.
const RECENT_PROPOSALS_QUERY = /* GraphQL */ `
  query RecentProposals($pool: String!, $first: Int!) {
    proposals(
      where: { pool: $pool }
      first: $first
      orderBy: creationTimestamp
      orderDirection: desc
    ) {
      id
      proposalId
      executed
      voters
      currentRawVotesFor
      currentRawVotesAgainst
      quorumReached
    }
  }
`;

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

export function registerPredictTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_proposal_forecast",
    {
      title: "Predictive proposal pass-rate forecaster",
      description:
        "Reads the latest 10 proposals on a DAO + their final states, computes the historical " +
        "pass-rate and average For-vote weight, and returns a forecast. " +
        "When `draft.actionsOnFor` is supplied the projection is annotated with the caller's vote weight. " +
        "Mainnet only by default — pass `forceRpcOnly: true` to run on testnet using on-chain reads alone.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        draft: z
          .object({
            actionsOnFor: z.array(z.unknown()).default([]),
            voteAmount: z.string().optional(),
          })
          .optional()
          .describe("Optional draft proposal — voteAmount is added to projectedFor"),
        forceRpcOnly: z
          .boolean()
          .default(false)
          .describe("Bypass mainnet-only guard; forecast purely from on-chain getProposals"),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, draft, forceRpcOnly = false, chainId }) => {
      if (!isAddress(govPool)) return err(`Invalid govPool: ${govPool}`);

      const resolvedChainId = rpc.resolveChainId(chainId);
      const isMainnet = resolvedChainId === 56;
      if (!isMainnet && !forceRpcOnly) {
        return ok({
          error: "subgraph required",
          hint: "Mainnet only by default. Pass forceRpcOnly: true to run from on-chain getProposals on this chain.",
        });
      }

      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;

      // Step 1: helpers + proposal count. The count drives the window offset —
      // getProposals(0, 10) would return the FIRST 10 proposals ever created,
      // not the recent history the forecast promises.
      const [helpersR, latestIdR] = await multicall(provider, [
        { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [], allowFailure: true },
        { target: govPool, iface: GOV_POOL_ABI, method: "latestProposalId", args: [], allowFailure: true },
      ]);
      if (!helpersR?.success) return err("getHelperContracts reverted");
      const helpers = helpersR.value as unknown as { settings: string };
      const latestId = latestIdR?.success ? BigInt(latestIdR.value as bigint) : 0n;
      const windowOffset = latestId > 10n ? latestId - 10n : 0n;

      // Step 2: required quorum + the LATEST (up to) 10 proposals.
      const [settingsR, proposalsR] = await multicall(provider, [
        {
          target: helpers.settings,
          iface: GOV_SETTINGS_ABI,
          method: "getDefaultSettings",
          args: [],
          allowFailure: true,
        },
        { target: govPool, iface: GOV_POOL_ABI, method: "getProposals", args: [windowOffset, 10n], allowFailure: true },
      ]);
      let requiredQuorum = 0n;
      if (settingsR?.success) {
        const s = settingsR.value as unknown as { quorum: bigint };
        requiredQuorum = s.quorum;
      }

      // Step 3: walk historical proposals.
      let proposals: {
        proposalId: string;
        state: string;
        executed: boolean;
        votesFor: bigint;
        votesAgainst: bigint;
      }[] = [];
      if (proposalsR?.success) {
        const views = proposalsR.value as unknown as Array<{
          proposal: { core: { executed: boolean; votesFor: bigint; votesAgainst: bigint } };
          proposalState: bigint | number;
        }>;
        proposals = views.map((v, i) => {
          const idx = Number(v.proposalState);
          return {
            proposalId: String(windowOffset + BigInt(i) + 1n),
            state: proposalStateLabel(idx),
            executed: v.proposal.core.executed,
            votesFor: v.proposal.core.votesFor,
            votesAgainst: v.proposal.core.votesAgainst,
          };
        });
      }

      // Step 4: optional subgraph cross-check for richer history (mainnet only).
      const subgraphUrl = ctx.config.subgraphPoolsUrl;
      let subgraphHistory: unknown = null;
      if (subgraphUrl && isMainnet) {
        try {
          const data = await gqlRequest<{ proposals: unknown[] }>(subgraphUrl, RECENT_PROPOSALS_QUERY, {
            pool: govPool.toLowerCase(),
            first: 10,
          });
          subgraphHistory = data.proposals;
        } catch {
          // soft-fail — on-chain data is enough
        }
      }

      // Stats: pass-rate + average For weight.
      const total = proposals.length;
      const passed = proposals.filter(
        (p) => p.state === "ExecutedFor" || p.state === "SucceededFor",
      ).length;
      const passRate = total > 0 ? passed / total : 0;
      const avgFor =
        total > 0
          ? proposals.reduce((acc, p) => acc + p.votesFor, 0n) / BigInt(total)
          : 0n;

      // Projection: average + caller's draft voteAmount.
      let projectedFor = avgFor;
      if (draft?.voteAmount) {
        try {
          projectedFor += BigInt(draft.voteAmount);
        } catch {
          // ignore malformed amount
        }
      }

      const projectedPct =
        requiredQuorum > 0n
          ? Number((projectedFor * 10000n) / requiredQuorum) / 100
          : 0;
      const hitProbability = Math.min(1, Math.max(0, projectedPct / 100));

      // Risks heuristic.
      const risks: string[] = [];
      if (passRate < 0.4 && total > 0) risks.push("voterApathy");
      if ((draft?.actionsOnFor?.length ?? 0) > 5) risks.push("complexityRisk");
      if (requiredQuorum > 0n && projectedFor < requiredQuorum) risks.push("quorumGap");

      let recommendation: "likelyPass" | "borderline" | "likelyFail";
      if (hitProbability >= 0.8) recommendation = "likelyPass";
      else if (hitProbability >= 0.5) recommendation = "borderline";
      else recommendation = "likelyFail";

      return ok({
        govPool,
        chain: resolvedChainId,
        quorum: {
          required: requiredQuorum.toString(),
          projectedFor: projectedFor.toString(),
          projectedPct,
          hitProbability,
        },
        historicalPassRate: {
          last10: passed,
          total,
          ratio: passRate,
        },
        history: proposals.map((p) => ({
          proposalId: p.proposalId,
          state: p.state,
          executed: p.executed,
          votesFor: p.votesFor.toString(),
          votesAgainst: p.votesAgainst.toString(),
        })),
        subgraphHistory,
        risks,
        recommendation,
      });
    },
  );
}
