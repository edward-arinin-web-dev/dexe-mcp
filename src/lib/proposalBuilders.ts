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
import { settingsAdvisories } from "./protocolAdvisories.js";
import { quorumPctFromRaw, judgeQuorum } from "./quorumRisk.js";
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
  ERC721_MULTIPLIER_MAX,
  UINT64_MAX,
  GOV_SETTINGS_FULL_ABI,
  numericIntString,
  numericAmountString,
  precheckMultiplierContract,
} from "../tools/proposalBuildComplex.js";
import { VALIDATORS_EXEC_ABI } from "../tools/proposalBuildInternal.js";
import { parseUintString } from "./amount.js";
import { parseAmount } from "./units.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "./multicall.js";

const DECIMALS_IFACE = new Interface(["function decimals() view returns (uint8)"]);

/**
 * A8 — amount resolution for the money-mover builders. Digits-only strings are
 * raw smallest units (unchanged back-compat). A decimal string ("12.5") is
 * human units: the token's real decimals are read on-chain and the value is
 * scaled. Needs an RPC only for the human form.
 */
async function resolveTokenAmount(
  amount: string,
  token: string,
  deps: BuilderDeps,
  opts?: { isNative?: boolean },
): Promise<bigint> {
  const s = amount.trim();
  if (/^\d+$/.test(s)) return BigInt(s);
  if (opts?.isNative) return parseAmount(s, 18);
  const pr = new RpcProvider(deps.ctx.config).tryProvider(deps.chainId);
  if ("error" in pr) {
    throw new Error(
      `Amount '${amount}' is in human units, which needs an RPC to read the token's decimals — and no RPC is ` +
        `configured for chain ${deps.chainId}. Either pass the raw smallest-unit amount (digits only) or configure an RPC. ${pr.remediation}`,
    );
  }
  const res = await multicall(pr.ok, [
    { target: token, iface: DECIMALS_IFACE, method: "decimals", args: [], allowFailure: true },
  ]);
  const decimals = res[0]!.success ? Number(res[0]!.value) : 18;
  return parseAmount(s, decimals);
}

// ---------- ABI fragments (identical strings to the build tools) ----------

const ERC20_TRANSFER_ABI = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC721_TRANSFER_ABI = new Interface([
  "function transferFrom(address from, address to, uint256 tokenId)",
]);
const GOV_SETTINGS_ABI = new Interface([
  "function editSettings(uint256[] ids, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] params)",
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
  "function settings(uint256) view returns (bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)",
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
  /** Governance-safety advisories for the proposed config (never empty when present). */
  advisories?: string[];
  /**
   * Worst risk across `advisories`. DANGER makes `dexe_proposal_create` refuse
   * to broadcast until the caller re-runs with `confirmRisky: true`.
   */
  risk?: "DANGER" | "CAUTION";
}

/**
 * Shared advisory pass for builders that carry GovSettings entries
 * (change_voting_settings, new_proposal_type/enable_staking). Quorum below the
 * DANGER threshold (0.8 × floor) is the treasury-drain scenario: whoever buys
 * that share of supply can pass and execute treasury-moving proposals alone.
 */
function settingsRisk(
  entries: { quorum?: string; validatorsVote: boolean; durationValidators: string; executionDelay: string; quorumValidators: string }[],
  floorPct: number,
): { advisories?: string[]; risk?: "DANGER" | "CAUTION" } {
  const advisories = entries.flatMap((s, i) =>
    settingsAdvisories(s, floorPct).map((a) => (entries.length > 1 ? `settings[${i}]: ${a}` : a)),
  );
  if (advisories.length === 0) return {};
  const worst = entries.reduce<"DANGER" | "CAUTION">((acc, s) => {
    if (acc === "DANGER" || s.quorum === undefined) return acc;
    return judgeQuorum(quorumPctFromRaw(s.quorum), floorPct) === "DANGER" ? "DANGER" : acc;
  }, "CAUTION");
  return { advisories, risk: worst };
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
    amount: numericAmountString
      .describe("Amount: raw smallest units (digits-only) OR human units with a decimal point ('12.5', scaled by the token's real decimals)"),
    isNative: z.boolean().default(false).describe("True for native BNB/ETH transfer"),
  }),
  async build(raw, deps) {
    const { ctx } = deps;
    const p = raw as { token: string; recipient: string; amount: string; isNative: boolean };
    if (!isAddress(p.recipient)) throw new Error(`Invalid recipient: ${p.recipient}`);
    if (p.isNative) {
      const amt = (await resolveTokenAmount(p.amount, "", deps, { isNative: true })).toString();
      return {
        actionsOnFor: [{ executor: p.recipient, value: amt, data: "0x" }],
        category: "tokenTransfer",
        metadataExtra: changes({ data: [{ tokenAmount: amt, receiverAddress: p.recipient }], tokenAddress: ZeroAddress }),
        summary: `Native transfer → ${p.recipient} (${amt} wei)`,
      };
    }
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    const bl = await checkBlacklist(ctx.config, p.token, p.recipient, deps.chainId);
    if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.recipient));
    const amount = await resolveTokenAmount(p.amount, p.token, deps);
    const data = ERC20_TRANSFER_ABI.encodeFunctionData("transfer", [p.recipient, amount]);
    return {
      actionsOnFor: [{ executor: p.token, value: "0", data }],
      category: "tokenTransfer",
      metadataExtra: changes({ data: [{ tokenAmount: amount.toString(), receiverAddress: p.recipient }], tokenAddress: p.token }),
      summary: `ERC20(${p.token}).transfer(${p.recipient}, ${amount})`,
    };
  },
};

const withdrawTreasuryBuilder: CatalogBuilder = {
  schema: z.object({
    receiver: z.string().describe("Treasury withdrawal recipient"),
    token: z.string().default("").describe("ERC20 token contract (omit for NFT-only)"),
    amount: numericAmountString
      .default("0")
      .describe("ERC20 amount: raw smallest units (digits-only) or human units ('12.5'). Omit/0 for NFT-only."),
    nftAddress: z.string().default("").describe("ERC721 contract (omit for token-only)"),
    nftIds: z.array(numericIntString).default([]).describe("NFT ids; one transferFrom per id"),
  }),
  async build(raw, deps) {
    const { ctx, govPool } = deps;
    const p = raw as { receiver: string; token: string; amount: string; nftAddress: string; nftIds: string[] };
    if (!isAddress(p.receiver)) throw new Error(`Invalid receiver: ${p.receiver}`);
    const rawAmount =
      p.token.length > 0 && isAddress(p.token) ? await resolveTokenAmount(p.amount, p.token, deps) : BigInt(/^\d+$/.test(p.amount) ? p.amount : "0");
    const wantToken = p.token.length > 0 && rawAmount > 0n;
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
      const bl = await checkBlacklist(ctx.config, p.token, p.receiver, deps.chainId);
      if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.receiver));
      actionsOnFor.push({
        executor: p.token,
        value: "0",
        data: ERC20_TRANSFER_ABI.encodeFunctionData("transfer", [p.receiver, rawAmount]),
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
      metadataExtra: changes({
        receiver: p.receiver,
        token: p.token,
        amount: rawAmount.toString(),
        nftAddress: p.nftAddress,
        nftIds: p.nftIds,
      }),
      summary: `Withdraw treasury → ${p.receiver} (${actionsOnFor.length} action${actionsOnFor.length === 1 ? "" : "s"})`,
    };
  },
};

const changeVotingSettingsBuilder: CatalogBuilder = {
  schema: z.object({
    govSettings: z.string().describe("GovSettings address (dexe_dao_info.helpers.settings)"),
    settings: z.array(ProposalSettingsSchema).min(1),
    settingsIds: z.array(numericIntString).default([]).describe("Ids to edit (parallel to settings). Empty => addSettings"),
  }),
  async build(raw, deps) {
    const p = raw as { govSettings: string; settings: z.infer<typeof ProposalSettingsSchema>[]; settingsIds: string[] };
    if (!isAddress(p.govSettings)) throw new Error(`Invalid govSettings: ${p.govSettings}`);
    if (p.settingsIds.length > 0 && p.settingsIds.length !== p.settings.length) {
      throw new Error("settingsIds length must match settings length when editing");
    }
    // editSettings replaces the WHOLE struct on-chain, so an empty
    // executorDescription silently wipes the settings-JSON IPFS ref the
    // frontend reads (comment/discussion thresholds etc.). Preserve the
    // current on-chain value for any entry the caller left blank.
    const preserveNotes: string[] = [];
    if (p.settingsIds.length > 0 && p.settings.some((s) => !s.executorDescription)) {
      const pr = new RpcProvider(deps.ctx.config).tryProvider(deps.chainId);
      if ("error" in pr) {
        preserveNotes.push(
          "Could not preserve existing executorDescription refs (no RPC for this chain) — blank entries will clear the settings JSON the frontend UI reads.",
        );
      } else {
        const reads = await multicall(
          pr.ok,
          p.settingsIds.map((id) => ({
            target: p.govSettings,
            iface: GOV_SETTINGS_ABI,
            method: "settings",
            args: [BigInt(id)],
            allowFailure: true,
          })),
        );
        p.settings.forEach((s, i) => {
          const r = reads[i];
          if (!s.executorDescription && r?.success) {
            const current = (r.value as unknown[])[11] as string;
            if (current) s.executorDescription = current;
          }
        });
      }
    }
    const tuples = p.settings.map(toSettingsTuple);
    const method = p.settingsIds.length > 0 ? "editSettings" : "addSettings";
    const data =
      method === "editSettings"
        ? GOV_SETTINGS_ABI.encodeFunctionData(method, [p.settingsIds.map((n) => BigInt(n)), tuples])
        : GOV_SETTINGS_ABI.encodeFunctionData(method, [tuples]);
    const risk = settingsRisk(p.settings, deps.ctx.config.minSafeQuorumPct);
    const advisories = [...(risk.advisories ?? []), ...preserveNotes];
    return {
      actionsOnFor: [{ executor: p.govSettings, value: "0", data }],
      category: "changeSettings",
      metadataExtra: changes({ mode: method, settingsIds: p.settingsIds, settings: p.settings }),
      summary: `Change voting settings (${method}, ${p.settings.length} entries)`,
      ...(advisories.length ? { advisories, risk: risk.risk ?? "CAUTION" } : {}),
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
    proposalId: numericIntString.describe("Expected proposalId (usually latestProposalId + 1)"),
    token: z.string(),
    amount: numericAmountString
      .describe("Amount: raw smallest units (digits-only) OR human units with a decimal point ('12.5', scaled by the token's real decimals)"),
    isNative: z.boolean().default(false).describe("True for native token — sends value instead of approve"),
  }),
  async build(raw, deps) {
    const p = raw as { distributionProposal: string; proposalId: string; token: string; amount: string; isNative: boolean };
    if (!isAddress(p.distributionProposal)) throw new Error(`Invalid distributionProposal: ${p.distributionProposal}`);
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    const amt = (await resolveTokenAmount(p.amount, p.token, deps, { isNative: p.isNative })).toString();
    const executeData = DISTRIBUTION_PROPOSAL_ABI.encodeFunctionData("execute", [BigInt(p.proposalId), p.token, BigInt(amt)]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.isNative) {
      actionsOnFor.push({ executor: p.distributionProposal, value: amt, data: executeData });
    } else {
      const approveData = ERC20_TRANSFER_ABI.encodeFunctionData("approve", [p.distributionProposal, BigInt(amt)]);
      actionsOnFor.push({ executor: p.token, value: "0", data: approveData });
      actionsOnFor.push({ executor: p.distributionProposal, value: "0", data: executeData });
    }
    return {
      actionsOnFor,
      category: "tokenDistribution",
      metadataExtra: changes({ tokenAddress: p.token, tokenAmount: amt, proposalId: p.proposalId }),
      summary: `Token distribution → ${amt} of ${p.token} via proposal #${p.proposalId}`,
    };
  },
};

const tokenSaleBuilder: CatalogBuilder = {
  schema: z.object({
    tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
    tiers: z.array(tierSchema).min(1),
    latestTierId: numericIntString.default("0").describe("Current latestTierId() — bump when extending an existing sale"),
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
    value: numericIntString.default("0"),
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
    changes: z.array(z.object({ user: z.string(), balance: numericIntString.describe("Wei; 0 to remove") })).min(1),
  }),
  async build(raw, deps) {
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
    // Self-stall advisory: a balance change that leaves every single validator
    // below the validator quorum means no one validator can complete a round
    // alone — if the others are inactive (or keys are lost) the DAO's validator
    // stage stalls for EVERY future proposal. Warn before it lands on-chain.
    const advisories = await validatorQuorumReachability(p, deps).catch(() => undefined);
    return {
      actionsOnFor: [{ executor: p.govValidators, value: "0", data }],
      category: "changeValidators",
      metadataExtra: changes({ validators: p.changes }),
      summary: `Manage validators (${p.changes.length} changes)`,
      ...(advisories?.length ? { advisories, risk: "CAUTION" as const } : {}),
    };
  },
};

// Frontend parity (useGovPoolCreateValidatorsAllocationProposal): "validators
// allocation" is NOT a validator-stake change — it funds the credit line that
// internal monthly_withdraw proposals draw against, via a self-addressed
// GovPool.setCreditInfo(tokens, amounts) external proposal.
const GOV_POOL_CREDIT_IFACE = new Interface([
  "function setCreditInfo(address[] tokens, uint256[] amounts)",
]);

const validatorsAllocationBuilder: CatalogBuilder = {
  schema: z.object({
    credits: z
      .array(
        z.object({
          token: z.string().describe("Token the validators may draw monthly"),
          amount: numericAmountString.describe(
            "Monthly credit limit: raw smallest units (digits-only) or human units ('12.5', scaled by the token's real decimals)",
          ),
        }),
      )
      .min(1)
      .describe("The validators' monthly credit lines — replaces the whole list on execute"),
  }),
  async build(raw, deps) {
    const p = raw as { credits: { token: string; amount: string }[] };
    const tokens: string[] = [];
    const amounts: bigint[] = [];
    for (const c of p.credits) {
      if (!isAddress(c.token)) throw new Error(`Invalid credit token: ${c.token}`);
      tokens.push(c.token);
      amounts.push(await resolveTokenAmount(c.amount, c.token, deps));
    }
    const data = GOV_POOL_CREDIT_IFACE.encodeFunctionData("setCreditInfo", [tokens, amounts]);
    return {
      actionsOnFor: [{ executor: deps.govPool, value: "0", data }],
      category: "validatorsAllocation",
      metadataExtra: {},
      summary:
        `setCreditInfo: ${tokens.length} monthly credit line(s) for the validators' monthly_withdraw ` +
        `(an internal monthly_withdraw against an unfunded credit reverts)`,
    };
  },
};

/**
 * Computes post-change validator-token distribution and warns when the largest
 * remaining validator falls below the external validator quorum
 * (default-settings quorumValidators vs new total supply). Best-effort: RPC
 * problems return no advisory rather than failing the build.
 */
async function validatorQuorumReachability(
  p: { govValidators: string; changes: { user: string; balance: string }[] },
  deps: BuilderDeps,
): Promise<string[] | undefined> {
  const pr = new RpcProvider(deps.ctx.config).tryProvider(deps.chainId);
  if ("error" in pr) return undefined;
  const provider = pr.ok;
  const validatorsIface = new Interface([
    "function govValidatorsToken() view returns (address)",
  ]);
  const govPoolIface = new Interface([
    "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  ]);
  const [tokenRes, helpersRes] = await multicall(provider, [
    { target: p.govValidators, iface: validatorsIface, method: "govValidatorsToken", args: [], allowFailure: true },
    { target: deps.govPool, iface: govPoolIface, method: "getHelperContracts", args: [], allowFailure: true },
  ]);
  if (!tokenRes?.success || !helpersRes?.success) return undefined;
  const tokenAddr = tokenRes.value as string;
  const settingsAddr = (helpersRes.value as unknown[])[0] as string;
  const erc20Iface = new Interface([
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const settingsIface = new Interface([
    "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
  ]);
  const reads = await multicall(provider, [
    { target: tokenAddr, iface: erc20Iface, method: "totalSupply", args: [], allowFailure: true },
    { target: settingsAddr, iface: settingsIface, method: "getDefaultSettings", args: [], allowFailure: true },
    ...p.changes.map((c) => ({
      target: tokenAddr,
      iface: erc20Iface,
      method: "balanceOf",
      args: [c.user] as unknown[],
      allowFailure: true,
    })),
  ]);
  const [supplyRes, defRes, ...balanceReads] = reads;
  if (!supplyRes?.success || !defRes?.success) return undefined;
  let newTotal = supplyRes.value as bigint;
  let largestChanged = 0n;
  for (let i = 0; i < p.changes.length; i++) {
    const cur = balanceReads[i]?.success ? (balanceReads[i]!.value as bigint) : 0n;
    const next = BigInt(p.changes[i]!.balance);
    newTotal = newTotal - cur + next;
    if (next > largestChanged) largestChanged = next;
  }
  if (newTotal === 0n) {
    return ["All validator balances end at 0 — the validator stage can never reach quorum again."];
  }
  // quorumValidators is a 25-decimal percentage (100% = 1e27).
  const quorumPct = (defRes.value as unknown[])[7] as bigint;
  const needed = (newTotal * quorumPct + (10n ** 27n - 1n)) / 10n ** 27n;
  // Unchanged validators' balances aren't enumerable cheaply; compare against the
  // largest balance we know of (changed entries). If even the untouched largest
  // could exceed it we still warn only when NO changed validator reaches quorum
  // alone AND the changed set includes a total increase (dilution risk).
  if (largestChanged < needed) {
    return [
      `After this change the external validator quorum needs ${needed} of ${newTotal} validator-token wei, ` +
        `and the largest CHANGED validator holds only ${largestChanged}. If no untouched validator meets the bar alone, ` +
        `passing any validator round will require multiple active validators — inactive or lost-key seats can stall ` +
        `the DAO's validator stage for every future proposal. Verify enough active validators jointly exceed the quorum ` +
        `before executing. [governance-safety advisory]`,
    ];
  }
  return undefined;
}

const delegateToExpertBuilder: CatalogBuilder = {
  schema: z.object({
    expert: z.string().describe("Expert address receiving the treasury delegation"),
    amount: numericIntString.describe("Token amount in wei"),
    nftIds: z.array(numericIntString).default([]),
    value: numericIntString.default("0").describe("Native coin value for payable path"),
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
    amount: numericIntString,
    nftIds: z.array(numericIntString).default([]),
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
    tierIds: z.array(numericIntString).min(1),
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
      .array(z.object({ tierId: numericIntString, users: z.array(z.string()).min(1), uri: z.string().default("") }))
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

// F7: nothing on-chain hands the StakingProposal address out via
// registry/factory — the frontend resolves it from the DAO's GovUserKeeper
// (useGovStakingAddress.ts) and deploys it ON DEMAND when unset.
const STAKING_RESOLVER_IFACE = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function stakingProposalAddress() view returns (address)",
  "function deployStakingProposal()",
]);

/** Resolve the DAO's StakingProposal via GovUserKeeper.stakingProposalAddress() (frontend parity). */
async function resolveStakingProposal(deps: BuilderDeps): Promise<string> {
  const pr = new RpcProvider(deps.ctx.config).tryProvider(deps.chainId);
  if ("error" in pr) {
    throw new Error(
      `stakingProposal was omitted (auto-resolve needs an RPC) and no RPC is configured for chain ${deps.chainId}. ` +
        `Pass stakingProposal explicitly (source: GovUserKeeper.stakingProposalAddress()) or configure an RPC. ${pr.remediation}`,
    );
  }
  const [helpersR] = await multicall(pr.ok, [
    { target: deps.govPool, iface: STAKING_RESOLVER_IFACE, method: "getHelperContracts", args: [], allowFailure: true },
  ]);
  if (!helpersR?.success) throw new Error(`Could not read getHelperContracts() on GovPool ${deps.govPool}.`);
  const userKeeper = (helpersR.value as unknown as { userKeeper: string }).userKeeper;
  const [stakingR] = await multicall(pr.ok, [
    { target: userKeeper, iface: STAKING_RESOLVER_IFACE, method: "stakingProposalAddress", args: [], allowFailure: true },
  ]);
  if (!stakingR?.success) {
    // A reverting getter (raw 0x) means the DEPLOYED UserKeeper implementation
    // predates the staking feature entirely — protocol-side, observed on every
    // chain-97 pool as of 2026-07: nothing MCP-side can enable staking there.
    throw new Error(
      `stakingProposalAddress() reverted on GovUserKeeper ${userKeeper} — this pool's deployed UserKeeper ` +
        `implementation predates staking support, so staking proposals are unavailable for this DAO ` +
        `(protocol limitation, not a config issue). If you are sure staking exists here, pass stakingProposal explicitly.`,
    );
  }
  const staking = stakingR.value as string;
  if (!staking || staking === ZeroAddress) {
    // Give the EXACT paste-able payload: a weak model told only the function
    // name will guess a selector (observed live: 0x3f6b57d9 guessed, B9 caught
    // the revert). deployStakingProposal is a PERMISSIONLESS direct tx — it
    // must never be wrapped into a governance proposal (custom/custom_abi).
    const deployData = STAKING_RESOLVER_IFACE.encodeFunctionData("deployStakingProposal", []);
    throw new Error(
      `This DAO has no StakingProposal deployed yet — GovUserKeeper.stakingProposalAddress() is the zero address. ` +
        `Deploy it first with ONE direct transaction (permissionless, NOT a governance proposal — do not wrap it ` +
        `in custom/custom_abi): call dexe_tx_send with exactly ` +
        `{"to":"${userKeeper}","data":"${deployData}","value":"0","chainId":${deps.chainId}} ` +
        `and then re-run this SAME call.`,
    );
  }
  return staking;
}

const createStakingTierBuilder: CatalogBuilder = {
  schema: z.object({
    stakingProposal: z
      .string()
      .optional()
      .describe(
        "StakingProposal contract address. Omit to auto-resolve via the DAO's GovUserKeeper.stakingProposalAddress() " +
          "(frontend parity); if it is not deployed yet you get the deployStakingProposal() remediation.",
      ),
    rewardToken: z.string(),
    rewardAmount: numericIntString.describe("Reward amount in raw smallest units (wei)"),
    startedAt: numericIntString.describe("Unix seconds"),
    deadline: numericIntString.describe("Unix seconds"),
    stakingMetadataUrl: z.string().describe("ipfs://<cid> of staking-specific metadata"),
    isNative: z.boolean().default(false),
  }),
  async build(raw, deps) {
    const p = raw as {
      stakingProposal?: string; rewardToken: string; rewardAmount: string;
      startedAt: string; deadline: string; stakingMetadataUrl: string; isNative: boolean;
    };
    const stakingProposal = p.stakingProposal ?? (await resolveStakingProposal(deps));
    if (!isAddress(stakingProposal)) throw new Error(`Invalid stakingProposal: ${stakingProposal}`);
    if (!isAddress(p.rewardToken)) throw new Error(`Invalid rewardToken: ${p.rewardToken}`);
    // StakingProposal.createStaking SILENTLY rejects a past deadline: the
    // execute succeeds (status 1), the reward bounces back to the treasury,
    // a StakingRejected event is emitted, and NO tier exists. Proven on-chain
    // 2026-07-23 (mainnet proposal executed with a 2024 deadline → 0 tiers).
    // Refuse here, before any transaction — and remember the deadline must
    // still be in the future when the proposal EXECUTES, not just now.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const startedAt = BigInt(p.startedAt);
    const deadline = BigInt(p.deadline);
    if (startedAt >= deadline) {
      throw new Error(
        `create_staking_tier: startedAt (${p.startedAt}) must be BEFORE deadline (${p.deadline}) — the contract reverts 'SP: Invalid settings'.`,
      );
    }
    if (deadline <= nowSec) {
      throw new Error(
        `create_staking_tier: deadline ${p.deadline} (${new Date(Number(deadline) * 1000).toISOString()}) is in the PAST — ` +
          `current unix time is ~${nowSec}. The contract would SILENTLY reject the tier at execute (transaction succeeds, ` +
          `no tier is created, the reward returns to the treasury). Use future timestamps computed from the current time — ` +
          `never guess the date — and leave headroom for the voting period before execution.`,
      );
    }
    const iface = new Interface(STAKING_PROPOSAL_ABI as unknown as string[]);
    const createData = iface.encodeFunctionData("createStaking", [
      p.rewardToken, BigInt(p.rewardAmount), BigInt(p.startedAt), BigInt(p.deadline), p.stakingMetadataUrl,
    ]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    if (p.isNative) {
      actionsOnFor.push({ executor: stakingProposal, value: p.rewardAmount, data: createData });
    } else {
      const erc20 = new Interface(ERC20_GOV_FULL_ABI as unknown as string[]);
      actionsOnFor.push({
        executor: p.rewardToken,
        value: "0",
        data: erc20.encodeFunctionData("approve", [stakingProposal, BigInt(p.rewardAmount)]),
      });
      actionsOnFor.push({ executor: stakingProposal, value: "0", data: createData });
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
    tokenId: numericIntString.optional(),
    uri: z.string().optional(),
    to: z.string().optional().describe("For mode=mint"),
    multiplier: numericIntString.optional().describe("Scaled by PRECISION=1e25 (1.5x => 15000000000000000000000000)"),
    rewardPeriod: numericIntString.default("0").describe("Lock duration in SECONDS (uint64)"),
    metadataUrl: z.string().default(""),
  }),
  async build(raw, deps) {
    const { govPool } = deps;
    const p = raw as {
      mode: "set_address" | "set_token_uri" | "mint" | "change_token";
      nftMultiplierContract?: string; newMultiplierAddress?: string; tokenId?: string;
      uri?: string; to?: string; multiplier?: string; rewardPeriod: string; metadataUrl: string;
    };
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    const warnings: string[] = [];
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
      // Bug #31 guard: refuse up-front when the multiplier is undeployed or not
      // owned by the GovPool — GovPool.execute would otherwise revert onlyOwner
      // and strand the proposal in SucceededFor. Degrades to a no-op offline.
      const pre = await precheckMultiplierContract(
        deps.ctx.config,
        {
          govPool,
          multiplierContract: p.nftMultiplierContract,
          checkCurrentAddress: p.mode === "mint" || p.mode === "change_token",
          // Wire the bug #31 selector-existence scan into the composite path too
          // (the standalone dexe_proposal_build_reward_multiplier already passes it).
          selectorCheck: p.mode === "mint" ? "mint" : p.mode === "change_token" ? "change_token" : undefined,
        },
        deps.chainId,
      );
      if (pre.refuse) throw new Error(pre.refuse);
      warnings.push(...pre.warnings);
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
        if (multiplierBn > ERC721_MULTIPLIER_MAX) {
          throw new Error(
            `${p.mode}: multiplier ${multiplierBn} looks over-scaled (> 100x = 1e27). PRECISION=1e25, so 1.5x = 15000000000000000000000000.`,
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
          if (p.to === ZeroAddress) throw new Error("mint: recipient 'to' is the zero address — ERC721 mint to 0x0 reverts. Pass the real holder address.");
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
      ...(warnings.length ? { advisories: warnings } : {}),
    };
  },
};

const applyToDaoBuilder: CatalogBuilder = {
  schema: z.object({
    token: z.string().describe("The DAO token contract (ERC20 or ERC20Gov)"),
    receiver: z.string(),
    amount: z.string().describe("Total amount to grant: raw smallest units (digits-only) or human units ('12.5')"),
    treasuryBalance: z
      .string()
      .optional()
      .describe("Current treasury balance of `token` in RAW smallest units. Omit to auto-read the live GovPool balance on-chain (recommended). If >= amount a single transfer is used, else transfer + mint shortfall."),
  }),
  async build(raw, deps) {
    const { ctx } = deps;
    const p = raw as { token: string; receiver: string; amount: string; treasuryBalance?: string };
    if (!isAddress(p.token)) throw new Error(`Invalid token: ${p.token}`);
    if (!isAddress(p.receiver)) throw new Error(`Invalid receiver: ${p.receiver}`);
    const bl = await checkBlacklist(ctx.config, p.token, p.receiver, deps.chainId);
    if (bl.status === "blacklisted") throw new Error(blacklistError(p.token, p.receiver));
    const iface = new Interface(ERC20_GOV_FULL_ABI as unknown as string[]);
    const actionsOnFor: { executor: string; value?: string; data: string }[] = [];
    const total = await resolveTokenAmount(p.amount, p.token, deps);
    // F11: frontend semantics are transfer-first, mint only the shortfall. An
    // omitted treasuryBalance used to default to 0, silently minting the full
    // grant — now the live GovPool balance is read instead.
    let have: bigint;
    if (p.treasuryBalance !== undefined) {
      have = parseUintString(p.treasuryBalance, "treasuryBalance");
    } else {
      const pr = new RpcProvider(deps.ctx.config).tryProvider(deps.chainId);
      if ("error" in pr) {
        throw new Error(
          `treasuryBalance was omitted (auto-read needs an RPC) and no RPC is configured for chain ${deps.chainId}. ` +
            `Pass treasuryBalance explicitly (dexe_read_treasury) or configure an RPC. ${pr.remediation}`,
        );
      }
      const res = await multicall(pr.ok, [
        { target: p.token, iface: ERC20_TRANSFER_ABI, method: "balanceOf", args: [deps.govPool], allowFailure: true },
      ]);
      if (!res[0]!.success) throw new Error(`Could not read treasury balance of ${p.token} at ${deps.govPool} — pass treasuryBalance explicitly.`);
      have = BigInt(res[0]!.value as string | number | bigint);
    }
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
          proposedChanges: { receiver: p.receiver, tokenAmount: total.toString(), tokenAddress: p.token },
          currentChanges: { treasuryBalance: have.toString() },
        },
      },
      summary: `Apply to DAO: ${total} of ${p.token} → ${p.receiver}`,
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
    newSettingId: numericIntString.describe("Id the new setting receives (= current getSettingsLength(); read via dexe_read_settings)"),
  }),
  async build(raw, deps) {
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
      ...settingsRisk([p.settings], deps.ctx.config.minSafeQuorumPct),
    };
  },
};

/**
 * Registry keyed by the short `proposalType` accepted by `dexe_proposal_create`.
 * Extend this to wire another catalog type into the composite. Aliases point at
 * the same builder object (enable_staking ≡ new_proposal_type with
 * StakingProposal among executors — matching the frontend, which reuses
 * useGovPoolCreateProposalType). validators_allocation is its own builder
 * (GovPool.setCreditInfo) — NOT an alias of manage_validators.
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
  // 0.29: was mis-aliased to manageValidatorsBuilder (changeBalances) — the
  // frontend's "validators allocation" is setCreditInfo, a different operation.
  validators_allocation: validatorsAllocationBuilder,
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
  /** GovValidators internal type (IGovValidators.ProposalType): 0 ChangeSettings, 1 ChangeBalances, 2 MonthlyWithdraw, 3 OffchainProposal. */
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
        internalType: 1,
        data,
        category: "changeValidatorBalances",
        metadataExtra: {},
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
        internalType: 0,
        data,
        category: "changeValidatorSettings",
        metadataExtra: {},
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
        metadataExtra: {},
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
        category: "emptyTx",
        metadataExtra: {},
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
