import { z } from "zod";
import { Contract, isAddress, type InterfaceAbi } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { CalldataDecoder, type DecodedProposalAction } from "../lib/decoders.js";
import { GovAddressResolver } from "../lib/govAddresses.js";
import { RpcProvider } from "../rpc.js";
import { ArtifactsMissingError } from "../artifacts.js";

export function registerGovTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  const decoder = new CalldataDecoder(ctx.artifacts, ctx.selectors);
  const addresses = new GovAddressResolver(ctx.artifacts);

  registerDecodeCalldata(server, ctx, decoder);
  registerDecodeProposal(server, ctx, decoder, addresses, rpc);
  registerReadGovState(server, ctx, addresses, rpc);
  registerListGovContractTypes(server);
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ---------- dexe_decode_calldata ----------

function registerDecodeCalldata(
  server: McpServer,
  ctx: ToolContext,
  decoder: CalldataDecoder,
): void {
  server.registerTool(
    "dexe_decode_calldata",
    {
      title: "Decode ABI-encoded calldata",
      description:
        "Decodes a raw '0x…' calldata blob against loaded contract ABIs. If `contract` is given, only that ABI is tried; otherwise every artifact whose selector matches is tried. Useful for understanding captured transactions or proposal action payloads.",
      inputSchema: {
        data: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string")
          .describe("Raw calldata including 4-byte selector"),
        contract: z.string().optional().describe("Optional: restrict to one contract's ABI"),
      },
      outputSchema: {
        matched: z.boolean(),
        primary: z
          .object({
            contract: z.string().nullable(),
            sourceName: z.string().nullable(),
            signature: z.string(),
            selector: z.string(),
            args: z.record(z.unknown()),
            argsArray: z.array(z.unknown()),
          })
          .nullable(),
        alternativeCount: z.number(),
        alternatives: z.array(
          z.object({
            contract: z.string().nullable(),
            signature: z.string(),
          }),
        ),
      },
    },
    async ({ data, contract }) => {
      try {
        ctx.artifacts.requireArtifactsExist();
      } catch (err) {
        if (err instanceof ArtifactsMissingError) return errorResult(err.message);
        throw err;
      }

      const result = decoder.decodeCalldata(data, contract);
      const structured = {
        matched: result.primary !== null,
        primary: result.primary,
        alternativeCount: result.alternatives.length,
        alternatives: result.alternatives.map((a) => ({ contract: a.contract, signature: a.signature })),
      };

      const text = result.primary
        ? `${result.primary.contract ?? "?"}.${result.primary.signature}\n\nArgs:\n${JSON.stringify(result.primary.args, null, 2).slice(0, 3000)}${
            result.alternatives.length > 0
              ? `\n\n${result.alternatives.length} alternative match(es): ${result.alternatives.map((a) => `${a.contract}.${a.signature}`).join(", ")}`
              : ""
          }`
        : `No matching ABI found for selector ${data.slice(0, 10)}. Try dexe_find_selector.`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured,
        isError: !result.primary,
      };
    },
  );
}

// ---------- dexe_decode_proposal ----------

function registerDecodeProposal(
  server: McpServer,
  ctx: ToolContext,
  decoder: CalldataDecoder,
  _addresses: GovAddressResolver,
  rpc: RpcProvider,
): void {
  server.registerTool(
    "dexe_decode_proposal",
    {
      title: "Read and decode a GovPool proposal",
      description:
        "Fetches a proposal from an on-chain GovPool via `getProposals(offset, limit)` and decodes every action in BOTH `actionsOnFor` and `actionsOnAgainst` against loaded ABIs. Requires DEXE_RPC_URL.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        proposalId: z.number().int().positive().describe("Proposal ID (1-indexed)"),
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.number(),
        proposalState: z.number(),
        descriptionURL: z.string(),
        requiredQuorum: z.string(),
        requiredValidatorsQuorum: z.string(),
        core: z.object({
          voteEnd: z.string(),
          executeAfter: z.string(),
          executed: z.boolean(),
          votesFor: z.string(),
          votesAgainst: z.string(),
          rawVotesFor: z.string(),
          rawVotesAgainst: z.string(),
          givenRewards: z.string(),
        }),
        forActions: z.array(z.unknown()),
        againstActions: z.array(z.unknown()),
      },
    },
    async ({ govPool, proposalId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      try {
        ctx.artifacts.requireArtifactsExist();
      } catch (err) {
        if (err instanceof ArtifactsMissingError) return errorResult(err.message);
        throw err;
      }

      let provider;
      try {
        provider = rpc.requireProvider();
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      const abi = ctx.artifacts.get("GovPool")[0]?.abi;
      if (!abi) return errorResult("GovPool artifact not loaded. Run dexe_compile first.");

      const pool = new Contract(govPool, abi as unknown as InterfaceAbi, provider);
      let views: unknown[];
      try {
        views = await pool.getFunction("getProposals")(proposalId - 1, 1);
      } catch (err) {
        return errorResult(`RPC call to getProposals failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!views || views.length === 0) {
        return errorResult(`Proposal ${proposalId} not found at ${govPool}.`);
      }

      // ProposalView = [proposal, validatorProposal, proposalState, requiredQuorum, requiredValidatorsQuorum]
      // proposal = [core, descriptionURL, actionsOnFor, actionsOnAgainst]
      // core = [settings, voteEnd, executeAfter, executed, votesFor, votesAgainst, rawVotesFor, rawVotesAgainst, givenRewards]
      const view = views[0] as unknown[];
      const proposal = view[0] as unknown[];
      const core = proposal[0] as unknown[];
      const descriptionURL = proposal[1] as string;
      const rawForActions = proposal[2] as Array<[string, bigint, string]>;
      const rawAgainstActions = proposal[3] as Array<[string, bigint, string]>;
      const proposalState = Number(view[2]);
      const requiredQuorum = (view[3] as bigint).toString();
      const requiredValidatorsQuorum = (view[4] as bigint).toString();

      const forActions: DecodedProposalAction[] = rawForActions.map((a) =>
        decoder.decodeProposalAction({ executor: a[0], value: a[1], data: a[2], side: "for" }),
      );
      const againstActions: DecodedProposalAction[] = rawAgainstActions.map((a) =>
        decoder.decodeProposalAction({ executor: a[0], value: a[1], data: a[2], side: "against" }),
      );

      const structured = {
        govPool,
        proposalId,
        proposalState,
        descriptionURL,
        requiredQuorum,
        requiredValidatorsQuorum,
        core: {
          voteEnd: (core[1] as bigint).toString(),
          executeAfter: (core[2] as bigint).toString(),
          executed: Boolean(core[3]),
          votesFor: (core[4] as bigint).toString(),
          votesAgainst: (core[5] as bigint).toString(),
          rawVotesFor: (core[6] as bigint).toString(),
          rawVotesAgainst: (core[7] as bigint).toString(),
          givenRewards: (core[8] as bigint).toString(),
        },
        forActions,
        againstActions,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Proposal ${proposalId} @ ${govPool}\nState: ${PROPOSAL_STATE_NAMES[proposalState] ?? proposalState}\nDescription: ${descriptionURL}\nActions on For: ${forActions.length}\nActions on Against: ${againstActions.length}\n${formatActions(forActions)}${formatActions(againstActions)}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

const PROPOSAL_STATE_NAMES = [
  "Voting",
  "WaitingForVotingTransfer",
  "ValidatorVoting",
  "Defeated",
  "SucceededFor",
  "SucceededAgainst",
  "Locked",
  "ExecutedFor",
  "ExecutedAgainst",
  "Undefined",
];

function formatActions(actions: DecodedProposalAction[]): string {
  if (actions.length === 0) return "";
  return (
    `\n\n--- ${actions[0]!.side.toUpperCase()} actions ---\n` +
    actions
      .map((a, i) => {
        const decoded = a.decoded
          ? `${a.decoded.contract ?? "?"}.${a.decoded.signature}`
          : "(no matching ABI)";
        return `  ${i}: executor=${a.executor} value=${a.value}\n     ${decoded}`;
      })
      .join("\n")
  );
}

// ---------- dexe_read_gov_state ----------

function registerReadGovState(
  server: McpServer,
  _ctx: ToolContext,
  addresses: GovAddressResolver,
  rpc: RpcProvider,
): void {
  server.registerTool(
    "dexe_read_gov_state",
    {
      title: "Read aggregate GovPool state",
      description:
        "For a given GovPool address, reads `getHelperContracts()` and `getNftContracts()` on-chain and returns the resolved helper + nft addresses. Requires DEXE_RPC_URL.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
      },
      outputSchema: {
        govPool: z.string(),
        helpers: z.object({
          settings: z.string(),
          userKeeper: z.string(),
          validators: z.string(),
          poolRegistry: z.string(),
          votePower: z.string(),
        }),
        nftContracts: z.object({
          nftMultiplier: z.string(),
          expertNft: z.string(),
          dexeExpertNft: z.string(),
          babt: z.string(),
        }),
      },
    },
    async ({ govPool }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      let provider;
      try {
        provider = rpc.requireProvider();
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      try {
        const helpers = await addresses.resolveHelpers(govPool, provider);
        const nftContracts = await addresses.resolveNftContracts(govPool, provider);
        const structured = { govPool, helpers, nftContracts };
        return {
          content: [
            {
              type: "text" as const,
              text: `GovPool ${govPool}\n\nHelpers:\n  settings     : ${helpers.settings}\n  userKeeper   : ${helpers.userKeeper}\n  validators   : ${helpers.validators}\n  poolRegistry : ${helpers.poolRegistry}\n  votePower    : ${helpers.votePower}\n\nNFT contracts:\n  nftMultiplier : ${nftContracts.nftMultiplier}\n  expertNft     : ${nftContracts.expertNft}\n  dexeExpertNft : ${nftContracts.dexeExpertNft}\n  babt          : ${nftContracts.babt}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`Failed to read gov state: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ---------- dexe_list_gov_contract_types ----------

function registerListGovContractTypes(server: McpServer): void {
  server.registerTool(
    "dexe_list_gov_contract_types",
    {
      title: "Orientation: gov subsystem contract catalog",
      description:
        "Static catalog describing the DeXe governance subsystem contracts: what each one does and where its source lives. Cheap orientation tool for agents new to the codebase.",
      inputSchema: {},
      outputSchema: {
        contracts: z.array(
          z.object({
            name: z.string(),
            role: z.string(),
            sourcePath: z.string(),
          }),
        ),
      },
    },
    async () => {
      const catalog = [
        { name: "GovPool", role: "Per-DAO main contract: proposals, voting, execution", sourcePath: "contracts/gov/GovPool.sol" },
        { name: "GovSettings", role: "Proposal settings (quorum, voting period, etc.)", sourcePath: "contracts/gov/settings/GovSettings.sol" },
        { name: "GovUserKeeper", role: "User deposits, delegations, and voting power bookkeeping", sourcePath: "contracts/gov/user-keeper/GovUserKeeper.sol" },
        { name: "GovValidators", role: "Validator set + second-step validator voting", sourcePath: "contracts/gov/validators/GovValidators.sol" },
        { name: "DistributionProposal", role: "Proposal executor for reward distribution", sourcePath: "contracts/gov/proposals/DistributionProposal.sol" },
        { name: "StakingProposal", role: "Proposal executor for staking-related actions", sourcePath: "contracts/gov/proposals/StakingProposal.sol" },
        { name: "TokenSaleProposal", role: "Proposal executor for token sale tiers", sourcePath: "contracts/gov/proposals/TokenSaleProposal.sol" },
        { name: "LinearPower", role: "Voting-power formula: linear", sourcePath: "contracts/gov/voting/LinearPower.sol" },
        { name: "PolynomialPower", role: "Voting-power formula: polynomial", sourcePath: "contracts/gov/voting/PolynomialPower.sol" },
        { name: "ContractsRegistry", role: "Service locator for global protocol contracts (not per-pool)", sourcePath: "contracts/core/ContractsRegistry.sol" },
        { name: "PoolRegistry", role: "Tracks all deployed GovPool instances", sourcePath: "contracts/core/PoolRegistry.sol" },
      ];
      return {
        content: [
          {
            type: "text" as const,
            text: catalog.map((c) => `  ${c.name.padEnd(22)} — ${c.role}\n    ${c.sourcePath}`).join("\n"),
          },
        ],
        structuredContent: { contracts: catalog },
      };
    },
  );
}
