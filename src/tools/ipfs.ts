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
        "Pins `{ title, description }` (the shape DeXe proposals expect) to IPFS via Pinata. Returns the CID for use as `descriptionURL` in `GovPool.createProposal`.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().default(""),
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
        const payload = { title, description, ...(extra ?? {}) };
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

function registerUploadDaoMetadata(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_dao_metadata",
    {
      title: "Upload DAO-level metadata JSON to IPFS (Pinata)",
      description:
        "Pins arbitrary DAO metadata JSON (name, description, avatar, links, tags). Returns the CID for use as `descriptionURL` in `deployGovPool`.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().default(""),
        avatar: z.string().optional().describe("Avatar CID or full URL"),
        links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
        tags: z.array(z.string()).optional(),
        extra: z.record(z.unknown()).optional(),
      },
      outputSchema: {
        cid: z.string(),
        size: z.number(),
        pinnedAt: z.string(),
        descriptionURL: z.string(),
      },
    },
    async ({ name, description = "", avatar, links, tags, extra }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const payload: Record<string, unknown> = { name, description };
        if (avatar) payload.avatar = avatar;
        if (links) payload.links = links;
        if (tags) payload.tags = tags;
        if (extra) Object.assign(payload, extra);
        const res = await client.pinJson(payload, { name: `dao:${name.slice(0, 48)}` });
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
              text: `Pinned DAO metadata → ${res.cid} (${res.size} bytes, ${res.pinnedAt})`,
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
