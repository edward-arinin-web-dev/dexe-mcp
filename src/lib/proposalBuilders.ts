/**
 * Server-side proposal action builders — the shared core behind the extended
 * `dexe_proposal_create` (see `src/tools/flow.ts`). Each entry maps a short
 * `proposalType` (e.g. `token_transfer`) to a zod param schema + a pure(ish)
 * builder that returns the on-chain `actionsOnFor`, the frontend metadata
 * `category`, and the `changes` payload the indexer expects.
 *
 * These builders MUST stay byte-parity with the equivalent
 * `dexe_proposal_build_*` tools (verified in `tests/lib/proposalBuilders.test.ts`).
 * Where a pure encoder already exists (token sale tiers, settings tuples) we
 * import it directly so there is a single source of truth for the calldata.
 *
 * A builder throws on bad input; the caller (`runProposalCreate`) turns the
 * throw into an actionable tool error. Builders never broadcast — they only
 * shape actions + metadata for the flow to deposit/create/vote.
 */
import { z } from "zod";
import { Interface, isAddress, getAddress, ZeroAddress } from "ethers";
import type { ToolContext } from "../tools/context.js";
import { checkBlacklist, blacklistError } from "./blacklist.js";
import { findForbiddenSelector, dangerousSelectorError } from "./dangerousSelectors.js";
import {
  ProposalSettingsSchema,
  toSettingsTuple,
  GOV_VALIDATORS_ABI,
  GOV_POOL_TREASURY_ABI,
} from "../tools/proposalBuildMore.js";
import {
  buildTokenSaleMultiActions,
  tierSchema,
  TOKEN_SALE_PROPOSAL_ABI,
  STAKING_PROPOSAL_ABI,
  GOV_POOL_EXT_ABI,
  ERC20_GOV_ABI as ERC20_GOV_FULL_ABI,
  ERC721_MULTIPLIER_ABI,
  ERC721_MULTIPLIER_PRECISION,
  UINT64_MAX,
  GOV_SETTINGS_FULL_ABI,
} from "../tools/proposalBuildComplex.js";
import { VALIDATORS_EXEC_ABI } from "../tools/proposalBuildInternal.js";
import { parseUintString } from "./amount.js";

// ---------- ABI fragments (identical strings to the build tools) ----------

const ERC20_TRANSFER_ABI = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ERC721_TRANSFER_ABI = new Interface([
  "function transferFrom(address from, address to, uint256 tokenId)",
]);
const GOV_SETTINGS_ABI = new Interface([
  "function editSettings(uint256[] ids, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] params)",
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
]);
const EXPERT_NFT_ABI = new Interface([
  "function mint(address to, string uri)",
  "function burn(address from)",
]);
const DISTRIBUTION_PROPOSAL_ABI = new Interface([
  "function execute(uint256 proposalId, address token, uint256 amount)",
]);

// ---------- shared types ----------

export interface BuiltProposalActions {
  /** On-chain actions the DAO will execute (executor/value/data). */
  actionsOnFor: { executor: string; value?: string; data: string }[];
  /** Frontend metadata category (e.g. "tokenTransfer"). */
  category?: string;
  /** Extra fields merged into the proposal IPFS metadata (e.g. `changes`). */
  metadataExtra: Record<string, unknown>;
  /** Short human summary for the flow step label. */
  summary: string;
}

export interface BuilderDeps {
  ctx: ToolContext;
  /** DAO GovPool address — used as `from` for treasury NFT transfers. */
  govPool: string;
  chainId: number;
}

export interface CatalogBuilder {
  schema: z.ZodTypeAny;
  build: (params: unknown, deps: BuilderDeps) => Promise<BuiltProposalActions>;
}

function changes(proposedChanges: Record<string, unknown>) {
  return { changes: { proposedChanges, currentChanges: {} } };
}

// ---------- builders ----------

const tokenTransferBuilder: CatalogBuilder = {
  schema: z.object({
    token: z.string().default("").describe("ERC20 token contract (ignored when isNative=true)"),
    recipient: z.string().describe("Recipient address"),
    amount: z.string().describe("Amount in wei / smallest unit"),
    isNative: z.boolean().default(false).describe("True for native BNB/ETH transfer"),
  }),
  async build(raw, { ctx }) {
    const p = raw as { token: string; recipient: string; amount: string; isNative: boolean };
    if (!isAddress(p.recipient)) throw new Error(`Invalid recipient: ${p.recipient}`);
    if (p.isNative) {
      return {
        actionsOnFor: [{ executor: p.recipient, value: p.amount, data: "0x" }],
        category: "tokenTransfer",
        metadataExtra: changes({ data: [{ tokenAmount: p.amount, receiverAddress: p.recipient }], tokenAddress: ZeroAddress }),
        summary: `Native transfer → ${p.recipient} (${p.amount} wei)`,
      };
    }
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    const bl = await checkBlacklist(ctx.config, p.token, p.recipient);
    if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.recipient));
    const data = ERC20_TRANSFER_ABI.encodeFunctionData("transfer", [p.recipient, BigInt(p.amount)]);
    return {
      actionsOnFor: [{ executor: p.token, value: "0", data }],
      category: "tokenTransfer",
      metadataExtra: changes({ data: [{ tokenAmount: p.amount, receiverAddress: p.recipient }], tokenAddress: p.token }),
      summary: `ERC20(${p.token}).transfer(${p.recipient}, ${p.amount})`,
    };
  },
};

const withdrawTreasuryBuilder: CatalogBuilder = {
  schema: z.object({
    receiver: z.string().describe("Treasury withdrawal recipient"),
    token: z.string().default("").describe("ERC20 token contract (omit for NFT-only)"),
    amount: z.string().default("0").describe("ERC20 amount in wei (omit/0 for NFT-only)"),
    nftAddress: z.string().default("").describe("ERC721 contract (omit for token-only)"),
    nftIds: z.array(z.string()).default([]).describe("NFT ids; one transferFrom per id"),
  }),
  async build(raw, { ctx, govPool }) {
    const p = raw as { receiver: string; token: string; amount: string; nftAddress: string; nftIds: string[] };
    if (!isAddress(p.receiver)) throw new Error(`Invalid receiver: ${p.receiver}`);
    const wantToken = p.token.length > 0 && BigInt(p.amount) > 0n;
    const wantNfts = p.nftAddress.length > 0 && p.nftIds.length > 0;
    if (!wantToken && !wantNfts) {
      throw new Error("Nothing to withdraw — supply `token` + non-zero `amount`, and/or `nftAddress` + `nftIds`.");
    }
    if (wantToken && !isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    if (wantNfts && !isAddress(p.nftAddress)) throw new Error(`Invalid nftAddress: ${p.nftAddress}`);
    // withdraw_treasury MUST emit external token.transfer, NEVER GovPool.withdraw
    // (failure mode 8 — "Gov: invalid internal data"). Treasury sits on GovPool
    // as a plain holding, so each withdrawal is an external ERC20/721 call.
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (wantToken) {
      const bl = await checkBlacklist(ctx.config, p.token, p.receiver);
      if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.receiver));
      actionsOnFor.push({
        executor: p.token,
        value: "0",
        data: ERC20_TRANSFER_ABI.encodeFunctionData("transfer", [p.receiver, BigInt(p.amount)]),
      });
    }
    if (wantNfts) {
      for (const id of p.nftIds) {
        actionsOnFor.push({
          executor: p.nftAddress,
          value: "0",
          data: ERC721_TRANSFER_ABI.encodeFunctionData("transferFrom", [govPool, p.receiver, BigInt(id)]),
        });
      }
    }
    return {
      actionsOnFor,
      category: "withdrawDeposit",
      metadataExtra: changes({ receiver: p.receiver, token: p.token, amount: p.amount, nftAddress: p.nftAddress, nftIds: p.nftIds }),
      summary: `Withdraw treasury → ${p.receiver} (${actionsOnFor.length} action${actionsOnFor.length === 1 ? "" : "s"})`,
    };
  },
};

const changeVotingSettingsBuilder: CatalogBuilder = {
  schema: z.object({
    govSettings: z.string().describe("GovSettings address (dexe_dao_info.helpers.settings)"),
    settings: z.array(ProposalSettingsSchema).min(1),
    settingsIds: z.array(z.string()).default([]).describe("Ids to edit (parallel to settings). Empty => addSettings"),
  }),
  async build(raw) {
    const p = raw as { govSettings: string; settings: z.infer<typeof ProposalSettingsSchema>[]; settingsIds: string[] };
    if (!isAddress(p.govSettings)) throw new Error(`Invalid govSettings: ${p.govSettings}`);
    if (p.settingsIds.length > 0 && p.settingsIds.length !== p.settings.length) {
      throw new Error("settingsIds length must match settings length when editing");
    }
    const tuples = p.settings.map(toSettingsTuple);
    const method = p.settingsIds.length > 0 ? "editSettings" : "addSettings";
    const data =
      method === "editSettings"
        ? GOV_SETTINGS_ABI.encodeFunctionData(method, [p.settingsIds.map((n) => BigInt(n)), tuples])
        : GOV_SETTINGS_ABI.encodeFunctionData(method, [tuples]);
    return {
      actionsOnFor: [{ executor: p.govSettings, value: "0", data }],
      category: "changeSettings",
      metadataExtra: changes({ mode: method, settingsIds: p.settingsIds, settings: p.settings }),
      summary: `Change voting settings (${method}, ${p.settings.length} entries)`,
    };
  },
};

const addExpertBuilder: CatalogBuilder = {
  schema: z.object({
    expertNftContract: z.string().describe("ExpertNft address (local: govPool.getNftContracts().expertNft; global: dexeExpertNft)"),
    scope: z.enum(["local", "global"]),
    nominatedUser: z.string(),
    uri: z.string().default(""),
  }),
  async build(raw) {
    const p = raw as { expertNftContract: string; scope: "local" | "global"; nominatedUser: string; uri: string };
    if (!isAddress(p.expertNftContract)) throw new Error(`Invalid expertNftContract: ${p.expertNftContract}`);
    if (!isAddress(p.nominatedUser)) throw new Error(`Invalid nominatedUser: ${p.nominatedUser}`);
    const data = EXPERT_NFT_ABI.encodeFunctionData("mint", [p.nominatedUser, p.uri]);
    return {
      actionsOnFor: [{ executor: p.expertNftContract, value: "0", data }],
      category: p.scope === "global" ? "globalExpert" : "localExpert",
      metadataExtra: changes({ scope: p.scope, nominatedUser: p.nominatedUser, expertNftContract: p.expertNftContract, uri: p.uri }),
      summary: `Add ${p.scope} expert → ${p.nominatedUser}`,
    };
  },
};

const removeExpertBuilder: CatalogBuilder = {
  schema: z.object({
    expertNftContract: z.string(),
    scope: z.enum(["local", "global"]),
    nominatedUser: z.string(),
  }),
  async build(raw) {
    const p = raw as { expertNftContract: string; scope: "local" | "global"; nominatedUser: string };
    if (!isAddress(p.expertNftContract)) throw new Error(`Invalid expertNftContract: ${p.expertNftContract}`);
    if (!isAddress(p.nominatedUser)) throw new Error(`Invalid nominatedUser: ${p.nominatedUser}`);
    const data = EXPERT_NFT_ABI.encodeFunctionData("burn", [p.nominatedUser]);
    return {
      actionsOnFor: [{ executor: p.expertNftContract, value: "0", data }],
      category: p.scope === "global" ? "globalExpertRemoval" : "localExpertRemoval",
      metadataExtra: changes({ scope: p.scope, nominatedUser: p.nominatedUser, expertNftContract: p.expertNftContract }),
      summary: `Remove ${p.scope} expert → ${p.nominatedUser}`,
    };
  },
};

const tokenDistributionBuilder: CatalogBuilder = {
  schema: z.object({
    distributionProposal: z.string().describe("DistributionProposal address"),
    proposalId: z.string().describe("Expected proposalId (usually latestProposalId + 1)"),
    token: z.string(),
    amount: z.string(),
    isNative: z.boolean().default(false).describe("True for native token — sends value instead of approve"),
  }),
  async build(raw) {
    const p = raw as { distributionProposal: string; proposalId: string; token: string; amount: string; isNative: boolean };
    if (!isAddress(p.distributionProposal)) throw new Error(`Invalid distributionProposal: ${p.distributionProposal}`);
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    const executeData = DISTRIBUTION_PROPOSAL_ABI.encodeFunctionData("execute", [BigInt(p.proposalId), p.token, BigInt(p.amount)]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.isNative) {
      actionsOnFor.push({ executor: p.distributionProposal, value: p.amount, data: executeData });
    } else {
      const approveData = ERC20_TRANSFER_ABI.encodeFunctionData("approve", [p.distributionProposal, BigInt(p.amount)]);
      actionsOnFor.push({ executor: p.token, value: "0", data: approveData });
      actionsOnFor.push({ executor: p.distributionProposal, value: "0", data: executeData });
    }
    return {
      actionsOnFor,
      category: "tokenDistribution",
      metadataExtra: changes({ tokenAddress: p.token, tokenAmount: p.amount, proposalId: p.proposalId }),
      summary: `Token distribution → ${p.amount} of ${p.token} via proposal #${p.proposalId}`,
    };
  },
};

const tokenSaleBuilder: CatalogBuilder = {
  schema: z.object({
    tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
    tiers: z.array(tierSchema).min(1),
    latestTierId: z.string().default("0").describe("Current latestTierId() — bump when extending an existing sale"),
  }),
  async build(raw) {
    const p = raw as { tokenSaleProposal: string; tiers: unknown[]; latestTierId: string };
    // Reuse the canonical multi-tier encoder (single source of truth, also used
    // by the OTC composites). Guarantees calldata parity with the build tool.
    const built = buildTokenSaleMultiActions({
      tokenSaleProposal: p.tokenSaleProposal,
      tiers: p.tiers as never,
      latestTierId: p.latestTierId,
    });
    const meta = built.metadata as { changes?: Record<string, unknown> };
    return {
      actionsOnFor: built.actions,
      category: "tokenSale",
      metadataExtra: meta.changes ? { changes: meta.changes } : {},
      summary: `Token sale tiers → ${built.tierNames}`,
    };
  },
};

const customAbiBuilder: CatalogBuilder = {
  schema: z.object({
    target: z.string().describe("Target contract the DAO will call"),
    signature: z.string().describe("Full function signature, e.g. 'function setX(uint256)'"),
    method: z.string().describe("Method name matching the signature"),
    args: z.array(z.unknown()).default([]),
    value: z.string().default("0"),
  }),
  async build(raw) {
    const p = raw as { target: string; signature: string; method: string; args: unknown[]; value: string };
    if (!isAddress(p.target)) throw new Error(`Invalid target: ${p.target}`);
    const iface = new Interface([p.signature]);
    const coerced = p.args.map((a) => {
      if (typeof a === "string" && /^-?\d+$/.test(a) && a.length > 9) {
        try {
          return BigInt(a);
        } catch {
          return a;
        }
      }
      return a;
    });
    const data = iface.encodeFunctionData(p.method, coerced);
    const forbidden = findForbiddenSelector(data);
    if (forbidden) throw new Error(dangerousSelectorError(forbidden, p.target));
    return {
      actionsOnFor: [{ executor: p.target, value: p.value, data }],
      metadataExtra: {},
      summary: `${p.target}.${p.method}(${p.args.length} args)`,
    };
  },
};

// ---------- v0.22: the remaining external catalog types ----------

const manageValidatorsBuilder: CatalogBuilder = {
  schema: z.object({
    govValidators: z.string().describe("GovValidators address (dexe_dao_info.helpers.validators)"),
    changes: z.array(z.object({ user: z.string(), balance: z.string().describe("Wei; 0 to remove") })).min(1),
  }),
  async build(raw) {
    const p = raw as { govValidators: string; changes: { user: string; balance: string }[] };
    if (!isAddress(p.govValidators)) throw new Error(`Invalid govValidators: ${p.govValidators}`);
    for (const c of p.changes) {
      if (!isAddress(c.user)) throw new Error(`Invalid validator user: ${c.user}`);
    }
    const iface = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("changeBalances", [
      p.changes.map((c) => BigInt(c.balance)),
      p.changes.map((c) => c.user),
    ]);
    return {
      actionsOnFor: [{ executor: p.govValidators, value: "0", data }],
      category: "changeValidators",
      metadataExtra: changes({ validators: p.changes }),
      summary: `Manage validators (${p.changes.length} changes)`,
    };
  },
};

const delegateToExpertBuilder: CatalogBuilder = {
  schema: z.object({
    expert: z.string().describe("Expert address receiving the treasury delegation"),
    amount: z.string().describe("Token amount in wei"),
    nftIds: z.array(z.string()).default([]),
    value: z.string().default("0").describe("Native coin value for payable path"),
  }),
  async build(raw, { govPool }) {
    const p = raw as { expert: string; amount: string; nftIds: string[]; value: string };
    if (!isAddress(p.expert)) throw new Error(`Invalid expert: ${p.expert}`);
    const iface = new Interface(GOV_POOL_TREASURY_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("delegateTreasury", [
      p.expert,
      BigInt(p.amount),
      p.nftIds.map((n) => BigInt(n)),
    ]);
    return {
      actionsOnFor: [{ executor: govPool, value: p.value, data }],
      category: "delegateTokensToExpert",
      metadataExtra: changes({ expert: p.expert, amount: p.amount, nftIds: p.nftIds, value: p.value }),
      summary: `Delegate treasury → ${p.expert} (${p.amount} wei, ${p.nftIds.length} NFTs)`,
    };
  },
};

const revokeFromExpertBuilder: CatalogBuilder = {
  schema: z.object({
    expert: z.string(),
    amount: z.string(),
    nftIds: z.array(z.string()).default([]),
  }),
  async build(raw, { govPool }) {
    const p = raw as { expert: string; amount: string; nftIds: string[] };
    if (!isAddress(p.expert)) throw new Error(`Invalid expert: ${p.expert}`);
    const iface = new Interface(GOV_POOL_TREASURY_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("undelegateTreasury", [
      p.expert,
      BigInt(p.amount),
      p.nftIds.map((n) => BigInt(n)),
    ]);
    return {
      actionsOnFor: [{ executor: govPool, value: "0", data }],
      category: "revokeTokensFromExpert",
      metadataExtra: changes({ expert: p.expert, amount: p.amount, nftIds: p.nftIds }),
      summary: `Revoke treasury delegation ← ${p.expert}`,
    };
  },
};

const tokenSaleRecoverBuilder: CatalogBuilder = {
  schema: z.object({
    tokenSaleProposal: z.string(),
    tierIds: z.array(z.string()).min(1),
  }),
  async build(raw) {
    const p = raw as { tokenSaleProposal: string; tierIds: string[] };
    if (!isAddress(p.tokenSaleProposal)) throw new Error(`Invalid tokenSaleProposal: ${p.tokenSaleProposal}`);
    const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("recover", [p.tierIds.map((n) => BigInt(n))]);
    return {
      actionsOnFor: [{ executor: p.tokenSaleProposal, value: "0", data }],
      category: "recoverTokenSale",
      metadataExtra: changes({ tierIds: p.tierIds }),
      summary: `Recover unsold tokens from tiers [${p.tierIds.join(", ")}]`,
    };
  },
};

const tokenSaleWhitelistBuilder: CatalogBuilder = {
  schema: z.object({
    tokenSaleProposal: z.string(),
    requests: z
      .array(z.object({ tierId: z.string(), users: z.array(z.string()).min(1), uri: z.string().default("") }))
      .min(1),
  }),
  async build(raw) {
    const p = raw as { tokenSaleProposal: string; requests: { tierId: string; users: string[]; uri: string }[] };
    if (!isAddress(p.tokenSaleProposal)) throw new Error(`Invalid tokenSaleProposal: ${p.tokenSaleProposal}`);
    const normalised = p.requests.map((r) => {
      for (const u of r.users) {
        if (!isAddress(u)) throw new Error(`Invalid whitelist user: ${u}`);
      }
      return [BigInt(r.tierId), r.users.map((u) => getAddress(u)), r.uri ?? ""];
    });
    const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("addToWhitelist", [normalised]);
    return {
      actionsOnFor: [{ executor: p.tokenSaleProposal, value: "0", data }],
      category: "tokenSale",
      metadataExtra: changes({ requests: p.requests }),
      summary: `addToWhitelist (${p.requests.length} request${p.requests.length === 1 ? "" : "s"})`,
    };
  },
};

const createStakingTierBuilder: CatalogBuilder = {
  schema: z.object({
    stakingProposal: z.string().describe("StakingProposal contract address"),
    rewardToken: z.string(),
    rewardAmount: z.string(),
    startedAt: z.string().describe("Unix seconds"),
    deadline: z.string().describe("Unix seconds"),
    stakingMetadataUrl: z.string().describe("ipfs://<cid> of staking-specific metadata"),
    isNative: z.boolean().default(false),
  }),
  async build(raw) {
    const p = raw as {
      stakingProposal: string; rewardToken: string; rewardAmount: string;
      startedAt: string; deadline: string; stakingMetadataUrl: string; isNative: boolean;
    };
    if (!isAddress(p.stakingProposal)) throw new Error(`Invalid stakingProposal: ${p.stakingProposal}`);
    if (!isAddress(p.rewardToken)) throw new Error(`Invalid rewardToken: ${p.rewardToken}`);
    const iface = new Interface(STAKING_PROPOSAL_ABI as unknown as string[]);
    const createData = iface.encodeFunctionData("createStaking", [
      p.rewardToken, BigInt(p.rewardAmount), BigInt(p.startedAt), BigInt(p.deadline), p.stakingMetadataUrl,
    ]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.isNative) {
      actionsOnFor.push({ executor: p.stakingProposal, value: p.rewardAmount, data: createData });
    } else {
      const erc20 = new Interface(ERC20_GOV_FULL_ABI as unknown as string[]);
      actionsOnFor.push({
        executor: p.rewardToken,
        value: "0",
        data: erc20.encodeFunctionData("approve", [p.stakingProposal, BigInt(p.rewardAmount)]),
      });
      actionsOnFor.push({ executor: p.stakingProposal, value: "0", data: createData });
    }
    return {
      actionsOnFor,
      category: "createStakingTier",
      metadataExtra: changes({
        rewardToken: p.rewardToken, rewardAmount: p.rewardAmount,
        startedAt: p.startedAt, deadline: p.deadline, metadata: p.stakingMetadataUrl,
      }),
      summary: `Create staking → ${p.rewardAmount} of ${p.rewardToken}`,
    };
  },
};

const changeMathModelBuilder: CatalogBuilder = {
  schema: z.object({
    newVotePower: z.string().describe("Deployed vote-power contract (LINEAR_POWER / POLYNOMIAL_POWER / custom)"),
  }),
  async build(raw, { govPool }) {
    const p = raw as { newVotePower: string };
    if (!isAddress(p.newVotePower)) throw new Error(`Invalid newVotePower: ${p.newVotePower}`);
    const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("changeVotePower", [p.newVotePower]);
    return {
      actionsOnFor: [{ executor: govPool, value: "0", data }],
      category: "mathModel",
      metadataExtra: changes({ newVotePower: p.newVotePower }),
      summary: `Change vote power → ${p.newVotePower}`,
    };
  },
};

const blacklistBuilder: CatalogBuilder = {
  schema: z.object({
    erc20Gov: z.string().describe("DAO ERC20Gov token contract"),
    addAddresses: z.array(z.string()).default([]),
    removeAddresses: z.array(z.string()).default([]),
  }),
  async build(raw) {
    const p = raw as { erc20Gov: string; addAddresses: string[]; removeAddresses: string[] };
    if (!isAddress(p.erc20Gov)) throw new Error(`Invalid erc20Gov: ${p.erc20Gov}`);
    for (const a of [...p.addAddresses, ...p.removeAddresses]) {
      if (!isAddress(a)) throw new Error(`Invalid blacklist address: ${a}`);
    }
    if (p.addAddresses.length === 0 && p.removeAddresses.length === 0) {
      throw new Error("Must supply at least one address to add or remove");
    }
    const iface = new Interface(ERC20_GOV_FULL_ABI as unknown as string[]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.addAddresses.length) {
      actionsOnFor.push({
        executor: p.erc20Gov, value: "0",
        data: iface.encodeFunctionData("blacklist", [p.addAddresses, true]),
      });
    }
    if (p.removeAddresses.length) {
      actionsOnFor.push({
        executor: p.erc20Gov, value: "0",
        data: iface.encodeFunctionData("blacklist", [p.removeAddresses, false]),
      });
    }
    return {
      actionsOnFor,
      category: "blacklistManagement",
      metadataExtra: changes({ addBlacklist: p.addAddresses, removeBlacklist: p.removeAddresses }),
      summary: `Blacklist: +${p.addAddresses.length} / -${p.removeAddresses.length}`,
    };
  },
};

const rewardMultiplierBuilder: CatalogBuilder = {
  schema: z.object({
    mode: z.enum(["set_address", "set_token_uri", "mint", "change_token"]),
    nftMultiplierContract: z.string().optional(),
    newMultiplierAddress: z.string().optional().describe("For mode=set_address (omit/zero to disable)"),
    tokenId: z.string().optional(),
    uri: z.string().optional(),
    to: z.string().optional().describe("For mode=mint"),
    multiplier: z.string().optional().describe("Scaled by PRECISION=1e25 (1.5x => 15000000000000000000000000)"),
    rewardPeriod: z.string().default("0").describe("Lock duration in SECONDS (uint64)"),
    metadataUrl: z.string().default(""),
  }),
  async build(raw, { govPool }) {
    const p = raw as {
      mode: "set_address" | "set_token_uri" | "mint" | "change_token";
      nftMultiplierContract?: string; newMultiplierAddress?: string; tokenId?: string;
      uri?: string; to?: string; multiplier?: string; rewardPeriod: string; metadataUrl: string;
    };
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.mode === "set_address") {
      const addr = p.newMultiplierAddress ?? ZeroAddress;
      if (!isAddress(addr)) throw new Error(`Invalid newMultiplierAddress: ${addr}`);
      const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
      actionsOnFor.push({
        executor: govPool, value: "0",
        data: iface.encodeFunctionData("setNftMultiplierAddress", [addr]),
      });
    } else {
      if (!p.nftMultiplierContract || !isAddress(p.nftMultiplierContract)) {
        throw new Error(`${p.mode} requires valid nftMultiplierContract`);
      }
      const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
      if (p.mode === "set_token_uri") {
        if (!p.tokenId) throw new Error("set_token_uri requires tokenId");
        if (p.uri === undefined) throw new Error("set_token_uri requires uri");
        actionsOnFor.push({
          executor: p.nftMultiplierContract, value: "0",
          data: iface.encodeFunctionData("setTokenURI", [BigInt(p.tokenId), p.uri]),
        });
      } else {
        if (!p.multiplier) throw new Error(`${p.mode} requires multiplier`);
        const multiplierBn = BigInt(p.multiplier);
        if (multiplierBn === 0n) throw new Error(`${p.mode}: multiplier=0 is meaningless — pass 1.5e25 for 1.5x (PRECISION=1e25).`);
        if (multiplierBn < ERC721_MULTIPLIER_PRECISION / 100n) {
          throw new Error(
            `${p.mode}: multiplier ${multiplierBn} is suspiciously small — values are scaled by PRECISION=1e25 (1.5x => 1.5e25). Did you forget the scale?`,
          );
        }
        const durationBn = BigInt(p.rewardPeriod ?? "0");
        if (durationBn > UINT64_MAX) throw new Error(`${p.mode}: rewardPeriod ${durationBn} > uint64 max ${UINT64_MAX}.`);
        if (p.mode === "change_token") {
          if (!p.tokenId) throw new Error("change_token requires tokenId");
          actionsOnFor.push({
            executor: p.nftMultiplierContract, value: "0",
            data: iface.encodeFunctionData("changeToken", [BigInt(p.tokenId), multiplierBn, durationBn]),
          });
        } else {
          if (!p.to || !isAddress(p.to)) throw new Error("mint requires valid to");
          if (durationBn === 0n) throw new Error("mint: rewardPeriod must be > 0 seconds (lock duration).");
          actionsOnFor.push({
            executor: p.nftMultiplierContract, value: "0",
            data: iface.encodeFunctionData("mint", [p.to, multiplierBn, durationBn, p.metadataUrl ?? ""]),
          });
        }
      }
    }
    return {
      actionsOnFor,
      category: "rewardMultiplier",
      metadataExtra: changes({ ...p }),
      summary: `Reward multiplier (${p.mode})`,
    };
  },
};

const applyToDaoBuilder: CatalogBuilder = {
  schema: z.object({
    token: z.string().describe("The DAO token contract (ERC20 or ERC20Gov)"),
    receiver: z.string(),
    amount: z.string().describe("Total amount to grant, in wei"),
    treasuryBalance: z
      .string()
      .default("0")
      .describe("Current treasury balance of `token` in wei (dexe_read_treasury). If >= amount a single transfer is used, else transfer + mint shortfall."),
  }),
  async build(raw, { ctx }) {
    const p = raw as { token: string; receiver: string; amount: string; treasuryBalance: string };
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    if (!isAddress(p.receiver)) throw new Error(`Invalid receiver: ${p.receiver}`);
    const bl = await checkBlacklist(ctx.config, p.token, p.receiver);
    if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.receiver));
    const iface = new Interface(ERC20_GOV_FULL_ABI as unknown as string[]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    const total = parseUintString(p.amount, "amount");
    const have = parseUintString(p.treasuryBalance, "treasuryBalance");
    if (have >= total) {
      actionsOnFor.push({ executor: p.token, value: "0", data: iface.encodeFunctionData("transfer", [p.receiver, total]) });
    } else {
      // H-4: transfer only what the treasury holds, then mint the shortfall.
      if (have > 0n) {
        actionsOnFor.push({ executor: p.token, value: "0", data: iface.encodeFunctionData("transfer", [p.receiver, have]) });
      }
      actionsOnFor.push({ executor: p.token, value: "0", data: iface.encodeFunctionData("mint", [p.receiver, total - have]) });
    }
    return {
      actionsOnFor,
      category: "applyToDao",
      metadataExtra: {
        changes: {
          proposedChanges: { receiver: p.receiver, tokenAmount: p.amount, tokenAddress: p.token },
          currentChanges: { treasuryBalance: p.treasuryBalance },
        },
      },
      summary: `Apply to DAO: ${p.amount} of ${p.token} → ${p.receiver}`,
    };
  },
};

/**
 * Fixed-scope aliases so the catalog-style names (external.add_local_expert,
 * external.remove_global_expert, …) work as proposalType values directly —
 * the scope param disappears because the name already carries it.
 */
function scopedExpertAlias(base: CatalogBuilder, scope: "local" | "global"): CatalogBuilder {
  const baseSchema = base.schema as z.ZodObject<z.ZodRawShape>;
  return {
    schema: baseSchema.omit({ scope: true }),
    build: (params, deps) => base.build({ ...(params as Record<string, unknown>), scope }, deps),
  };
}

const newProposalTypeBuilder: CatalogBuilder = {
  schema: z.object({
    govSettings: z.string().describe("GovSettings address (dexe_dao_info.helpers.settings)"),
    settings: ProposalSettingsSchema,
    executors: z.array(z.string()).min(1),
    newSettingId: z.string().describe("Id the new setting receives (= current getSettingsLength(); read via dexe_read_settings)"),
  }),
  async build(raw) {
    const p = raw as {
      govSettings: string; settings: z.infer<typeof ProposalSettingsSchema>;
      executors: string[]; newSettingId: string;
    };
    if (!isAddress(p.govSettings)) throw new Error(`Invalid govSettings: ${p.govSettings}`);
    for (const e of p.executors) {
      if (!isAddress(e)) throw new Error(`Invalid executor: ${e}`);
    }
    const iface = new Interface(GOV_SETTINGS_FULL_ABI as unknown as string[]);
    const addData = iface.encodeFunctionData("addSettings", [[toSettingsTuple(p.settings)]]);
    const changeData = iface.encodeFunctionData("changeExecutors", [
      p.executors,
      p.executors.map(() => BigInt(p.newSettingId)),
    ]);
    return {
      actionsOnFor: [
        { executor: p.govSettings, value: "0", data: addData },
        { executor: p.govSettings, value: "0", data: changeData },
      ],
      category: "createProposalType",
      metadataExtra: changes({ settings: p.settings, executors: p.executors, newSettingId: p.newSettingId }),
      summary: `New proposal type (settingsId=${p.newSettingId}, ${p.executors.length} executors)`,
    };
  },
};

/**
 * Registry keyed by the short `proposalType` accepted by `dexe_proposal_create`.
 * Extend this to wire another catalog type into the composite. Aliases point at
 * the same builder object (validators_allocation ≡ manage_validators;
 * enable_staking ≡ new_proposal_type with StakingProposal among executors —
 * matching the frontend, which reuses useGovPoolCreateProposalType).
 */
export const PROPOSAL_BUILDERS: Record<string, CatalogBuilder> = {
  token_transfer: tokenTransferBuilder,
  withdraw_treasury: withdrawTreasuryBuilder,
  change_voting_settings: changeVotingSettingsBuilder,
  add_expert: addExpertBuilder,
  remove_expert: removeExpertBuilder,
  token_distribution: tokenDistributionBuilder,
  token_sale: tokenSaleBuilder,
  custom_abi: customAbiBuilder,
  // v0.22 — full catalog coverage
  manage_validators: manageValidatorsBuilder,
  validators_allocation: manageValidatorsBuilder,
  delegate_to_expert: delegateToExpertBuilder,
  revoke_from_expert: revokeFromExpertBuilder,
  token_sale_recover: tokenSaleRecoverBuilder,
  token_sale_whitelist: tokenSaleWhitelistBuilder,
  create_staking_tier: createStakingTierBuilder,
  change_math_model: changeMathModelBuilder,
  blacklist: blacklistBuilder,
  reward_multiplier: rewardMultiplierBuilder,
  apply_to_dao: applyToDaoBuilder,
  new_proposal_type: newProposalTypeBuilder,
  enable_staking: newProposalTypeBuilder,
  // catalog-style names accepted verbatim (no separate scope/name mapping needed)
  delegate_tokens_to_expert: delegateToExpertBuilder,
  revoke_tokens_from_expert: revokeFromExpertBuilder,
  add_local_expert: scopedExpertAlias(addExpertBuilder, "local"),
  add_global_expert: scopedExpertAlias(addExpertBuilder, "global"),
  remove_local_expert: scopedExpertAlias(removeExpertBuilder, "local"),
  remove_global_expert: scopedExpertAlias(removeExpertBuilder, "global"),
};

// ---------- v0.22: internal proposals (GovValidators.createInternalProposal) ----------

export interface BuiltInternalProposal {
  /** GovValidators internal type: 0 ChangeBalances, 1 ChangeSettings, 2 MonthlyWithdraw, 3 OffchainProposal. */
  internalType: 0 | 1 | 2 | 3;
  /** Selector + abi-encoded args for the internal executor method ("0x" for type 3). */
  data: string;
  category: string;
  metadataExtra: Record<string, unknown>;
  summary: string;
}

export interface InternalCatalogBuilder {
  schema: z.ZodTypeAny;
  build: (params: unknown) => BuiltInternalProposal;
}

const validatorsExecIface = () => new Interface(VALIDATORS_EXEC_ABI as unknown as string[]);

/**
 * Internal proposals do NOT go through GovPool.createProposalAndVote — they are
 * created on GovValidators (validators-only voting, no deposit). The flow layer
 * routes these to a single createInternalProposal payload.
 */
export const INTERNAL_PROPOSAL_BUILDERS: Record<string, InternalCatalogBuilder> = {
  change_validator_balances: {
    schema: z.object({
      changes: z.array(z.object({ user: z.string(), balance: z.string().describe("Wei; 0 to remove") })).min(1),
    }),
    build(raw) {
      const p = raw as { changes: { user: string; balance: string }[] };
      for (const c of p.changes) {
        if (!isAddress(c.user)) throw new Error(`Invalid validator address: ${c.user}`);
      }
      const data = validatorsExecIface().encodeFunctionData("changeBalances", [
        p.changes.map((c) => BigInt(c.balance)),
        p.changes.map((c) => c.user),
      ]);
      return {
        internalType: 0,
        data,
        category: "changeValidatorBalances",
        metadataExtra: changes({ validators: p.changes }),
        summary: `Change validator balances (${p.changes.length} changes)`,
      };
    },
  },
  change_validator_settings: {
    schema: z.object({
      duration: z.string().describe("Voting duration in seconds (uint64)"),
      executionDelay: z.string().describe("Delay after success before execution, seconds (uint64)"),
      quorum: z.string().describe("Quorum (uint128, 10^27 percentage scale)"),
    }),
    build(raw) {
      const p = raw as { duration: string; executionDelay: string; quorum: string };
      const data = validatorsExecIface().encodeFunctionData("changeSettings", [
        BigInt(p.duration), BigInt(p.executionDelay), BigInt(p.quorum),
      ]);
      return {
        internalType: 1,
        data,
        category: "changeValidatorSettings",
        metadataExtra: changes({ duration: p.duration, executionDelay: p.executionDelay, quorum: p.quorum }),
        summary: `Change validator settings (duration=${p.duration}s, delay=${p.executionDelay}s)`,
      };
    },
  },
  monthly_withdraw: {
    schema: z.object({
      withdrawals: z.array(z.object({ token: z.string(), amount: z.string() })).min(1),
      destination: z.string(),
    }),
    build(raw) {
      const p = raw as { withdrawals: { token: string; amount: string }[]; destination: string };
      if (!isAddress(p.destination)) throw new Error(`Invalid destination: ${p.destination}`);
      for (const w of p.withdrawals) {
        if (!isAddress(w.token)) throw new Error(`Invalid token: ${w.token}`);
      }
      const data = validatorsExecIface().encodeFunctionData("monthlyWithdraw", [
        p.withdrawals.map((w) => w.token),
        p.withdrawals.map((w) => BigInt(w.amount)),
        p.destination,
      ]);
      return {
        internalType: 2,
        data,
        category: "monthlyWithdraw",
        metadataExtra: changes({ withdrawals: p.withdrawals, destination: p.destination }),
        summary: `Monthly withdraw (${p.withdrawals.length} tokens → ${p.destination})`,
      };
    },
  },
  offchain_internal_proposal: {
    schema: z.object({}),
    build() {
      return {
        internalType: 3,
        data: "0x",
        category: "offchainInternalProposal",
        metadataExtra: changes({}),
        summary: "Off-chain internal proposal (validators attest the off-chain result)",
      };
    },
  },
};

/**
 * Off-chain proposal types live on the DeXe backend (api.dexe.io), not on any
 * contract — `dexe_proposal_create` rejects them with the exact alternative
 * flow instead of a dead-end.
 */
export const OFFCHAIN_FLOW_TYPES = [
  "offchain_single_option",
  "offchain_multi_option",
  "offchain_for_against",
] as const;

/** proposalType values `dexe_proposal_create` accepts directly. */
export const FLOW_PROPOSAL_TYPES = [
  "modify_dao_profile",
  "custom",
  ...Object.keys(PROPOSAL_BUILDERS),
  ...Object.keys(INTERNAL_PROPOSAL_BUILDERS),
  ...OFFCHAIN_FLOW_TYPES,
] as const;
