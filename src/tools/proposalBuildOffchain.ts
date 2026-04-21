import { z } from "zod";
import { isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";

/**
 * Phase 3d — off-chain proposals via the DeXe backend API.
 *
 * Every tool returns a ready-to-send HTTP request object:
 *   { request: { method, url, headers, body }, authRequired?: boolean }
 * The MCP NEVER sends HTTP itself. Agent wallet/client signs + dispatches.
 *
 * Auth is a 2-step dance:
 *   1) dexe_auth_request_nonce → GET a nonce message for the user address
 *   2) user wallet signs the message
 *   3) dexe_auth_login_request → POST signed message, get access_token
 *   4) all subsequent requests use `Authorization: Bearer <access_token>`
 *
 * JSON:API format everywhere: { data: { type, attributes: {...} } }.
 *
 * Base URL: DEXE_BACKEND_API_URL (e.g. https://api.dexe.io).
 */

const PROPOSAL_ENDPOINT = "/integrations/voting/proposals";
const VOTE_ENDPOINT = "/integrations/voting/vote";
const NONCE_ENDPOINT = "/integrations/nonce-auth-svc/nonce";
const LOGIN_ENDPOINT = "/integrations/nonce-auth-svc/login";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function requireBase(): string | { error: string } {
  const base = process.env.DEXE_BACKEND_API_URL?.trim();
  if (!base) {
    return {
      error:
        "DEXE_BACKEND_API_URL is not set. Add it to the MCP env block (e.g. https://api.dexe.io or https://api.beta.dexe.io).",
    };
  }
  return base.replace(/\/$/, "");
}

function requestResult(
  method: string,
  url: string,
  body: unknown,
  opts: { authRequired?: boolean; note?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authRequired) {
    headers["Authorization"] = "Bearer <ACCESS_TOKEN>";
  }
  const request = { method, url, headers, body };
  const preview = `${method} ${url}${opts.authRequired ? "\n(Authorization: Bearer <ACCESS_TOKEN>)" : ""}\n${JSON.stringify(body, null, 2)}`;
  return {
    content: [
      {
        type: "text" as const,
        text: `${opts.note ?? ""}${opts.note ? "\n\n" : ""}${preview}`,
      },
    ],
    structuredContent: { request, authRequired: !!opts.authRequired },
  };
}

function requestOutputSchema() {
  return {
    request: z.object({
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string()),
      body: z.unknown(),
    }),
    authRequired: z.boolean(),
  };
}

// ---------- register ----------

export function registerProposalBuildOffchainTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerAuthNonce(server);
  registerAuthLogin(server);
  registerSingleOption(server);
  registerMultiOption(server);
  registerForAgainst(server);
  registerSettingsProposal(server);
  registerCastVote(server);
  registerCancelVote(server);
}

// ---------- auth: request nonce ----------

function registerAuthNonce(server: McpServer): void {
  server.registerTool(
    "dexe_auth_request_nonce",
    {
      title: "Auth step 1/2: request a nonce to sign",
      description:
        "Returns the HTTP request for POST /integrations/nonce-auth-svc/nonce. The response will contain `{ message: string }` — feed that to the wallet to sign, then call dexe_auth_login_request.",
      inputSchema: {
        address: z.string().describe("User wallet address"),
      },
      outputSchema: requestOutputSchema(),
    },
    async ({ address }) => {
      if (!isAddress(address)) return errorResult(`Invalid address: ${address}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = {
        data: { type: "auth_nonce_request", attributes: { address } },
      };
      return requestResult("POST", `${base}${NONCE_ENDPOINT}`, body, {
        note: "Next: sign the `message` field of the response, then call dexe_auth_login_request with the signature.",
      });
    },
  );
}

// ---------- auth: login with signed message ----------

function registerAuthLogin(server: McpServer): void {
  server.registerTool(
    "dexe_auth_login_request",
    {
      title: "Auth step 2/2: exchange signed nonce for access_token",
      description:
        "Returns the HTTP request for POST /integrations/nonce-auth-svc/login. Response: `{ access_token: { id }, refresh_token: { id } }`. Store access_token.id and use it as Bearer in all subsequent calls.",
      inputSchema: {
        address: z.string(),
        signedMessage: z.string().describe("The nonce message signed by the user's wallet (0x-hex)"),
      },
      outputSchema: requestOutputSchema(),
    },
    async ({ address, signedMessage }) => {
      if (!isAddress(address)) return errorResult(`Invalid address: ${address}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = {
        data: {
          type: "login_request",
          attributes: {
            auth_pair: { address, signed_message: signedMessage },
          },
        },
      };
      return requestResult("POST", `${base}${LOGIN_ENDPOINT}`, body, {
        note: "Response: { access_token: { id }, refresh_token: { id } }. Store access_token.id.",
      });
    },
  );
}

// ---------- common proposal-body builder ----------

interface ProposalParamsBase {
  title: string;
  description: string;
  chainId: number;
  poolAddress: string;
  voteOptions: string[];
  type?: string;
  useDelegated?: boolean;
  votingDurationSeconds: string;
  minimalVotePower?: string;
  minimalCreateProposalPower?: string;
  minimalCommentReadPower?: string;
  minimalCommentCreatePower?: string;
}

function buildCustomParameters(
  p: ProposalParamsBase,
  votingType: "one_of" | "multiple_of" | "for_against",
  quorum: Record<string, unknown>,
) {
  return {
    title: p.title,
    description: p.description,
    type: p.type ?? String(Math.floor(Date.now() / 1000)),
    use_delegated: p.useDelegated ?? true,
    voting_duration: Number(p.votingDurationSeconds),
    voting_type: votingType,
    quorum,
    minimal_vote_power: p.minimalVotePower ?? "0",
    minimal_create_proposal_power: p.minimalCreateProposalPower ?? "0",
    minimal_comment_read_power: p.minimalCommentReadPower ?? "0",
    minimal_comment_create_power: p.minimalCommentCreatePower ?? "0",
    pool_address: p.poolAddress,
  };
}

function buildProposalBody(
  p: ProposalParamsBase,
  votingType: "one_of" | "multiple_of" | "for_against",
  quorum: Record<string, unknown>,
) {
  return {
    data: {
      type: "proposals",
      attributes: {
        type: p.type ?? String(Math.floor(Date.now() / 1000)),
        title: p.title,
        chain_id: p.chainId,
        description: JSON.stringify(markdownToSlate(p.description)),
        pool_address: p.poolAddress,
        vote_options: p.voteOptions,
        custom_parameters: buildCustomParameters(p, votingType, quorum),
      },
    },
  };
}

const commonInputSchema = {
  poolAddress: z.string(),
  chainId: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().default("").describe(
    "Proposal description — supports Markdown: # headings, **bold**, *italic*, " +
    "~~strikethrough~~, [links](url), `code`, - lists. Auto-converted to Slate " +
    "editor format and JSON-stringified for the backend API.",
  ),
  voteOptions: z.array(z.string()).min(2),
  votingDurationSeconds: z.string(),
  useDelegated: z.boolean().default(true),
  minimalVotePower: z.string().default("0"),
  minimalCreateProposalPower: z.string().default("0"),
  minimalCommentReadPower: z.string().default("0"),
  minimalCommentCreatePower: z.string().default("0"),
};

// ---------- single_option_voting ----------

function registerSingleOption(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_offchain_single_option",
    {
      title: "Off-chain: single-option voting proposal (pick one of N)",
      description:
        "Builds POST /integrations/voting/proposals with voting_type='one_of'. Voter picks exactly one of `voteOptions`. Requires auth (Bearer access_token).",
      inputSchema: {
        ...commonInputSchema,
        generalClosingPercent: z.number().min(0).max(100).default(50),
        anticipatoryClosingPercent: z.number().min(0).max(100).default(0),
        againstPercent: z.number().min(0).max(100).default(0),
      },
      outputSchema: requestOutputSchema(),
    },
    async (input) => {
      if (!isAddress(input.poolAddress)) return errorResult(`Invalid poolAddress: ${input.poolAddress}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = buildProposalBody(input, "one_of", {
        one_of_quorum: {
          general_closing_percent: input.generalClosingPercent,
          anticipatory_closing_percent: input.anticipatoryClosingPercent,
          against_percent: input.againstPercent,
        },
      });
      return requestResult("POST", `${base}${PROPOSAL_ENDPOINT}`, body, {
        authRequired: true,
        note: `Off-chain 'one_of' proposal for ${input.poolAddress} — ${input.voteOptions.length} options.`,
      });
    },
  );
}

// ---------- multi_option_voting ----------

function registerMultiOption(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_offchain_multi_option",
    {
      title: "Off-chain: multi-option voting proposal (pick M of N)",
      description:
        "POST /integrations/voting/proposals with voting_type='multiple_of'. Voter picks any subset of `voteOptions`.",
      inputSchema: {
        ...commonInputSchema,
        boundaryPercent: z.number().min(0).max(100).default(50),
        againstPercent: z.number().min(0).max(100).default(0),
      },
      outputSchema: requestOutputSchema(),
    },
    async (input) => {
      if (!isAddress(input.poolAddress)) return errorResult(`Invalid poolAddress: ${input.poolAddress}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = buildProposalBody(input, "multiple_of", {
        multiple_of_quorum: {
          boundary_percent: input.boundaryPercent,
          against_percent: input.againstPercent,
        },
      });
      return requestResult("POST", `${base}${PROPOSAL_ENDPOINT}`, body, {
        authRequired: true,
        note: `Off-chain 'multiple_of' proposal for ${input.poolAddress} — ${input.voteOptions.length} options.`,
      });
    },
  );
}

// ---------- for_against_voting ----------

function registerForAgainst(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_offchain_for_against",
    {
      title: "Off-chain: binary for/against voting proposal",
      description:
        "POST /integrations/voting/proposals with voting_type='for_against'. `voteOptions` is usually ['For','Against'] but you can pass any 2 labels.",
      inputSchema: {
        ...commonInputSchema,
        voteOptions: z
          .array(z.string())
          .default(["For", "Against"])
          .describe("Exactly 2 labels; defaults to [For, Against]"),
        forPercent: z.number().min(0).max(100).default(50),
        againstPercent: z.number().min(0).max(100).default(50),
      },
      outputSchema: requestOutputSchema(),
    },
    async (input) => {
      if (!isAddress(input.poolAddress)) return errorResult(`Invalid poolAddress: ${input.poolAddress}`);
      if (input.voteOptions.length !== 2) return errorResult("for_against expects exactly 2 voteOptions");
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = buildProposalBody(input, "for_against", {
        for_against_quorum: {
          for_percent: input.forPercent,
          against_percent: input.againstPercent,
        },
      });
      return requestResult("POST", `${base}${PROPOSAL_ENDPOINT}`, body, {
        authRequired: true,
        note: `Off-chain 'for_against' proposal for ${input.poolAddress}.`,
      });
    },
  );
}

// ---------- change_voting_settings_offchain / new_template ----------

function registerSettingsProposal(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_offchain_settings",
    {
      title: "Off-chain: change voting settings or save a new template",
      description:
        "POST /integrations/voting/proposals with attributes.type='edit_proposal_type' (change DAO-wide off-chain settings) or 'create_proposal_type' (save a reusable voting template). Body shape mirrors the voting-type-specific tools.",
      inputSchema: {
        mode: z.enum(["edit_proposal_type", "create_proposal_type"]),
        poolAddress: z.string(),
        chainId: z.number().int().positive(),
        title: z.string().min(1),
        description: z.string().default("").describe(
          "Proposal description — supports Markdown. Auto-converted to Slate format.",
        ),
        votingType: z.enum(["one_of", "multiple_of", "for_against"]).default("one_of"),
        voteOptions: z.array(z.string()).default([]),
        votingDurationSeconds: z.string(),
        quorum: z
          .record(z.unknown())
          .describe("Quorum object matching the chosen votingType"),
        useDelegated: z.boolean().default(true),
        minimalVotePower: z.string().default("0"),
        minimalCreateProposalPower: z.string().default("0"),
        minimalCommentReadPower: z.string().default("0"),
        minimalCommentCreatePower: z.string().default("0"),
      },
      outputSchema: requestOutputSchema(),
    },
    async (input) => {
      if (!isAddress(input.poolAddress)) return errorResult(`Invalid poolAddress: ${input.poolAddress}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = {
        data: {
          type: "proposals",
          attributes: {
            type: input.mode, // "edit_proposal_type" or "create_proposal_type"
            title: input.title,
            chain_id: input.chainId,
            description: JSON.stringify(markdownToSlate(input.description)),
            pool_address: input.poolAddress,
            vote_options: input.voteOptions,
            custom_parameters: {
              title: input.title,
              description: JSON.stringify(markdownToSlate(input.description)),
              type: input.mode,
              use_delegated: input.useDelegated,
              voting_duration: Number(input.votingDurationSeconds),
              voting_type: input.votingType,
              quorum: input.quorum,
              minimal_vote_power: input.minimalVotePower,
              minimal_create_proposal_power: input.minimalCreateProposalPower,
              minimal_comment_read_power: input.minimalCommentReadPower,
              minimal_comment_create_power: input.minimalCommentCreatePower,
              pool_address: input.poolAddress,
            },
          },
        },
      };
      return requestResult("POST", `${base}${PROPOSAL_ENDPOINT}`, body, {
        authRequired: true,
        note: `Off-chain ${input.mode} for ${input.poolAddress}.`,
      });
    },
  );
}

// ---------- cast_vote ----------

function registerCastVote(server: McpServer): void {
  server.registerTool(
    "dexe_offchain_build_vote",
    {
      title: "Off-chain: cast a vote on an existing off-chain proposal",
      description:
        "POST /integrations/voting/vote. `options` is an array of selected option strings (length 1 for one_of/for_against, ≥1 for multiple_of).",
      inputSchema: {
        proposalId: z.number().int().positive(),
        voterAddress: z.string(),
        options: z.array(z.string()).min(1),
      },
      outputSchema: requestOutputSchema(),
    },
    async ({ proposalId, voterAddress, options }) => {
      if (!isAddress(voterAddress)) return errorResult(`Invalid voterAddress: ${voterAddress}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const body = {
        data: {
          type: "votes",
          attributes: {
            proposal_id: proposalId,
            voter_address: voterAddress,
            options,
          },
        },
      };
      return requestResult("POST", `${base}${VOTE_ENDPOINT}`, body, {
        authRequired: true,
        note: `Off-chain vote on proposal #${proposalId} by ${voterAddress}.`,
      });
    },
  );
}

// ---------- cancel_vote ----------

function registerCancelVote(server: McpServer): void {
  server.registerTool(
    "dexe_offchain_build_cancel_vote",
    {
      title: "Off-chain: cancel a previously cast vote",
      description:
        "DELETE /integrations/voting/vote/{proposalId}/{voterAddress}. No body.",
      inputSchema: {
        proposalId: z.number().int().positive(),
        voterAddress: z.string(),
      },
      outputSchema: requestOutputSchema(),
    },
    async ({ proposalId, voterAddress }) => {
      if (!isAddress(voterAddress)) return errorResult(`Invalid voterAddress: ${voterAddress}`);
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);
      const url = `${base}${VOTE_ENDPOINT}/${proposalId}/${voterAddress}`;
      return requestResult("DELETE", url, null, {
        authRequired: true,
        note: `Cancel off-chain vote on proposal #${proposalId} by ${voterAddress}.`,
      });
    },
  );
}
