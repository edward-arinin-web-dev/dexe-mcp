import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";
import { ArtifactsMissingError } from "../artifacts.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import { RpcProvider } from "../rpc.js";
import { PinataClient } from "../lib/ipfs.js";

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
        "Prefer running `dexe_compile` first for strict ABI parity.",
      inputSchema: {
        poolFactory: z
          .string()
          .optional()
          .describe("PoolFactory address override; defaults to ContractsRegistry lookup"),
        deployer: z
          .string()
          .describe("tx.origin that will send the deploy tx — required for address prediction"),
        params: z.object({
          settingsParams: SettingsDeployParamsSchema,
          validatorsParams: ValidatorsDeployParamsSchema.optional(),
          userKeeperParams: UserKeeperDeployParamsSchema,
          tokenParams: TokenParamsSchema,
          votePowerParams: VotePowerDeployParamsSchema,
          verifier: z.string().default("0x0000000000000000000000000000000000000000"),
          onlyBABTHolders: z.boolean().default(false),
          descriptionURL: z.string().describe("ipfs://<cid> of DAO metadata JSON"),
          name: z.string().min(1),
        }),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ poolFactory, deployer, params }) => {
      const isTokenCreation = params.tokenParams.name.length > 0;
      const hasValidators = !!(params.validatorsParams && params.validatorsParams.validators.length > 0);

      // ---------- auto-encode vote power initData ----------
      let votePowerInitData: string;
      try {
        if (params.votePowerParams.voteType === "CUSTOM_VOTES") {
          // CUSTOM_VOTES: use caller-provided initData (contract skips .call for custom)
          votePowerInitData = params.votePowerParams.initData ?? "0x";
        } else {
          // LINEAR / POLYNOMIAL: auto-encode the correct initializer
          votePowerInitData = encodeVotePowerInitData(
            params.votePowerParams.voteType,
            params.votePowerParams.polynomialCoefficients,
          );
        }
      } catch (err) {
        return errorResult(
          `Failed to encode vote power initData: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      // Bug #11: Frontend appends "-VT" suffix to validator token name and symbol.
      // The form UI always stores name/symbol with the suffix already included.
      // Replicate that here: if the suffix isn't already present, append it.
      const validatorsParams = {
        ...rawValidatorsParams,
        name: rawValidatorsParams.name.endsWith(VT_SUFFIX)
          ? rawValidatorsParams.name
          : rawValidatorsParams.name + VT_SUFFIX,
        symbol: rawValidatorsParams.symbol.endsWith(VT_SUFFIX)
          ? rawValidatorsParams.symbol
          : rawValidatorsParams.symbol + VT_SUFFIX,
      };

      // ---------- validate leaf addresses ----------
      if (poolFactory && !isAddress(poolFactory)) return errorResult(`Invalid poolFactory: ${poolFactory}`);
      if (!isAddress(deployer)) return errorResult(`Invalid deployer: ${deployer}`);
      if (isTokenCreation && params.tokenParams.users.length === 0)
        return errorResult(
          "tokenParams.users must have at least one recipient when creating a new token",
        );
      if (!isAddress(params.verifier)) return errorResult(`Invalid verifier: ${params.verifier}`);
      if (!isAddress(params.userKeeperParams.tokenAddress))
        return errorResult(`Invalid userKeeperParams.tokenAddress`);
      if (!isAddress(params.userKeeperParams.nftAddress))
        return errorResult(`Invalid userKeeperParams.nftAddress`);
      if (!isAddress(params.votePowerParams.presetAddress))
        return errorResult(`Invalid votePowerParams.presetAddress`);
      for (const v of validatorsParams.validators) {
        if (!isAddress(v)) return errorResult(`Invalid validator: ${v}`);
      }
      if (
        validatorsParams.validators.length !== validatorsParams.balances.length
      ) {
        return errorResult("validatorsParams.validators and .balances must be the same length");
      }
      for (const u of params.tokenParams.users) {
        if (!isAddress(u)) return errorResult(`Invalid tokenParams.users entry: ${u}`);
      }
      if (params.tokenParams.users.length !== params.tokenParams.amounts.length) {
        return errorResult("tokenParams.users and .amounts must be the same length");
      }

      // ---------- resolve PoolFactory address ----------
      let factoryAddress = poolFactory;
      if (!factoryAddress) {
        try {
          const provider = rpc.requireProvider();
          const book = new AddressBook({
            provider,
            chainId: ctx.config.chainId,
            registryOverride: ctx.config.registryOverride,
          });
          factoryAddress = await book.resolve(CONTRACT_NAMES.POOL_FACTORY);
        } catch (err) {
          return errorResult(
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
        const provider = rpc.requireProvider();
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
      } catch (err) {
        return errorResult(
          `Failed to predict gov addresses: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const ZERO = "0x0000000000000000000000000000000000000000";

      // Wire predicted govToken into userKeeperParams when creating a new token
      const effectiveTokenAddress = isTokenCreation && predictedGovToken
        ? predictedGovToken
        : params.userKeeperParams.tokenAddress;

      // Bug #12: When "use governance token for rewards" is checked, the frontend
      // sets rewardToken to the predicted govToken address. When creating a new
      // token, the address isn't known at input time, so callers pass ZERO_ADDR.
      // Detect this case: rewardToken is zero BUT reward amounts are non-zero
      // → substitute the predicted govToken address (matching frontend behavior).
      if (isTokenCreation && predictedGovToken) {
        const hasRewardAmounts = (r: { creationReward: string; executionReward: string; voteRewardsCoefficient: string }) =>
          BigInt(r.creationReward) > 0n || BigInt(r.executionReward) > 0n || BigInt(r.voteRewardsCoefficient) > 0n;
        for (const s of params.settingsParams.proposalSettings) {
          if (
            (s.rewardsInfo.rewardToken === ZERO || s.rewardsInfo.rewardToken === "") &&
            hasRewardAmounts(s.rewardsInfo)
          ) {
            s.rewardsInfo.rewardToken = predictedGovToken;
          }
        }
      }

      // Always wire predicted distribution + tokenSale into additionalProposalExecutors
      const effectiveExecutors = [...params.settingsParams.additionalProposalExecutors];
      if (predictedDistribution && !effectiveExecutors.includes(predictedDistribution))
        effectiveExecutors.push(predictedDistribution);
      if (predictedTokenSale && !effectiveExecutors.includes(predictedTokenSale))
        effectiveExecutors.push(predictedTokenSale);

      // Validate: after wiring, at least one governance asset must be non-zero
      if (effectiveTokenAddress === ZERO && params.userKeeperParams.nftAddress === ZERO) {
        return errorResult(
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
        const dpSettings = {
          ...baseWithValidatorFallback,
          delegatedVotingAllowed: false,
          earlyCompletion: false,
        };
        expandedSettings = [
          baseWithValidatorFallback, // [0] default
          baseWithValidatorFallback, // [1] internal
          baseWithValidatorFallback, // [2] validators
          dpSettings,                // [3] distributionProposal
          baseWithValidatorFallback, // [4] tokenSale
        ];
      } else if (expandedSettings.length !== 5) {
        return errorResult(
          `proposalSettings must be 1 (auto-expand to 5) or exactly 5. Got ${expandedSettings.length}.`,
        );
      }

      // ---------- auto-upload executorDescription to IPFS (when Pinata configured) ----------
      // The frontend uploads each proposal settings object as JSON to IPFS and stores
      // the CID as `executorDescription`. Without this, DAOs display broken metadata in
      // the UI. We replicate the frontend's behavior: for each settings slot, if
      // executorDescription is empty and Pinata is available, upload the settings JSON
      // and set executorDescription = "ipfs://<cid>".
      //
      // The uploaded JSON shape matches the frontend exactly:
      // { earlyCompletion, delegatedVotingAllowed, validatorsVote, duration, durationValidators,
      //   quorum, quorumValidators, minVotesForVoting, minVotesForCreating, executionDelay,
      //   rewardsInfo: { rewardToken, creationReward, executionReward, voteRewardsCoefficient } }
      let pinataWarning = "";
      if (ctx.config.pinataJwt) {
        const pinata = new PinataClient(ctx.config.pinataJwt);
        // We only auto-upload for default (index 0) and DP (index 3) settings,
        // matching the frontend which shares the same CID across default/internal/validators/tokenSale
        // and a separate CID for DP settings.
        const settingsToUpload: Array<{ index: number; label: string }> = [
          { index: 0, label: "default" },
          { index: 3, label: "distributionProposal" },
        ];
        for (const { index, label } of settingsToUpload) {
          const s = expandedSettings[index]!;
          if (!s.executorDescription || s.executorDescription === "") {
            try {
              // Bug #13: Frontend includes minVotesForReadProposalDiscussion and
              // minVotesForCreatingComment in the settings JSON uploaded to IPFS.
              // Defaults from frontend: 0 (read) and 1e18 (comment = 1 token).
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
              const res = await pinata.pinJson(settingsJson, {
                name: `dao-settings-${label}:${params.name.slice(0, 40)}`,
              });
              const cid = `ipfs://${res.cid}`;
              // Apply the CID to the relevant slots (frontend shares CIDs across slots)
              if (index === 0) {
                // Default CID shared across: default(0), internal(1), validators(2), tokenSale(4)
                expandedSettings[0] = { ...expandedSettings[0]!, executorDescription: cid };
                expandedSettings[1] = { ...expandedSettings[1]!, executorDescription: cid };
                expandedSettings[2] = { ...expandedSettings[2]!, executorDescription: cid };
                expandedSettings[4] = { ...expandedSettings[4]!, executorDescription: cid };
              } else {
                // DP settings get their own CID
                expandedSettings[3] = { ...expandedSettings[3]!, executorDescription: cid };
              }
            } catch (err) {
              pinataWarning += `\n⚠️  Failed to upload ${label} executorDescription: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
      } else {
        // Check if any executorDescription is missing — warn about UI impact
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
        // settingsParams
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
        // validatorsParams
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
        // userKeeperParams
        [
          effectiveTokenAddress,
          params.userKeeperParams.nftAddress,
          BigInt(params.userKeeperParams.individualPower),
          BigInt(params.userKeeperParams.nftsTotalSupply),
        ],
        // tokenParams
        [
          params.tokenParams.name,
          params.tokenParams.symbol,
          params.tokenParams.users,
          BigInt(params.tokenParams.cap),
          BigInt(params.tokenParams.mintedTotal),
          params.tokenParams.amounts.map((a) => BigInt(a)),
        ],
        // votePowerParams
        [
          VOTE_POWER_TYPES.indexOf(params.votePowerParams.voteType), // uint8 enum
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
          // Sanity: ensure it has deployGovPool
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
          return errorResult(
            `Failed to load PoolFactory ABI: ${err instanceof Error ? err.message : String(err)}`,
          );
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
          chainId: ctx.config.chainId,
          contractLabel: "PoolFactory",
          description: `PoolFactory.deployGovPool("${params.name}") via ${ifaceSource}`,
        });
      } catch (err) {
        return errorResult(
          `deployGovPool encoding failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let note =
        ifaceSource.includes("fallback")
          ? "⚠️  Using fallback tuple ABI. For guaranteed parity, run dexe_compile to populate artifacts."
          : "Encoded against compiled artifact — strict parity with deployed PoolFactory.";
      if (pinataWarning) note += pinataWarning;

      return payloadResult(payload, { predictedGovPool, note });
    },
  );
}
