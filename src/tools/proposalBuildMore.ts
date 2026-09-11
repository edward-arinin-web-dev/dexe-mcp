import { z } from "zod";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { checkBlacklist, blacklistError } from "../lib/blacklist.js";
import {
  buildChainIdParam,
  govPoolParam,
  DELEGATEE_DESC,
  NFT_IDS_TREASURY_DESC,
} from "../lib/params.js";
import { settingsAdvisories } from "../lib/protocolAdvisories.js";
import { assessActions, withWarnings, legacyGovernanceAdvisories } from "./buildResult.js";
import { warningsOutputField } from "../lib/buildWarning.js";
import { buildTimeTreasuryAdvisory } from "../lib/quorumRisk.js";
import { safeErrorMessage } from "../lib/redact.js";

/**
 * Phase 3b named wrappers. Every wrapper returns the same scaffold shape as
 * `dexe_proposal_build_token_transfer`:
 *   { metadata, action, nextStep }
 * — the agent then (1) uploads `metadata` via dexe_ipfs_upload_proposal_metadata,
 * (2) calls dexe_proposal_build_external with the returned CID and [action].
 *
 * Signatures were captured verbatim from the DeXe frontend hooks at
 * C:/dev/investing-dashboard/src/hooks/dao/proposals/** (2026-04-15 audit).
 */

const GOV_SETTINGS_ABI = [
  "function editSettings(uint256[] ids, tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] params)",
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
] as const;

export const GOV_VALIDATORS_ABI = [
  "function changeBalances(uint256[] balances, address[] users)",
] as const;

const EXPERT_NFT_ABI = [
  "function mint(address to, string uri)",
  "function burn(address from)",
] as const;

export const GOV_POOL_TREASURY_ABI = [
  "function delegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
  "function undelegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
] as const;

// ---------- schemas ----------

const RewardsInfoSchema = z.object({
  rewardToken: z.string().describe("Reward token address; zero address disables rewards."),
  creationReward: z.string().default("0").describe("Paid to the creator, RAW base units (wei)."),
  executionReward: z.string().default("0").describe("Paid to the executor, RAW base units (wei)."),
  voteRewardsCoefficient: z
    .string()
    .default("0")
    .describe("Per-vote reward factor, 25-decimal (1e25 = 1x)."),
});

export const ProposalSettingsSchema = z.object({
  earlyCompletion: z.boolean().describe("End the vote as soon as the result is decided."),
  delegatedVotingAllowed: z.boolean().describe("Allow delegated power to vote on this type."),
  validatorsVote: z.boolean().describe("Send a passed proposal to the validator chamber."),
  duration: z.string().describe("Main voting duration, seconds."),
  durationValidators: z.string().describe("Validator voting duration, seconds."),
  executionDelay: z.string().default("0").describe("Delay between success and execution, seconds."),
  quorum: z.string().describe("Main quorum, 25-decimal percent (1e25 = 1%)."),
  quorumValidators: z.string().describe("Validator quorum, 25-decimal percent (1e25 = 1%)."),
  minVotesForVoting: z.string().describe("Minimum power to vote, RAW base units (wei)."),
  minVotesForCreating: z.string().describe("Minimum power to create, RAW base units (wei)."),
  rewardsInfo: RewardsInfoSchema.describe("Creation / execution / voting reward settings."),
  executorDescription: z
    .string()
    .default("")
    .describe("Executor label; also the settings-JSON IPFS ref the UI reads."),
});

export type ProposalSettingsInput = z.infer<typeof ProposalSettingsSchema>;

export const GOV_SETTINGS_EDIT_ABI = GOV_SETTINGS_ABI;

export function toSettingsTuple(s: ProposalSettingsInput) {
  return [
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
  ];
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Action = { executor: string; value: string; data: string };

/**
 * The per-module result chokepoint, bound to the tool context so the build-time
 * harm pass runs on EVERY wrapper in this file rather than on whichever one a
 * reviewer happened to be looking at. It is a factory rather than a module-level
 * helper because the assessment needs `ctx.config` (default chain + treasury
 * posture) and a module-level copy would be shared across servers in-process.
 *
 * `governanceAdvisories` (the 0.33.0 channel) is preserved alongside the new
 * `warnings` array — merged, never replaced.
 */
function makeWrapperResult(ctx: ToolContext) {
  return function wrapperResult(params: {
    metadata: unknown;
    actions: Action[];
    title: string;
    detail: string;
    /** Governance-safety advisories — mirrored into structuredContent so clients that only render the structured payload still see them. */
    advisories?: string[];
    /** Exactly what the caller passed; `undefined` means "not supplied". */
    chainId?: number;
    govPool?: string;
  }) {
    const { metadata, actions, title, detail, advisories, chainId, govPool } = params;
    const warnings = assessActions({ ctx, chainId, actions, govPool }).filter(
      // `withdraw_treasury` already prints the treasury advisory into `detail`;
      // saying it twice is how a warning stops being read.
      (w) => !(w.code === "treasury.risk" && detail.includes(w.message)),
    );
    return withWarnings(
      {
        text:
          `${title}\n${detail}\n\nNext:\n` +
          `1) dexe_ipfs_upload_proposal_metadata with the metadata object → get CID\n` +
          `2) dexe_proposal_build_external with descriptionURL=<CID>, actionsOnFor=actions (${actions.length} action${actions.length === 1 ? "" : "s"})`,
        structured: {
          metadata,
          actions,
          ...(advisories?.length ? { governanceAdvisories: advisories } : {}),
        },
      },
      warnings,
      { legacy: legacyGovernanceAdvisories(advisories ?? []) },
    );
  };
}

function payloadOutputSchema() {
  return {
    metadata: z.unknown(),
    actions: z.array(
      z.object({
        executor: z.string(),
        value: z.string(),
        data: z.string(),
      }),
    ),
    governanceAdvisories: z.array(z.string()).optional(),
    warnings: warningsOutputField,
  };
}

// ---------- register ----------

export function registerProposalBuildMoreTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerChangeVotingSettings(server, _ctx);
  registerManageValidators(server, _ctx);
  registerAddExpert(server, _ctx);
  registerRemoveExpert(server, _ctx);
  registerWithdrawTreasury(server, _ctx);
  registerDelegateToExpert(server, _ctx);
  registerRevokeFromExpert(server, _ctx);
}

// ---------- 1. change_voting_settings ----------

function registerChangeVotingSettings(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_change_voting_settings",
    {
      title: "Wrapper: change voting settings (edit existing or add new)",
      description:
        "Builds proposal actions; does not broadcast. GovSettings.editSettings(ids, params) when `settingsIds` are supplied, else GovSettings.addSettings(params) — a new settings slot.",
      inputSchema: {
        govSettings: z.string().describe("GovSettings contract address (from dexe_dao_info.helpers.settings)"),
        settings: z
          .array(ProposalSettingsSchema)
          .min(1)
          .describe("Full settings struct per slot; editSettings replaces the whole struct."),
        settingsIds: z
          .array(z.string())
          .default([])
          .describe("Settings ids to edit (parallel to `settings`). Empty => addSettings"),
        // Without settingsIds this emits addSettings, which is chain-gated by
        // upstream #36. The chain-aware guard structurally could not run here
        // before, because the tool had nothing to key on.
        chainId: buildChainIdParam,
        proposalName: z.string().default("Change Voting Settings").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govSettings,
      settings,
      settingsIds = [],
      chainId,
      proposalName = "Change Voting Settings",
      proposalDescription = "",
    }) => {
      if (!isAddress(govSettings)) return errorResult(`Invalid govSettings: ${govSettings}`);
      if (settingsIds.length > 0 && settingsIds.length !== settings.length) {
        return errorResult("settingsIds length must match settings length when editing");
      }
      try {
        const iface = new Interface(GOV_SETTINGS_ABI as unknown as string[]);
        const tuples = settings.map(toSettingsTuple);
        let data: string;
        let method: string;
        if (settingsIds.length > 0) {
          method = "editSettings";
          data = iface.encodeFunctionData(method, [settingsIds.map((n) => BigInt(n)), tuples]);
        } else {
          method = "addSettings";
          data = iface.encodeFunctionData(method, [tuples]);
        }
        const action = { executor: govSettings, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "changeSettings",
          isMeta: false,
          changes: {
            proposedChanges: { mode: method, settingsIds, settings },
            currentChanges: {},
          },
        };
        const advisories = settings.flatMap((s, i) =>
          settingsAdvisories(s, ctx.config.minSafeQuorumPct).map((a) => `⚠ settings[${i}]: ${a}`),
        );
        if (settingsIds.length > 0 && settings.some((s) => !s.executorDescription)) {
          advisories.push(
            "⚠ editSettings replaces the whole struct: an empty executorDescription clears the settings-JSON IPFS ref " +
              "the frontend UI reads (comment/discussion thresholds). Read the current value first (dexe_read_settings) " +
              "and pass it through, or use dexe_proposal_create (proposalType change_voting_settings) which preserves it automatically.",
          );
        }
        return wrapperResult({
          metadata,
          actions: [action],
          chainId,
          title: `Change Voting Settings (${method}, ${settings.length} entries)`,
          detail:
            `Target: GovSettings(${govSettings}).${method}\nCalldata: ${data.slice(0, 66)}…` +
            (advisories.length > 0
              ? `\n\nGovernance-safety advisories:\n${advisories.join("\n")}`
              : ""),
          advisories,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 2. manage_validators ----------

function registerManageValidators(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_manage_validators",
    {
      title: "Wrapper: change validator balances (add/remove validators via balance tweak)",
      description:
        "Builds proposal actions; does not broadcast. GovValidators.changeBalances(balances, users) — balance 0 removes a validator, >0 adds or updates.",
      inputSchema: {
        govValidators: z
          .string()
          .describe("GovValidators contract address (from dexe_dao_info.helpers.validators)."),
        changes: z
          .array(
            z.object({
              user: z.string().describe("Validator address."),
              balance: z.string().describe("New validator balance, RAW base units (wei); 0 removes."),
            }),
          )
          .min(1)
          .describe("Validator balance changes to apply."),
        chainId: buildChainIdParam,
        proposalName: z.string().default("Manage Validators").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govValidators,
      changes,
      proposalName = "Manage Validators",
      proposalDescription = "",
    }) => {
      if (!isAddress(govValidators)) return errorResult(`Invalid govValidators: ${govValidators}`);
      for (const c of changes) {
        if (!isAddress(c.user)) return errorResult(`Invalid validator user: ${c.user}`);
      }
      try {
        const iface = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);
        const balances = changes.map((c) => BigInt(c.balance));
        const users = changes.map((c) => c.user);
        const data = iface.encodeFunctionData("changeBalances", [balances, users]);
        const action = { executor: govValidators, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "changeValidators",
          isMeta: false,
          changes: {
            proposedChanges: { validators: changes },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Manage Validators (${changes.length} changes)`,
          detail: `Target: GovValidators(${govValidators}).changeBalances\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 3. add_expert (local or global) ----------

function registerAddExpert(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_add_expert",
    {
      title: "Wrapper: mint a local or global Expert NFT to a nominated user",
      description:
        "Builds proposal actions; does not broadcast. ExpertNft.mint(nominatedUser, uri); scope 'local' = the DAO's ExpertNft, 'global' = DeXeExpertNft.",
      inputSchema: {
        expertNftContract: z
          .string()
          .describe(
            "ExpertNft contract address. Local: govPool.getNftContracts().expertNft; Global: dexeExpertNft",
          ),
        scope: z.enum(["local", "global"]).describe("'local' = this DAO's ExpertNft, 'global' = DeXeExpertNft."),
        nominatedUser: z.string().describe("Address receiving the expert NFT."),
        uri: z.string().default("").describe("Token URI stored on the minted NFT; may be empty."),
        chainId: buildChainIdParam,
        proposalName: z.string().default("Add Expert").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      expertNftContract,
      scope,
      nominatedUser,
      uri = "",
      proposalName = "Add Expert",
      proposalDescription = "",
    }) => {
      if (!isAddress(expertNftContract)) return errorResult(`Invalid expertNftContract: ${expertNftContract}`);
      if (!isAddress(nominatedUser)) return errorResult(`Invalid nominatedUser: ${nominatedUser}`);
      try {
        const iface = new Interface(EXPERT_NFT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("mint", [nominatedUser, uri]);
        const action = { executor: expertNftContract, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: scope === "global" ? "globalExpert" : "localExpert",
          isMeta: false,
          changes: {
            proposedChanges: { scope, nominatedUser, expertNftContract, uri },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Add ${scope} Expert → ${nominatedUser}`,
          detail: `Target: ExpertNft(${expertNftContract}).mint\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 4. remove_expert (local or global) ----------

function registerRemoveExpert(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_remove_expert",
    {
      title: "Wrapper: burn an Expert NFT (revoke expert role)",
      description:
        "Builds proposal actions; does not broadcast. ExpertNft.burn(nominatedUser); scope 'local' = the DAO's ExpertNft, 'global' = DeXeExpertNft.",
      inputSchema: {
        expertNftContract: z
          .string()
          .describe("ExpertNft contract address. Local: expertNft; Global: dexeExpertNft."),
        scope: z.enum(["local", "global"]).describe("'local' = this DAO's ExpertNft, 'global' = DeXeExpertNft."),
        nominatedUser: z.string().describe("Address whose expert NFT is burned."),
        chainId: buildChainIdParam,
        proposalName: z.string().default("Remove Expert").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      expertNftContract,
      scope,
      nominatedUser,
      proposalName = "Remove Expert",
      proposalDescription = "",
    }) => {
      if (!isAddress(expertNftContract)) return errorResult(`Invalid expertNftContract: ${expertNftContract}`);
      if (!isAddress(nominatedUser)) return errorResult(`Invalid nominatedUser: ${nominatedUser}`);
      try {
        const iface = new Interface(EXPERT_NFT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("burn", [nominatedUser]);
        const action = { executor: expertNftContract, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: scope === "global" ? "globalExpertRemoval" : "localExpertRemoval",
          isMeta: false,
          changes: {
            proposedChanges: { scope, nominatedUser, expertNftContract },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Remove ${scope} Expert → ${nominatedUser}`,
          detail: `Target: ExpertNft(${expertNftContract}).burn\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 5. withdraw_treasury ----------

const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount)"] as const;
const ERC721_TRANSFER_ABI = [
  "function transferFrom(address from, address to, uint256 tokenId)",
] as const;

function registerWithdrawTreasury(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_withdraw_treasury",
    {
      title: "Wrapper: withdraw ERC20/ERC721 from the DAO treasury",
      description:
        "Builds proposal actions; does not broadcast. One ERC20.transfer per token and/or one ERC721.transferFrom(govPool → receiver) per NFT. When an RPC is reachable for the target chain (the built-in public RPC counts) and `token` is ERC20Gov, the receiver is checked against isBlacklisted; build aborts if blacklisted.",
      inputSchema: {
        // The blacklist probe must hit the chain the proposal will run on: on any
        // other chain the token has no code, the probe degrades to `skipped`, and a
        // blacklisted recipient sails through a guard that never actually ran.
        chainId: buildChainIdParam.describe(
          "Chain the proposal targets (56 mainnet / 97 testnet; default: MCP default chain). Blacklist check reads it.",
        ),
        govPool: z.string().describe("DAO GovPool address — used as the `from` for NFT transferFrom"),
        receiver: z.string().describe("Address receiving the tokens and/or NFTs."),
        token: z.string().default("").describe("ERC20 token contract for the cash withdrawal (omit for NFT-only)"),
        amount: z.string().default("0").describe("ERC20 amount in wei (omit/0 for NFT-only)"),
        nftAddress: z.string().default("").describe("ERC721 contract address (omit for token-only)"),
        nftIds: z.array(z.string()).default([]).describe("NFT token ids to transfer; one transferFrom per id"),
        proposalName: z.string().default("Withdraw from Treasury").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      chainId,
      govPool,
      receiver,
      token = "",
      amount = "0",
      nftAddress = "",
      nftIds = [],
      proposalName = "Withdraw from Treasury",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(receiver)) return errorResult(`Invalid receiver: ${receiver}`);
      const wantToken = token.length > 0 && BigInt(amount) > 0n;
      const wantNfts = nftAddress.length > 0 && nftIds.length > 0;
      if (!wantToken && !wantNfts) {
        return errorResult(
          "Nothing to withdraw — supply `token` + non-zero `amount`, and/or `nftAddress` + `nftIds`.",
        );
      }
      if (wantToken && !isAddress(token)) return errorResult(`Invalid token: ${token}`);
      if (wantNfts && !isAddress(nftAddress)) return errorResult(`Invalid nftAddress: ${nftAddress}`);
      try {
        let blacklistNote = "";
        if (wantToken) {
          const bl = await checkBlacklist(ctx.config, token, receiver, chainId ?? ctx.config.defaultChainId);
          if (bl.status === "blacklisted") return errorResult(blacklistError(token, receiver));
          blacklistNote =
            bl.status === "skipped"
              ? ` Blacklist precheck skipped: ${bl.reason}.`
              : " Recipient not blacklisted.";
        }
        const actions: Action[] = [];
        if (wantToken) {
          const erc20 = new Interface(ERC20_TRANSFER_ABI as unknown as string[]);
          actions.push({
            executor: token,
            value: "0",
            data: erc20.encodeFunctionData("transfer", [receiver, BigInt(amount)]),
          });
        }
        if (wantNfts) {
          const erc721 = new Interface(ERC721_TRANSFER_ABI as unknown as string[]);
          for (const id of nftIds) {
            actions.push({
              executor: nftAddress,
              value: "0",
              data: erc721.encodeFunctionData("transferFrom", [govPool, receiver, BigInt(id)]),
            });
          }
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "withdrawDeposit",
          isMeta: false,
          changes: {
            proposedChanges: { receiver, token, amount, nftAddress, nftIds },
            currentChanges: {},
          },
        };
        const tokenSeg = wantToken ? `${amount} of ${token}` : "";
        const nftSeg = wantNfts ? `${nftIds.length} NFT(s) from ${nftAddress}` : "";
        const summary = [tokenSeg, nftSeg].filter(Boolean).join(" + ");
        const treasuryAdvisory = buildTimeTreasuryAdvisory(actions, ctx.config.treasuryGuard);
        return wrapperResult({
          metadata,
          actions,
          chainId,
          govPool,
          title: `Withdraw Treasury → ${receiver}: ${summary}`,
          detail:
            `${actions.length} external action${actions.length === 1 ? "" : "s"} (token.transfer / nft.transferFrom from GovPool).${blacklistNote}` +
            (treasuryAdvisory ? `\n\n${treasuryAdvisory}` : ""),
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 6. delegate_to_expert ----------

function registerDelegateToExpert(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_delegate_to_expert",
    {
      title: "Wrapper: delegate DAO treasury stake (tokens + NFTs) to an expert",
      description:
        "Builds proposal actions; does not broadcast. GovPool.delegateTreasury(delegatee, amount, nftIds) — the DAO TREASURY's power, not yours; the delegatee must already have expert status (GovPool.getExpertStatus).",
      inputSchema: {
        govPool: govPoolParam,
        expert: z.string().describe(DELEGATEE_DESC),
        amount: z.string().describe("Treasury tokens to delegate, RAW base units (wei)."),
        nftIds: z.array(z.string()).default([]).describe(NFT_IDS_TREASURY_DESC),
        value: z.string().default("0").describe("Native coin sent with the call, in wei."),
        chainId: buildChainIdParam,
        proposalName: z.string().default("Delegate to Expert").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      expert,
      amount,
      nftIds = [],
      value = "0",
      proposalName = "Delegate to Expert",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(expert)) return errorResult(`Invalid expert: ${expert}`);
      try {
        const iface = new Interface(GOV_POOL_TREASURY_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("delegateTreasury", [
          expert,
          BigInt(amount),
          nftIds.map((n) => BigInt(n)),
        ]);
        const action = { executor: govPool, value, data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "delegateTokensToExpert",
          isMeta: false,
          changes: {
            proposedChanges: { expert, amount, nftIds, value },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Delegate → ${expert} (${amount} wei, ${nftIds.length} NFTs)`,
          detail: `Target: GovPool(${govPool}).delegateTreasury\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}

// ---------- 7. revoke_from_expert ----------

function registerRevokeFromExpert(server: McpServer, ctx: ToolContext): void {
  const wrapperResult = makeWrapperResult(ctx);
  server.registerTool(
    "dexe_proposal_build_revoke_from_expert",
    {
      title: "Wrapper: revoke delegation from an expert (undelegateTreasury)",
      description:
        "Builds proposal actions; does not broadcast. GovPool.undelegateTreasury(delegatee, amount, nftIds) — pulls back power delegated from the DAO TREASURY, not yours.",
      inputSchema: {
        govPool: govPoolParam,
        expert: z.string().describe("Expert whose treasury delegation is revoked."),
        amount: z.string().describe("Treasury tokens to pull back, RAW base units (wei)."),
        nftIds: z.array(z.string()).default([]).describe(NFT_IDS_TREASURY_DESC),
        chainId: buildChainIdParam,
        proposalName: z.string().default("Revoke from Expert").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      expert,
      amount,
      nftIds = [],
      proposalName = "Revoke from Expert",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(expert)) return errorResult(`Invalid expert: ${expert}`);
      try {
        const iface = new Interface(GOV_POOL_TREASURY_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("undelegateTreasury", [
          expert,
          BigInt(amount),
          nftIds.map((n) => BigInt(n)),
        ]);
        const action = { executor: govPool, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "revokeTokensFromExpert",
          isMeta: false,
          changes: {
            proposedChanges: { expert, amount, nftIds },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Revoke ← ${expert} (${amount} wei, ${nftIds.length} NFTs)`,
          detail: `Target: GovPool(${govPool}).undelegateTreasury\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
    },
  );
}
