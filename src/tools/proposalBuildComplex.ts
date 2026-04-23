import { z } from "zod";
import { Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

/**
 * Phase 3c — 10 complex named wrappers. Same contract as 3a/3b:
 * every wrapper returns `{ metadata, actions: Action[] }`. Actions are fed
 * to `dexe_proposal_build_external`. Signatures verified against DeXe
 * frontend hooks at `C:/dev/investing-dashboard/src/hooks/dao/proposals/**`
 * on 2026-04-15.
 *
 * Note: `enable_staking` is NOT a distinct wrapper — the frontend reuses
 * `useGovPoolCreateProposalType`, so the catalog routes it to
 * `dexe_proposal_build_new_proposal_type`.
 */

// ---------- ABIs ----------

const DISTRIBUTION_PROPOSAL_ABI = [
  "function execute(uint256 proposalId, address token, uint256 amount)",
] as const;

const TOKEN_SALE_PROPOSAL_ABI = [
  "function createTiers(tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint256 saleStartTime, uint256 saleEndTime, address saleTokenAddress, uint256 claimLockDuration, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 cliffPeriod, uint256 unlockStep, uint256 vestingDuration, uint256 vestingPercentage) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
  "function recover(uint256[] tierIds)",
] as const;

const STAKING_PROPOSAL_ABI = [
  "function createStaking(address rewardToken, uint256 rewardAmount, uint256 startedAt, uint256 deadline, string metadata)",
] as const;

const GOV_POOL_EXT_ABI = [
  "function changeVotePower(address newVotePower)",
  "function editDescriptionURL(string descriptionURL)",
  "function setNftMultiplierAddress(address nftMultiplier)",
] as const;

const ERC20_GOV_ABI = [
  "function blacklist(address[] users, bool isBlacklisted)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const ERC721_MULTIPLIER_ABI = [
  "function setTokenURI(uint256 tokenId, string uri)",
  "function mint(address to, uint256 multiplier, uint256 rewardPeriod, string metadataUrl)",
  "function changeToken(uint256 tokenId, uint256 multiplier, uint256 rewardPeriod)",
] as const;

const GOV_SETTINGS_FULL_ABI = [
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
  "function changeExecutors(address[] executors, uint256[] settingsIds)",
] as const;

// ---------- shared shapes ----------

type Action = { executor: string; value: string; data: string };

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function payloadOutputSchema() {
  return {
    metadata: z.unknown(),
    actions: z.array(
      z.object({ executor: z.string(), value: z.string(), data: z.string() }),
    ),
  };
}

function wrapperResult(params: {
  metadata: unknown;
  actions: Action[];
  title: string;
  detail: string;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${params.title}\n${params.detail}\n\nNext:\n` +
          `1) dexe_ipfs_upload_proposal_metadata with the metadata object → get CID\n` +
          `2) dexe_proposal_build_external with descriptionURL=<CID>, actionsOnFor=actions (${params.actions.length} action${params.actions.length === 1 ? "" : "s"})`,
      },
    ],
    structuredContent: { metadata: params.metadata, actions: params.actions },
  };
}

// ---------- register ----------

export function registerProposalBuildComplexTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerTokenDistribution(server);
  registerTokenSale(server);
  registerTokenSaleRecover(server);
  registerCreateStakingTier(server);
  registerChangeMathModel(server);
  registerModifyDaoProfile(server);
  registerBlacklistManagement(server);
  registerRewardMultiplier(server);
  registerApplyToDao(server);
  registerNewProposalType(server);
}

// ---------- 1. token_distribution ----------

function registerTokenDistribution(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_distribution",
    {
      title: "Wrapper: batch token distribution via DistributionProposal",
      description:
        "Builds a 'Token Distribution' external proposal. Encodes `DistributionProposal.execute(proposalId, token, amount)`. For ERC20 tokens, automatically prepends an `ERC20.approve` action. For native tokens (isNative=true), sets the action value instead. `proposalId` is the DAO's latest proposalId + 1.",
      inputSchema: {
        distributionProposal: z
          .string()
          .describe("DistributionProposal address (from catalog / registry lookup)"),
        proposalId: z
          .string()
          .describe("Expected proposalId for this distribution (usually latestProposalId + 1)"),
        token: z.string(),
        amount: z.string(),
        isNative: z.boolean().default(false).describe("True for native token (BNB/ETH) — sends value instead of approve"),
        proposalName: z.string().default("Token Distribution"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      distributionProposal,
      proposalId,
      token,
      amount,
      isNative = false,
      proposalName = "Token Distribution",
      proposalDescription = "",
    }) => {
      if (!isAddress(distributionProposal)) return errorResult(`Invalid distributionProposal: ${distributionProposal}`);
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      try {
        const distIface = new Interface(DISTRIBUTION_PROPOSAL_ABI as unknown as string[]);
        const executeData = distIface.encodeFunctionData("execute", [
          BigInt(proposalId),
          token,
          BigInt(amount),
        ]);
        const actions: Action[] = [];
        if (isNative) {
          actions.push({ executor: distributionProposal, value: amount, data: executeData });
        } else {
          const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
          const approveData = erc20Iface.encodeFunctionData("approve", [distributionProposal, BigInt(amount)]);
          actions.push({ executor: token, value: "0", data: approveData });
          actions.push({ executor: distributionProposal, value: "0", data: executeData });
        }
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Token Distribution",
          isMeta: false,
          changes: {
            proposedChanges: { tokenAddress: token, tokenAmount: amount, proposalId },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Token Distribution → ${amount} of ${token} via proposal #${proposalId}`,
          detail: `Target: DistributionProposal(${distributionProposal}).execute (${actions.length} actions)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 2. token_sale ----------

function registerTokenSale(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_sale",
    {
      title: "Wrapper: launch a token-sale tier via TokenSaleProposal.createTiers",
      description:
        "Builds a Token Sale proposal with a single tier. Covers the common case (basic tier, optional plain whitelist, no merkle participation). For advanced merkle-whitelist tiers, encode `participationDetails` externally and use `dexe_proposal_build_custom_abi` instead.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tier: z.object({
          name: z.string(),
          description: z.string().default(""),
          totalTokenProvided: z.string(),
          saleStartTime: z.string().describe("Unix seconds"),
          saleEndTime: z.string().describe("Unix seconds"),
          saleTokenAddress: z.string(),
          claimLockDuration: z.string().default("0"),
          purchaseTokenAddresses: z.array(z.string()).min(1),
          exchangeRates: z.array(z.string()).min(1),
          minAllocationPerUser: z.string().default("0"),
          maxAllocationPerUser: z.string().default("0"),
          vestingSettings: z
            .object({
              cliffPeriod: z.string().default("0"),
              unlockStep: z.string().default("0"),
              vestingDuration: z.string().default("0"),
              vestingPercentage: z.string().default("0"),
            })
            .default({
              cliffPeriod: "0",
              unlockStep: "0",
              vestingDuration: "0",
              vestingPercentage: "0",
            }),
        }),
        proposalName: z.string().default("Token Sale"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ tokenSaleProposal, tier, proposalName = "Token Sale", proposalDescription = "" }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      if (!isAddress(tier.saleTokenAddress)) return errorResult(`Invalid saleTokenAddress`);
      if (tier.purchaseTokenAddresses.length !== tier.exchangeRates.length) {
        return errorResult("purchaseTokenAddresses and exchangeRates must be parallel arrays");
      }
      try {
        const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
        const tierTuple = [
          [tier.name, tier.description],
          BigInt(tier.totalTokenProvided),
          BigInt(tier.saleStartTime),
          BigInt(tier.saleEndTime),
          tier.saleTokenAddress,
          BigInt(tier.claimLockDuration),
          tier.purchaseTokenAddresses,
          tier.exchangeRates.map((r) => BigInt(r)),
          BigInt(tier.minAllocationPerUser),
          BigInt(tier.maxAllocationPerUser),
          [
            BigInt(tier.vestingSettings.cliffPeriod),
            BigInt(tier.vestingSettings.unlockStep),
            BigInt(tier.vestingSettings.vestingDuration),
            BigInt(tier.vestingSettings.vestingPercentage),
          ],
          [], // participationDetails — empty for the common case
        ];
        const data = iface.encodeFunctionData("createTiers", [[tierTuple]]);
        const actions: Action[] = [];
        // Prepend ERC20.approve for the sale token (required for on-chain execution)
        if (isAddress(tier.saleTokenAddress)) {
          const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
          const approveData = erc20Iface.encodeFunctionData("approve", [
            tokenSaleProposal,
            BigInt(tier.totalTokenProvided),
          ]);
          actions.push({ executor: tier.saleTokenAddress, value: "0", data: approveData });
        }
        actions.push({ executor: tokenSaleProposal, value: "0", data });
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Token Sale",
          isMeta: false,
          changes: {
            proposedChanges: { tier },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Token Sale tier → ${tier.name}`,
          detail: `Target: TokenSaleProposal(${tokenSaleProposal}).createTiers (1 tier)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 3. token_sale_recover ----------

function registerTokenSaleRecover(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_sale_recover",
    {
      title: "Wrapper: recover unsold tokens from token-sale tiers",
      description:
        "Builds a 'Recover Token Sale' external proposal calling TokenSaleProposal.recover(tierIds).",
      inputSchema: {
        tokenSaleProposal: z.string(),
        tierIds: z.array(z.string()).min(1),
        proposalName: z.string().default("Recover Token Sale"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      tokenSaleProposal,
      tierIds,
      proposalName = "Recover Token Sale",
      proposalDescription = "",
    }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      try {
        const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("recover", [tierIds.map((n) => BigInt(n))]);
        const actions: Action[] = [{ executor: tokenSaleProposal, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Recover Token Sale",
          isMeta: false,
          changes: {
            proposedChanges: { tierIds },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Recover tiers [${tierIds.join(", ")}]`,
          detail: `Target: TokenSaleProposal(${tokenSaleProposal}).recover`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 4. create_staking_tier ----------

function registerCreateStakingTier(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_create_staking_tier",
    {
      title: "Wrapper: create a staking pool/tier via StakingProposal.createStaking",
      description:
        "Builds a 'Create Staking Tier' external proposal calling StakingProposal.createStaking(rewardToken, rewardAmount, startedAt, deadline, metadata). For ERC20 reward tokens, automatically prepends an ERC20.approve action. For native tokens (isNative=true), sets the action value instead.",
      inputSchema: {
        stakingProposal: z.string().describe("StakingProposal contract address"),
        rewardToken: z.string(),
        rewardAmount: z.string(),
        startedAt: z.string().describe("Unix seconds"),
        deadline: z.string().describe("Unix seconds"),
        stakingMetadataUrl: z.string().describe("ipfs://<cid> of staking-specific metadata"),
        isNative: z.boolean().default(false).describe("True when reward token is native (BNB/ETH)"),
        proposalName: z.string().default("Create Staking"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      stakingProposal,
      rewardToken,
      rewardAmount,
      startedAt,
      deadline,
      stakingMetadataUrl,
      isNative = false,
      proposalName = "Create Staking",
      proposalDescription = "",
    }) => {
      if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
      if (!isAddress(rewardToken)) return errorResult(`Invalid rewardToken: ${rewardToken}`);
      try {
        const iface = new Interface(STAKING_PROPOSAL_ABI as unknown as string[]);
        const createData = iface.encodeFunctionData("createStaking", [
          rewardToken,
          BigInt(rewardAmount),
          BigInt(startedAt),
          BigInt(deadline),
          stakingMetadataUrl,
        ]);
        const actions: Action[] = [];
        if (isNative) {
          actions.push({ executor: stakingProposal, value: rewardAmount, data: createData });
        } else {
          const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
          const approveData = erc20Iface.encodeFunctionData("approve", [stakingProposal, BigInt(rewardAmount)]);
          actions.push({ executor: rewardToken, value: "0", data: approveData });
          actions.push({ executor: stakingProposal, value: "0", data: createData });
        }
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Create Staking",
          isMeta: false,
          changes: {
            proposedChanges: {
              rewardToken,
              rewardAmount,
              startedAt,
              deadline,
              metadata: stakingMetadataUrl,
            },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Create Staking → ${rewardAmount} of ${rewardToken}`,
          detail: `Target: StakingProposal(${stakingProposal}).createStaking`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 5. change_math_model ----------

function registerChangeMathModel(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_change_math_model",
    {
      title: "Wrapper: swap the DAO's vote-power math contract",
      description:
        "Builds a 'Change Math Model' external proposal calling GovPool.changeVotePower(newVotePower). `newVotePower` is the address of a deployed power contract (LINEAR_POWER, POLYNOMIAL_POWER, or a custom one registered in PoolRegistry).",
      inputSchema: {
        govPool: z.string(),
        newVotePower: z.string(),
        proposalName: z.string().default("Change Vote Power"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      newVotePower,
      proposalName = "Change Vote Power",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(newVotePower)) return errorResult(`Invalid newVotePower: ${newVotePower}`);
      try {
        const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("changeVotePower", [newVotePower]);
        const actions: Action[] = [{ executor: govPool, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Change Math Model",
          isMeta: false,
          changes: {
            proposedChanges: { newVotePower },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Change Vote Power → ${newVotePower}`,
          detail: `Target: GovPool(${govPool}).changeVotePower`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 6. modify_dao_profile ----------

function registerModifyDaoProfile(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_modify_dao_profile",
    {
      title: "Wrapper: update the DAO descriptionURL (name, avatar, links)",
      description:
        "Builds a 'Modify DAO Profile' external proposal calling GovPool.editDescriptionURL(url). You upload the new DAO metadata JSON to IPFS first (via dexe_ipfs_upload_dao_metadata), then pass the resulting descriptionURL (ipfs://<cid>) here.",
      inputSchema: {
        govPool: z.string(),
        newDescriptionURL: z.string().describe("ipfs://<cid> of new DAO metadata JSON"),
        proposalName: z.string().default("Modify DAO Profile"),
        proposalDescription: z.string().default(""),
        previousDescriptionURL: z.string().optional(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      newDescriptionURL,
      proposalName = "Modify DAO Profile",
      proposalDescription = "",
      previousDescriptionURL,
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("editDescriptionURL", [newDescriptionURL]);
        const actions: Action[] = [{ executor: govPool, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Modify DAO Profile",
          isMeta: true,
          changes: {
            proposedChanges: { descriptionUrl: newDescriptionURL },
            currentChanges: { descriptionUrl: previousDescriptionURL ?? null },
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Modify DAO Profile → ${newDescriptionURL}`,
          detail: `Target: GovPool(${govPool}).editDescriptionURL`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 7. blacklist_management ----------

function registerBlacklistManagement(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_blacklist",
    {
      title: "Wrapper: add/remove addresses from the DAO token blacklist",
      description:
        "Builds a 'Blacklist Management' external proposal. Emits up to 2 actions: one ERC20Gov.blacklist(add, true) and one ERC20Gov.blacklist(remove, false). Pass empty arrays to skip either.",
      inputSchema: {
        erc20Gov: z.string().describe("DAO ERC20Gov token contract"),
        addAddresses: z.array(z.string()).default([]),
        removeAddresses: z.array(z.string()).default([]),
        proposalName: z.string().default("Blacklist Management"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      erc20Gov,
      addAddresses = [],
      removeAddresses = [],
      proposalName = "Blacklist Management",
      proposalDescription = "",
    }) => {
      if (!isAddress(erc20Gov)) return errorResult(`Invalid erc20Gov: ${erc20Gov}`);
      for (const a of [...addAddresses, ...removeAddresses]) {
        if (!isAddress(a)) return errorResult(`Invalid blacklist address: ${a}`);
      }
      if (addAddresses.length === 0 && removeAddresses.length === 0) {
        return errorResult("Must supply at least one address to add or remove");
      }
      try {
        const iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
        const actions: Action[] = [];
        if (addAddresses.length) {
          actions.push({
            executor: erc20Gov,
            value: "0",
            data: iface.encodeFunctionData("blacklist", [addAddresses, true]),
          });
        }
        if (removeAddresses.length) {
          actions.push({
            executor: erc20Gov,
            value: "0",
            data: iface.encodeFunctionData("blacklist", [removeAddresses, false]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Blacklist Management",
          isMeta: false,
          changes: {
            proposedChanges: { addBlacklist: addAddresses, removeBlacklist: removeAddresses },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Blacklist: +${addAddresses.length} / -${removeAddresses.length}`,
          detail: `Target: ERC20Gov(${erc20Gov}).blacklist (${actions.length} action${actions.length === 1 ? "" : "s"})`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 8. reward_multiplier ----------

function registerRewardMultiplier(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_reward_multiplier",
    {
      title: "Wrapper: manage the DAO's reward-multiplier NFT contract",
      description:
        "Four modes: 'set_address' (GovPool.setNftMultiplierAddress — ZERO to disable), 'set_token_uri' (ERC721Multiplier.setTokenURI on a tokenId), 'mint' (ERC721Multiplier.mint(to, multiplier, rewardPeriod, metadataUrl)), 'change_token' (ERC721Multiplier.changeToken(tokenId, multiplier, rewardPeriod) — modify existing NFT).",
      inputSchema: {
        mode: z.enum(["set_address", "set_token_uri", "mint", "change_token"]),
        govPool: z.string().optional(),
        nftMultiplierContract: z.string().optional(),
        newMultiplierAddress: z.string().optional().describe("For mode=set_address"),
        tokenId: z.string().optional().describe("For mode=set_token_uri or change_token"),
        uri: z.string().optional().describe("For mode=set_token_uri"),
        to: z.string().optional().describe("For mode=mint"),
        multiplier: z.string().optional().describe("For mode=mint or change_token"),
        rewardPeriod: z.string().default("0").describe("For mode=mint or change_token"),
        metadataUrl: z.string().default("").describe("For mode=mint — metadata URI string"),
        proposalName: z.string().default("Reward Multiplier"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async (input) => {
      const { mode, proposalName = "Reward Multiplier", proposalDescription = "" } = input;
      try {
        const actions: Action[] = [];
        if (mode === "set_address") {
          if (!input.govPool || !isAddress(input.govPool))
            return errorResult(`set_address requires valid govPool`);
          const addr = input.newMultiplierAddress ?? ZeroAddress;
          if (!isAddress(addr)) return errorResult(`Invalid newMultiplierAddress: ${addr}`);
          const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
          actions.push({
            executor: input.govPool,
            value: "0",
            data: iface.encodeFunctionData("setNftMultiplierAddress", [addr]),
          });
        } else if (mode === "set_token_uri") {
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`set_token_uri requires valid nftMultiplierContract`);
          if (!input.tokenId) return errorResult(`set_token_uri requires tokenId`);
          if (input.uri === undefined) return errorResult(`set_token_uri requires uri`);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("setTokenURI", [BigInt(input.tokenId), input.uri]),
          });
        } else if (mode === "change_token") {
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`change_token requires valid nftMultiplierContract`);
          if (!input.tokenId) return errorResult(`change_token requires tokenId`);
          if (!input.multiplier) return errorResult(`change_token requires multiplier`);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("changeToken", [
              BigInt(input.tokenId),
              BigInt(input.multiplier),
              BigInt(input.rewardPeriod ?? "0"),
            ]),
          });
        } else {
          // mint — 4-arg: mint(address, uint256, uint256, string)
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`mint requires valid nftMultiplierContract`);
          if (!input.to || !isAddress(input.to)) return errorResult(`mint requires valid to`);
          if (!input.multiplier) return errorResult(`mint requires multiplier`);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("mint", [
              input.to,
              BigInt(input.multiplier),
              BigInt(input.rewardPeriod ?? "0"),
              input.metadataUrl ?? "",
            ]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Reward Multiplier",
          isMeta: false,
          changes: {
            proposedChanges: { ...input, mode },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Reward Multiplier (${mode})`,
          detail: `${actions.length} action${actions.length === 1 ? "" : "s"} encoded`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 9. apply_to_dao ----------

function registerApplyToDao(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_apply_to_dao",
    {
      title: "Wrapper: apply for/disburse DAO tokens to a receiver (transfer + optional mint)",
      description:
        "Builds an 'Apply to DAO' external proposal. If the DAO treasury has enough tokens, emits one ERC20.transfer action. If not, emits ERC20Gov.transfer + ERC20Gov.mint for the shortfall. Pass `treasuryBalance` (in wei) so we decide correctly.",
      inputSchema: {
        token: z.string().describe("The token contract (ERC20 or ERC20Gov)"),
        receiver: z.string(),
        amount: z.string().describe("Total amount to grant, in wei"),
        treasuryBalance: z
          .string()
          .default("0")
          .describe("Current treasury balance of `token`. If >= amount, a single transfer is used."),
        proposalName: z.string().default("Apply to DAO"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      token,
      receiver,
      amount,
      treasuryBalance = "0",
      proposalName = "Apply to DAO",
      proposalDescription = "",
    }) => {
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      if (!isAddress(receiver)) return errorResult(`Invalid receiver: ${receiver}`);
      try {
        const iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
        const actions: Action[] = [];
        const total = BigInt(amount);
        const have = BigInt(treasuryBalance);
        actions.push({
          executor: token,
          value: "0",
          data: iface.encodeFunctionData("transfer", [receiver, total]),
        });
        if (have < total) {
          const shortfall = total - have;
          actions.push({
            executor: token,
            value: "0",
            data: iface.encodeFunctionData("mint", [receiver, shortfall]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Apply to DAO",
          isMeta: false,
          changes: {
            proposedChanges: { receiver, tokenAmount: amount, tokenAddress: token },
            currentChanges: { treasuryBalance },
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Apply to DAO: ${amount} of ${token} → ${receiver}`,
          detail: `${actions.length} action${actions.length === 1 ? "" : "s"} (transfer${actions.length > 1 ? " + mint" : ""})`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 10. new_proposal_type (also: enable_staking) ----------

function registerNewProposalType(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_new_proposal_type",
    {
      title: "Wrapper: register a new proposal settings template + bind executors",
      description:
        "Builds a 'New Proposal Type' external proposal with 2 actions: GovSettings.addSettings([newSettings]) + GovSettings.changeExecutors(executors, [newSettingId, …]). This is also the path for enabling staking (executors include StakingProposal).",
      inputSchema: {
        govSettings: z.string(),
        settings: z.object({
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
          rewardsInfo: z.object({
            rewardToken: z.string(),
            creationReward: z.string().default("0"),
            executionReward: z.string().default("0"),
            voteRewardsCoefficient: z.string().default("0"),
          }),
          executorDescription: z.string().default(""),
        }),
        executors: z.array(z.string()).min(1),
        newSettingId: z
          .string()
          .describe(
            "Id the new setting will receive on GovSettings (= current getSettingsLength()). The agent reads this before building.",
          ),
        proposalName: z.string().default("New Proposal Type"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govSettings,
      settings,
      executors,
      newSettingId,
      proposalName = "New Proposal Type",
      proposalDescription = "",
    }) => {
      if (!isAddress(govSettings)) return errorResult(`Invalid govSettings: ${govSettings}`);
      for (const e of executors) {
        if (!isAddress(e)) return errorResult(`Invalid executor: ${e}`);
      }
      try {
        const iface = new Interface(GOV_SETTINGS_FULL_ABI as unknown as string[]);
        const tuple = [
          settings.earlyCompletion,
          settings.delegatedVotingAllowed,
          settings.validatorsVote,
          BigInt(settings.duration),
          BigInt(settings.durationValidators),
          BigInt(settings.executionDelay),
          BigInt(settings.quorum),
          BigInt(settings.quorumValidators),
          BigInt(settings.minVotesForVoting),
          BigInt(settings.minVotesForCreating),
          [
            settings.rewardsInfo.rewardToken,
            BigInt(settings.rewardsInfo.creationReward),
            BigInt(settings.rewardsInfo.executionReward),
            BigInt(settings.rewardsInfo.voteRewardsCoefficient),
          ],
          settings.executorDescription,
        ];
        const addData = iface.encodeFunctionData("addSettings", [[tuple]]);
        const changeData = iface.encodeFunctionData("changeExecutors", [
          executors,
          executors.map(() => BigInt(newSettingId)),
        ]);
        const actions: Action[] = [
          { executor: govSettings, value: "0", data: addData },
          { executor: govSettings, value: "0", data: changeData },
        ];
        const metadata = {
          proposalName,
          proposalDescription,
          category: "New Proposal Type",
          isMeta: false,
          changes: {
            proposedChanges: { settings, executors, newSettingId },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `New Proposal Type (settingsId=${newSettingId}, ${executors.length} executors)`,
          detail: `Target: GovSettings(${govSettings}).addSettings + changeExecutors (2 actions)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
