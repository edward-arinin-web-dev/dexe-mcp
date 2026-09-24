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
  quorumConcentration,
  worstRisk,
  type RiskLevel,
} from "../lib/quorumRisk.js";
import {
  classifyGovernanceActions,
  governanceVerdict,
  type GovernanceHit,
} from "../lib/buildAdvisories.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";
import { resolveControllingHoldersVotedFor } from "../lib/controllingVoters.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/errors.js";
import { renderUntrusted, untrustedResult } from "../lib/sanitize.js";

/**
 * Layer 6 — `dexe_proposal_risk_assess`. A treasury-safety risk readout for a
 * proposal, addressed to whoever votes / creates / executes it. Read-only;
 * assesses either an on-chain
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
  executor: z.string().describe("Target contract the action calls."),
  value: z.string().default("0").describe("Native coin sent with the call, in wei."),
  data: z.string().default("0x").describe("ABI-encoded calldata, 0x-hex."),
});

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Exported for unit test: the no-treasury branch used to assert safety
 * ("Standard governance review applies") for ANY proposal the six-selector
 * treasury table did not recognise — including `blacklist([govPool], true)`,
 * which permanently freezes the treasury. Absence of a recognised selector is
 * absence of INFORMATION, not absence of risk, and `verdict: "SAFE"` is what an
 * agent branches on.
 */
export function recommend(
  verdict: RiskLevel,
  floorPct: number,
  treasuryTouching: boolean,
  governanceHits: readonly GovernanceHit[] = [],
  /**
   * The verdict of the TREASURY leg alone (quorum + concentration). Defaults to
   * `verdict` for callers that have no separate figure. The merged verdict used
   * to be fed to the treasury sentence, so a governance DANGER printed
   * "treasury-moving under a low quorum" beside `quorumVerdict: SAFE`.
   */
  treasuryVerdict: RiskLevel = verdict,
): string {
  const govLine = governanceRecommendation(governanceHits, treasuryTouching);
  // Sentences are joined with a space, not a blank line: `structuredContent`
  // is deep-sanitized on the way out and a newline there renders as a literal
  // `\x0a`, which is what the agent — and the user — saw.
  if (!treasuryTouching) {
    const base =
      "No treasury-moving action detected (no ERC20 approve/transfer/transferFrom or native value). " +
      "This tool classifies a fixed selector set — an unrecognised call is UNASSESSED, not proven safe. " +
      "Review the actions themselves (dexe_decode_proposal) before voting or executing.";
    return govLine ? `${govLine} ${base}` : base;
  }
  const treasury = recommendTreasury(treasuryVerdict, floorPct);
  return govLine ? `${govLine} ${treasury}` : treasury;
}

function governanceRecommendation(hits: readonly GovernanceHit[], treasuryTouching = false): string | null {
  if (hits.length === 0) return null;
  const owned = hits.filter((h) => h.protocolTargets.length > 0);
  const unknown = hits.filter((h) => h.kind === "unknownPrivileged");
  const parts: string[] = [];
  // The governance leg is scored independently of the treasury leg; say which
  // one this sentence is about instead of asserting "moves no treasury value"
  // beside a treasury hit in the same readout.
  const scope = treasuryTouching
    ? "This is separate from the treasury movement assessed below — the quorum model covers that movement, not this call."
    : "It moves no treasury value, so the quorum model below does not apply.";
  if (owned.length > 0) {
    parts.push(
      `DANGER: this proposal calls ${[...new Set(owned.map((h) => h.kind))].join(", ")} targeting the DAO's own ` +
        `contract(s) ${[...new Set(owned.flatMap((h) => h.protocolTargets))].join(", ")}. ${scope} A passing vote ` +
        `can permanently disable governance or freeze the treasury. Verify the target address before voting FOR.`,
    );
  } else {
    parts.push(
      `CAUTION: this proposal changes DAO governance (${[...new Set(hits.map((h) => h.kind))].join(", ")}). ` +
        `${scope} Review the change itself.`,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `It also calls a DAO contract with a selector this tool does not recognise: UNASSESSED, not proven safe.`,
    );
  }
  return parts.join(" ");
}

function recommendTreasury(verdict: RiskLevel, floorPct: number): string {
  if (verdict === "DANGER") {
    return `HIGH RISK: this is a treasury-moving proposal under a low quorum. Confirm quorum ≥${floorPct}% AND participation by key stakeholders (validators / majority holders) before executing. Responsibility rests with the voter/creator/executor.`;
  }
  if (verdict === "CAUTION") {
    return `CAUTION: treasury-moving with quorum near or below the ${floorPct}% floor, or supply concentration unknown. Verify stakeholder participation before executing.`;
  }
  return `Quorum ≥${floorPct}% — a true majority is required to pass. Still confirm the recipient and amounts before executing.`;
}

export function registerRiskTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_proposal_risk_assess",
    {
      title: "Treasury-safety risk readout for a proposal (or hypothetical actions)",
      description:
        "Read-only. Assesses low-quorum treasury risk and privileged no-value governance calls (blacklist, pause, " +
        "changeVotePower, add/editSettings, changeExecutors, changeBalances). SAFE means 'no risk of the kinds this tool " +
        "classifies', never 'this proposal is safe'.",
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
        governanceHits: z.array(
          z.object({
            index: z.number(),
            executor: z.string(),
            selector: z.string().nullable(),
            kind: z.string(),
            protocolTargets: z.array(z.string()),
          }),
        ),
        totalSupply: z.string().nullable(),
        requiredWeight: z.string().nullable(),
        quorumSupplyPct: z.number().nullable(),
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
        return errorResult(safeErrorMessage(e));
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
        // The five-field return was being narrowed to two, so the DAO's own
        // validators / poolRegistry / votePower were invisible to every check
        // downstream. GOV_POOL_ABI declares all five and multicall returns the
        // full Result for a multi-output call, so this costs no extra RPC.
        const helpers = resA[0]!.value as unknown as {
          settings: string;
          userKeeper: string;
          validators: string;
          poolRegistry: string;
          votePower: string;
        };

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

        // ---- quorum-concentration metric ----
        const qConc = quorumConcentration({
          quorumPct,
          floorPct,
          totalSupply: totalSupply ?? undefined,
          requiredWeight: requiredWeight ?? undefined,
          // hypothetical: approximate total vote weight by total supply (indicative).
          totalVoteWeight: requiredWeight === null ? totalSupply ?? undefined : undefined,
        });

        // Founder/validator participation signal. On-chain proposal only —
        // a hypothetical actions[] assessment has no voters. Subgraph/mainnet-only;
        // null = unknown (never forces a refuse).
        const controllingHoldersVotedFor =
          proposalId !== undefined
            ? await resolveControllingHoldersVotedFor({
                provider,
                govPool,
                proposalId,
                cfg: ctx.config,
                chainId: chain.chainId,
              })
            : null;

        // Privileged governance calls that move NO treasury value — blacklist,
        // pause, changeVotePower, addSettings/editSettings, changeExecutors,
        // changeBalances — are invisible to the six-selector treasury table, so
        // `blacklist([govPool], true)` scored SAFE with "Standard governance
        // review applies" while permanently freezing the treasury. Selector
        // match comes FIRST and is independent of the executor, so a failed
        // `tokenAddress()` read can never silently downgrade a finding.
        const protocolAddresses = [
          govPool,
          helpers.settings,
          helpers.userKeeper,
          helpers.validators,
          helpers.poolRegistry,
          helpers.votePower,
          govToken,
        ].filter(
          (a): a is string =>
            typeof a === "string" &&
            isAddress(a) &&
            a !== "0x0000000000000000000000000000000000000000",
        );
        const governanceHits = classifyGovernanceActions(assessedActions, { protocolAddresses });
        const govV = governanceVerdict(governanceHits);

        const treasuryVerdict: RiskLevel = treasuryTouching ? worstRisk(quorumVerdict, qConc.verdict) : "SAFE";
        const verdict: RiskLevel = worstRisk(treasuryVerdict, govV);

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
          quorumSupplyPct: qConc.pctOfSupplyForQuorum,
          controllingHoldersVotedFor,
          governanceHits: governanceHits.map((h) => ({
            index: h.index,
            executor: h.executor,
            selector: h.selector,
            kind: h.kind,
            protocolTargets: h.protocolTargets,
          })),
          recommendation: recommend(verdict, floorPct, treasuryTouching, governanceHits, treasuryVerdict),
        };

        const lines = [
          `Risk assessment for ${govPool}${proposalId !== undefined ? ` proposal #${proposalId}` : " (hypothetical actions)"}`,
          `  verdict: ${verdict}  (quorum=${Number.isFinite(quorumPct) ? `${quorumPct}%` : "?"}, floor=${floorPct}%, quorumVerdict=${quorumVerdict})`,
          `  treasury-touching: ${treasuryTouching} (${treasuryHits.length} hit${treasuryHits.length === 1 ? "" : "s"})`,
          qConc.pctOfSupplyForQuorum !== null
            ? `  quorum threshold: ~${qConc.pctOfSupplyForQuorum}% of token supply required to meet quorum (indicative)`
            : `  quorum threshold: unknown (supply/weight unavailable)`,
          treasuryAtRisk.length > 0
            ? // `symbol()` is whatever the token's deployer chose to return, and a
              // treasury row lists tokens anyone can airdrop in. Rendered raw it
              // forges lines in this readout (a newline paints a second
              // "treasury at risk" entry) — so it goes through the same
              // `renderUntrusted` that `dexe_read_treasury` uses on the
              // identical field.
              `  treasury at risk: ${treasuryAtRisk
                .map((t) => `${t.symbol != null ? renderUntrusted(t.symbol, 40) : "?"}=${t.balance ?? "?"}`)
                .join(", ")}`
            : "",
          governanceHits.length > 0
            ? // Deliberately NOT the phrase "treasury at risk": a prompt-injection
              // test counts lines carrying it and asserts there is exactly one.
              `  governance calls: ${governanceHits
                .map(
                  (h) =>
                    `${h.kind}[${h.index}]${h.protocolTargets.length > 0 ? ` → DAO-owned ${h.protocolTargets.join(", ")}` : ""}`,
                )
                .join(", ")}`
            : "",
          `  controlling-holders voted For: ${controllingHoldersVotedFor === null ? "unknown (no subgraph)" : controllingHoldersVotedFor}`,
          ``,
          structured.recommendation,
        ].filter(Boolean);

        // Same funnel `dexe_read_treasury` uses: the prose above is
        // server-authored except for the symbols, which are already rendered
        // through `renderUntrusted`, and `structuredContent` carries those same
        // symbols — so the payload is deep-sanitized and announced rather than
        // handed over raw beside escaped prose.
        return untrustedResult({
          summary: lines.join("\n"),
          label: "treasury token symbols (chosen by each token's deployer)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_proposal_risk_assess").message);
      }
    },
  );
}
