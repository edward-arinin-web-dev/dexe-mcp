import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { gqlRequest, resolveSubgraphUrl, type ResolvedSubgraph } from "../lib/subgraph.js";
import { proposalOutcome, proposalStateLabel, type ProposalStateName } from "../lib/govEnums.js";
import { chainIdParam } from "../lib/params.js";
import {
  quorumAttainmentPct,
  quorumPctFromRaw,
  requiredQuorumWeight,
} from "../lib/quorumRisk.js";
import { safeErrorMessage } from "../lib/redact.js";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * dexe_proposal_forecast — predictive pass-rate based on historical proposals.
 *
 * Reads the latest 10 proposals on the DAO via getProposals + their final
 * states, computes pass-rate + average For-vote weight, and returns a
 * recommendation.
 *
 * The numbers come from RPC (multicall on getProposals), so the forecast works
 * on any configured chain; the pools subgraph only adds a richer history
 * cross-check. A subgraph indexes exactly ONE chain, so that cross-check runs
 * only when an endpoint exists for the chain being forecast — another chain's
 * proposal history spliced into this DAO's forecast is wrong data wearing a
 * correct answer's clothes. A chain with no endpoint is gated behind
 * `forceRpcOnly: true`, so the caller opts in knowing the history is on-chain
 * only; the response reports `indexedChainId` either way.
 */

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function latestProposalId() view returns (uint256)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst) proposal, tuple(tuple(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter, uint128 quorum, uint256 votesFor, uint256 votesAgainst) core) validatorProposal, uint8 proposalState, uint256 requiredQuorum, uint256 requiredValidatorsQuorum)[])",
]);

/**
 * `getTotalPower()` is the denominator GovPool itself uses:
 * `_govUserKeeper.getTotalPower().ratio(core.settings.quorum, PERCENTAGE_100)`
 * (DeXe-Protocol contracts/gov/GovPool.sol:495). It lives on GovUserKeeper —
 * GovPool has no such function — so the call MUST be addressed to
 * `getHelperContracts().userKeeper`, never to the pool.
 */
const USER_KEEPER_ABI = new Interface(["function getTotalPower() view returns (uint256)"]);

const GOV_SETTINGS_ABI = new Interface([
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
]);

// Subgraph fallback for daos with proposalCount > on-chain getProposals
// reasonable cap. Same shape as the pools subgraph proposals entity.
/*
 * Every field here is verified against the live pools schema (dexe://graph-schema).
 * The previous version asked for `executed`, `voters`, `currentRawVotesFor`,
 * `currentRawVotesAgainst`, `quorumReached` and ordered by `creationTimestamp` —
 * NONE of which exist on `Proposal`. The gateway rejected the whole document, the
 * catch below swallowed it, and the cross-check silently returned nothing on every
 * install since it shipped.
 *
 * The real schema expresses the two booleans as timestamps: a proposal is executed
 * when `executionTimestamp > 0`, and quorum was reached when
 * `quorumReachedTimestamp > 0`. `Proposal` carries no creation field at all, so
 * "most recent" is `proposalId` descending — ids are assigned in creation order.
 */
const RECENT_PROPOSALS_QUERY = /* GraphQL */ `
  query RecentProposals($pool: String!, $first: Int!) {
    proposals(
      where: { pool: $pool }
      first: $first
      orderBy: proposalId
      orderDirection: desc
    ) {
      id
      proposalId
      executionTimestamp
      quorumReachedTimestamp
      currentVotesFor
      currentVotesAgainst
      quorum
      votersVoted
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
        "Read-only. Reads the latest 10 proposals on a DAO and their final states and forecasts the pass-rate over DECIDED " +
        "proposals (still-voting ones are `pending`, never failures), with the average For-vote weight. " +
        "`quorum.requiredWeight` is an ABSOLUTE vote weight (getTotalPower x quorum / 1e27), not the 1e25 percentage " +
        "setting. The history cross-check needs a pools subgraph for the chain being forecast; a chain with none is " +
        "forecast on-chain only (`subgraphHistory: null`, `subgraphNote` says why) — never from another chain's index. " +
        "`indexedChainId` reports whose index was used (null = none).",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        draft: z
          .object({
            actionsOnFor: z
              .array(z.unknown())
              .default([])
              .describe("Draft actionsOnFor; more than 5 flags complexityRisk."),
            voteAmount: z
              .string()
              .optional()
              .describe("Vote weight to add to projectedFor, RAW 18-decimal voting power."),
          })
          .optional()
          .describe("Optional draft proposal — voteAmount is added to projectedFor"),
        forceRpcOnly: z
          .boolean()
          .default(false)
          .describe(
            "Skip the subgraph history cross-check even when this chain has one; a chain with none is on-chain only anyway.",
          ),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, draft, forceRpcOnly = false, chainId }) => {
      if (!isAddress(govPool)) return err(`Invalid govPool: ${govPool}`);

      const resolvedChainId = rpc.resolveChainId(chainId);

      // Resolve the index for the chain actually being forecast. The old gate
      // asked `resolvedChainId === 56` and then read the flat
      // ctx.config.subgraphPoolsUrl — safe only while that field was
      // unconditionally BSC mainnet. DEXE_SUBGRAPH_CHAIN_ID can now file it
      // under any chain, so the two halves could disagree and a mainnet
      // forecast would carry testnet proposal history (or vice versa) with
      // nothing in the payload saying so.
      let subgraph: ResolvedSubgraph | null = null;
      let noSubgraphReason: string | null = null;
      try {
        subgraph = resolveSubgraphUrl(ctx.config, "pools", resolvedChainId);
      } catch (e) {
        // The resolver's message IS the user-facing remediation (it names the
        // chains that do have an index and the env var to set).
        noSubgraphReason = safeErrorMessage(e);
      }
      // A chain with no pools subgraph is forecast from on-chain getProposals
      // alone. The chain-correctness rule (0.30.2) is "never another chain's
      // index"; it was never "no answer at all" — but that is what a testnet
      // user got: `{error: "subgraph required"}` plus a flag to pass, on every
      // call, for a number the tool computes on-chain anyway. `subgraphNote`
      // below still carries the resolver's remediation (which chains ARE
      // indexed, which env var adds one), so nothing the error said is lost.
      // `forceRpcOnly` keeps one job: skip the cross-check on a chain that HAS
      // an index.
      if (forceRpcOnly && subgraph) {
        noSubgraphReason =
          `forceRpcOnly: the history cross-check against the chain-${subgraph.chainId} pools index was skipped ` +
          `by request; this forecast is on-chain only.`;
        subgraph = null;
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
      const helpers = helpersR.value as unknown as { settings: string; userKeeper?: string };
      // A malformed helpers decode must degrade to "quorum unknown", never throw:
      // multicall builds its calldata OUTSIDE the per-call allowFailure guard
      // (src/lib/multicall.ts:48-52), so `target: undefined` would take the whole
      // tool down instead of nulling one field.
      const userKeeper =
        typeof helpers.userKeeper === "string" &&
        isAddress(helpers.userKeeper) &&
        helpers.userKeeper !== ZERO_ADDRESS
          ? helpers.userKeeper
          : null;
      const latestId = latestIdR?.success ? BigInt(latestIdR.value as bigint) : 0n;
      const windowOffset = latestId > 10n ? latestId - 10n : 0n;

      // Step 2: quorum setting + total power + the LATEST (up to) 10 proposals.
      // getTotalPower joins the SAME aggregate3 batch — no extra round-trip.
      const step2: Call[] = [
        {
          target: helpers.settings,
          iface: GOV_SETTINGS_ABI,
          method: "getDefaultSettings",
          args: [],
          allowFailure: true,
        },
        { target: govPool, iface: GOV_POOL_ABI, method: "getProposals", args: [windowOffset, 10n], allowFailure: true },
      ];
      if (userKeeper) {
        step2.push({
          target: userKeeper,
          iface: USER_KEEPER_ABI,
          method: "getTotalPower",
          args: [],
          allowFailure: true,
        });
      }
      const [settingsR, proposalsR, totalPowerR] = await multicall(provider, step2);
      let quorumRaw = 0n;
      if (settingsR?.success) {
        const s = settingsR.value as unknown as { quorum: bigint };
        quorumRaw = s.quorum;
      }
      const totalPower = totalPowerR?.success ? (totalPowerR.value as bigint) : null;
      // THE fix (D1-1): `settings.quorum` is a PERCENTAGE scaled by 1e27, while
      // votesFor is an absolute token weight. Comparing them is wrong by
      // totalPower/1e27 — orders of magnitude, in either direction.
      const requiredWeight = requiredQuorumWeight(totalPower, quorumRaw);

      // Step 3: walk historical proposals.
      //
      // `requiredQuorum` is a per-proposal ABSOLUTE weight the view already
      // carries (GovPoolView.sol:65) and the ABI above already declares — it
      // used to be decoded and dropped. Keeping it makes every historical row
      // scale-free, which matters because a DAO's quorum setting can move
      // mid-history (BOXY went 1e25 → 5e25 between proposals 4 and 5), and a
      // flat mean of absolute votesFor is meaningless across such a change.
      //
      // Named (not positional) field access on purpose: decodeProposalView in
      // src/lib/govProposalView.ts reads v[0]/v[3], which the plain-object
      // fixtures this tool is tested with cannot satisfy.
      let proposals: {
        proposalId: string;
        state: ProposalStateName;
        executed: boolean;
        votesFor: bigint;
        votesAgainst: bigint;
        requiredQuorum: bigint;
      }[] = [];
      if (proposalsR?.success) {
        const views = proposalsR.value as unknown as Array<{
          proposal: { core: { executed: boolean; votesFor: bigint; votesAgainst: bigint } };
          proposalState: bigint | number;
          requiredQuorum?: bigint;
        }>;
        proposals = views.map((v, i) => {
          const idx = Number(v.proposalState);
          return {
            proposalId: String(windowOffset + BigInt(i) + 1n),
            state: proposalStateLabel(idx),
            executed: v.proposal.core.executed,
            votesFor: v.proposal.core.votesFor,
            votesAgainst: v.proposal.core.votesAgainst,
            // Absent on a legacy/partial decode — never let `undefined` reach
            // the arithmetic below (mirrors src/tools/report.ts:1124).
            requiredQuorum: v.requiredQuorum ?? 0n,
          };
        });
      }

      // Step 4: optional cross-check for richer history — strictly from the
      // index of the chain we just read on-chain, or not at all.
      let subgraphHistory: unknown = null;
      if (subgraph) {
        try {
          const data = await gqlRequest<{ proposals: unknown[] }>(subgraph.url, RECENT_PROPOSALS_QUERY, {
            pool: govPool.toLowerCase(),
            first: 10,
          });
          // The indexer's `Proposal.quorum` is the 1e25-scaled SETTING, and it
          // arrived here sitting next to token-wei `currentVotesFor` under a
          // name that invited exactly the division D1-1 got wrong. Label it,
          // and add the human percentage. The original key is preserved so
          // existing consumers keep working.
          subgraphHistory = data.proposals.map((row) => {
            const r = row as Record<string, unknown>;
            const raw = r.quorum;
            const pct = raw == null ? NaN : quorumPctFromRaw(String(raw));
            return {
              ...r,
              quorumSettingRaw: raw == null ? null : String(raw),
              quorumSettingPct: Number.isFinite(pct) ? pct : null,
            };
          });
        } catch (queryErr) {
          // Soft-fail: on-chain data alone is a valid forecast. But say WHY the
          // history is missing — a swallowed error made a rejected query look
          // identical to "this DAO has never had a proposal", which is how the
          // invalid field set above survived unnoticed.
          noSubgraphReason =
            `history cross-check failed against the chain-${subgraph.chainId} index: ` +
            `${safeErrorMessage(queryErr)}`;
        }
      }

      // Stats: pass-rate + average For weight.
      //
      // The denominator is DECIDED proposals only (D1-4). Counting a proposal
      // that is still Voting — and the newest proposal in this window usually
      // is, since the window ends at latestProposalId — as a failure dragged the
      // rate down and fired a false `voterApathy` on DAOs where nothing had been
      // decided yet. `passedFor` keeps its long-standing meaning: the For side
      // won. An Against win is still not a pass.
      const total = proposals.length;
      const outcomes = proposals.map((p) => proposalOutcome(p.state));
      const passed = outcomes.filter((o) => o === "passedFor").length;
      const pending = outcomes.filter((o) => o === "pending").length;
      const decided = total - pending;
      const passRate = decided > 0 ? passed / decided : 0;
      const avgFor =
        total > 0
          ? proposals.reduce((acc, p) => acc + p.votesFor, 0n) / BigInt(total)
          : 0n;

      // Scale-free history: each row against ITS OWN quorum target. Rows with a
      // 0/absent target (GovPool returns 0 for voteEnd == 0) contribute null and
      // are excluded from the mean — never a NaN wearing a number's clothes.
      const perRowAttainment = proposals.map((p) =>
        quorumAttainmentPct(p.votesFor, p.requiredQuorum > 0n ? p.requiredQuorum : null),
      );
      const knownAttainment = perRowAttainment.filter((n): n is number => n !== null);
      const historicalQuorumAttainmentPct =
        knownAttainment.length > 0
          ? knownAttainment.reduce((a, b) => a + b, 0) / knownAttainment.length
          : null;

      // Projection: average + caller's draft voteAmount.
      let projectedFor = avgFor;
      if (draft?.voteAmount) {
        try {
          projectedFor += BigInt(draft.voteAmount);
        } catch {
          // ignore malformed amount
        }
      }

      const projectedPct = quorumAttainmentPct(projectedFor, requiredWeight);
      const hitProbability = projectedPct === null ? null : Math.min(1, Math.max(0, projectedPct / 100));

      // Risks heuristic.
      const risks: string[] = [];
      // No apathy verdict off a window where nothing has been decided.
      if (decided > 0 && passRate < 0.4) risks.push("voterApathy");
      if ((draft?.actionsOnFor?.length ?? 0) > 5) risks.push("complexityRisk");
      if (requiredWeight !== null && projectedFor < requiredWeight) risks.push("quorumGap");
      if (requiredWeight === null) risks.push("quorumUnknown");

      let recommendation: "likelyPass" | "borderline" | "likelyFail" | "unknown";
      if (hitProbability === null) recommendation = "unknown";
      else if (hitProbability >= 0.8) recommendation = "likelyPass";
      else if (hitProbability >= 0.5) recommendation = "borderline";
      else recommendation = "likelyFail";

      const quorumNote =
        requiredWeight === null
          ? `Quorum target unknown: GovUserKeeper.getTotalPower() at ${userKeeper ?? "(no userKeeper in getHelperContracts)"} ` +
            `returned 0 or did not answer, so the forecast cannot say how far the votes are from quorum. ` +
            `getTotalPower is the gov token's total supply (plus NFT power) — depositing does NOT change it. ` +
            `Check that this DAO has a gov token or NFT with non-zero supply (dexe_dao_info shows the helper ` +
            `contracts, dexe_read_gov_state the token), and that the RPC for chain ${resolvedChainId} is healthy ` +
            `(dexe_doctor). historicalPassRate below is still computed from on-chain proposals ` +
            `(${passed}/${decided} decided, ${pending} still in flight).`
          : null;

      return ok({
        govPool,
        chain: resolvedChainId,
        quorum: {
          /** The raw 1e25-scaled percentage SETTING (5e26 = 50%). Never a weight. */
          settingRaw: quorumRaw.toString(),
          quorumPct: Number.isFinite(quorumPctFromRaw(quorumRaw)) ? quorumPctFromRaw(quorumRaw) : null,
          totalPower: totalPower === null ? null : totalPower.toString(),
          /** The ABSOLUTE vote weight quorum demands. Null when totalPower is unknown. */
          requiredWeight: requiredWeight === null ? null : requiredWeight.toString(),
          // Back-compat name, now carrying the value it always claimed to hold.
          required: requiredWeight === null ? null : requiredWeight.toString(),
          projectedFor: projectedFor.toString(),
          projectedPct,
          hitProbability,
          basis:
            "GovUserKeeper.getTotalPower() x GovSettings.getDefaultSettings().quorum / 1e27 — the same formula as " +
            "GovPool.getProposalRequiredQuorum. Uses the DEFAULT settings; internal/validator/custom-executor " +
            "proposals may carry a different quorum. On-chain, quorum is reached by votesFor OR votesAgainst; " +
            "this projection tracks the For side only. hitProbability is an attainment ratio clamped to 1 " +
            "(185% of target ⇒ 1.0), not a statistical probability.",
        },
        quorumNote,
        historicalPassRate: {
          // `last10` is a count of passes, not a window size — kept for
          // back-compat alongside the fields that actually say what they are.
          last10: passed,
          passed,
          decided,
          pending,
          total,
          ratio: passRate,
        },
        historicalQuorumAttainmentPct,
        history: proposals.map((p, i) => ({
          proposalId: p.proposalId,
          state: p.state,
          outcome: outcomes[i]!,
          executed: p.executed,
          votesFor: p.votesFor.toString(),
          votesAgainst: p.votesAgainst.toString(),
          /** Absolute weight this proposal needed — per row, not the DAO default. */
          requiredQuorum: p.requiredQuorum.toString(),
          quorumAttainmentPct: perRowAttainment[i]!,
        })),
        subgraphHistory,
        // Provenance for the block above: the chain whose index produced it, and
        // — when there is none — why. `subgraphHistory: null` must never be
        // mistaken for "this chain has no proposals".
        indexedChainId: subgraph?.chainId ?? null,
        // Populated for BOTH failure shapes: no endpoint for this chain, and an
        // endpoint that was queried and refused. Reporting only the first made a
        // broken query indistinguishable from an empty index.
        subgraphNote: noSubgraphReason,
        risks,
        recommendation,
      });
    },
  );
}
