import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  cidForBytes,
  cidForJson,
  fetchIpfs,
  parseCid,
  PinataClient,
} from "../lib/ipfs.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";

export function registerIpfsTools(server: McpServer, ctx: ToolContext): void {
  const gateways = resolveGateways(ctx);

  registerUploadProposalMetadata(server, ctx);
  registerUploadDaoMetadata(server, ctx);
  registerUploadFile(server, ctx);
  registerFetch(server, gateways);
  registerCidInfo(server, gateways);
  registerCidForJson(server);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Build the gateway chain used by fetch/cid_info. Primary gateway is a single
 * dedicated endpoint the user configures — public gateways are only added if
 * the user opts in via `DEXE_IPFS_GATEWAYS_FALLBACK`. Returns an empty array
 * if nothing is configured; the fetch tool fails clean in that case.
 */
function resolveGateways(_ctx: ToolContext): string[] {
  const out: string[] = [];
  const primary = process.env.DEXE_IPFS_GATEWAY?.trim();
  if (primary) out.push(primary.replace(/\/$/, ""));
  const fallback = process.env.DEXE_IPFS_GATEWAYS_FALLBACK?.trim();
  if (fallback) {
    for (const g of fallback.split(",").map((s) => s.trim().replace(/\/$/, ""))) {
      if (g && !out.includes(g)) out.push(g);
    }
  }
  return out;
}

const NO_GATEWAY_HINT =
  "No IPFS gateway configured. Set DEXE_IPFS_GATEWAY to a dedicated gateway " +
  "(Pinata gives one free with your JWT — e.g. https://<your-subdomain>.mypinata.cloud — " +
  "or use Filebase / Quicknode / a self-hosted gateway). " +
  "Public gateways (dweb.link, ipfs.io) are unreliable and not defaulted. " +
  "Optional best-effort fallback: DEXE_IPFS_GATEWAYS_FALLBACK=https://dweb.link,https://ipfs.io.";

function requirePinata(ctx: ToolContext): PinataClient | { error: string } {
  if (!ctx.config.pinataJwt) {
    return {
      error:
        "DEXE_PINATA_JWT is not set. Add your Pinata JWT to the MCP env block to enable uploads.",
    };
  }
  return new PinataClient(ctx.config.pinataJwt);
}

// ---------- dexe_ipfs_upload_proposal_metadata ----------

function registerUploadProposalMetadata(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_proposal_metadata",
    {
      title: "Upload proposal metadata JSON to IPFS (Pinata)",
      description:
        "Pins `{ proposalName, proposalDescription, ... }` (the shape DeXe proposals expect) to IPFS via Pinata. Returns the CID for use as `descriptionURL` in `GovPool.createProposal`.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().default("").describe(
          "Proposal description — supports full Markdown: # headings, **bold**, *italic*, " +
          "~~strikethrough~~, [links](url), `inline code`, ```code blocks```, " +
          "- bullet lists, 1. numbered lists. Automatically converted to the Slate " +
          "editor node format the frontend expects. Plain text also works.",
        ),
        extra: z
          .record(z.unknown())
          .optional()
          .describe("Optional extra fields merged into the metadata object"),
      },
      outputSchema: {
        cid: z.string(),
        size: z.number(),
        pinnedAt: z.string(),
        descriptionURL: z.string(),
      },
    },
    async ({ title, description = "", extra }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const slateDescription = markdownToSlate(description);
        const payload = { proposalName: title, proposalDescription: JSON.stringify(slateDescription), ...(extra ?? {}) };
        const res = await client.pinJson(payload, { name: `proposal:${title.slice(0, 48)}` });
        const structured = {
          cid: res.cid,
          size: res.size,
          pinnedAt: res.pinnedAt,
          descriptionURL: res.cid,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Pinned proposal metadata → ${res.cid} (${res.size} bytes, ${res.pinnedAt})\nUse as descriptionURL.`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_ipfs_upload_dao_metadata ----------

/**
 * Matches the frontend's nested IPFS upload chain for DAO descriptionURL.
 *
 * Frontend does 3 uploads:
 *   1. Avatar file → CID v1 (optional)
 *   2. Description text/JSON → CID v0 → "ipfs://<cid>"
 *   3. Outer metadata wrapper (references #1 and #2) → CID v0 → "ipfs://<cid>"
 *
 * The outer CID (#3) becomes `descriptionURL` in `deployGovPool`.
 *
 * Outer metadata shape (must match for frontend UI compatibility):
 * {
 *   avatarUrl: "https://<cidV1>.ipfs.4everland.io/<filename>" | "",
 *   avatarCID: "<cidV1>" | undefined,
 *   avatarFileName: "<filename>.jpeg" | "",
 *   daoName: string,
 *   websiteUrl: string,
 *   description: "ipfs://<cidV0>",   // nested CID pointing to description content
 *   socialLinks: [["twitter", "https://..."], ...],
 *   documents: [{ name: string, url: string }, ...]
 * }
 */
function registerUploadDaoMetadata(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_dao_metadata",
    {
      title: "Upload DAO metadata to IPFS (frontend-compatible nested format)",
      description:
        "Uploads DAO metadata to IPFS using the exact schema the DeXe frontend expects. " +
        "Performs a nested upload chain: (1) description content → IPFS, (2) outer metadata referencing the description CID → IPFS. " +
        "Returns the outer CID for use as `descriptionURL` in `deployGovPool`. " +
        "If avatarCID is provided (from a prior `dexe_ipfs_upload_file` call), it's wired into the metadata. " +
        "Field names match the frontend exactly: `daoName`, `websiteUrl`, `socialLinks`, `documents`.",
      inputSchema: {
        daoName: z.string().min(1).describe("DAO name (displayed in UI)"),
        description: z.string().default("").describe(
          "DAO description — supports full Markdown: # headings, **bold**, *italic*, " +
          "~~strikethrough~~, [links](url), `inline code`, ```code blocks```, " +
          "- bullet lists, 1. numbered lists. Automatically converted to the Slate " +
          "editor node format the frontend expects. Plain text also works.",
        ),
        websiteUrl: z.string().default("").describe("DAO website URL"),
        avatarCID: z.string().optional().describe(
          "CID v1 of a previously uploaded avatar image (from dexe_ipfs_upload_file). Omit if no avatar.",
        ),
        avatarFileName: z.string().optional().describe(
          "Avatar filename with extension, e.g. 'logo.jpeg'. Required if avatarCID is provided.",
        ),
        socialLinks: z
          .array(z.tuple([z.string(), z.string()]))
          .optional()
          .describe('Social links as [platform, url] tuples, e.g. [["twitter", "https://x.com/dao"]]'),
        documents: z
          .array(z.object({ name: z.string(), url: z.string() }))
          .optional()
          .describe("External documents, e.g. [{ name: \"Whitepaper\", url: \"https://...\" }]"),
      },
      outputSchema: {
        cid: z.string(),
        descriptionCid: z.string(),
        size: z.number(),
        pinnedAt: z.string(),
        descriptionURL: z.string(),
      },
    },
    async ({
      daoName,
      description = "",
      websiteUrl = "",
      avatarCID,
      avatarFileName,
      socialLinks,
      documents,
    }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        // Step 1: Upload description content as its own IPFS pin.
        // The frontend stores descriptions as Slate editor node arrays and
        // renders them via SlateDescendant[]. We convert markdown/plain text
        // to the full Slate format (headings, bold, links, lists, etc.)
        // using remark-slate-transformer with frontend-matching overrides.
        const descriptionPayload = markdownToSlate(description);
        const descriptionRes = await client.pinJson(descriptionPayload, {
          name: `dao-desc:${daoName.slice(0, 40)}`,
        });
        const descriptionIpfsPath = `ipfs://${descriptionRes.cid}`;

        // Step 2: Build the outer metadata wrapper (matches frontend schema exactly)
        let avatarUrl = "";
        if (avatarCID && avatarFileName) {
          // Frontend uses 4everland gateway: https://<cidV1>.ipfs.4everland.io/<filename>
          avatarUrl = `https://${avatarCID}.ipfs.4everland.io/${avatarFileName}`;
        }

        const outerPayload = {
          avatarUrl,
          avatarCID: avatarCID ?? undefined,
          avatarFileName: avatarFileName ?? "",
          daoName,
          websiteUrl,
          description: descriptionIpfsPath,
          socialLinks: socialLinks ?? [],
          documents: documents ?? [],
        };

        // Step 3: Upload the outer metadata wrapper
        const metadataRes = await client.pinJson(outerPayload, {
          name: `dao:${daoName.slice(0, 48)}`,
        });

        const structured = {
          cid: metadataRes.cid,
          descriptionCid: descriptionRes.cid,
          size: metadataRes.size,
          pinnedAt: metadataRes.pinnedAt,
          descriptionURL: metadataRes.cid,
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Pinned DAO metadata (frontend-compatible):\n` +
                `  description content → ${descriptionRes.cid}\n` +
                `  outer metadata      → ${metadataRes.cid} (${metadataRes.size} bytes)\n` +
                `Use "${metadataRes.cid}" as descriptionURL in deployGovPool.`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_ipfs_upload_file ----------

function registerUploadFile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_file",
    {
      title: "Upload raw bytes (avatar, attachment, etc.) to IPFS (Pinata)",
      description:
        "Pins a file to IPFS. Accepts base64-encoded bytes; returns the CID. Use for DAO avatars or proposal attachments.",
      inputSchema: {
        base64: z.string().min(1).describe("Base64-encoded file bytes"),
        fileName: z.string().default("file"),
        contentType: z.string().default("application/octet-stream"),
      },
      outputSchema: {
        cid: z.string(),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({ base64, fileName = "file", contentType = "application/octet-stream" }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
        const res = await client.pinFile(bytes, { fileName, contentType, name: fileName });
        const structured = { cid: res.cid, size: res.size, pinnedAt: res.pinnedAt };
        return {
          content: [
            {
              type: "text" as const,
              text: `Pinned ${fileName} (${bytes.length} bytes) → ${res.cid} (size on IPFS=${res.size})`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_ipfs_fetch ----------

function registerFetch(server: McpServer, defaultGateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_fetch",
    {
      title: "Fetch content by CID (dedicated gateway, optional fallback)",
      description:
        "Fetches IPFS content via the gateway configured in DEXE_IPFS_GATEWAY (recommended: a dedicated gateway — Pinata gives one with the JWT). Public gateways are NOT a default because they're unreliable; opt in via DEXE_IPFS_GATEWAYS_FALLBACK (comma-separated) for best-effort fallback after the primary. Returns parsed JSON when content-type is JSON, plus raw bytes size.",
      inputSchema: {
        cid: z.string().describe("CID (with or without ipfs:// prefix)"),
        timeoutMs: z.number().int().min(500).max(30_000).default(4000),
      },
      outputSchema: {
        cid: z.string(),
        gateway: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
        attempts: z.number(),
        json: z.unknown().nullable(),
      },
    },
    async ({ cid, timeoutMs = 4000 }) => {
      if (defaultGateways.length === 0) return errorResult(NO_GATEWAY_HINT);
      try {
        const res = await fetchIpfs(cid, {
          gateways: defaultGateways,
          perRequestTimeoutMs: timeoutMs,
        });
        const structured = {
          cid: res.cid,
          gateway: res.gateway,
          contentType: res.contentType,
          sizeBytes: res.bytes.length,
          attempts: res.attempts,
          json: res.json,
        };
        const preview =
          res.json != null
            ? JSON.stringify(res.json, null, 2).slice(0, 800)
            : `(${res.bytes.length} bytes of ${res.contentType})`;
        return {
          content: [
            {
              type: "text" as const,
              text: `CID ${res.cid} via ${res.gateway} (attempts=${res.attempts})\n${preview}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_ipfs_cid_info ----------

function registerCidInfo(server: McpServer, gateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_cid_info",
    {
      title: "Parse a CID, show version/codec, compute the alternate version + gateway URLs",
      description:
        "Parses a CIDv0 or CIDv1, reports codec + multihash, converts between v0↔v1 when legal, and emits the gateway URL for each configured gateway.",
      inputSchema: {
        cid: z.string().describe("CID (with or without ipfs:// prefix)"),
      },
      outputSchema: {
        cid: z.string(),
        version: z.number(),
        codec: z.string(),
        multihash: z.string(),
        alternate: z.string().nullable(),
        gatewayUrls: z.array(z.string()),
      },
    },
    async ({ cid }) => {
      try {
        const info = parseCid(cid);
        const gatewayUrls = gateways.length
          ? gateways.map((g) => `${g.replace(/\/$/, "")}/ipfs/${info.cid}`)
          : [];
        const structured = { ...info, gatewayUrls };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `CID    : ${info.cid}\n` +
                `Version: v${info.version}\n` +
                `Codec  : ${info.codec}\n` +
                `Multihash (base58btc): ${info.multihash}\n` +
                `Alt    : ${info.alternate ?? "(no legal alternate)"}\n` +
                `Gateway URLs:\n${gatewayUrls.map((u) => `  ${u}`).join("\n")}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- dexe_ipfs_cid_for_json ----------

function registerCidForJson(server: McpServer): void {
  server.registerTool(
    "dexe_ipfs_cid_for_json",
    {
      title: "Compute the CIDv1 for a JSON value locally — no network",
      description:
        "Computes the deterministic CIDv1 (json codec, sha-256) for arbitrary JSON. Useful for dry-run flows: precompute the CID, build/sign a proposal with it as `descriptionURL`, then upload separately. The CID computed here matches what Pinata returns for the same bytes encoded with the multiformats json codec.",
      inputSchema: {
        value: z.unknown(),
      },
      outputSchema: {
        cid: z.string(),
        codec: z.string(),
      },
    },
    async ({ value }) => {
      try {
        const cid = await cidForJson(value);
        return {
          content: [{ type: "text" as const, text: `CID (json, sha-256): ${cid}` }],
          structuredContent: { cid, codec: "json" },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// Keep this export so `cidForBytes` isn't flagged as dead code by strict builds;
// tools can opt into it later.
export { cidForBytes };
