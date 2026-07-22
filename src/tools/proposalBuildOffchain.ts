import { z } from "zod";
import { isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { DEFAULTS } from "../config.js";

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

// Bug #27: backend rejects unix-timestamp `type` with
// "proposal type was not found". Real values are registered template names.
// F21: the backend auto-provisions exactly TWO types per pool —
// default_single_option_type and default_multiple_option_type ("multiple",
// not "multi"; verified against GET /integrations/voting/proposal-types).
// There is NO default for_against type: it must first be created via a
// create_proposal_type proposal (dexe_proposal_build_offchain_settings,
// mode=create_proposal_type) that passes and is submitted.
const DEFAULT_TYPE_SINGLE_OPTION = "default_single_option_type";
const DEFAULT_TYPE_MULTI_OPTION = "default_multiple_option_type";
// F22: the DeXe product does not support for_against off-chain voting. Verified
// against the frontend (NewTemplateForm/steps/TemplateStep exposes only oneOf +
// multipleOf tabs; OffChainVotingTypeListMap maps only those) and the backend
// (GET /integrations/voting/proposal-types auto-provisions only single+multiple
// per pool). The for_against enum/i18n exist but have no creation path — every
// create request 400s ("proposal type was not found" / "invalid custom parameters").
const FOR_AGAINST_UNSUPPORTED =
  "for_against off-chain voting is NOT supported by the DeXe backend/product. Only two off-chain " +
  "voting types are creatable: single-option (dexe_proposal_build_offchain_single_option) and " +
  "multi-option (dexe_proposal_build_offchain_multi_option). For a binary vote, use the single-option " +
  "builder with voteOptions ['For','Against']. (Verified against investing-dashboard TemplateStep — " +
  "only oneOf/multipleOf tabs — and the backend proposal-types endpoint.)";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function requireBase(): string | { error: string } {
  // Always resolves — env override or baked default (https://api.dexe.io).
  const base = process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl;
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
  signer?: SignerManager,
  wc?: WalletConnectManager,
): void {
  registerAuthNonce(server);
  registerAuthLogin(server);
  if (signer && wc) registerAuthLoginComposite(server, signer, wc);
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

// ---------- auth: one-call login (signs internally) ----------

/**
 * One-call off-chain login. When a signer is configured (DEXE_PRIVATE_KEY EOA
 * or a connected WalletConnect session — the same opt-in surface as
 * dexe_tx_send), this fetches the nonce, signs it, and exchanges it for a
 * Bearer access token — all inside the server. This exists so an AI agent
 * NEVER has to write code that extracts the private key to sign the auth nonce
 * (that pattern is exactly what off-chain flows used to force). Falls back to
 * an instruction to use the manual build tools when no signer is available.
 */
function registerAuthLoginComposite(
  server: McpServer,
  signer: SignerManager,
  wc: WalletConnectManager,
): void {
  server.registerTool(
    "dexe_auth_login",
    {
      title: "Off-chain auth — one call: fetch nonce, sign, log in, return Bearer token",
      description:
        "Composite for DeXe off-chain backend auth. When a signer is available (DEXE_PRIVATE_KEY or a connected WalletConnect session) it GETs the nonce, signs it with the configured signer, POSTs the login, and returns the Bearer access token — no manual nonce→sign→login dance, and no need to handle the private key in agent code. Use the returned accessToken as `Authorization: Bearer <accessToken>` on off-chain proposal/vote requests (build them with dexe_proposal_build_offchain_*). If no signer is configured, returns instructions to use dexe_auth_request_nonce + dexe_auth_login_request instead.",
      inputSchema: {
        address: z
          .string()
          .optional()
          .describe("Override the signer address (defaults to the configured EOA / connected WC account)."),
      },
      outputSchema: {
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        address: z.string().optional(),
        expiresIn: z.number().optional(),
        signerMode: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async ({ address }) => {
      const base = requireBase();
      if (typeof base !== "string") return errorResult(base.error);

      // Resolve which signer to use — EOA key takes precedence, else a live WC session.
      const eoa = signer.hasSigner();
      const wcConnected = wc.isConnected();
      if (!eoa && !wcConnected) {
        return jsonResult({
          note:
            "No signer configured — cannot sign the auth nonce internally. Either set DEXE_PRIVATE_KEY " +
            "(or run dexe_wc_connect), then re-call dexe_auth_login; OR do it manually: dexe_auth_request_nonce → " +
            "sign the returned `message` with your wallet → dexe_auth_login_request with the signature.",
        });
      }
      const signerAddress = address ?? (eoa ? signer.getAddress() : wc.account());
      if (!signerAddress || !isAddress(signerAddress)) {
        return errorResult(`Could not resolve a valid signer address (got: ${signerAddress ?? "none"}).`);
      }
      const signerMode = eoa ? "eoa" : "walletconnect";

      try {
        // Step 1 — nonce.
        const nonceRes = await fetch(`${base}${NONCE_ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { type: "auth_nonce_request", attributes: { address: signerAddress } } }),
        });
        if (!nonceRes.ok) {
          return errorResult(`Nonce request failed (HTTP ${nonceRes.status}): ${await safeBody(nonceRes)}`);
        }
        const nonceJson = (await nonceRes.json()) as { data?: { attributes?: { message?: string } } };
        const message = nonceJson.data?.attributes?.message;
        if (!message) return errorResult(`Nonce response missing message field: ${JSON.stringify(nonceJson)}`);

        // Step 2 — sign (never exposes the key to the caller).
        const signature = eoa ? await signer.signMessage(message) : await wc.signMessage(message);

        // Step 3 — login.
        const loginRes = await fetch(`${base}${LOGIN_ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: { type: "login_request", attributes: { auth_pair: { address: signerAddress, signed_message: signature } } },
          }),
        });
        if (!loginRes.ok) {
          return errorResult(`Login failed (HTTP ${loginRes.status}): ${await safeBody(loginRes)}`);
        }
        const loginJson = (await loginRes.json()) as {
          data?: { relationships?: { access_token?: { data?: { id?: string } }; refresh_token?: { data?: { id?: string } } } };
          included?: Array<{ type?: string; attributes?: { expires_in?: number } }>;
        };
        const accessToken = loginJson.data?.relationships?.access_token?.data?.id;
        const refreshToken = loginJson.data?.relationships?.refresh_token?.data?.id;
        if (!accessToken) return errorResult(`Login response missing access_token: ${JSON.stringify(loginJson)}`);
        const expiresIn = loginJson.included?.find((i) => i.type === "access_jwt")?.attributes?.expires_in;

        return jsonResult({
          accessToken,
          refreshToken,
          address: signerAddress,
          expiresIn,
          signerMode,
          note:
            "Logged in. Use `Authorization: Bearer <accessToken>` on off-chain requests " +
            "(dexe_proposal_build_offchain_* / dexe_offchain_build_vote). Token is a JWT; expiresIn is its unix expiry.",
        });
      } catch (err) {
        return errorResult(`Auth login failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "(no body)";
  }
}

function jsonResult(obj: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
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
  defaultType: string,
) {
  return {
    title: p.title,
    description: p.description,
    type: p.type ?? defaultType,
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
  defaultType: string,
) {
  return {
    data: {
      type: "proposals",
      attributes: {
        type: p.type ?? defaultType,
        title: p.title,
        chain_id: p.chainId,
        description: JSON.stringify(markdownToSlate(p.description)),
        pool_address: p.poolAddress,
        vote_options: p.voteOptions,
        custom_parameters: buildCustomParameters(p, votingType, quorum, defaultType),
      },
    },
  };
}

// Bug #27 (decimals variant): backend stores quorum percentages as fractions
// (0.5 = 50%), but the tool inputs use whole numbers (50 = 50%) for ergonomic
// parity with the frontend form. Divide once at the boundary.
function pctToFraction(p: number): number {
  return p / 100;
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
          general_closing_percent: pctToFraction(input.generalClosingPercent),
          anticipatory_closing_percent: pctToFraction(input.anticipatoryClosingPercent),
          against_percent: pctToFraction(input.againstPercent),
        },
      }, DEFAULT_TYPE_SINGLE_OPTION);
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
          boundary_percent: pctToFraction(input.boundaryPercent),
          against_percent: pctToFraction(input.againstPercent),
        },
      }, DEFAULT_TYPE_MULTI_OPTION);
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
      title: "Off-chain: binary for/against voting proposal (NOT supported by DeXe backend)",
      description:
        "DISABLED (F22): the DeXe product does NOT support creating for_against off-chain proposals. " +
        "The web app exposes only two off-chain voting types — single-option (one_of) and multi-option " +
        "(multiple_of); there is no for_against creation path and the backend auto-provisions no " +
        "for_against type, so any create request 400s. Use dexe_proposal_build_offchain_single_option " +
        "with two options ['For','Against'] instead. This tool is kept only to return that guidance.",
      inputSchema: {
        ...commonInputSchema,
        voteOptions: z
          .array(z.string())
          .default(["For", "Against"])
          .describe("Ignored — for_against is not creatable on the DeXe backend."),
        forPercent: z.number().min(0).max(100).default(50),
        againstPercent: z.number().min(0).max(100).default(50),
      },
      outputSchema: requestOutputSchema(),
    },
    async (_input) => {
      return errorResult(FOR_AGAINST_UNSUPPORTED);
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
        votingType: z.enum(["one_of", "multiple_of"]).default("one_of").describe(
          "Only one_of and multiple_of are supported off-chain — for_against is not creatable on the DeXe backend (F22).",
        ),
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
      if ((input.votingType as string) === "for_against") return errorResult(FOR_AGAINST_UNSUPPORTED);
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
