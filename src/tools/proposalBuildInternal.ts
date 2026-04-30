import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

/**
 * Phase 3e — internal proposal wrappers.
 *
 * Internal proposals go through `GovValidators.createInternalProposal(
 *   proposalType, descriptionURL, data
 * )` — they are NOT external proposals. The `data` bytes are selector +
 * abi-encoded args for the specific internal-executor method:
 *
 *   type 0 ChangeBalances  → selector(changeBalances) + (uint256[] balances, address[] users)
 *   type 1 ChangeSettings  → selector(changeSettings) + (uint64 duration, uint64 executionDelay, uint128 quorum)
 *   type 2 MonthlyWithdraw → selector(monthlyWithdraw) + (address[] tokens, uint256[] amounts, address destination)
 *   type 3 OffchainProposal → empty bytes ("0x")
 *
 * Source: `D:/dev/DeXe-Protocol/contracts/libs/gov/gov-validators/GovValidatorsCreate.sol`
 * (`_validateInternalProposal` branches).
 *
 * Wrappers return `{ metadata, proposalType, data, nextStep }` — the agent
 * (1) uploads metadata via dexe_ipfs_upload_proposal_metadata → CID,
 * (2) calls dexe_proposal_build_internal with validators + type + CID + data.
 */

const VALIDATORS_EXEC_ABI = [
  "function changeBalances(uint256[] balances, address[] users)",
  "function changeSettings(uint64 duration, uint64 executionDelay, uint128 quorum)",
  "function monthlyWithdraw(address[] tokens, uint256[] amounts, address destination)",
] as const;

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function internalResult(params: {
  metadata: unknown;
  proposalType: 0 | 1 | 2 | 3;
  data: string;
  title: string;
}) {
  const typeLabel = ["ChangeBalances", "ChangeSettings", "MonthlyWithdraw", "OffchainProposal"][
    params.proposalType
  ]!;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${params.title}\nproposalType=${params.proposalType} (${typeLabel})\n` +
          `data=${params.data === "0x" ? "0x (empty — required for OffchainProposal)" : params.data.slice(0, 66) + "…"}\n\nNext:\n` +
          `1) dexe_ipfs_upload_proposal_metadata → get CID\n` +
          `2) dexe_proposal_build_internal with validators=<address>, proposalType=${params.proposalType}, descriptionURL=<CID>, data=<this data>`,
      },
    ],
    structuredContent: {
      metadata: params.metadata,
      proposalType: params.proposalType,
      data: params.data,
    },
  };
}

function outputSchema() {
  return {
    metadata: z.unknown(),
    proposalType: z.number(),
    data: z.string(),
  };
}

export function registerProposalBuildInternalTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerChangeValidatorBalances(server);
  registerChangeValidatorSettings(server);
  registerMonthlyWithdraw(server);
  registerOffchainInternalProposal(server);
}

// ---------- type 0 — change validator balances ----------

function registerChangeValidatorBalances(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_change_validator_balances",
    {
      title: "Internal type 0: change validator balances",
      description:
        "Builds the `data` bytes for GovValidators.createInternalProposal(type=0). Encodes changeBalances(balances, users). Set balance=0 to remove a validator.",
      inputSchema: {
        changes: z
          .array(z.object({ user: z.string(), balance: z.string() }))
          .min(1),
        proposalName: z.string().default("Change Validator Balances"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: outputSchema(),
    },
    async ({
      changes,
      proposalName = "Change Validator Balances",
      proposalDescription = "",
    }) => {
      for (const c of changes) {
        if (!isAddress(c.user)) return errorResult(`Invalid validator address: ${c.user}`);
      }
      try {
        const iface = new Interface(VALIDATORS_EXEC_ABI as unknown as string[]);
        const balances = changes.map((c) => BigInt(c.balance));
        const users = changes.map((c) => c.user);
        const data = iface.encodeFunctionData("changeBalances", [balances, users]);
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(proposalDescription),
          category: "changeValidatorBalances",
          changes: {
            proposedChanges: { validators: changes },
            currentChanges: {},
          },
        };
        return internalResult({
          metadata,
          proposalType: 0,
          data,
          title: `Change Validator Balances (${changes.length} changes)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- type 1 — change validator settings ----------

function registerChangeValidatorSettings(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_change_validator_settings",
    {
      title: "Internal type 1: change validator voting settings (duration, delay, quorum)",
      description:
        "Builds the `data` bytes for GovValidators.createInternalProposal(type=1). Encodes changeSettings(duration, executionDelay, quorum). All three values are seconds/percent-as-BN.",
      inputSchema: {
        duration: z.string().describe("Voting duration in seconds (uint64)"),
        executionDelay: z.string().describe("Delay after success before execution, seconds (uint64)"),
        quorum: z.string().describe("Quorum (uint128, DeXe uses 10^27 scale for percentages)"),
        proposalName: z.string().default("Change Validator Settings"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: outputSchema(),
    },
    async ({
      duration,
      executionDelay,
      quorum,
      proposalName = "Change Validator Settings",
      proposalDescription = "",
    }) => {
      try {
        const iface = new Interface(VALIDATORS_EXEC_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("changeSettings", [
          BigInt(duration),
          BigInt(executionDelay),
          BigInt(quorum),
        ]);
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(proposalDescription),
          category: "changeValidatorSettings",
          changes: {
            proposedChanges: { duration, executionDelay, quorum },
            currentChanges: {},
          },
        };
        return internalResult({
          metadata,
          proposalType: 1,
          data,
          title: `Change Validator Settings (duration=${duration}s, delay=${executionDelay}s, quorum=${quorum})`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- type 2 — monthly withdraw ----------

function registerMonthlyWithdraw(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_monthly_withdraw",
    {
      title: "Internal type 2: monthly validator withdrawal",
      description:
        "Builds the `data` bytes for GovValidators.createInternalProposal(type=2). Encodes monthlyWithdraw(tokens, amounts, destination). `tokens` and `amounts` must be parallel arrays; tokens must not be zero address.",
      inputSchema: {
        withdrawals: z
          .array(z.object({ token: z.string(), amount: z.string() }))
          .min(1),
        destination: z.string(),
        proposalName: z.string().default("Monthly Withdraw"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: outputSchema(),
    },
    async ({
      withdrawals,
      destination,
      proposalName = "Monthly Withdraw",
      proposalDescription = "",
    }) => {
      if (!isAddress(destination)) return errorResult(`Invalid destination: ${destination}`);
      for (const w of withdrawals) {
        if (!isAddress(w.token)) return errorResult(`Invalid token: ${w.token}`);
      }
      try {
        const iface = new Interface(VALIDATORS_EXEC_ABI as unknown as string[]);
        const tokens = withdrawals.map((w) => w.token);
        const amounts = withdrawals.map((w) => BigInt(w.amount));
        const data = iface.encodeFunctionData("monthlyWithdraw", [tokens, amounts, destination]);
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(proposalDescription),
          category: "monthlyWithdraw",
          changes: {
            proposedChanges: { withdrawals, destination },
            currentChanges: {},
          },
        };
        return internalResult({
          metadata,
          proposalType: 2,
          data,
          title: `Monthly Withdraw (${withdrawals.length} tokens → ${destination})`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- type 3 — off-chain internal proposal ----------

function registerOffchainInternalProposal(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_offchain_internal_proposal",
    {
      title: "Internal type 3: off-chain proposal (validators attest off-chain result)",
      description:
        "Builds the `data` bytes for GovValidators.createInternalProposal(type=3). Per contract rule data MUST be empty (0x). Only the descriptionURL (IPFS metadata) carries the proposal payload.",
      inputSchema: {
        proposalName: z.string().default("Off-chain Validator Proposal"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: outputSchema(),
    },
    async ({
      proposalName = "Off-chain Validator Proposal",
      proposalDescription = "",
    }) => {
      const metadata = {
        proposalName,
        proposalDescription: JSON.stringify(proposalDescription),
        category: "offchainInternalProposal",
        changes: {
          proposedChanges: {},
          currentChanges: {},
        },
      };
      return internalResult({
        metadata,
        proposalType: 3,
        data: "0x",
        title: `Off-chain Internal Proposal: ${proposalName}`,
      });
    },
  );
}
