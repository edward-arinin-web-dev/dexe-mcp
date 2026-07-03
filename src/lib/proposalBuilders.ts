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
import { Interface, isAddress, ZeroAddress } from "ethers";
import type { ToolContext } from "../tools/context.js";
import { checkBlacklist, blacklistError } from "./blacklist.js";
import { findForbiddenSelector, dangerousSelectorError } from "./dangerousSelectors.js";
import {
  ProposalSettingsSchema,
  toSettingsTuple,
} from "../tools/proposalBuildMore.js";
import {
  buildTokenSaleMultiActions,
  tierSchema,
} from "../tools/proposalBuildComplex.js";

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

/**
 * Registry keyed by the short `proposalType` accepted by `dexe_proposal_create`.
 * Extend this to wire another catalog type into the composite.
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
};

/** proposalType values `dexe_proposal_create` accepts directly. */
export const FLOW_PROPOSAL_TYPES = [
  "modify_dao_profile",
  "custom",
  ...Object.keys(PROPOSAL_BUILDERS),
] as const;
