import { z } from "zod";
import { Contract, formatUnits, getAddress, getCreateAddress, isAddress, parseUnits, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteToolContext } from "./writeContext.js";
import type { SignerManager } from "../lib/signer.js";
import { resolveChain } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
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
import {
  encodeLaneDeploy,
  FAST_LANE_ABI,
  FAST_LANE_SOURCE_SHA256,
  fastLaneChainRefusal,
  fastLaneGuarantees,
  fastLaneSettings,
  FAST_LANE_WINDOW_DAYS,
  payProposalRecipe,
  resolveFastLaneConfig,
  type FastLaneConfig,
} from "../lib/agentFastLane.js";
import { DAO_CREATE_SHAPE, type DaoCreateExtras, type DaoCreateRunner } from "./daoCreate.js";

const PCT_25DEC = 10n ** 25n;
const ONE_TOKEN = 10n ** 18n;
const TOOL = "dexe_agent_treasury_create";
const LANE_LABEL = "agentFastLane";

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
    fastLane: z
      .object({
        perPaymentCap: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Largest single fast-lane payment, WHOLE gov tokens."),
        windowCap: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe(`Largest fast-lane total over any rolling ${FAST_LANE_WINDOW_DAYS} days, WHOLE gov tokens.`),
        allowlist: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Recipients the fast lane may pay. Adding more later is a validator-round proposal."),
        floatPercent: z
          .number()
          .gt(0)
          .max(50)
          .default(1)
          .describe(
            "Share of the supply minted to the lane as its float, % with ≤2 decimals, taken OUT of the treasury. " +
              "Default 1. The lane can never pay more than it holds.",
          ),
        voteSeconds: z
          .number()
          .int()
          .positive()
          .default(600)
          .describe("Agent voting window of a fast-lane proposal (early completion is on). Default 600."),
        existingLane: z
          .string()
          .optional()
          .describe(
            "An AgentFastLane already deployed for THIS deployer + daoName (its govPool() must equal the " +
              "predicted govPool). Use it to resume after a failed DAO deploy, or when no hot key can deploy the lane.",
          ),
      })
      .optional()
      .describe(
        "TESTNET ONLY (chain 97). Adds a capped petty-cash lane: small allowlisted payments pass on the agents' " +
          "k-of-n vote alone, with no validator round. Deploys contracts/AgentFastLane.sol (unaudited) and binds it " +
          "as an executor with its own fast settings at deploy — SphereX blocks changeExecutors on 97, so this " +
          "cannot be added to an existing DAO. See docs/AGENT-TREASURY.md.",
      ),
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

const PREDICT_ABI = [
  "function predictGovAddresses(address deployer, string poolName) view returns (tuple(address govPool, address govTokenSale, address govToken, address distributionProposal, address expertNft, address nftMultiplier))",
];

interface LanePlan {
  cfg: FastLaneConfig;
  floatBps: number;
  floatWei: bigint;
  predicted: { govPool: string; govToken: string };
  /** The lane address the deploy is assembled against. */
  address: string;
  /** How `address` was obtained. */
  source: "existing" | "predicted-create" | "deployed";
  warnings: string[];
}

export function registerAgentTreasuryCreateTool(
  server: McpServer,
  ctx: WriteToolContext,
  signer: SignerManager,
  runDaoCreate: DaoCreateRunner,
): void {
  const rpc = new RpcProvider(ctx.config);

  server.tool(
    TOOL,
    "Broadcasts when a signer is configured. Deploys a DAO whose treasury n AI agents run k-of-n, with human " +
      "validators as a veto. Each agent gets an equal token share sized so k agents voting FOR reach quorum and " +
      "k-1 do not; the rest stays in the treasury. Validators are seated at deploy, so every proposal also needs " +
      "the validator round — except, with `fastLane` (TESTNET ONLY), small allowlisted payments through the " +
      "capped AgentFastLane executor, which pass on the agents' vote alone. Same guards and preview/confirm " +
      "posture as dexe_dao_create.",
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
      const tokens = (wei: bigint) => (wei / ONE_TOKEN).toString() + (wei % ONE_TOKEN === 0n ? "" : "+");

      const overlap = agentAddrs.filter((a) => validatorAddrs.some((v) => v.toLowerCase() === a.toLowerCase()));
      const warnings: string[] = [];
      if (overlap.length) {
        warnings.push(
          `${overlap.join(", ")} is both an agent and a validator: that wallet can approve its own proposals in ` +
            `the veto round. Use separate human wallets for the validators.`,
        );
      }

      const m = validatorAddrs.length;
      const chainId = resolveChain(ctx.config, input.chainId).chainId;
      const deployer =
        input.deployer ?? (signer.hasSigner(input.signerKey) ? signer.getAddress(input.signerKey) : undefined);

      // ---------- fast lane: config, chain fence, address ----------
      let lane: LanePlan | undefined;
      if (input.fastLane) {
        const refusal = fastLaneChainRefusal(chainId);
        if (refusal) return err(refusal);
        const fl = input.fastLane;
        const cfgRes = resolveFastLaneConfig({
          perPaymentCap: fl.perPaymentCap,
          windowCap: fl.windowCap,
          allowlist: fl.allowlist,
          voteSeconds: fl.voteSeconds,
        });
        if (!cfgRes.ok) return err(cfgRes.reason);
        const floatBps = Math.round(fl.floatPercent * 100);
        if (Math.abs(fl.floatPercent * 100 - floatBps) > 1e-9 || floatBps <= 0) {
          return err(`fastLane.floatPercent must be a positive percent with at most 2 decimals (got ${fl.floatPercent}).`);
        }
        if (floatBps >= sh.treasuryBps) {
          return err(
            `fastLane.floatPercent ${fl.floatPercent}% must stay below the treasury share ` +
              `(${sh.treasuryPct}% after the agents' ${n} × ${sh.sharePct}%): the float comes out of the treasury.`,
          );
        }
        const floatWei = (supplyWei * BigInt(floatBps)) / 10000n;
        const laneWarnings: string[] = [];
        if (cfgRes.config.windowCapWei > floatWei) {
          laneWarnings.push(
            `The ${FAST_LANE_WINDOW_DAYS}-day cap (${fl.windowCap} ${input.symbol}) exceeds the float ` +
              `(${formatUnits(floatWei, 18)} ${input.symbol}); the float is the binding limit until a ` +
              `validator-round proposal tops it up.`,
          );
        }
        if (cfgRes.config.allowlist.some((a) => agentAddrs.some((g) => g.toLowerCase() === a.toLowerCase()))) {
          laneWarnings.push(
            "An agent wallet is on the fast-lane allowlist: the agents can pay themselves up to the caps with no " +
              "human in the loop. Intentional only if the caps are the whole point.",
          );
        }
        if (!deployer) {
          return err(
            "Provide 'deployer' address, or connect a signer (dexe_wc_connect, or DEXE_SIGNER_MODE=unattended + DEXE_PRIVATE_KEY).",
          );
        }

        // The lane's constructor pins the GovPool, so the DAO's addresses are
        // predicted first (create2 by deployer + name: nonce-independent).
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        let predicted: { govPool: string; govToken: string };
        try {
          const book = new AddressBook({ provider, chainId, registryOverride: ctx.config.registryOverride });
          const factory = new Contract(await book.resolve(CONTRACT_NAMES.POOL_FACTORY), PREDICT_ABI, provider);
          const res = await factory.getFunction("predictGovAddresses").staticCall(deployer, input.daoName);
          predicted = { govPool: getAddress(res.govPool as string), govToken: getAddress(res.govToken as string) };
        } catch (e) {
          return err(`fastLane: could not predict the DAO addresses the lane binds to: ${safeErrorMessage(e)}`);
        }

        if (fl.existingLane !== undefined) {
          if (!isAddress(fl.existingLane)) return err(`fastLane.existingLane: invalid address ${fl.existingLane}`);
          const address = getAddress(fl.existingLane);
          const check = await verifyExistingLane(provider, address, predicted, cfgRes.config);
          if (check) return err(`fastLane.existingLane ${address}: ${check}`);
          lane = { cfg: cfgRes.config, floatBps, floatWei, predicted, address, source: "existing", warnings: laneWarnings };
        } else {
          // Not deployed yet: the address is CREATE(signer, pending nonce). It
          // holds only while the signer sends nothing else in between — the
          // confirm path re-predicts right before deploying.
          const hot = signer.hasSigner(input.signerKey) ? signer.trySigner(chainId, input.signerKey) : undefined;
          if (!hot || "error" in hot) {
            return err(
              `fastLane needs a hot key to deploy AgentFastLane.sol (there is no calldata-only path for a contract ` +
                `creation)${hot && "error" in hot ? `: ${hot.error}` : ""}. Either run with DEXE_SIGNER_MODE=unattended ` +
                `on testnet 97, or deploy the lane yourself and pass fastLane.existingLane.`,
            );
          }
          let address: string;
          try {
            const nonce = await hot.ok.provider!.getTransactionCount(hot.ok.address, "pending");
            address = getCreateAddress({ from: hot.ok.address, nonce });
          } catch (e) {
            return err(`fastLane: could not predict the lane address (nonce read failed): ${safeErrorMessage(e)}`);
          }
          lane = { cfg: cfgRes.config, floatBps, floatWei, predicted, address, source: "predicted-create", warnings: laneWarnings };
        }
      }

      const treasuryBps = sh.treasuryBps - (lane?.floatBps ?? 0);
      const treasuryWei = supplyWei - shareWei * BigInt(n) - (lane?.floatWei ?? 0n);
      if (budgetWei !== undefined && budgetWei > treasuryWei) {
        warnings.push(
          `monthlyBudget ${input.monthlyBudget} ${input.symbol} exceeds the whole treasury ` +
            `(${tokens(treasuryWei)} ${input.symbol}).`,
        );
      }

      const guarantees = agentTreasuryGuarantees(sh, m);
      if (lane) {
        // The float comes out of the treasury: say the share that actually stays.
        guarantees.treasury =
          `${treasuryBps / 100}% of the supply stays in the DAO treasury and is never votable; it moves only through ` +
          `proposals that pass both rounds. The lane's ${lane.floatBps / 100}% float is outside the treasury and ` +
          `capped by the lane.`;
      }
      const laneSummary = (l: LanePlan) => ({
        address: l.address,
        addressSource:
          l.source === "existing"
            ? "existing lane, verified on-chain"
            : l.source === "deployed"
              ? "deployed by this call"
              : "predicted CREATE address (signer + pending nonce); final once the lane is deployed on confirm",
        token: l.predicted.govToken,
        govPool: l.predicted.govPool,
        perPaymentCap: `${input.fastLane!.perPaymentCap} ${input.symbol}`,
        windowCap: `${input.fastLane!.windowCap} ${input.symbol} per rolling ${FAST_LANE_WINDOW_DAYS} days`,
        float: { percent: l.floatBps / 100, tokens: tokens(l.floatWei) },
        allowlist: l.cfg.allowlist,
        voteSeconds: l.cfg.voteSeconds,
        settingsSlot: 5,
        guarantees: fastLaneGuarantees({
          perPaymentCap: input.fastLane!.perPaymentCap,
          windowCap: input.fastLane!.windowCap,
          symbol: input.symbol,
          allowlistCount: l.cfg.allowlist.length,
          voteSeconds: l.cfg.voteSeconds,
        }),
        ...(l.warnings.length ? { warnings: l.warnings } : {}),
      });
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
        treasury: { percent: treasuryBps / 100, tokens: tokens(treasuryWei) },
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
        ...(lane ? { fastLane: laneSummary(lane) } : {}),
        ...(warnings.length ? { presetWarnings: warnings } : {}),
      };

      const assembleDaoInput = (laneAddress: string | undefined, over: { dryRun?: boolean; confirm?: boolean } = {}) =>
        z.object(DAO_CREATE_SHAPE).parse({
          ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
          ...(input.deployer !== undefined ? { deployer: input.deployer } : {}),
          daoName: input.daoName,
          daoDescription: input.daoDescription,
          symbol: input.symbol,
          totalSupply: input.totalSupply,
          treasuryPercent: treasuryBps / 100,
          quorumPercent: input.quorumPercent,
          voteModel: "LINEAR",
          durationSeconds: input.agentVoteSeconds,
          executionDelaySeconds: input.executionDelaySeconds,
          recipients: [
            ...input.agents.map((a) => ({ address: a.address, percent: sh.shareBps / 100 })),
            ...(lane && laneAddress ? [{ address: laneAddress, percent: lane.floatBps / 100 }] : []),
          ],
          confirmRisky: input.confirmRisky,
          confirm: over.confirm ?? input.confirm,
          dryRun: over.dryRun ?? input.dryRun,
          ...(input.signerKey !== undefined ? { signerKey: input.signerKey } : {}),
          ...(input.flowContext !== undefined ? { flowContext: input.flowContext } : {}),
        });

      const validatorQuorumRaw = (
        (BigInt(Math.round(input.validatorQuorumPercent * 1_000_000)) * PCT_25DEC) /
        1_000_000n
      ).toString();
      const budgetHint =
        input.monthlyBudget !== undefined
          ? `After the deploy, set the monthly budget with the dexe_proposal_create call in agentTreasury.budgetRecipe ` +
            `(the deploy result fills in the real govPool and token).`
          : undefined;
      const laneHint = lane
        ? `Fast-lane payments: dexe_agent_fast_lane_build_pay checks a payment against the lane and returns the ` +
          `dexe_proposal_create call (custom_abi, lane.pay) that needs only the agents' vote.`
        : undefined;
      const nextExtra = [budgetHint, laneHint].filter(Boolean).join(" ");

      const extrasFor = (l: LanePlan | undefined): DaoCreateExtras => ({
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
          ...(l
            ? {
                fastLane: {
                  address: l.address,
                  token: l.predicted.govToken,
                  perPaymentCapWei: l.cfg.perPaymentCapWei.toString(),
                  windowCapWei: l.cfg.windowCapWei.toString(),
                  windowDays: FAST_LANE_WINDOW_DAYS,
                  allowlist: l.cfg.allowlist,
                  voteSeconds: l.cfg.voteSeconds,
                  contract: "AgentFastLane.sol",
                  sourceSha256: FAST_LANE_SOURCE_SHA256,
                  testnetOnly: true,
                },
              }
            : {}),
        },
        ...(l
          ? {
              extraExecutors: [
                { executor: l.address, label: LANE_LABEL, settings: (d) => fastLaneSettings(d, l.cfg.voteSeconds) },
              ],
            }
          : {}),
        previewExtra: {
          agentTreasury: {
            ...summary,
            ...(l ? { fastLane: laneSummary(l) } : {}),
            ...(input.monthlyBudget !== undefined
              ? { budgetRecipe: budgetRecipe({ monthlyBudget: input.monthlyBudget, chainId, symbol: input.symbol }) }
              : {}),
          },
        },
        ...(nextExtra ? { previewNextExtra: nextExtra } : {}),
        resultExtra: (predicted) => ({
          agentTreasury: { ...summary, ...(l ? { fastLane: laneSummary(l) } : {}) },
          ...(l
            ? {
                fastLane: {
                  ...laneSummary(l),
                  payRecipeExample: payProposalRecipe({
                    govPool: predicted.govPool ?? l.predicted.govPool,
                    chainId,
                    lane: l.address,
                    to: l.cfg.allowlist[0]!,
                    amountWei: l.cfg.perPaymentCapWei,
                    amountHuman: `${input.fastLane!.perPaymentCap} ${input.symbol}`,
                  }),
                },
              }
            : {}),
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
                    `${JSON.stringify(recipe.args)}. It goes through the validator round like every proposal.` +
                    (laneHint ? ` ${laneHint}` : ""),
                };
              })()
            : laneHint
              ? { next: laneHint }
              : {}),
        }),
      });

      // ---------- no lane, or a lane that already exists: one deploy call ----------
      const deployLaneNow =
        lane !== undefined && lane.source === "predicted-create" && !input.dryRun && input.confirm === true;
      if (!deployLaneNow) {
        let daoInput;
        try {
          daoInput = assembleDaoInput(lane?.address);
        } catch (e) {
          return err(`Could not assemble the deploy: ${safeErrorMessage(e)}`);
        }
        return runDaoCreate(daoInput, extrasFor(lane));
      }

      // ---------- lane first, then the DAO ----------
      // Order: a dry run of the DAO deploy (every guard, no pin, no broadcast)
      // → deploy the lane → the real DAO deploy. The lane goes first because its
      // address is baked into the deploy (float recipient + executor): if the
      // DAO deploy then fails, the lane is reusable through `existingLane`; the
      // other order would leave a DAO pointing at an address nothing can ever
      // occupy (a failed CREATE still burns the nonce).
      const l = lane!;
      try {
        const dry = await runDaoCreate(assembleDaoInput(l.address, { dryRun: true, confirm: false }), extrasFor(l));
        if (dry.isError) return dry;
      } catch (e) {
        return err(`Could not assemble the deploy: ${safeErrorMessage(e)}`);
      }

      const hot = signer.trySigner(chainId, input.signerKey);
      if ("error" in hot) return err(`${hot.error}\n${hot.remediation}`);
      let laneTx: { hash: string; address: string };
      try {
        const nonce = await hot.ok.provider!.getTransactionCount(hot.ok.address, "pending");
        const expected = getCreateAddress({ from: hot.ok.address, nonce });
        const tx = await hot.ok.sendTransaction({
          data: encodeLaneDeploy(l.predicted.govPool, l.predicted.govToken, l.cfg),
          nonce,
        });
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
          return err(`AgentFastLane deploy tx ${tx.hash} failed (status ${receipt?.status ?? "unknown"}). Nothing else was sent.`);
        }
        laneTx = { hash: tx.hash, address: getAddress(receipt.contractAddress) };
        if (laneTx.address.toLowerCase() !== expected.toLowerCase()) {
          // Harmless: the deploy below is assembled against the real address.
          l.warnings.push(`Lane landed at ${laneTx.address}, not the predicted ${expected} (nonce moved).`);
        }
      } catch (e) {
        return err(`AgentFastLane deploy failed: ${safeErrorMessage(e)}. Nothing else was sent.`);
      }
      const deployed: LanePlan = { ...l, address: laneTx.address, source: "deployed" };

      let daoInput;
      try {
        daoInput = assembleDaoInput(deployed.address);
      } catch (e) {
        return err(`Could not assemble the deploy: ${safeErrorMessage(e)}`);
      }
      const extras = extrasFor(deployed);
      const prevResult = extras.resultExtra!;
      extras.resultExtra = (p) => {
        const base = prevResult(p);
        const fl = base.fastLane as Record<string, unknown> | undefined;
        return { ...base, fastLane: { ...(fl ?? {}), deployTxHash: laneTx.hash } };
      };
      const res = await runDaoCreate(daoInput, extras);
      if (res.isError) {
        const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
        return err(
          `${text}\n\nThe AgentFastLane IS deployed at ${laneTx.address} (tx ${laneTx.hash}) and bound to the ` +
            `predicted govPool ${l.predicted.govPool}. Fix the cause and re-run the SAME call with ` +
            `fastLane.existingLane: "${laneTx.address}" — do not deploy a second lane.`,
        );
      }
      return res;
    },
  );
}

/**
 * An `existingLane` must be the lane for THIS DAO: its govPool() is the
 * predicted pool and its token() the predicted gov token, and its caps are the
 * ones the call asked for (so the preview tells the truth).
 */
async function verifyExistingLane(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  address: string,
  predicted: { govPool: string; govToken: string },
  cfg: FastLaneConfig,
): Promise<string | undefined> {
  const c = new Contract(address, FAST_LANE_ABI as unknown as string[], provider as never);
  try {
    const [govPool, token, perPaymentCap, windowCap] = (await Promise.all([
      c.getFunction("govPool").staticCall(),
      c.getFunction("token").staticCall(),
      c.getFunction("perPaymentCap").staticCall(),
      c.getFunction("windowCap").staticCall(),
    ])) as [string, string, bigint, bigint];
    if (getAddress(govPool) !== predicted.govPool) {
      return `its govPool() is ${govPool}, but this deployer + daoName predicts ${predicted.govPool}. A lane is bound to one DAO.`;
    }
    if (getAddress(token) !== predicted.govToken) return `its token() is ${token}, not the predicted gov token ${predicted.govToken}.`;
    if (perPaymentCap !== cfg.perPaymentCapWei || windowCap !== cfg.windowCapWei) {
      return (
        `its caps are ${formatUnits(perPaymentCap, 18)} / ${formatUnits(windowCap, 18)} per payment / per window, ` +
        `not the ${formatUnits(cfg.perPaymentCapWei, 18)} / ${formatUnits(cfg.windowCapWei, 18)} requested — pass the lane's own caps.`
      );
    }
    for (const a of cfg.allowlist) {
      const ok = (await c.getFunction("allowed").staticCall(a)) as boolean;
      if (!ok) return `${a} is not on its allowlist (the allowlist is set at the lane's deploy).`;
    }
  } catch (e) {
    return `could not read it as an AgentFastLane: ${safeErrorMessage(e)}`;
  }
  return undefined;
}
