import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";
import { resolveChain } from "../config.js";
import { ArtifactsMissingError } from "../artifacts.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import { RpcProvider } from "../rpc.js";
import { PinataClient } from "../lib/ipfs.js";
import { quorumPctFromRaw, judgeQuorum } from "../lib/quorumRisk.js";
import {
  firstFailure,
  checkTreasuryRemainder,
  checkQuorumReachable,
  checkMinVotesVsDistribution,
  checkSettingsBounds,
  checkNoTreasuryRecipient,
  checkValidatorsCoherence,
  checkCustomVotePower,
} from "../lib/preflight.js";
import { simulateDeployGovPool } from "../lib/deploySim.js";
import { roundTripDeployCalldata, type DeployStructView } from "../lib/deployGuard.js";

/**
 * Phase 5 — deploy a new DAO via `PoolFactory.deployGovPool(GovPoolDeployParams)`.
 *
 * The input struct is large and deeply nested. We load the PoolFactory ABI
 * from the compiled Hardhat artifacts so encoding stays in lockstep with the
 * on-chain contract — run `dexe_compile` before calling if artifacts are
 * missing. Falls back to a hand-rolled tuple signature if artifacts are not
 * available (the fallback is carefully matched to
 * `contracts/interfaces/factory/IPoolFactory.sol`).
 *
 * VotePowerType enum: LINEAR_VOTES=0, POLYNOMIAL_VOTES=1, CUSTOM_VOTES=2.
 */

const VOTE_POWER_TYPES = ["LINEAR_VOTES", "POLYNOMIAL_VOTES", "CUSTOM_VOTES"] as const;

// ---- Vote power initializer ABIs (must match deployed contracts) ----
// LinearPower.__LinearPower_init() — no args, just triggers OwnableUpgradeable
const LINEAR_POWER_ABI = [
  "function __LinearPower_init()",
] as const;

// PolynomialPower.__PolynomialPower_init(uint256,uint256,uint256)
const POLYNOMIAL_POWER_ABI = [
  "function __PolynomialPower_init(uint256 coefficient1, uint256 coefficient2, uint256 coefficient3)",
] as const;

/**
 * Encode the initData for the vote power proxy based on voteType.
 * The PoolFactory calls `.call(initData)` on the deployed proxy during
 * `_initGovPool` — if initData is empty (`0x`), the proxy is never
 * initialized and downstream calls revert.
 */
function encodeVotePowerInitData(
  voteType: (typeof VOTE_POWER_TYPES)[number],
  polynomialCoefficients?: { coefficient1: string; coefficient2: string; coefficient3: string },
): string {
  if (voteType === "LINEAR_VOTES") {
    const iface = new Interface(LINEAR_POWER_ABI as unknown as string[]);
    return iface.encodeFunctionData("__LinearPower_init", []);
  }
  if (voteType === "POLYNOMIAL_VOTES") {
    if (!polynomialCoefficients) {
      throw new Error(
        "POLYNOMIAL_VOTES requires polynomialCoefficients (coefficient1, coefficient2, coefficient3)",
      );
    }
    const iface = new Interface(POLYNOMIAL_POWER_ABI as unknown as string[]);
    return iface.encodeFunctionData("__PolynomialPower_init", [
      BigInt(polynomialCoefficients.coefficient1),
      BigInt(polynomialCoefficients.coefficient2),
      BigInt(polynomialCoefficients.coefficient3),
    ]);
  }
  // CUSTOM_VOTES: caller provides raw initData or 0x (contract skips the call)
  return "0x";
}

const FALLBACK_POOL_FACTORY_ABI = [
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)",
] as const;

// ---------- input schemas ----------

const RewardsInfoSchema = z.object({
  rewardToken: z.string().describe("Reward token address (use ZERO_ADDR if no rewards)"),
  creationReward: z.string().default("0").describe("18-decimal wei token amount"),
  executionReward: z.string().default("0").describe("18-decimal wei token amount"),
  voteRewardsCoefficient: z.string().default("0").describe("25-decimal wei percentage"),
});

const MainProposalSettingsSchema = z.object({
  earlyCompletion: z.boolean(),
  delegatedVotingAllowed: z.boolean().describe("Contract-inverted: true = DISABLE delegation, false = ALLOW"),
  validatorsVote: z.boolean(),
  duration: z.string().describe("Voting duration in seconds (e.g. \"86400\" for 1 day)"),
  durationValidators: z.string().describe("Validator voting duration in seconds"),
  executionDelay: z.string().default("0").describe("Delay before execution in seconds"),
  quorum: z.string().describe("25-decimal wei percentage (50% = \"500000000000000000000000000\")"),
  quorumValidators: z.string().describe("25-decimal wei percentage"),
  minVotesForVoting: z.string().describe("18-decimal wei token amount"),
  minVotesForCreating: z.string().describe("18-decimal wei token amount"),
  rewardsInfo: RewardsInfoSchema,
  executorDescription: z.string().default("").describe(
    "IPFS CID of settings JSON (auto-uploaded when empty and DEXE_PINATA_JWT is set)",
  ),
});

const SettingsDeployParamsSchema = z.object({
  proposalSettings: z.array(MainProposalSettingsSchema).min(1).max(5),
  additionalProposalExecutors: z.array(z.string()).default([]),
});

const ValidatorProposalSettingsSchema = z.object({
  duration: z.string().describe("Validator voting duration in seconds"),
  executionDelay: z.string().default("0").describe("Delay before execution in seconds"),
  quorum: z.string().describe("25-decimal wei percentage"),
});

const ValidatorsDeployParamsSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  proposalSettings: ValidatorProposalSettingsSchema,
  validators: z.array(z.string()).default([]),
  balances: z.array(z.string()).default([]),
});

const UserKeeperDeployParamsSchema = z.object({
  tokenAddress: z.string().default("0x0000000000000000000000000000000000000000").describe(
    "Existing ERC20 governance token (auto-wired to predicted govToken when creating new token)",
  ),
  nftAddress: z.string().default("0x0000000000000000000000000000000000000000"),
  individualPower: z.string().default("0").describe("18-decimal wei — voting power per NFT"),
  nftsTotalSupply: z.string().default("0").describe("Total NFT collection size (plain integer)"),
});

const TokenParamsSchema = z.object({
  name: z.string().default("").describe("Gov token name (non-empty triggers token creation)"),
  symbol: z.string().default(""),
  users: z.array(z.string()).default([]).describe("Initial token recipient addresses"),
  cap: z.string().default("0").describe("18-decimal wei token cap"),
  mintedTotal: z.string().default("0").describe("18-decimal wei total initial mint"),
  amounts: z.array(z.string()).default([]).describe("18-decimal wei amounts per recipient"),
});

const PolynomialCoefficientsSchema = z.object({
  coefficient1: z.string().describe("Expert delegation coefficient (18-decimal wei)"),
  coefficient2: z.string().describe("Expert coefficient (18-decimal wei)"),
  coefficient3: z.string().describe("Holder coefficient (18-decimal wei)"),
});

const VotePowerDeployParamsSchema = z.object({
  voteType: z.enum(VOTE_POWER_TYPES),
  /** Raw initData override — only used for CUSTOM_VOTES. For LINEAR/POLYNOMIAL
   *  the tool auto-encodes the correct initializer calldata. */
  initData: z.string().optional().describe(
    "Raw hex initData — only for CUSTOM_VOTES. LINEAR/POLYNOMIAL are auto-encoded.",
  ),
  presetAddress: z.string().default("0x0000000000000000000000000000000000000000"),
  /** Required when voteType is POLYNOMIAL_VOTES. */
  polynomialCoefficients: PolynomialCoefficientsSchema.optional().describe(
    "Required for POLYNOMIAL_VOTES: the three curve coefficients (18-decimal wei strings)",
  ),
});

// ---------- register ----------

export function registerDaoDeployTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerBuildDeploy(server, ctx, rpc);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function payloadResult(payload: TxPayload, extra?: { predictedGovPool?: string; note?: string }) {
  const lines = [
    payload.description,
    `  to   : ${payload.to}`,
    `  value: ${payload.value}`,
    `  data : ${payload.data.slice(0, 66)}…`,
  ];
  if (extra?.predictedGovPool) lines.push(`  predicted govPool: ${extra.predictedGovPool}`);
  if (extra?.note) lines.push(`\n${extra.note}`);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: {
      payload: { ...payload } as Record<string, unknown>,
      predictedGovPool: extra?.predictedGovPool ?? null,
    },
  };
}

function payloadOutputSchema() {
  return {
    payload: z.object({
      to: z.string(),
      data: z.string(),
      value: z.string(),
      chainId: z.number(),
      description: z.string(),
    }),
    predictedGovPool: z.string().nullable(),
  };
}

// ---------- shared deploy params schema (reused by dexe_dao_create) ----------

/**
 * Full `deployGovPool` parameter object. `descriptionURL` and `name` are the
 * two fields `dexe_dao_create` derives itself (from the uploaded DAO metadata
 * + daoName), so it consumes `DeployParamsSchema.omit({ descriptionURL, name })`.
 */
export const DeployParamsSchema = z.object({
  settingsParams: SettingsDeployParamsSchema,
  validatorsParams: ValidatorsDeployParamsSchema.optional(),
  userKeeperParams: UserKeeperDeployParamsSchema,
  tokenParams: TokenParamsSchema,
  votePowerParams: VotePowerDeployParamsSchema,
  verifier: z.string().default("0x0000000000000000000000000000000000000000"),
  onlyBABTHolders: z.boolean().default(false),
  descriptionURL: z.string().describe("ipfs://<cid> of DAO metadata JSON"),
  name: z.string().min(1),
});

export type DeployParams = z.infer<typeof DeployParamsSchema>;

export interface DeployBuildInput {
  chainId?: number;
  poolFactory?: string;
  deployer: string;
  params: DeployParams;
}

export type DeployBuildResult =
  | {
      ok: true;
      payload: TxPayload;
      predictedGovPool?: string;
      note: string;
      predicted: {
        govPool?: string;
        govToken?: string;
        distributionProposal?: string;
        govTokenSale?: string;
      };
    }
  | { ok: false; error: string };

/**
 * Pure builder for the `PoolFactory.deployGovPool` tx. Extracted from the
 * `dexe_dao_build_deploy` handler so the `dexe_dao_create` composite reuses the
 * exact same predicted-address wiring, settings auto-expand, cap/minted guard,
 * executorDescription IPFS upload, and encoding. Returns a discriminated result
 * instead of tool-shaped content.
 */
export async function buildDeployGovPool(
  input: DeployBuildInput,
  ctx: ToolContext,
  rpc: RpcProvider,
): Promise<DeployBuildResult> {
  const { chainId, poolFactory, deployer, params } = input;
  const fail = (error: string): DeployBuildResult => ({ ok: false, error });
  const chain = resolveChain(ctx.config, chainId);
  const isTokenCreation = params.tokenParams.name.length > 0;
  const hasValidators = !!(params.validatorsParams && params.validatorsParams.validators.length > 0);

  // ---------- auto-encode vote power initData ----------
  let votePowerInitData: string;
  try {
    if (params.votePowerParams.voteType === "CUSTOM_VOTES") {
      votePowerInitData = params.votePowerParams.initData ?? "0x";
    } else {
      votePowerInitData = encodeVotePowerInitData(
        params.votePowerParams.voteType,
        params.votePowerParams.polynomialCoefficients,
      );
    }
  } catch (err) {
    return fail(`Failed to encode vote power initData: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---------- default validatorsParams when omitted ----------
  const VT_SUFFIX = "-VT";
  const rawValidatorsParams = params.validatorsParams ?? {
    name: "Validator Token",
    symbol: "VT",
    proposalSettings: {
      duration: params.settingsParams.proposalSettings[0]!.duration,
      executionDelay: params.settingsParams.proposalSettings[0]!.executionDelay,
      quorum: params.settingsParams.proposalSettings[0]!.quorum,
    },
    validators: [],
    balances: [],
  };
  const validatorsParams = {
    ...rawValidatorsParams,
    name: rawValidatorsParams.name.endsWith(VT_SUFFIX) ? rawValidatorsParams.name : rawValidatorsParams.name + VT_SUFFIX,
    symbol: rawValidatorsParams.symbol.endsWith(VT_SUFFIX) ? rawValidatorsParams.symbol : rawValidatorsParams.symbol + VT_SUFFIX,
  };

  // ---------- validate leaf addresses ----------
  if (poolFactory && !isAddress(poolFactory)) return fail(`Invalid poolFactory: ${poolFactory}`);
  if (!isAddress(deployer)) return fail(`Invalid deployer: ${deployer}`);
  if (isTokenCreation && params.tokenParams.users.length === 0)
    return fail("tokenParams.users must have at least one recipient when creating a new token");
  if (!isAddress(params.verifier)) return fail(`Invalid verifier: ${params.verifier}`);
  if (!isAddress(params.userKeeperParams.tokenAddress)) return fail(`Invalid userKeeperParams.tokenAddress`);
  if (!isAddress(params.userKeeperParams.nftAddress)) return fail(`Invalid userKeeperParams.nftAddress`);
  if (!isAddress(params.votePowerParams.presetAddress)) return fail(`Invalid votePowerParams.presetAddress`);
  for (const v of validatorsParams.validators) {
    if (!isAddress(v)) return fail(`Invalid validator: ${v}`);
  }
  if (validatorsParams.validators.length !== validatorsParams.balances.length) {
    return fail("validatorsParams.validators and .balances must be the same length");
  }
  for (const u of params.tokenParams.users) {
    if (!isAddress(u)) return fail(`Invalid tokenParams.users entry: ${u}`);
  }
  if (params.tokenParams.users.length !== params.tokenParams.amounts.length) {
    return fail("tokenParams.users and .amounts must be the same length");
  }
  // cap rules (verified live on mainnet): cap > 0 (ERC20Capped rejects cap=0) and
  // cap >= mintedTotal (cap==minted is a valid fixed supply). See checkDeployCap.
  if (isTokenCreation) {
    const capBn = BigInt(params.tokenParams.cap);
    const mintedBn = BigInt(params.tokenParams.mintedTotal);
    if (capBn <= 0n) {
      return fail(
        `tokenParams.cap must be > 0 — the gov token is ERC20Capped and cap=0 reverts ("ERC20Capped: cap is 0"). Set cap ≥ mintedTotal (${mintedBn}); cap == mintedTotal is a valid fixed supply.`,
      );
    }
    if (capBn < mintedBn) {
      return fail(
        `tokenParams.cap (${capBn}) must be ≥ tokenParams.mintedTotal (${mintedBn}) — otherwise deployGovPool reverts "ERC20Gov: mintedTotal should not be greater than cap". cap == mintedTotal is allowed.`,
      );
    }
  }

  // ---------- resolve PoolFactory address ----------
  let factoryAddress = poolFactory;
  if (!factoryAddress) {
    try {
      const pr = rpc.tryProvider(chain.chainId);
      if ("error" in pr) return fail(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;
      const book = new AddressBook({
        provider,
        chainId: chain.chainId,
        registryOverride: chain.registryOverride ?? ctx.config.registryOverride,
      });
      factoryAddress = await book.resolve(CONTRACT_NAMES.POOL_FACTORY);
    } catch (err) {
      return fail(
        `poolFactory address needed: pass it explicitly, or configure DEXE_RPC_URL so the ContractsRegistry lookup works. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // ---------- predict addresses (always required — wires executors) ----------
  let predictedGovPool: string | undefined;
  let predictedGovToken: string | undefined;
  let predictedDistribution: string | undefined;
  let predictedTokenSale: string | undefined;
  try {
    const pr = rpc.tryProvider(chain.chainId);
    if ("error" in pr) return fail(`${pr.error}\n${pr.remediation}`);
    const provider = pr.ok;
    const predictIface = new Interface([
      "function predictGovAddresses(address deployer, string poolName) view returns (tuple(address govPool, address govTokenSale, address govToken, address distributionProposal, address expertNft, address nftMultiplier))",
    ]);
    const { Contract } = await import("ethers");
    const factory = new Contract(factoryAddress, predictIface, provider);
    const res = await factory.getFunction("predictGovAddresses").staticCall(deployer, params.name);
    predictedGovPool = res.govPool as string;
    predictedGovToken = res.govToken as string;
    predictedDistribution = res.distributionProposal as string;
    predictedTokenSale = res.govTokenSale as string;

    // Name-collision pre-check: the create2 salt is deployer+name, so code at
    // the predicted govPool means this exact name was already deployed by this
    // deployer — the factory would revert "PoolFactory: pool name is already
    // taken" after burning gas. One getCode converts that into a build error.
    const existing = await provider.getCode(predictedGovPool);
    if (existing !== "0x") {
      return fail(
        `DAO name '${params.name}' is already deployed by ${deployer} on chain ${chain.chainId} ` +
          `(govPool ${predictedGovPool} has code). deployGovPool would revert "PoolFactory: pool name is ` +
          `already taken". Pick a different daoName — any change works.`,
      );
    }

    // CUSTOM vote power: the preset must be a deployed contract, or the factory
    // reverts "PoolFactory: power init failed" with the reason swallowed.
    if (params.votePowerParams.voteType === "CUSTOM_VOTES") {
      const presetCode = await provider.getCode(params.votePowerParams.presetAddress);
      if (presetCode === "0x") {
        return fail(
          `votePowerParams.presetAddress ${params.votePowerParams.presetAddress} has no contract code on ` +
            `chain ${chain.chainId}. CUSTOM_VOTES requires a deployed vote-power contract; the factory calls ` +
            `its init and reverts "PoolFactory: power init failed" otherwise.`,
        );
      }
    }
  } catch (err) {
    return fail(
      `Failed to predict gov addresses / run pre-deploy checks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ZERO = "0x0000000000000000000000000000000000000000";

  const effectiveTokenAddress =
    isTokenCreation && predictedGovToken ? predictedGovToken : params.userKeeperParams.tokenAddress;

  // Bug #12: substitute predicted govToken as rewardToken when reward amounts set.
  if (isTokenCreation && predictedGovToken) {
    const hasRewardAmounts = (r: { creationReward: string; executionReward: string; voteRewardsCoefficient: string }) =>
      BigInt(r.creationReward) > 0n || BigInt(r.executionReward) > 0n || BigInt(r.voteRewardsCoefficient) > 0n;
    for (const s of params.settingsParams.proposalSettings) {
      if ((s.rewardsInfo.rewardToken === ZERO || s.rewardsInfo.rewardToken === "") && hasRewardAmounts(s.rewardsInfo)) {
        s.rewardsInfo.rewardToken = predictedGovToken;
      }
    }
  }

  const effectiveExecutors = [...params.settingsParams.additionalProposalExecutors];
  if (predictedDistribution && !effectiveExecutors.includes(predictedDistribution))
    effectiveExecutors.push(predictedDistribution);
  if (predictedTokenSale && !effectiveExecutors.includes(predictedTokenSale))
    effectiveExecutors.push(predictedTokenSale);

  if (effectiveTokenAddress === ZERO && params.userKeeperParams.nftAddress === ZERO) {
    return fail(
      "GovUK requires at least one governance asset: set userKeeperParams.tokenAddress (existing ERC20), userKeeperParams.nftAddress (existing ERC721), or provide tokenParams.name to create a new token",
    );
  }

  // ---------- auto-expand proposal settings (1 → 5) ----------
  let expandedSettings = params.settingsParams.proposalSettings;
  if (expandedSettings.length === 1) {
    const base = expandedSettings[0]!;
    const baseWithValidatorFallback = {
      ...base,
      validatorsVote: true,
      durationValidators: hasValidators ? base.durationValidators : base.duration,
      quorumValidators: hasValidators ? base.quorumValidators : base.quorum,
    };
    const dpSettings = { ...baseWithValidatorFallback, delegatedVotingAllowed: false, earlyCompletion: false };
    expandedSettings = [
      baseWithValidatorFallback,
      baseWithValidatorFallback,
      baseWithValidatorFallback,
      dpSettings,
      baseWithValidatorFallback,
    ];
  } else if (expandedSettings.length !== 5) {
    return fail(`proposalSettings must be 1 (auto-expand to 5) or exactly 5. Got ${expandedSettings.length}.`);
  }

  // ---------- governance coherence guards (frontend parity) ----------
  // Single chokepoint for BOTH dexe_dao_create and dexe_dao_build_deploy. Blocks
  // configs the frontend blocks: unreachable quorum, min-votes above every
  // holder, out-of-range settings, treasury jammed into the voter list. Votable
  // power excludes any amount sent to the predicted govPool (treasury).
  const gpLower = predictedGovPool?.toLowerCase();
  let votable = 0n;
  params.tokenParams.users.forEach((u, i) => {
    if (!gpLower || u.toLowerCase() !== gpLower) votable += BigInt(params.tokenParams.amounts[i] ?? "0");
  });
  const base0 = expandedSettings[0]!;
  const coherence = firstFailure([
    checkCustomVotePower(
      params.votePowerParams.voteType,
      params.votePowerParams.initData,
      params.votePowerParams.presetAddress,
    ),
    checkValidatorsCoherence({
      validators: validatorsParams.validators,
      balances: validatorsParams.balances,
      duration: validatorsParams.proposalSettings.duration,
      quorum: validatorsParams.proposalSettings.quorum,
    }),
    checkNoTreasuryRecipient(params.tokenParams.users, predictedGovPool),
    checkTreasuryRemainder(params.tokenParams.mintedTotal, params.tokenParams.amounts, isTokenCreation),
    checkSettingsBounds({
      quorum: base0.quorum,
      quorumValidators: base0.quorumValidators,
      duration: base0.duration,
      durationValidators: base0.durationValidators,
    }),
    checkMinVotesVsDistribution(base0.minVotesForVoting, base0.minVotesForCreating, params.tokenParams.amounts, isTokenCreation),
    checkQuorumReachable({
      voteType: params.votePowerParams.voteType,
      quorumRaw: base0.quorum,
      mintedTotal: params.tokenParams.mintedTotal,
      votable: votable.toString(),
      isTokenCreation,
    }),
  ]);
  if (coherence) {
    return fail(
      `Preflight [${coherence.check}] failed: ${coherence.remediation}${coherence.detail ? ` (${coherence.detail})` : ""}`,
    );
  }

  // ---------- treasury-safety advisory: quorum floor ----------
  let quorumWarning = "";
  if (ctx.config.treasuryGuard !== "off") {
    const floor = ctx.config.minSafeQuorumPct;
    const showPct = (p: number) => (Number.isFinite(p) ? `${p}%` : "unparseable");
    const lowQuorum: string[] = [];
    expandedSettings.forEach((s, i) => {
      const pct = quorumPctFromRaw(s.quorum);
      if (judgeQuorum(pct, floor) !== "SAFE") lowQuorum.push(`proposalSettings[${i}] quorum=${showPct(pct)}`);
    });
    const vpct = quorumPctFromRaw(validatorsParams.proposalSettings.quorum);
    if (judgeQuorum(vpct, floor) !== "SAFE") lowQuorum.push(`validatorsParams quorum=${showPct(vpct)}`);
    if (lowQuorum.length > 0) {
      quorumWarning =
        `\n⚠️  Quorum below the ${floor}% safe floor (DEXE_MIN_SAFE_QUORUM_PCT): ${lowQuorum.join(", ")}. ` +
        `Low quorum reduces the participation required to pass a proposal; for a DAO that will hold ` +
        `treasury assets, set quorum ≥50% (51%+ recommended). The safe value is DAO-specific and must ` +
        `be verified. [governance-safety advisory]`;
    }
  }

  // ---------- auto-upload executorDescription to IPFS ----------
  let pinataWarning = "";
  if (ctx.config.pinataJwt) {
    const pinata = new PinataClient(ctx.config.pinataJwt);
    const settingsToUpload: Array<{ index: number; label: string }> = [
      { index: 0, label: "default" },
      { index: 3, label: "distributionProposal" },
    ];
    for (const { index, label } of settingsToUpload) {
      const s = expandedSettings[index]!;
      if (!s.executorDescription || s.executorDescription === "") {
        try {
          const settingsJson = {
            earlyCompletion: s.earlyCompletion,
            delegatedVotingAllowed: s.delegatedVotingAllowed,
            validatorsVote: s.validatorsVote,
            duration: s.duration,
            durationValidators: s.durationValidators,
            quorum: s.quorum,
            quorumValidators: s.quorumValidators,
            minVotesForVoting: s.minVotesForVoting,
            minVotesForCreating: s.minVotesForCreating,
            executionDelay: s.executionDelay,
            rewardsInfo: {
              rewardToken: s.rewardsInfo.rewardToken,
              creationReward: s.rewardsInfo.creationReward,
              executionReward: s.rewardsInfo.executionReward,
              voteRewardsCoefficient: s.rewardsInfo.voteRewardsCoefficient,
            },
            minVotesForReadProposalDiscussion: "0",
            minVotesForCreatingComment: "1000000000000000000",
          };
          const res = await pinata.pinJson(settingsJson, { name: `dao-settings-${label}:${params.name.slice(0, 40)}` });
          const cid = `ipfs://${res.cid}`;
          if (index === 0) {
            expandedSettings[0] = { ...expandedSettings[0]!, executorDescription: cid };
            expandedSettings[1] = { ...expandedSettings[1]!, executorDescription: cid };
            expandedSettings[2] = { ...expandedSettings[2]!, executorDescription: cid };
            expandedSettings[4] = { ...expandedSettings[4]!, executorDescription: cid };
          } else {
            expandedSettings[3] = { ...expandedSettings[3]!, executorDescription: cid };
          }
        } catch (err) {
          pinataWarning += `\n⚠️  Failed to upload ${label} executorDescription: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  } else {
    const missingDesc = expandedSettings.some((s) => !s.executorDescription || s.executorDescription === "");
    if (missingDesc) {
      pinataWarning =
        "\n⚠️  DEXE_PINATA_JWT not configured — executorDescription fields are empty. " +
        "DAOs created without executorDescription will display broken proposal settings in the frontend UI. " +
        "Set DEXE_PINATA_JWT to enable auto-upload.";
    }
  }

  // ---------- build the tuple arg ----------
  const paramsTuple = [
    [
      expandedSettings.map((s) => [
        s.earlyCompletion,
        s.delegatedVotingAllowed,
        s.validatorsVote,
        BigInt(s.duration),
        BigInt(s.durationValidators),
        BigInt(s.executionDelay),
        BigInt(s.quorum),
        BigInt(s.quorumValidators),
        BigInt(s.minVotesForVoting),
        BigInt(s.minVotesForCreating),
        [
          s.rewardsInfo.rewardToken,
          BigInt(s.rewardsInfo.creationReward),
          BigInt(s.rewardsInfo.executionReward),
          BigInt(s.rewardsInfo.voteRewardsCoefficient),
        ],
        s.executorDescription,
      ]),
      effectiveExecutors,
    ],
    [
      validatorsParams.name,
      validatorsParams.symbol,
      [
        BigInt(validatorsParams.proposalSettings.duration),
        BigInt(validatorsParams.proposalSettings.executionDelay),
        BigInt(validatorsParams.proposalSettings.quorum),
      ],
      validatorsParams.validators,
      validatorsParams.balances.map((b) => BigInt(b)),
    ],
    [
      effectiveTokenAddress,
      params.userKeeperParams.nftAddress,
      BigInt(params.userKeeperParams.individualPower),
      BigInt(params.userKeeperParams.nftsTotalSupply),
    ],
    [
      params.tokenParams.name,
      params.tokenParams.symbol,
      params.tokenParams.users,
      BigInt(params.tokenParams.cap),
      BigInt(params.tokenParams.mintedTotal),
      params.tokenParams.amounts.map((a) => BigInt(a)),
    ],
    [
      VOTE_POWER_TYPES.indexOf(params.votePowerParams.voteType),
      votePowerInitData,
      params.votePowerParams.presetAddress,
    ],
    params.verifier,
    params.onlyBABTHolders,
    params.descriptionURL.replace(/^ipfs:\/\//, ""),
    params.name,
  ];

  // ---------- get ABI (artifact > fallback) ----------
  let iface: Interface;
  let ifaceSource: string;
  try {
    const records = ctx.artifacts.get("PoolFactory");
    if (records.length > 0) {
      iface = new Interface(records[0]!.abi as never[]);
      ifaceSource = "compiled artifact";
      try {
        iface.getFunction("deployGovPool");
      } catch {
        iface = new Interface(FALLBACK_POOL_FACTORY_ABI as unknown as string[]);
        ifaceSource = "fallback (compiled artifact missing deployGovPool)";
      }
    } else {
      iface = new Interface(FALLBACK_POOL_FACTORY_ABI as unknown as string[]);
      ifaceSource = "fallback (artifacts not loaded — run dexe_compile for strict parity)";
    }
  } catch (err) {
    if (err instanceof ArtifactsMissingError) {
      iface = new Interface(FALLBACK_POOL_FACTORY_ABI as unknown as string[]);
      ifaceSource = "fallback (no artifacts — run dexe_compile for strict parity)";
    } else {
      return fail(`Failed to load PoolFactory ABI: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- encode ----------
  let payload: TxPayload;
  try {
    payload = buildPayload({
      to: factoryAddress,
      iface,
      method: "deployGovPool",
      args: [paramsTuple],
      chainId: chain.chainId,
      contractLabel: "PoolFactory",
      description: `PoolFactory.deployGovPool("${params.name}") via ${ifaceSource}`,
    });
  } catch (err) {
    return fail(`deployGovPool encoding failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---------- round-trip self-check (offline encoding guard) ----------
  // Decode the calldata we just built and assert every load-bearing field
  // survived encoding. Catches ABI/positional drift — the exact class of bug
  // that shifts fields and empties `name` → "PoolFactory: pool name cannot be
  // empty" revert — at build time, before the B9 eth_call sim runs. See
  // lib/deployGuard.ts.
  {
    const expected: DeployStructView = {
      name: params.name,
      descriptionURL: params.descriptionURL.replace(/^ipfs:\/\//, ""),
      verifier: params.verifier,
      onlyBABTHolders: params.onlyBABTHolders,
      votePowerParams: {
        voteType: VOTE_POWER_TYPES.indexOf(params.votePowerParams.voteType),
        initData: votePowerInitData,
        presetAddress: params.votePowerParams.presetAddress,
      },
      settingsParams: {
        proposalSettings: expandedSettings as unknown as DeployStructView["settingsParams"]["proposalSettings"],
        additionalProposalExecutors: effectiveExecutors,
      },
      validatorsParams: {
        name: validatorsParams.name,
        symbol: validatorsParams.symbol,
        proposalSettings: validatorsParams.proposalSettings,
        validators: validatorsParams.validators,
        balances: validatorsParams.balances,
      },
      userKeeperParams: {
        tokenAddress: effectiveTokenAddress,
        nftAddress: params.userKeeperParams.nftAddress,
        individualPower: params.userKeeperParams.individualPower,
        nftsTotalSupply: params.userKeeperParams.nftsTotalSupply,
      },
      tokenParams: params.tokenParams as unknown as DeployStructView["tokenParams"],
    };
    let rt;
    try {
      rt = roundTripDeployCalldata(payload.data, iface, expected);
    } catch (err) {
      return fail(
        `deployGovPool calldata self-check could not decode the built calldata (${err instanceof Error ? err.message : String(err)}). ` +
          `This is an ABI/encoding mismatch — run dexe_compile to refresh the PoolFactory ABI. Refusing to emit un-decodable calldata.`,
      );
    }
    if (!rt.ok) {
      const detail = rt.mismatches
        .slice(0, 8)
        .map((m) => `${m.field}: expected "${m.expected}" got "${m.got}"`)
        .join("; ");
      return fail(
        `deployGovPool calldata self-check FAILED — the encoded calldata does not match the intended params ` +
          `(ABI/positional drift; this is the class of bug that empties \`name\` and reverts ` +
          `"PoolFactory: pool name cannot be empty"). Mismatches: ${detail}` +
          `${rt.mismatches.length > 8 ? ` (+${rt.mismatches.length - 8} more)` : ""}. ` +
          `Run dexe_compile to refresh the PoolFactory ABI (current source: ${ifaceSource}).`,
      );
    }
  }

  let note = ifaceSource.includes("fallback")
    ? "⚠️  Using fallback tuple ABI. For guaranteed parity, run dexe_compile to populate artifacts."
    : "Encoded against compiled artifact — strict parity with deployed PoolFactory.";
  note += "\n✓ Calldata round-trip self-check passed (decoded == intended params).";
  if (pinataWarning) note += pinataWarning;
  if (quorumWarning) note += quorumWarning;

  return {
    ok: true,
    payload,
    predictedGovPool,
    note,
    predicted: {
      govPool: predictedGovPool,
      govToken: predictedGovToken,
      distributionProposal: predictedDistribution,
      govTokenSale: predictedTokenSale,
    },
  };
}

// ---------- dexe_dao_build_deploy ----------

function registerBuildDeploy(
  server: McpServer,
  ctx: ToolContext,
  rpc: RpcProvider,
): void {
  server.registerTool(
    "dexe_dao_build_deploy",
    {
      title: "Build calldata to deploy a new DAO (PoolFactory.deployGovPool)",
      description:
        "Builds the `PoolFactory.deployGovPool(GovPoolDeployParams)` tx. Mirrors the frontend wizard at app.dexe.network/create-dao.\n\n" +
        "**Proposal settings auto-expand:** Pass 1 setting → auto-expands to 5 (default, internal, validators, distributionProposal, tokenSale). " +
        "DPSettings (index 3) forces `delegatedVotingAllowed: false` and `earlyCompletion: false`. Pass exactly 5 to override.\n\n" +
        "**delegatedVotingAllowed inversion:** Contract semantics are inverted — pass `true` to DISABLE delegation, `false` to ALLOW it (matches frontend behavior).\n\n" +
        "**Vote power initData:** Automatically encoded — do NOT pass `initData` for LINEAR or POLYNOMIAL types. " +
        "For LINEAR_VOTES: auto-encodes `__LinearPower_init()`. " +
        "For POLYNOMIAL_VOTES: auto-encodes `__PolynomialPower_init(c1,c2,c3)` — pass `polynomialCoefficients`. " +
        "For CUSTOM_VOTES: pass `initData` manually (or omit if the custom contract skips init).\n\n" +
        "**Predicted addresses:** `deployer` is always required. Tool calls `predictGovAddresses` and auto-wires: " +
        "(1) `govToken` → `userKeeperParams.tokenAddress` when creating token, " +
        "(2) `distributionProposal` + `govTokenSale` → `additionalProposalExecutors` always.\n\n" +
        "**Validators defaults:** When no validators needed, omit `validatorsParams` — defaults to name='Validator Token', symbol='VT', empty list. " +
        "`durationValidators`/`quorumValidators` in proposal settings fall back to `duration`/`quorum` when no validators.\n\n" +
        "**Decimal conventions (must match frontend):**\n" +
        "- `quorum`, `quorumValidators`, `voteRewardsCoefficient`: 25-decimal wei. 50% = `\"500000000000000000000000000\"` (50 × 10^25).\n" +
        "- `minVotesForVoting`, `minVotesForCreating`, `creationReward`, `executionReward`, token `cap`/`mintedTotal`/`amounts`, `individualPower`: 18-decimal wei. 100 tokens = `\"100000000000000000000\"` (100 × 10^18).\n" +
        "- `duration`, `durationValidators`, `executionDelay`: plain seconds as string. 1 day = `\"86400\"`.\n" +
        "- `polynomialCoefficients` (coefficient1/2/3): 25-decimal wei.\n\n" +
        "**executorDescription auto-upload:** When `DEXE_PINATA_JWT` is configured and `executorDescription` is empty, " +
        "the tool auto-uploads proposal settings JSON to IPFS and sets the CID (matching frontend behavior). " +
        "Without this, the DAO's proposal settings won't display correctly in the frontend UI.\n\n" +
        "**Token cap constraint:** When creating a new gov token (`tokenParams.name` non-empty), `cap` MUST be > 0 and ≥ `mintedTotal` (cap == mintedTotal is a valid fixed supply; there is NO uncapped mode). The tool pre-flight-rejects violations with a clear error.\n\n" +
        "**Pre-sign simulation:** After building, the calldata is simulated via eth_call from the deployer against live chain state. " +
        "A provable revert → the tool REFUSES to emit the payload and returns the cause + fix (no gas can be wasted on it). " +
        "Pass `skipSimulation: true` only to deliberately bypass (e.g. offline/flaky RPC). RPC transport failures never block — the payload is returned with a warning.\n\n" +
        "Prefer running `dexe_compile` first for strict ABI parity.",
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Target chain id. Defaults to the MCP's default chain. The predicted addresses + TxPayload.chainId are computed against this chain — broadcast with the same chainId.",
          ),
        poolFactory: z
          .string()
          .optional()
          .describe("PoolFactory address override; defaults to ContractsRegistry lookup"),
        deployer: z
          .string()
          .describe("tx.origin that will send the deploy tx — required for address prediction"),
        params: DeployParamsSchema,
        skipSimulation: z
          .boolean()
          .optional()
          .describe(
            "Bypass the pre-sign eth_call simulation (deliberate override for offline/flaky-RPC use). " +
              "Default false: a provably-reverting payload is refused with cause + fix.",
          ),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ chainId, poolFactory, deployer, params, skipSimulation }) => {
      const res = await buildDeployGovPool({ chainId, poolFactory, deployer, params }, ctx, rpc);
      if (!res.ok) return errorResult(res.error);

      // Pre-sign simulation: never hand out a payload that provably reverts —
      // the caller would sign and burn gas on it. Transport failures fail open
      // (verdict lands in the note); `skipSimulation` is the deliberate bypass.
      let note = res.note;
      if (!skipSimulation) {
        const verdict = await simulateDeployGovPool({
          to: res.payload.to,
          data: res.payload.data,
          deployer,
          chainId: Number(res.payload.chainId),
          config: ctx.config,
        });
        if (verdict.status === "reverted") {
          return errorResult(
            `Refusing to emit a payload that provably reverts. ${verdict.summary} ` +
              "(pass skipSimulation: true only if you are certain the simulation is wrong)",
          );
        }
        note = `${note}\n${verdict.summary}`;
      }
      return payloadResult(res.payload, { predictedGovPool: res.predictedGovPool, note });
    },
  );
}
