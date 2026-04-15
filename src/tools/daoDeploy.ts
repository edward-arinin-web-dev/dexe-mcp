import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";
import { ArtifactsMissingError } from "../artifacts.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import { RpcProvider } from "../rpc.js";

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

const FALLBACK_POOL_FACTORY_ABI = [
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)",
] as const;

// ---------- input schemas ----------

const RewardsInfoSchema = z.object({
  rewardToken: z.string(),
  creationReward: z.string().default("0"),
  executionReward: z.string().default("0"),
  voteRewardsCoefficient: z.string().default("0"),
});

const MainProposalSettingsSchema = z.object({
  earlyCompletion: z.boolean(),
  delegatedVotingAllowed: z.boolean(),
  validatorsVote: z.boolean(),
  duration: z.string(),
  durationValidators: z.string(),
  executionDelay: z.string().default("0"),
  quorum: z.string(),
  quorumValidators: z.string(),
  minVotesForVoting: z.string(),
  minVotesForCreating: z.string(),
  rewardsInfo: RewardsInfoSchema,
  executorDescription: z.string().default(""),
});

const SettingsDeployParamsSchema = z.object({
  proposalSettings: z.array(MainProposalSettingsSchema).min(1),
  additionalProposalExecutors: z.array(z.string()).default([]),
});

const ValidatorProposalSettingsSchema = z.object({
  duration: z.string(),
  executionDelay: z.string().default("0"),
  quorum: z.string(),
});

const ValidatorsDeployParamsSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  proposalSettings: ValidatorProposalSettingsSchema,
  validators: z.array(z.string()).default([]),
  balances: z.array(z.string()).default([]),
});

const UserKeeperDeployParamsSchema = z.object({
  tokenAddress: z.string().default("0x0000000000000000000000000000000000000000"),
  nftAddress: z.string().default("0x0000000000000000000000000000000000000000"),
  individualPower: z.string().default("0"),
  nftsTotalSupply: z.string().default("0"),
});

const TokenParamsSchema = z.object({
  name: z.string().default(""),
  symbol: z.string().default(""),
  users: z.array(z.string()).default([]),
  cap: z.string().default("0"),
  mintedTotal: z.string().default("0"),
  amounts: z.array(z.string()).default([]),
});

const VotePowerDeployParamsSchema = z.object({
  voteType: z.enum(VOTE_POWER_TYPES),
  initData: z.string().default("0x"),
  presetAddress: z.string().default("0x0000000000000000000000000000000000000000"),
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
        "Builds the `PoolFactory.deployGovPool(GovPoolDeployParams)` tx. Input mirrors the nested struct from `IPoolFactory.sol` — settings + validators + userKeeper + token + votePower + verifier + onlyBABTHolders + descriptionURL + name. If `poolFactory` is omitted, resolves via the configured ContractsRegistry. If `deployer` is provided AND RPC is configured, also returns `predictedGovPool` so you can wire it into follow-up txs before the DAO is actually deployed.\n\nPrefer running `dexe_compile` first so we encode against the compiled ABI (strict parity); the tool falls back to a hand-rolled tuple signature otherwise.",
      inputSchema: {
        poolFactory: z
          .string()
          .optional()
          .describe("PoolFactory address override; defaults to ContractsRegistry lookup"),
        deployer: z
          .string()
          .optional()
          .describe("tx.origin expected to send the deploy — used only for predictedGovPool"),
        params: z.object({
          settingsParams: SettingsDeployParamsSchema,
          validatorsParams: ValidatorsDeployParamsSchema,
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
      // ---------- validate leaf addresses ----------
      if (poolFactory && !isAddress(poolFactory)) return errorResult(`Invalid poolFactory: ${poolFactory}`);
      if (deployer && !isAddress(deployer)) return errorResult(`Invalid deployer: ${deployer}`);
      if (!isAddress(params.verifier)) return errorResult(`Invalid verifier: ${params.verifier}`);
      if (!isAddress(params.userKeeperParams.tokenAddress))
        return errorResult(`Invalid userKeeperParams.tokenAddress`);
      if (!isAddress(params.userKeeperParams.nftAddress))
        return errorResult(`Invalid userKeeperParams.nftAddress`);
      if (!isAddress(params.votePowerParams.presetAddress))
        return errorResult(`Invalid votePowerParams.presetAddress`);
      for (const v of params.validatorsParams.validators) {
        if (!isAddress(v)) return errorResult(`Invalid validator: ${v}`);
      }
      if (
        params.validatorsParams.validators.length !== params.validatorsParams.balances.length
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

      // ---------- build the tuple arg ----------
      const paramsTuple = [
        // settingsParams
        [
          params.settingsParams.proposalSettings.map((s) => [
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
          params.settingsParams.additionalProposalExecutors,
        ],
        // validatorsParams
        [
          params.validatorsParams.name,
          params.validatorsParams.symbol,
          [
            BigInt(params.validatorsParams.proposalSettings.duration),
            BigInt(params.validatorsParams.proposalSettings.executionDelay),
            BigInt(params.validatorsParams.proposalSettings.quorum),
          ],
          params.validatorsParams.validators,
          params.validatorsParams.balances.map((b) => BigInt(b)),
        ],
        // userKeeperParams
        [
          params.userKeeperParams.tokenAddress,
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
          params.votePowerParams.initData,
          params.votePowerParams.presetAddress,
        ],
        params.verifier,
        params.onlyBABTHolders,
        params.descriptionURL,
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

      // ---------- optional: predict govPool ----------
      let predictedGovPool: string | undefined;
      if (deployer && ctx.config.rpcUrl) {
        try {
          const provider = rpc.requireProvider();
          const predictIface = new Interface([
            "function predictGovAddresses(address deployer, string poolName) view returns (tuple(address govPool, address govTokenSale, address govToken, address distributionProposal, address expertNft, address nftMultiplier))",
          ]);
          const { Contract } = await import("ethers");
          const factory = new Contract(factoryAddress, predictIface, provider);
          const res = await factory.getFunction("predictGovAddresses").staticCall(deployer, params.name);
          predictedGovPool = res.govPool as string;
        } catch {
          // best-effort; absence is not fatal
        }
      }

      const note =
        ifaceSource.includes("fallback")
          ? "⚠️  Using fallback tuple ABI. For guaranteed parity, run dexe_compile to populate artifacts."
          : "Encoded against compiled artifact — strict parity with deployed PoolFactory.";

      return payloadResult(payload, { predictedGovPool, note });
    },
  );
}
