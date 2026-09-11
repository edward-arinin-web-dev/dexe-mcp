import { z } from "zod";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";
import { checkBlacklist, blacklistError } from "../lib/blacklist.js";
import { findForbiddenSelector, dangerousSelectorError } from "../lib/dangerousSelectors.js";
import { CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY } from "../lib/protocolAdvisories.js";
import { buildTimeTreasuryAdvisory } from "../lib/quorumRisk.js";
import { assessActions, withWarnings, type BuildWarning } from "./buildResult.js";
import { warningsOutputField } from "../lib/buildWarning.js";
import { buildChainIdParam, govPoolParam } from "../lib/params.js";
import { DEFAULTS } from "../config.js";
import {
  PROPOSAL_CATALOG,
  EXTERNAL_METADATA_SHAPE,
  INTERNAL_METADATA_SHAPE,
  INTERNAL_PROPOSAL_TYPE_LABELS,
  type ProposalTypeEntry,
} from "../lib/proposalCatalog.js";
import { safeErrorMessage } from "../lib/redact.js";

const GOV_POOL_ABI = [
  "function createProposal(string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)",
  "function createProposalAndVote(string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
] as const;

export const GOV_VALIDATORS_CREATE_ABI = [
  "function createInternalProposal(uint8 proposalType, string descriptionURL, bytes data)",
] as const;
const GOV_VALIDATORS_ABI = GOV_VALIDATORS_CREATE_ABI;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

/**
 * "0=ChangeSettings, 1=ChangeBalances, …" rendered from the canonical enum so
 * the prose in the tool description can never disagree with the value the
 * builder actually encodes.
 */
const INTERNAL_TYPE_DOC = INTERNAL_PROPOSAL_TYPE_LABELS.map((l, i) => `${i}=${l}`).join(", ");

const ActionSchema = z.object({
  executor: z.string().describe("Contract the DAO calls when this action executes."),
  value: z.string().default("0").describe("Native coin sent with the call, in wei."),
  data: z.string().describe("0x-hex calldata for the call."),
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
        "Read-only, local. Every proposal type DeXe supports (external, internal validator, off-chain) with target, IPFS-metadata need, gating and builder tool.",
      inputSchema: {
        category: z
          .enum(["external", "internal", "offchain", "all"])
          .default("all")
          .describe("Restrict to one category; 'all' returns the whole catalog."),
        implementedOnly: z.boolean().default(false).describe("True to list only types that have an MCP builder."),
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
        "Builds calldata; does not broadcast. GovPool.createProposal(descriptionURL, actionsOnFor, actionsOnAgainst), or createProposalAndVote when andVote=true.",
      inputSchema: {
        govPool: govPoolParam,
        descriptionURL: z
          .string()
          .describe("IPFS CID (or ipfs://<cid>) pointing at the proposal metadata JSON"),
        actionsOnFor: z.array(ActionSchema).default([]).describe("Actions executed if the proposal passes."),
        actionsOnAgainst: z.array(ActionSchema).default([]).describe("Actions executed if the 'against' side wins."),
        andVote: z.boolean().default(false).describe("True to create and vote in one tx (createProposalAndVote)."),
        voteAmount: z.string().default("0").describe("Tokens to vote with, RAW base units (wei); andVote only."),
        voteNftIds: z.array(z.string()).default([]).describe("Your governance NFT token ids to vote with; andVote only."),
        chainId: buildChainIdParam,
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
      chainId,
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
        const on = actionsOnFor.map(toAction);
        const against = actionsOnAgainst.map(toAction);
        for (const a of [...on, ...against]) {
          const forbidden = findForbiddenSelector(a.data);
          if (forbidden) return errorResult(dangerousSelectorError(forbidden, a.executor));
        }
        // The full build-time harm pass on the assembled actions. This is the
        // LAST point at which the selectors are visible: once wrapped into
        // `createProposal` calldata the nested actions are opaque to every
        // selector-keyed check, which is why it runs here and not after
        // `buildPayload`. Every named wrapper tool routes its actions through
        // this primitive, so a guard added here reaches all of them.
        const assessed = assessActions({
          ctx,
          chainId,
          govPool,
          actions: [...on, ...against].map((a) => ({
            executor: a.executor,
            value: a.value.toString(),
            data: a.data,
          })),
        });
        // Layer 4 (treasury-safety advisory): flag any value-moving /
        // allowance-granting action so a reviewer checks quorum before voting.
        const treasuryAdvisory = buildTimeTreasuryAdvisory(
          [...on, ...against].map((a) => ({ executor: a.executor, value: a.value.toString(), data: a.data })),
          ctx.config.treasuryGuard,
        );
        // `treasury.risk` is already the text above — do not print it twice.
        const warnings = assessed.filter((w) => !(treasuryAdvisory && w.code === "treasury.risk"));
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
            chainId: chainId ?? ctx.config.defaultChainId,
            contractLabel: "GovPool",
            description: `GovPool.createProposalAndVote (${on.length} for / ${against.length} against)`,
          });
        } else {
          payload = buildPayload({
            to: govPool,
            iface,
            method: "createProposal",
            args: [descriptionURL, on, against],
            chainId: chainId ?? ctx.config.defaultChainId,
            contractLabel: "GovPool",
            description: `GovPool.createProposal (${on.length} for / ${against.length} against)`,
          });
        }
        return payloadResult(payload, treasuryAdvisory, warnings);
      } catch (err) {
        return errorResult(safeErrorMessage(err));
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
        "Builds calldata; does not broadcast. `GovValidators.createInternalProposal(proposalType, descriptionURL, data)` " +
        `— proposalType is ${INTERNAL_TYPE_DOC}. The four internal wrappers encode \`data\` and pick the type for you.`,
      inputSchema: {
        validators: z.string().describe("GovValidators contract address"),
        // Literal union, not min/max — the enum value is unguessable from a bare
        // numeric range, and guessing it silently creates the WRONG proposal.
        proposalType: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
          .describe(`GovValidators.ProposalType — ${INTERNAL_TYPE_DOC}`),
        descriptionURL: z.string().describe("IPFS CID (or ipfs://<cid>) of the proposal metadata JSON."),
        data: z.string().default("0x").describe("0x-hex payload for the chosen type; 0x for OffchainProposal."),
        chainId: buildChainIdParam,
      },
      outputSchema: payloadSchema(),
    },
    async ({ validators, proposalType, descriptionURL, data = "0x", chainId }) => {
      if (!isAddress(validators)) return errorResult(`Invalid validators: ${validators}`);
      if (!data.startsWith("0x")) return errorResult("data must be 0x-prefixed hex");
      try {
        const iface = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);
        const label = INTERNAL_PROPOSAL_TYPE_LABELS[proposalType]!;
        const payload = buildPayload({
          to: validators,
          iface,
          method: "createInternalProposal",
          args: [proposalType, descriptionURL, data],
          chainId: chainId ?? ctx.config.defaultChainId,
          contractLabel: "GovValidators",
          description: `GovValidators.createInternalProposal(${label})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(safeErrorMessage(err));
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
        "Builds calldata; does not broadcast. Encodes one ProposalAction {executor, value, data} from a function signature + args, for `actionsOnFor` of dexe_proposal_build_external.",
      inputSchema: {
        target: z.string().describe("Target contract the DAO will call"),
        signature: z.string().describe("Full function signature, e.g. 'function setX(uint256)'"),
        method: z.string().describe("Method name matching the signature"),
        args: z.array(z.unknown()).default([]).describe("Call arguments, in signature order."),
        value: z.string().default("0").describe("Native coin sent with the call, in wei."),
        // D11-5: this is the raw-calldata path, and the chain-specific execute
        // traps (#36 addSettings) can only be judged against a chain. Advisory
        // only — the encoded action is byte-identical with or without it.
        chainId: buildChainIdParam,
      },
      outputSchema: {
        action: z.object({
          executor: z.string(),
          value: z.string(),
          data: z.string(),
        }),
        preview: z.string(),
        warnings: warningsOutputField,
      },
    },
    async ({ target, signature, method, args = [], value = "0", chainId }) => {
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
        const forbidden = findForbiddenSelector(data);
        if (forbidden) return errorResult(dangerousSelectorError(forbidden, target));
        const action = { executor: target, value, data };
        const preview = `ProposalAction → ${target}.${method}(${args.length} args), value=${value}, calldata=${data.slice(0, 18)}…`;
        const treasuryAdvisory = buildTimeTreasuryAdvisory([action], ctx.config.treasuryGuard);
        // custom_abi is the raw-calldata path every other guard has historically
        // walked past. Assessing the encoded action means the #36 trap, the
        // GovSettings bounds, the F15 vesting leg and a self-harming blacklist
        // are caught here too, not only in the typed builders.
        const warnings = assessActions({
          ctx,
          chainId: chainId ?? ctx.config.defaultChainId,
          actions: [action],
        }).filter((w) => !(treasuryAdvisory && w.code === "treasury.risk"));
        return withWarnings(
          {
            text:
              `${preview}\n\n${CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY}` +
              (treasuryAdvisory ? `\n\n${treasuryAdvisory}` : ""),
            structured: { action, preview },
          },
          warnings,
        );
      } catch (err) {
        return errorResult(safeErrorMessage(err));
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
        "Builds an HTTP request; does not send it. Returns method/url/headers/body for POSTing an off-chain proposal to the DeXe backend — you send it. Backend defaults to api.dexe.io; override with DEXE_BACKEND_API_URL.",
      inputSchema: {
        endpoint: z
          .string()
          .describe("Backend endpoint path, e.g. '/proposals' or '/templates/voting'"),
        body: z.record(z.unknown()).describe("JSON body to POST"),
        method: z.enum(["POST", "PUT", "PATCH"]).default("POST").describe("HTTP verb for the request."),
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
      // Always resolves — env override or baked default (https://api.dexe.io).
      const base = process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl;
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
        "Builds proposal actions; does not broadcast. ERC20.transfer(recipient, amount), or a native value transfer when isNative=true. When an RPC is reachable for the target chain (the built-in public RPC counts) and the token is ERC20Gov, the recipient is checked against isBlacklisted; build aborts if blacklisted.",
      inputSchema: {
        govPool: govPoolParam,
        token: z.string().describe("ERC20 token contract (the transfer executor). Ignored when isNative=true."),
        recipient: z.string().describe("Address receiving the tokens."),
        // The blacklist probe reads the token contract, so it MUST run on the
        // chain the proposal targets: on any other chain the token has no code,
        // the guard degrades to `skipped`, and a blacklisted recipient produces
        // a proposal that passes the vote and then reverts forever (bug #29).
        chainId: buildChainIdParam,
        amount: z.string().describe("Amount to transfer, RAW base units (wei), decimal string."),
        isNative: z.boolean().default(false).describe("True for native token (BNB/ETH) transfers — sends value instead of ERC20.transfer"),
        proposalName: z.string().default("Token Transfer").describe("Proposal title."),
        proposalDescription: z.string().default("").describe("Proposal body, markdown."),
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
        warnings: warningsOutputField,
      },
    },
    async ({
      govPool,
      token,
      recipient,
      chainId,
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
        let blacklistNote = "";
        if (isNative) {
          actions = [{ executor: recipient, value: amount, data: "0x" }];
          actionLabel = `Native transfer → ${recipient} (${amount} wei)`;
        } else {
          const bl = await checkBlacklist(ctx.config, token, recipient, chainId ?? ctx.config.defaultChainId);
          if (bl.status === "blacklisted") return errorResult(blacklistError(token, recipient));
          blacklistNote =
            bl.status === "skipped"
              ? ` (blacklist precheck skipped: ${bl.reason})`
              : " (recipient not blacklisted)";
          const iface = new Interface(ERC20_ABI as unknown as string[]);
          const data = iface.encodeFunctionData("transfer", [recipient, BigInt(amount)]);
          actions = [{ executor: token, value: "0", data }];
          actionLabel = `ERC20(${token}).transfer(${recipient}, ${amount})${blacklistNote}`;
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
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
        const treasuryAdvisory = buildTimeTreasuryAdvisory(actions, ctx.config.treasuryGuard);
        const warnings = assessActions({ ctx, chainId, govPool, actions }).filter(
          (w) => !(treasuryAdvisory && w.code === "treasury.risk"),
        );
        return withWarnings(
          {
            text:
              `Built token-transfer proposal scaffolding.\n\nAction: ${actionLabel}\n\nNext:\n${nextStep}` +
              (treasuryAdvisory ? `\n\n${treasuryAdvisory}` : ""),
            structured: { metadata, actions, nextStep },
          },
          warnings,
        );
      } catch (err) {
        return errorResult(safeErrorMessage(err));
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
    warnings: warningsOutputField,
  };
}

/**
 * Every payload-returning tool in this file goes through here, so the build-time
 * harm pass cannot be forgotten at one of them. Before 0.34.0 the treasury
 * advisory reached `content[].text` only and `structuredContent` carried
 * `{...payload}` alone — a client reading the structured payload saw an
 * advisory-free build for calldata the server had already flagged.
 */
function payloadResult(payload: TxPayload, advisory?: string | null, warnings: BuildWarning[] = []) {
  return withWarnings(
    {
      text:
        `${payload.description}\n  to   : ${payload.to}\n  value: ${payload.value}\n  data : ${payload.data.slice(0, 66)}…` +
        (advisory ? `\n\n${advisory}` : ""),
      structured: { ...payload } as Record<string, unknown>,
    },
    warnings,
  );
}
