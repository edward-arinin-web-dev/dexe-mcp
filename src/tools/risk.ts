import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { resolveChain } from "../config.js";
import {
  classifyTreasuryActions,
  quorumPctFromRaw,
  judgeQuorum,
  attackerCost,
  worstRisk,
  type RiskLevel,
} from "../lib/quorumRisk.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";

/**
 * Layer 6 — `dexe_proposal_risk_assess`. The comprehensive treasury-drain risk
 * readout the DeXe contract team asked for, addressed to whoever votes /
 * creates / executes a proposal. Read-only; assesses either an on-chain
 * proposal (`proposalId`) or a hypothetical action set (`actions`).
 *
 * Founder/validator participation is subgraph/mainnet-only — reported as
 * `controllingHoldersVotedFor: null` (unknown) until that enrichment lands; null
 * is never treated as "safe".
 */

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getProposalRequiredQuorum(uint256 proposalId) view returns (uint256)",
  GET_PROPOSALS_FRAGMENT,
]);

const SETTINGS_ABI = new Interface([
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
]);

const USER_KEEPER_ABI = new Interface([
  "function tokenAddress() view returns (address)",
]);

const ERC20_ABI = new Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ActionSchema = z.object({
  executor: z.string(),
  value: z.string().default("0"),
  data: z.string().default("0x"),
});

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function recommend(verdict: RiskLevel, floorPct: number, treasuryTouching: boolean): string {
  if (!treasuryTouching) {
    return "No treasury-moving action detected (no ERC20 approve/transfer/transferFrom or native value). Standard governance review applies.";
  }
  if (verdict === "DANGER") {
    return `HIGH RISK: a minority stake can pass this and drain the treasury. Do NOT execute without quorum ≥${floorPct}% AND confirmed participation by founders/validators/majority holders. Responsibility rests with the voter/creator/executor.`;
  }
  if (verdict === "CAUTION") {
    return `CAUTION: treasury-moving with quorum near or below the ${floorPct}% floor, or attacker-cost unknown. Verify controlling-member participation before executing.`;
  }
  return `Quorum ≥${floorPct}% — a true majority is required to pass. Still confirm the recipient and amounts before executing.`;
}

export function registerRiskTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_proposal_risk_assess",
    {
      title: "Treasury-drain risk readout for a proposal (or hypothetical actions)",
      description:
        "Assesses low-quorum treasury-drain risk for a DAO proposal. Pass `proposalId` to assess an on-chain proposal's actionsOnFor + its own quorum, or `actions` to assess a hypothetical action set against the DAO's default settings. Reports quorum %, the safe floor (DEXE_MIN_SAFE_QUORUM_PCT), the treasury tokens an action would move, an indicative attacker-cost (% of supply needed to pass alone), and a verdict (SAFE/CAUTION/DANGER) with a recommendation. Read-only; never broadcasts. Founder/validator participation is reported only when a subgraph is available (else null).",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        proposalId: z.number().int().min(1).optional().describe("On-chain proposal id (1-indexed) to assess"),
        actions: z
          .array(ActionSchema)
          .optional()
          .describe("Hypothetical actionsOnFor to assess instead of an on-chain proposal"),
        chainId: z.number().int().positive().optional().describe("Target chain id; defaults to the MCP default chain"),
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.number().nullable(),
        quorumPct: z.number(),
        safeFloorPct: z.number(),
        quorumVerdict: z.string(),
        verdict: z.string(),
        treasuryTouching: z.boolean(),
        treasuryHits: z.array(
          z.object({
            index: z.number(),
            executor: z.string(),
            kind: z.string(),
            recipient: z.string().nullable(),
            amount: z.string().nullable(),
          }),
        ),
        treasuryAtRisk: z.array(
          z.object({ token: z.string(), symbol: z.string().nullable(), balance: z.string().nullable() }),
        ),
        totalSupply: z.string().nullable(),
        requiredWeight: z.string().nullable(),
        attackerCostPct: z.number().nullable(),
        controllingHoldersVotedFor: z.boolean().nullable(),
        recommendation: z.string(),
      },
    },
    async ({ govPool, proposalId, actions, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (proposalId === undefined && (!actions || actions.length === 0)) {
        return errorResult("Provide either `proposalId` (on-chain) or a non-empty `actions` array (hypothetical).");
      }
      const floorPct = ctx.config.minSafeQuorumPct;

      let chain;
      try {
        chain = resolveChain(ctx.config, chainId);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
      const pr = rpc.tryProvider(chain.chainId);
      if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;

      try {
        // ---- round A: helpers (+ on-chain proposal when proposalId given) ----
        const callsA: Call[] = [
          { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
        ];
        if (proposalId !== undefined) {
          callsA.push({ target: govPool, iface: GOV_POOL_ABI, method: "getProposals", args: [proposalId - 1, 1], allowFailure: true });
        }
        const resA = await multicall(provider, callsA);
        if (!resA[0]?.success) return errorResult("getHelperContracts reverted — is this a GovPool?");
        const helpers = resA[0]!.value as unknown as { settings: string; userKeeper: string };

        let assessedActions: { executor: string; value: string; data: string }[];
        let quorumRaw: bigint;
        let requiredWeight: bigint | null = null;

        if (proposalId !== undefined) {
          const views = resA[1]?.success ? (resA[1]!.value as unknown[]) : null;
          if (!views || views.length === 0) return errorResult(`Proposal ${proposalId} not found at ${govPool}`);
          const decoded = decodeProposalView(views[0]);
          if (!decoded) return errorResult("Failed to decode proposal view");
          assessedActions = decoded.actionsOnFor;
          quorumRaw = decoded.quorumRaw;
          requiredWeight = decoded.requiredQuorum;
        } else {
          assessedActions = actions!.map((a) => ({ executor: a.executor, value: a.value, data: a.data }));
          // Hypothetical: use the DAO's default-settings quorum.
          const resS = await multicall(provider, [
            { target: helpers.settings, iface: SETTINGS_ABI, method: "getDefaultSettings", args: [] },
          ]);
          if (!resS[0]?.success) return errorResult("getDefaultSettings reverted");
          quorumRaw = (resS[0]!.value as unknown[])[6] as bigint;
        }

        const quorumPct = quorumPctFromRaw(quorumRaw);
        const quorumVerdict = judgeQuorum(quorumPct, floorPct);
        const treasuryHits = classifyTreasuryActions(assessedActions);
        const treasuryTouching = treasuryHits.length > 0;

        // ---- gov token total supply ----
        const resTok = await multicall(provider, [
          { target: helpers.userKeeper, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [], allowFailure: true },
        ]);
        const govToken = resTok[0]?.success ? (resTok[0]!.value as string) : null;
        let totalSupply: bigint | null = null;
        if (govToken && isAddress(govToken) && govToken !== "0x0000000000000000000000000000000000000000") {
          const resSupply = await multicall(provider, [
            { target: govToken, iface: ERC20_ABI, method: "totalSupply", args: [], allowFailure: true },
          ]);
          totalSupply = resSupply[0]?.success ? (resSupply[0]!.value as bigint) : null;
        }

        // ---- treasury balances for the tokens an action would move ----
        const tokenExecutors = [
          ...new Set(
            treasuryHits
              .filter((h) => h.kind !== "nativeValue" && isAddress(h.executor))
              .map((h) => h.executor),
          ),
        ];
        const treasuryAtRisk: { token: string; symbol: string | null; balance: string | null }[] = [];
        if (tokenExecutors.length > 0) {
          const balCalls: Call[] = [];
          for (const t of tokenExecutors) {
            balCalls.push({ target: t, iface: ERC20_ABI, method: "balanceOf", args: [govPool], allowFailure: true });
            balCalls.push({ target: t, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true });
          }
          const balRes = await multicall(provider, balCalls);
          tokenExecutors.forEach((t, i) => {
            treasuryAtRisk.push({
              token: t,
              balance: balRes[i * 2]?.success ? (balRes[i * 2]!.value as bigint).toString() : null,
              symbol: balRes[i * 2 + 1]?.success ? (balRes[i * 2 + 1]!.value as string) : null,
            });
          });
        }
        if (treasuryHits.some((h) => h.kind === "nativeValue")) {
          const nativeBal = (await provider.getBalance(govPool)).toString();
          treasuryAtRisk.push({ token: "native", symbol: chain.chainId === 56 || chain.chainId === 97 ? "BNB" : "native", balance: nativeBal });
        }

        // ---- attacker cost ----
        const attacker = attackerCost({
          quorumPct,
          floorPct,
          totalSupply: totalSupply ?? undefined,
          requiredWeight: requiredWeight ?? undefined,
          // hypothetical: approximate total vote weight by total supply (indicative).
          totalVoteWeight: requiredWeight === null ? totalSupply ?? undefined : undefined,
        });

        // Founder/validator participation — subgraph/mainnet-only (Phase B). null = unknown.
        const controllingHoldersVotedFor: boolean | null = null;

        const verdict: RiskLevel = treasuryTouching
          ? worstRisk(quorumVerdict, attacker.verdict)
          : "SAFE";

        const structured = {
          govPool,
          proposalId: proposalId ?? null,
          quorumPct,
          safeFloorPct: floorPct,
          quorumVerdict,
          verdict,
          treasuryTouching,
          treasuryHits: treasuryHits.map((h) => ({
            index: h.index,
            executor: h.executor,
            kind: h.kind,
            recipient: h.recipient,
            amount: h.amount,
          })),
          treasuryAtRisk,
          totalSupply: totalSupply !== null ? totalSupply.toString() : null,
          requiredWeight: requiredWeight !== null ? requiredWeight.toString() : null,
          attackerCostPct: attacker.pctOfSupplyToPass,
          controllingHoldersVotedFor,
          recommendation: recommend(verdict, floorPct, treasuryTouching),
        };

        const lines = [
          `Risk assessment for ${govPool}${proposalId !== undefined ? ` proposal #${proposalId}` : " (hypothetical actions)"}`,
          `  verdict: ${verdict}  (quorum=${Number.isFinite(quorumPct) ? `${quorumPct}%` : "?"}, floor=${floorPct}%, quorumVerdict=${quorumVerdict})`,
          `  treasury-touching: ${treasuryTouching} (${treasuryHits.length} hit${treasuryHits.length === 1 ? "" : "s"})`,
          attacker.pctOfSupplyToPass !== null
            ? `  attacker cost: ~${attacker.pctOfSupplyToPass}% of token supply to pass alone (indicative lower-bound)`
            : `  attacker cost: unknown (supply/weight unavailable)`,
          treasuryAtRisk.length > 0
            ? `  treasury at risk: ${treasuryAtRisk.map((t) => `${t.symbol ?? "?"}=${t.balance ?? "?"}`).join(", ")}`
            : "",
          `  controlling-holders voted For: ${controllingHoldersVotedFor === null ? "unknown (no subgraph)" : controllingHoldersVotedFor}`,
          ``,
          structured.recommendation,
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: structured };
      } catch (err) {
        return errorResult(`risk_assess failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
