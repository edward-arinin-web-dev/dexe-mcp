import { z } from "zod";
import { Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";
import {
  PROPOSAL_CATALOG,
  EXTERNAL_METADATA_SHAPE,
  INTERNAL_METADATA_SHAPE,
  type ProposalTypeEntry,
} from "../lib/proposalCatalog.js";

const GOV_POOL_ABI = [
  "function createProposal(string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)",
  "function createProposalAndVote(string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
] as const;

const GOV_VALIDATORS_ABI = [
  "function createInternalProposal(uint8 proposalType, string descriptionURL, bytes data)",
] as const;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const ActionSchema = z.object({
  executor: z.string(),
  value: z.string().default("0"),
  data: z.string(),
});
type ActionInput = z.infer<typeof ActionSchema>;

function toAction(a: ActionInput): { executor: string; value: bigint; data: string } {
  if (!isAddress(a.executor)) throw new Error(`Invalid executor: ${a.executor}`);
  if (!a.data.startsWith("0x")) throw new Error(`data must be 0x-hex, got: ${a.data.slice(0, 16)}…`);
  return { executor: a.executor, value: BigInt(a.value || "0"), data: a.data };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerProposalBuildTools(server: McpServer, ctx: ToolContext): void {
  registerCatalog(server);
  registerBuildExternal(server, ctx);
  registerBuildInternal(server, ctx);
  registerBuildCustomAbi(server, ctx);
  registerBuildOffchain(server, ctx);
  registerBuildTokenTransfer(server, ctx);
}

// ---------- dexe_proposal_catalog ----------

function registerCatalog(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_catalog",
    {
      title: "List every proposal type DeXe supports",
      description:
        "Returns the full catalog of proposal types the DeXe frontend exposes (external on-chain, internal validator, off-chain backend). Each entry lists target contract/endpoint, IPFS metadata requirement, gating, and the MCP builder tool (or null if callers must compose via primitives). Use this before building a proposal to discover the right type and shape.",
      inputSchema: {
        category: z.enum(["external", "internal", "offchain", "all"]).default("all"),
        implementedOnly: z.boolean().default(false),
      },
      outputSchema: {
        total: z.number(),
        types: z.array(
          z.object({
            id: z.string(),
            category: z.string(),
            name: z.string(),
            formPath: z.string(),
            effect: z.string(),
            target: z.string(),
            needsIpfs: z.boolean(),
            gating: z.array(z.string()),
            mcpTool: z.string().nullable(),
            implemented: z.boolean(),
          }),
        ),
        externalMetadataShape: z.unknown(),
        internalMetadataShape: z.unknown(),
      },
    },
    async ({ category = "all", implementedOnly = false }) => {
      let types: ProposalTypeEntry[] = PROPOSAL_CATALOG;
      if (category !== "all") types = types.filter((t) => t.category === category);
      if (implementedOnly) types = types.filter((t) => t.implemented);
      const structured = {
        total: types.length,
        types,
        externalMetadataShape: EXTERNAL_METADATA_SHAPE,
        internalMetadataShape: INTERNAL_METADATA_SHAPE,
      };
      const implemented = types.filter((t) => t.implemented).length;
      const lines = types.map(
        (t) =>
          `  ${t.implemented ? "[x]" : "[ ]"} ${t.id.padEnd(36)} ${t.name}${
            t.mcpTool ? `  →  ${t.mcpTool}` : "  (compose via primitives)"
          }`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `DeXe proposal catalog (${types.length} types, ${implemented} shipped)\n\n${lines.join("\n")}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_proposal_build_external ----------

function registerBuildExternal(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_external",
    {
      title: "Primitive: build calldata for GovPool.createProposal",
      description:
        "Raw external proposal builder. You supply the descriptionURL (IPFS CID from dexe_ipfs_upload_proposal_metadata), actionsOnFor array, actionsOnAgainst array. Every named wrapper tool (token_transfer, change_voting_settings, etc.) composes through this primitive. Set `andVote=true` for createProposalAndVote.",
      inputSchema: {
        govPool: z.string(),
        descriptionURL: z
          .string()
          .describe("IPFS CID (or ipfs://<cid>) pointing at the proposal metadata JSON"),
        actionsOnFor: z.array(ActionSchema).default([]),
        actionsOnAgainst: z.array(ActionSchema).default([]),
        andVote: z.boolean().default(false),
        voteAmount: z.string().default("0"),
        voteNftIds: z.array(z.string()).default([]),
      },
      outputSchema: payloadSchema(),
    },
    async ({
      govPool,
      descriptionURL,
      actionsOnFor = [],
      actionsOnAgainst = [],
      andVote = false,
      voteAmount = "0",
      voteNftIds = [],
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
        const on = actionsOnFor.map(toAction);
        const against = actionsOnAgainst.map(toAction);
        let payload: TxPayload;
        if (andVote) {
          payload = buildPayload({
            to: govPool,
            iface,
            method: "createProposalAndVote",
            args: [
              descriptionURL,
              on,
              against,
              BigInt(voteAmount),
              voteNftIds.map((n) => BigInt(n)),
            ],
            chainId: ctx.config.chainId,
            contractLabel: "GovPool",
            description: `GovPool.createProposalAndVote (${on.length} for / ${against.length} against)`,
          });
        } else {
          payload = buildPayload({
            to: govPool,
            iface,
            method: "createProposal",
            args: [descriptionURL, on, against],
            chainId: ctx.config.chainId,
            contractLabel: "GovPool",
            description: `GovPool.createProposal (${on.length} for / ${against.length} against)`,
          });
        }
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_proposal_build_internal ----------

function registerBuildInternal(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_internal",
    {
      title: "Primitive: build calldata for GovValidators.createInternalProposal",
      description:
        "Raw internal proposal builder. proposalType: 0=ChangeBalances, 1=ChangeSettings, 2=MonthlyWithdraw, 3=OffchainProposal. `data` is the abi-encoded type-specific payload (see DeXe docs or use a dedicated wrapper in Phase 3e).",
      inputSchema: {
        validators: z.string().describe("GovValidators contract address"),
        proposalType: z.number().int().min(0).max(3),
        descriptionURL: z.string(),
        data: z.string().default("0x"),
      },
      outputSchema: payloadSchema(),
    },
    async ({ validators, proposalType, descriptionURL, data = "0x" }) => {
      if (!isAddress(validators)) return errorResult(`Invalid validators: ${validators}`);
      if (!data.startsWith("0x")) return errorResult("data must be 0x-prefixed hex");
      try {
        const iface = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);
        const label = ["ChangeBalances", "ChangeSettings", "MonthlyWithdraw", "OffchainProposal"][proposalType]!;
        const payload = buildPayload({
          to: validators,
          iface,
          method: "createInternalProposal",
          args: [proposalType, descriptionURL, data],
          chainId: ctx.config.chainId,
          contractLabel: "GovValidators",
          description: `GovValidators.createInternalProposal(${label})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_proposal_build_custom_abi ----------

function registerBuildCustomAbi(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_custom_abi",
    {
      title: "Encode a single ProposalAction from user-supplied ABI fragment",
      description:
        "Takes a full function signature (e.g. 'function transfer(address,uint256)'), method name, args, and target contract. Returns a ready-to-use `ProposalAction` object { executor, value, data } that you can drop into `actionsOnFor` of dexe_proposal_build_external. The returned object is JSON-safe (value as string).",
      inputSchema: {
        target: z.string().describe("Target contract the DAO will call"),
        signature: z.string().describe("Full function signature, e.g. 'function setX(uint256)'"),
        method: z.string().describe("Method name matching the signature"),
        args: z.array(z.unknown()).default([]),
        value: z.string().default("0").describe("ETH value to send with the call"),
      },
      outputSchema: {
        action: z.object({
          executor: z.string(),
          value: z.string(),
          data: z.string(),
        }),
        preview: z.string(),
      },
    },
    async ({ target, signature, method, args = [], value = "0" }) => {
      if (!isAddress(target)) return errorResult(`Invalid target: ${target}`);
      try {
        const iface = new Interface([signature]);
        const coerced = args.map((a) => {
          if (typeof a === "string" && /^-?\d+$/.test(a) && a.length > 9) {
            try {
              return BigInt(a);
            } catch {
              return a;
            }
          }
          return a;
        });
        const data = iface.encodeFunctionData(method, coerced);
        const action = { executor: target, value, data };
        const preview = `ProposalAction → ${target}.${method}(${args.length} args), value=${value}, calldata=${data.slice(0, 18)}…`;
        return {
          content: [{ type: "text" as const, text: preview }],
          structuredContent: { action, preview },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_proposal_build_offchain ----------

function registerBuildOffchain(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_offchain",
    {
      title: "Primitive: build HTTP request for DeXe off-chain proposal backend",
      description:
        "Returns the ready-to-send HTTP request (method, url, headers, body) for submitting an off-chain proposal to the DeXe backend. You send it yourself; no wallet required. Requires DEXE_BACKEND_API_URL (not yet wired — placeholder until schema audit in Phase 3d).",
      inputSchema: {
        endpoint: z
          .string()
          .describe("Backend endpoint path, e.g. '/proposals' or '/templates/voting'"),
        body: z.record(z.unknown()).describe("JSON body to POST"),
        method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
      },
      outputSchema: {
        request: z.object({
          method: z.string(),
          url: z.string(),
          headers: z.record(z.string()),
          body: z.unknown(),
        }),
      },
    },
    async ({ endpoint, body, method = "POST" }) => {
      const base = process.env.DEXE_BACKEND_API_URL?.trim();
      if (!base) {
        return errorResult(
          "DEXE_BACKEND_API_URL is not set. Add it to the MCP env block to build off-chain proposal requests.",
        );
      }
      const url = `${base.replace(/\/$/, "")}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
      const req = {
        method,
        url,
        headers: { "Content-Type": "application/json" },
        body,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `${method} ${url}\n${JSON.stringify(body, null, 2)}`,
          },
        ],
        structuredContent: { request: req },
      };
    },
  );
}

// ---------- dexe_proposal_build_token_transfer (Layer-3 named wrapper) ----------

function registerBuildTokenTransfer(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_token_transfer",
    {
      title: "Wrapper: build a 'Token Transfer' proposal (treasury → recipient)",
      description:
        "Builds a complete Token Transfer external proposal. Returns three things the agent composes: (1) the IPFS metadata JSON to upload (shape expected by the frontend indexer), (2) the ProposalAction encoded for the ERC20.transfer call, (3) a hint message explaining the next step (upload → get CID → call dexe_proposal_build_external with that CID and `actions`). Does NOT upload or send the tx itself — returns signable payload components.",
      inputSchema: {
        govPool: z.string(),
        token: z.string().describe("ERC20 token contract (the transfer executor). Ignored when isNative=true."),
        recipient: z.string(),
        amount: z.string().describe("Wei / smallest-unit amount as decimal string"),
        isNative: z.boolean().default(false).describe("True for native token (BNB/ETH) transfers — sends value instead of ERC20.transfer"),
        proposalName: z.string().default("Token Transfer"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: {
        metadata: z.unknown(),
        actions: z.array(
          z.object({
            executor: z.string(),
            value: z.string(),
            data: z.string(),
          }),
        ),
        nextStep: z.string(),
      },
    },
    async ({
      govPool,
      token,
      recipient,
      amount,
      isNative = false,
      proposalName = "Token Transfer",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isNative && !isAddress(token)) return errorResult(`Invalid token: ${token}`);
      if (!isAddress(recipient)) return errorResult(`Invalid recipient: ${recipient}`);
      try {
        let actions: { executor: string; value: string; data: string }[];
        let actionLabel: string;
        if (isNative) {
          actions = [{ executor: recipient, value: amount, data: "0x" }];
          actionLabel = `Native transfer → ${recipient} (${amount} wei)`;
        } else {
          const iface = new Interface(ERC20_ABI as unknown as string[]);
          const data = iface.encodeFunctionData("transfer", [recipient, BigInt(amount)]);
          actions = [{ executor: token, value: "0", data }];
          actionLabel = `ERC20(${token}).transfer(${recipient}, ${amount})`;
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(proposalDescription),
          category: "tokenTransfer",
          isMeta: false,
          changes: {
            proposedChanges: {
              data: [{ tokenAmount: amount, receiverAddress: recipient }],
              tokenAddress: isNative ? ZeroAddress : token,
            },
            currentChanges: {},
          },
        };
        const nextStep =
          `1) dexe_ipfs_upload_proposal_metadata with { title: "${proposalName}", description, extra: changes } → get CID\n` +
          `2) dexe_proposal_build_external with govPool="${govPool}", descriptionURL=<CID>, actionsOnFor=actions`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Built token-transfer proposal scaffolding.\n\nAction: ${actionLabel}\n\nNext:\n${nextStep}`,
            },
          ],
          structuredContent: { metadata, actions, nextStep },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- helpers ----------

function payloadSchema() {
  return {
    to: z.string(),
    data: z.string(),
    value: z.string(),
    chainId: z.number(),
    description: z.string(),
  };
}

function payloadResult(payload: TxPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${payload.description}\n  to   : ${payload.to}\n  value: ${payload.value}\n  data : ${payload.data.slice(0, 66)}…`,
      },
    ],
    structuredContent: { ...payload } as Record<string, unknown>,
  };
}
