import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

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

const GOV_VALIDATORS_ABI = [
  "function changeBalances(uint256[] balances, address[] users)",
] as const;

const EXPERT_NFT_ABI = [
  "function mint(address to, string uri)",
  "function burn(address from)",
] as const;

const GOV_POOL_TREASURY_ABI = [
  "function withdraw(address receiver, uint256 amount, uint256[] nftIds)",
  "function delegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
  "function undelegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
] as const;

// ---------- schemas ----------

const RewardsInfoSchema = z.object({
  rewardToken: z.string(),
  creationReward: z.string().default("0"),
  executionReward: z.string().default("0"),
  voteRewardsCoefficient: z.string().default("0"),
});

const ProposalSettingsSchema = z.object({
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

type ProposalSettingsInput = z.infer<typeof ProposalSettingsSchema>;

function toSettingsTuple(s: ProposalSettingsInput) {
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

function wrapperResult(params: {
  metadata: unknown;
  actions: Action[];
  title: string;
  detail: string;
}) {
  const { metadata, actions, title, detail } = params;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${title}\n${detail}\n\nNext:\n` +
          `1) dexe_ipfs_upload_proposal_metadata with the metadata object → get CID\n` +
          `2) dexe_proposal_build_external with descriptionURL=<CID>, actionsOnFor=actions (${actions.length} action${actions.length === 1 ? "" : "s"})`,
      },
    ],
    structuredContent: { metadata, actions },
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
  };
}

// ---------- register ----------

export function registerProposalBuildMoreTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerChangeVotingSettings(server);
  registerManageValidators(server);
  registerAddExpert(server);
  registerRemoveExpert(server);
  registerWithdrawTreasury(server);
  registerDelegateToExpert(server);
  registerRevokeFromExpert(server);
}

// ---------- 1. change_voting_settings ----------

function registerChangeVotingSettings(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_change_voting_settings",
    {
      title: "Wrapper: change voting settings (edit existing or add new)",
      description:
        "Builds a 'Change Voting Settings' external proposal. Targets GovSettings.editSettings(ids, params) when `settingsIds` are supplied (edit existing), or GovSettings.addSettings(params) when empty (create new settings slot). Resolve GovSettings address via dexe_dao_info first.",
      inputSchema: {
        govSettings: z.string().describe("GovSettings contract address (from dexe_dao_info.helpers.settings)"),
        settings: z.array(ProposalSettingsSchema).min(1),
        settingsIds: z
          .array(z.string())
          .default([])
          .describe("Settings ids to edit (parallel to `settings`). Empty => addSettings"),
        proposalName: z.string().default("Change Voting Settings"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govSettings,
      settings,
      settingsIds = [],
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
          proposalDescription,
          category: "Change Voting Settings",
          isMeta: false,
          changes: {
            proposedChanges: { mode: method, settingsIds, settings },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Change Voting Settings (${method}, ${settings.length} entries)`,
          detail: `Target: GovSettings(${govSettings}).${method}\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 2. manage_validators ----------

function registerManageValidators(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_manage_validators",
    {
      title: "Wrapper: change validator balances (add/remove validators via balance tweak)",
      description:
        "Builds a 'Manage Validators' external proposal calling GovValidators.changeBalances(balances, users). Set a user's balance to 0 to remove, >0 to add or update. Resolve GovValidators address via dexe_dao_info first.",
      inputSchema: {
        govValidators: z.string(),
        changes: z
          .array(
            z.object({
              user: z.string(),
              balance: z.string().describe("Wei; 0 to remove"),
            }),
          )
          .min(1),
        proposalName: z.string().default("Manage Validators"),
        proposalDescription: z.string().default(""),
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
          proposalDescription,
          category: "Manage Validators",
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 3. add_expert (local or global) ----------

function registerAddExpert(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_add_expert",
    {
      title: "Wrapper: mint a local or global Expert NFT to a nominated user",
      description:
        "Builds an 'Add Expert' external proposal. `scope='local'` mints on the DAO's ExpertNft (dao_info.nftContracts.expertNft). `scope='global'` mints on DeXeExpertNft (dao_info.nftContracts.dexeExpertNft). URI is passed through (default empty).",
      inputSchema: {
        expertNftContract: z
          .string()
          .describe(
            "ExpertNft contract address. Local: govPool.getNftContracts().expertNft; Global: dexeExpertNft",
          ),
        scope: z.enum(["local", "global"]),
        nominatedUser: z.string(),
        uri: z.string().default(""),
        proposalName: z.string().default("Add Expert"),
        proposalDescription: z.string().default(""),
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
          proposalDescription,
          category: scope === "global" ? "Add Global Expert" : "Add Local Expert",
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 4. remove_expert (local or global) ----------

function registerRemoveExpert(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_remove_expert",
    {
      title: "Wrapper: burn an Expert NFT (revoke expert role)",
      description:
        "Builds a 'Remove Expert' external proposal calling ExpertNft.burn(from). `scope='local'` targets the DAO's ExpertNft; 'global' targets DeXeExpertNft.",
      inputSchema: {
        expertNftContract: z.string(),
        scope: z.enum(["local", "global"]),
        nominatedUser: z.string(),
        proposalName: z.string().default("Remove Expert"),
        proposalDescription: z.string().default(""),
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
          proposalDescription,
          category: scope === "global" ? "Remove Global Expert" : "Remove Local Expert",
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 5. withdraw_treasury ----------

function registerWithdrawTreasury(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_withdraw_treasury",
    {
      title: "Wrapper: withdraw native/tokens/NFTs from the DAO treasury",
      description:
        "Builds a 'Withdraw from Treasury' external proposal calling GovPool.withdraw(receiver, amount, nftIds). The executor IS the GovPool itself — treasury is held there.",
      inputSchema: {
        govPool: z.string(),
        receiver: z.string(),
        amount: z.string().describe("Token amount in wei (0 for NFT-only)"),
        nftIds: z.array(z.string()).default([]),
        proposalName: z.string().default("Withdraw from Treasury"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      receiver,
      amount,
      nftIds = [],
      proposalName = "Withdraw from Treasury",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(receiver)) return errorResult(`Invalid receiver: ${receiver}`);
      try {
        const iface = new Interface(GOV_POOL_TREASURY_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("withdraw", [
          receiver,
          BigInt(amount),
          nftIds.map((n) => BigInt(n)),
        ]);
        const action = { executor: govPool, value: "0", data };
        const metadata = {
          proposalName,
          proposalDescription,
          category: "Withdraw from Treasury",
          isMeta: false,
          changes: {
            proposedChanges: { receiver, amount, nftIds },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions: [action],
          title: `Withdraw Treasury → ${receiver} (${amount} wei, ${nftIds.length} NFTs)`,
          detail: `Target: GovPool(${govPool}).withdraw\nCalldata: ${data.slice(0, 66)}…`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 6. delegate_to_expert ----------

function registerDelegateToExpert(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_delegate_to_expert",
    {
      title: "Wrapper: delegate DAO treasury stake (tokens + NFTs) to an expert",
      description:
        "Builds a 'Delegate to Expert' external proposal calling GovPool.delegateTreasury(delegatee, amount, nftIds).",
      inputSchema: {
        govPool: z.string(),
        expert: z.string(),
        amount: z.string().describe("Token amount in wei"),
        nftIds: z.array(z.string()).default([]),
        value: z.string().default("0").describe("Native coin value for payable path"),
        proposalName: z.string().default("Delegate to Expert"),
        proposalDescription: z.string().default(""),
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
          proposalDescription,
          category: "Delegate Tokens to Expert",
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 7. revoke_from_expert ----------

function registerRevokeFromExpert(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_revoke_from_expert",
    {
      title: "Wrapper: revoke delegation from an expert (undelegateTreasury)",
      description:
        "Builds a 'Revoke from Expert' external proposal calling GovPool.undelegateTreasury(delegatee, amount, nftIds).",
      inputSchema: {
        govPool: z.string(),
        expert: z.string(),
        amount: z.string(),
        nftIds: z.array(z.string()).default([]),
        proposalName: z.string().default("Revoke from Expert"),
        proposalDescription: z.string().default(""),
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
          proposalDescription,
          category: "Revoke Tokens from Expert",
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
