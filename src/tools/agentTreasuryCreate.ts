import { z } from "zod";
import { isAddress, parseUnits, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteToolContext } from "./writeContext.js";
import type { SignerManager } from "../lib/signer.js";
import { resolveChain } from "../config.js";
import { flowContextSchema } from "../lib/flowChain.js";
import { signerKeyParam } from "../lib/writeParams.js";
import { safeErrorMessage } from "../lib/redact.js";
import {
  AGENT_MAX,
  AGENT_MIN,
  agentTreasuryGuarantees,
  computeAgentShares,
  defaultApprovals,
} from "../lib/agentTreasury.js";
import { DAO_CREATE_SHAPE, type DaoCreateRunner } from "./daoCreate.js";

const PCT_25DEC = 10n ** 25n;
const ONE_TOKEN = 10n ** 18n;
const TOOL = "dexe_agent_treasury_create";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Input shape of dexe_agent_treasury_create. A function, not a const: it reuses
 * dexe_dao_create's field schemas, and daoCreate.ts imports this module, so a
 * top-level read of DAO_CREATE_SHAPE would hit the import cycle before
 * daoCreate.ts has initialised it.
 */
export function agentTreasuryShape() {
  return {
    chainId: DAO_CREATE_SHAPE.chainId,
    deployer: DAO_CREATE_SHAPE.deployer,
    daoName: DAO_CREATE_SHAPE.daoName,
    symbol: z.string().min(1).describe("Gov token symbol (e.g. 'AGT'). The validator token becomes '<symbol>-VT'."),
    totalSupply: z.string().default("1000000").describe("Gov token supply in WHOLE tokens. Default '1000000'."),
    daoDescription: DAO_CREATE_SHAPE.daoDescription,
    agents: z
      .array(
        z.object({
          address: z.string().describe("Agent wallet; receives an equal share of the supply."),
          role: z.string().min(1).max(80).describe("What this agent does, e.g. 'treasurer'. Pinned in DAO metadata."),
          scope: z.string().max(200).optional().describe("Optional note on what the agent may propose."),
        }),
      )
      .min(AGENT_MIN)
      .max(AGENT_MAX)
      .describe(`${AGENT_MIN}..${AGENT_MAX} AI agent wallets, distinct and non-zero.`),
    approvalsNeeded: z
      .number()
      .int()
      .optional()
      .describe("k: agents voting FOR that pass a proposal alone; 2..n. Default floor(n/2)+1."),
    humanValidators: z
      .array(z.object({ address: z.string().describe("Human validator wallet.") }))
      .min(1)
      .max(5)
      .describe("1..5 human wallets seated as validators at deploy (1 validator token each). They veto."),
    quorumPercent: z.number().gt(0).max(100).default(50).describe("Member quorum, % of supply. Default 50."),
    validatorQuorumPercent: z
      .number()
      .gt(0)
      .max(100)
      .default(50)
      .describe("Validator-round quorum, % of validator tokens. Default 50."),
    agentVoteSeconds: z.number().int().positive().default(3600).describe("Member (agent) voting window. Default 3600."),
    validatorVoteSeconds: z
      .number()
      .int()
      .positive()
      .default(86400)
      .describe("Validator-round window. Default 86400."),
    executionDelaySeconds: z.number().int().min(0).default(0).describe("Delay before execution. Default 0."),
    monthlyBudget: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional()
      .describe("Optional monthly credit, WHOLE gov tokens; returns the validators_allocation proposal recipe."),
    confirmRisky: DAO_CREATE_SHAPE.confirmRisky,
    confirm: DAO_CREATE_SHAPE.confirm,
    dryRun: DAO_CREATE_SHAPE.dryRun,
    signerKey: signerKeyParam,
    flowContext: flowContextSchema,
  };
}

export type AgentTreasuryInput = z.infer<z.ZodObject<ReturnType<typeof agentTreasuryShape>>>;

const isZero = (a: string) => a.toLowerCase() === ZeroAddress.toLowerCase();

function checkAddresses(list: string[], label: string): string | undefined {
  const seen = new Set<string>();
  for (const [i, a] of list.entries()) {
    if (!isAddress(a)) return `${label}[${i}]: invalid address ${a}`;
    if (isZero(a)) return `${label}[${i}]: the zero address cannot hold tokens`;
    const key = a.toLowerCase();
    if (seen.has(key)) return `${label}[${i}]: duplicate address ${a}`;
    seen.add(key);
  }
  return undefined;
}

/** Deployment recipe for the monthly budget: one validators_allocation proposal. */
export function budgetRecipe(args: {
  monthlyBudget: string;
  chainId: number;
  govPool?: string | null;
  govToken?: string;
  symbol: string;
}): Record<string, unknown> {
  const amountWei = parseUnits(args.monthlyBudget, 18).toString();
  return {
    tool: "dexe_proposal_create",
    args: {
      govPool: args.govPool ?? "<predictedGovPool from the deploy result>",
      chainId: args.chainId,
      proposalType: "validators_allocation",
      title: `Monthly budget: ${args.monthlyBudget} ${args.symbol}`,
      params: {
        credits: [{ token: args.govToken ?? "<predicted.govToken from the deploy result>", amount: amountWei }],
      },
    },
    amountHuman: `${args.monthlyBudget} ${args.symbol} (${amountWei} wei)`,
    notes: [
      "Agents must deposit their tokens into the DAO before they can create or vote (dexe_proposal_create and " +
        "dexe_proposal_vote_and_execute deposit for you).",
      "This sets the treasury credit line that internal monthly_withdraw proposals draw against; it replaces the " +
        "whole credit list on execute.",
      "Like every member proposal it goes through the validator round: the human validators must vote it through " +
        "before it can execute.",
    ],
  };
}

export function registerAgentTreasuryCreateTool(
  server: McpServer,
  ctx: WriteToolContext,
  _signer: SignerManager,
  runDaoCreate: DaoCreateRunner,
): void {
  server.tool(
    TOOL,
    "Broadcasts when a signer is configured. Deploys a DAO whose treasury n AI agents run k-of-n, with human " +
      "validators as a veto. Each agent gets an equal token share sized so k agents voting FOR reach quorum and " +
      "k-1 do not; the rest stays in the treasury. Validators are seated at deploy, so every proposal also needs " +
      "the validator round. Same guards and preview/confirm posture as dexe_dao_create.",
    agentTreasuryShape(),
    async (raw) => {
      const input = raw as AgentTreasuryInput;
      const n = input.agents.length;
      const agentAddrs = input.agents.map((a) => a.address);
      const validatorAddrs = input.humanValidators.map((v) => v.address);
      const badAgent = checkAddresses(agentAddrs, "agents");
      if (badAgent) return err(badAgent);
      const badValidator = checkAddresses(validatorAddrs, "humanValidators");
      if (badValidator) return err(badValidator);

      const floorPct = ctx.config.minSafeQuorumPct;
      if (input.quorumPercent < floorPct) {
        return err(
          `quorumPercent ${input.quorumPercent} is below this server's ${floorPct}% safety floor ` +
            `(DEXE_MIN_SAFE_QUORUM_PCT). Use ≥ ${floorPct}.`,
        );
      }
      const k = input.approvalsNeeded ?? defaultApprovals(n);
      const sharesRes = computeAgentShares(n, k, input.quorumPercent);
      if (!sharesRes.ok) return err(sharesRes.reason);
      const sh = sharesRes.shares;

      let budgetWei: bigint | undefined;
      if (input.monthlyBudget !== undefined) {
        try {
          budgetWei = parseUnits(input.monthlyBudget, 18);
          if (budgetWei <= 0n) return err("monthlyBudget must be > 0.");
        } catch (e) {
          return err(`monthlyBudget: ${safeErrorMessage(e)}`);
        }
      }

      let supplyWei: bigint;
      try {
        supplyWei = parseUnits(input.totalSupply, 18);
      } catch (e) {
        return err(`totalSupply: ${safeErrorMessage(e)}`);
      }
      const shareWei = (supplyWei * BigInt(sh.shareBps)) / 10000n;
      const treasuryWei = supplyWei - shareWei * BigInt(n);
      const tokens = (wei: bigint) => (wei / ONE_TOKEN).toString() + (wei % ONE_TOKEN === 0n ? "" : "+");

      const overlap = agentAddrs.filter((a) => validatorAddrs.some((v) => v.toLowerCase() === a.toLowerCase()));
      const warnings: string[] = [];
      if (overlap.length) {
        warnings.push(
          `${overlap.join(", ")} is both an agent and a validator: that wallet can approve its own proposals in ` +
            `the veto round. Use separate human wallets for the validators.`,
        );
      }
      if (budgetWei !== undefined && budgetWei > treasuryWei) {
        warnings.push(
          `monthlyBudget ${input.monthlyBudget} ${input.symbol} exceeds the whole treasury ` +
            `(${tokens(treasuryWei)} ${input.symbol}).`,
        );
      }

      const m = validatorAddrs.length;
      const chainId = resolveChain(ctx.config, input.chainId).chainId;
      const guarantees = agentTreasuryGuarantees(sh, m);
      const summary = {
        preset: "agent-treasury",
        kOfN: `${k}-of-${n}`,
        agents: input.agents.map((a) => ({
          address: a.address,
          role: a.role,
          ...(a.scope ? { scope: a.scope } : {}),
          sharePercent: sh.sharePct,
          tokens: tokens(shareWei),
        })),
        treasury: { percent: sh.treasuryPct, tokens: tokens(treasuryWei) },
        quorum: {
          memberPercent: input.quorumPercent,
          kForPercent: sh.kForPct,
          kMinusOneForPercent: sh.kMinusOneForPct,
          requiredTurnoutPercent: sh.requiredTurnoutPct,
          ...(sh.raisedForTurnout
            ? { note: `share raised above ${sh.bounds.lo / 100}% so the quorum passes the turnout-margin rule` }
            : {}),
        },
        validators: {
          seated: validatorAddrs,
          tokenEach: "1",
          validatorQuorumPercent: input.validatorQuorumPercent,
          validatorsNeededApprox: Math.max(1, Math.ceil((m * input.validatorQuorumPercent) / 100)),
        },
        durations: {
          agentVoteSeconds: input.agentVoteSeconds,
          validatorVoteSeconds: input.validatorVoteSeconds,
          executionDelaySeconds: input.executionDelaySeconds,
        },
        guarantees,
        ...(warnings.length ? { presetWarnings: warnings } : {}),
      };

      let daoInput;
      try {
        daoInput = z.object(DAO_CREATE_SHAPE).parse({
          ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
          ...(input.deployer !== undefined ? { deployer: input.deployer } : {}),
          daoName: input.daoName,
          daoDescription: input.daoDescription,
          symbol: input.symbol,
          totalSupply: input.totalSupply,
          treasuryPercent: sh.treasuryBps / 100,
          quorumPercent: input.quorumPercent,
          voteModel: "LINEAR",
          durationSeconds: input.agentVoteSeconds,
          executionDelaySeconds: input.executionDelaySeconds,
          recipients: input.agents.map((a) => ({ address: a.address, percent: sh.shareBps / 100 })),
          confirmRisky: input.confirmRisky,
          confirm: input.confirm,
          dryRun: input.dryRun,
          ...(input.signerKey !== undefined ? { signerKey: input.signerKey } : {}),
          ...(input.flowContext !== undefined ? { flowContext: input.flowContext } : {}),
        });
      } catch (e) {
        return err(`Could not assemble the deploy: ${safeErrorMessage(e)}`);
      }

      const validatorQuorumRaw = (
        (BigInt(Math.round(input.validatorQuorumPercent * 1_000_000)) * PCT_25DEC) /
        1_000_000n
      ).toString();
      const budgetHint =
        input.monthlyBudget !== undefined
          ? `After the deploy, set the monthly budget with the dexe_proposal_create call in agentTreasury.budgetRecipe ` +
            `(the deploy result fills in the real govPool and token).`
          : undefined;

      return runDaoCreate(daoInput, {
        tool: TOOL,
        validatorsParams: {
          name: input.daoName,
          symbol: input.symbol,
          proposalSettings: {
            duration: String(input.validatorVoteSeconds),
            executionDelay: String(input.executionDelaySeconds),
            quorum: validatorQuorumRaw,
          },
          validators: validatorAddrs,
          balances: validatorAddrs.map(() => ONE_TOKEN.toString()),
        },
        durationValidatorsSeconds: input.validatorVoteSeconds,
        quorumValidatorsPercent: input.validatorQuorumPercent,
        metadataExtra: {
          preset: "agent-treasury",
          presetVersion: 1,
          agents: input.agents.map((a) => ({ address: a.address, role: a.role })),
        },
        previewExtra: {
          agentTreasury: {
            ...summary,
            ...(input.monthlyBudget !== undefined
              ? { budgetRecipe: budgetRecipe({ monthlyBudget: input.monthlyBudget, chainId, symbol: input.symbol }) }
              : {}),
          },
        },
        ...(budgetHint ? { previewNextExtra: budgetHint } : {}),
        resultExtra: (predicted) => ({
          agentTreasury: summary,
          ...(input.monthlyBudget !== undefined
            ? (() => {
                const recipe = budgetRecipe({
                  monthlyBudget: input.monthlyBudget!,
                  chainId,
                  govPool: predicted.govPool,
                  ...(predicted.govToken ? { govToken: predicted.govToken } : {}),
                  symbol: input.symbol,
                });
                return {
                  budgetRecipe: recipe,
                  next:
                    `Agents deposit their tokens, then create the monthly budget proposal: dexe_proposal_create ` +
                    `${JSON.stringify(recipe.args)}. It goes through the validator round like every proposal.`,
                };
              })()
            : {}),
        }),
      });
    },
  );
}
