import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  cidForBytes,
  cidForJson,
  fetchIpfs,
  parseCid,
  PinataClient,
  toCidV1,
} from "../lib/ipfs.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";

export function registerIpfsTools(server: McpServer, ctx: ToolContext): void {
  const gateways = resolveGateways(ctx);

  registerUploadProposalMetadata(server, ctx);
  registerUploadDaoMetadata(server, ctx);
  registerUploadFile(server, ctx);
  registerUploadAvatar(server, ctx);
  registerGenerateAvatar(server, ctx);
  registerUpdateDaoMetadata(server, ctx, gateways);
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
/**
 * Path-style gateway base URL used to build the `avatarUrl` field stored in
 * DAO metadata. Must produce `<base>/ipfs/<cid>/<filename>` because the
 * DeXe `ipfs-cache.dexe.io` backend reads this field server-side to pull
 * the avatar binary, and it only resolves path-form URLs (subdomain-form
 * URLs like `<cid>.ipfs.<host>/<file>` silently fail server-side fetching,
 * so the cache never populates `<descCID>.jpeg` and the frontend renders
 * a blank avatar). Matches the format DeXe Protocol DAO uses
 * (`https://ipfs.io/ipfs/Qm…/dexe11.jpeg`).
 *
 * Configurable via `DEXE_IPFS_AVATAR_GATEWAY` (full URL or host).
 */
function avatarGatewayBase(): string {
  const raw = process.env.DEXE_IPFS_AVATAR_GATEWAY?.trim();
  if (!raw) return "https://ipfs.io";
  const stripped = raw.replace(/\/$/, "");
  if (/^https?:\/\//i.test(stripped)) return stripped;
  return `https://${stripped}`;
}

function buildAvatarUrl(cidV1: string, fileName: string): string {
  return `${avatarGatewayBase()}/ipfs/${cidV1}/${fileName}`;
}

/**
 * Best-effort POST to the DeXe IPFS cache service so the next reader hit on
 * `https://ipfs-cache.dexe.io/<cid>.json|.jpeg` serves cached bytes instead
 * of 404. The frontend's modify-profile flow does this automatically; the
 * MCP path didn't, which is why agents who landed a `editDescriptionURL`
 * proposal saw their new avatar fail to render on app.dexe.io even though
 * the on-chain pointer was correct.
 *
 * Never throws; returns the warmed CID(s) on success.
 */
async function warmDexeIpfsCache(cidV0: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const body = JSON.stringify({ data: { attributes: { link: cidV0 } } });
    const r = await fetch("https://api.dexe.io/integrations/ipfs-cache-svc/public/pool-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveGateways(_ctx: ToolContext): string[] {
  const out: string[] = [];
  const normalize = (raw: string): string => {
    const trimmed = raw.trim().replace(/\/$/, "");
    if (!trimmed) return "";
    // Allow operators to set DEXE_IPFS_GATEWAY=<host> without a scheme — fetch()
    // refuses such URLs with "Failed to parse URL", which masquerades as an
    // IPFS outage. Default to https since every realistic gateway requires it.
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };
  const primary = process.env.DEXE_IPFS_GATEWAY;
  if (primary) {
    const p = normalize(primary);
    if (p) out.push(p);
  }
  const fallback = process.env.DEXE_IPFS_GATEWAYS_FALLBACK;
  if (fallback) {
    for (const g of fallback.split(",").map(normalize)) {
      if (g && !out.includes(g)) out.push(g);
    }
  }
  // Auto-fallback: if the primary is a Pinata dedicated gateway AND no
  // gateway key is configured, anonymous reads return 403 and tools like
  // dexe_ipfs_update_dao_metadata hang. Append `https://ipfs.io` as a
  // last-resort public reader so flows keep working out of the box.
  // Opt-out via DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1.
  const disablePublic = process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK === "1";
  const usesRestrictedPinata = out.some((g) => /\.mypinata\.cloud(\/|$)/i.test(g));
  const haveGatewayKey = !!process.env.DEXE_PINATA_GATEWAY_TOKEN?.trim();
  if (!disablePublic && usesRestrictedPinata && !haveGatewayKey) {
    const publicFallback = "https://ipfs.io";
    if (!out.includes(publicFallback)) out.push(publicFallback);
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
 *   avatarUrl: "https://<cidV1>.ipfs.<host>/<filename>" | "",
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
        let avatarCidV1: string | undefined;
        if (avatarCID && avatarFileName) {
          // Normalize to CID v1 base32 — subdomain gateway only resolves v1.
          avatarCidV1 = toCidV1(avatarCID);
          avatarUrl = buildAvatarUrl(avatarCidV1, avatarFileName);
        }

        // Match the schema shape DeXe Protocol DAO (and every other working
        // production DAO) pins: only `avatarUrl` lives in the outer
        // metadata. Including `avatarCID` / `avatarFileName` here makes
        // `ipfs-cache.dexe.io` skip its own server-side fetch of the
        // avatar binary, so `<descCid>.jpeg` never populates and the
        // frontend renders a jazzicon fallback.
        const outerPayload = {
          avatarUrl,
          daoName,
          websiteUrl,
          description: descriptionIpfsPath,
          socialLinks: socialLinks ?? [],
          documents: documents ?? [],
        };
        void avatarCidV1;

        // Step 3: Upload the outer metadata wrapper
        const metadataRes = await client.pinJson(outerPayload, {
          name: `dao:${daoName.slice(0, 48)}`,
        });

        // Step 4: Prewarm the DeXe IPFS cache so app.dexe.io renders the new
        // metadata + avatar immediately. Best-effort; never fails the call.
        const warmed = await warmDexeIpfsCache(metadataRes.cid);

        const structured = {
          cid: metadataRes.cid,
          descriptionCid: descriptionRes.cid,
          size: metadataRes.size,
          pinnedAt: metadataRes.pinnedAt,
          descriptionURL: metadataRes.cid,
          cachePrewarmed: warmed.ok,
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Pinned DAO metadata (frontend-compatible):\n` +
                `  description content → ${descriptionRes.cid}\n` +
                `  outer metadata      → ${metadataRes.cid} (${metadataRes.size} bytes)\n` +
                `  ipfs-cache.dexe.io prewarm → ${warmed.ok ? "ok" : `skipped (${warmed.status ?? warmed.error})`}\n` +
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
        "Pins a file to IPFS. Accepts base64-encoded bytes; returns the CID v1 (base32) and the (possibly normalized) filename. " +
        "For images (contentType: image/*) the filename extension is normalized to `.jpeg` to match what the DeXe frontend stores — " +
        "this is what `dexe_ipfs_upload_dao_metadata` and the DAO profile reader expect. Set `normalizeImageExt: false` to opt out.",
      inputSchema: {
        base64: z.string().min(1).describe("Base64-encoded file bytes"),
        fileName: z.string().default("file"),
        contentType: z.string().default("application/octet-stream"),
        normalizeImageExt: z
          .boolean()
          .default(true)
          .describe("If true and contentType starts with image/, rename the file extension to .jpeg."),
      },
      outputSchema: {
        cid: z.string().describe("CID v1 base32 — use this as avatarCID."),
        cidV0: z.string().describe("Original CID returned by Pinata (usually v0 Qm...). Kept for legacy callers."),
        fileName: z.string().describe("Filename actually pinned (possibly normalized to .jpeg)."),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({
      base64,
      fileName = "file",
      contentType = "application/octet-stream",
      normalizeImageExt = true,
    }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const isImage = contentType.toLowerCase().startsWith("image/");
        const effectiveFileName =
          normalizeImageExt && isImage
            ? `${fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName}.jpeg`
            : fileName;
        const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
        const res = await client.pinFile(bytes, {
          fileName: effectiveFileName,
          contentType,
          name: effectiveFileName,
        });
        const cidV1 = toCidV1(res.cid);
        const structured = {
          cid: cidV1,
          cidV0: res.cid,
          fileName: effectiveFileName,
          size: res.size,
          pinnedAt: res.pinnedAt,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Pinned ${effectiveFileName} (${bytes.length} bytes) → ${cidV1} (v0=${res.cid}, size on IPFS=${res.size})`,
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
          ? gateways.map((g) => `${g.replace(/\/+$/, "").replace(/\/ipfs$/, "")}/ipfs/${info.cid}`)
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

// ---------- dexe_ipfs_upload_avatar (one-shot composite) ----------

/**
 * Convenience wrapper around `dexe_ipfs_upload_file` that returns the
 * exact triple `dexe_ipfs_upload_dao_metadata` (and `*_modify_dao_profile`)
 * expect: { avatarCID (v1), avatarFileName (.jpeg), avatarUrl }.
 *
 * Single call replaces: pinFile → toV1 → rename → build subdomain URL.
 */
function registerUploadAvatar(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_avatar",
    {
      title: "Upload a DAO avatar (one-shot: pins + returns avatarCID/avatarFileName/avatarUrl)",
      description:
        "Uploads an image and returns the {avatarCID, avatarFileName, avatarUrl} triple ready to feed into `dexe_ipfs_upload_dao_metadata` " +
        "(for DAO creation) or `dexe_proposal_build_modify_dao_profile` (for profile updates). " +
        "Normalizes the filename to `.jpeg` (matching the frontend) and returns a CID v1 base32 string that resolves on the subdomain gateway.",
      inputSchema: {
        base64: z.string().min(1).describe("Base64-encoded image bytes"),
        fileName: z.string().default("avatar").describe("Base filename; extension will be normalized to .jpeg"),
        contentType: z
          .string()
          .default("image/jpeg")
          .describe("MIME type; must start with image/. Defaults to image/jpeg."),
      },
      outputSchema: {
        avatarCID: z.string().describe("CID v1 base32 — pass to upload_dao_metadata as avatarCID."),
        avatarFileName: z.string().describe("Filename (always ends with .jpeg)."),
        avatarUrl: z.string().describe("Full subdomain-gateway URL — what the frontend stores verbatim."),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({ base64, fileName = "avatar", contentType = "image/jpeg" }) => {
      if (!contentType.toLowerCase().startsWith("image/")) {
        return errorResult(`contentType must be image/* (got: ${contentType})`);
      }
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const base = fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName;
        const normalized = `${base || "avatar"}.jpeg`;
        const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
        const res = await client.pinFile(bytes, {
          fileName: normalized,
          contentType,
          name: normalized,
        });
        const avatarCID = toCidV1(res.cid);
        const avatarUrl = buildAvatarUrl(avatarCID, normalized);
        const structured = {
          avatarCID,
          avatarFileName: normalized,
          avatarUrl,
          size: res.size,
          pinnedAt: res.pinnedAt,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Avatar pinned: ${avatarUrl} (cidV1=${avatarCID}, ${bytes.length} bytes)`,
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

// ---------- dexe_dao_generate_avatar (no external provider) ----------

/**
 * Deterministic placeholder avatar: 1–2 letter initials over a hash-coloured
 * gradient. Pure SVG → uploaded as image/svg+xml then served via the same
 * subdomain gateway frontend uses. No third-party generator required.
 */
function registerGenerateAvatar(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_dao_generate_avatar",
    {
      title: "Generate a deterministic placeholder avatar for a DAO",
      description:
        "Builds an SVG avatar with the DAO's initials over a hash-coloured gradient (no external generator) and pins it to IPFS. " +
        "Returns the same {avatarCID, avatarFileName, avatarUrl} shape as `dexe_ipfs_upload_avatar`, " +
        "ready to feed into `dexe_ipfs_upload_dao_metadata` or `dexe_proposal_build_modify_dao_profile`. " +
        "Same input always produces the same colours (great for re-deploys).",
      inputSchema: {
        daoName: z.string().min(1).describe("DAO name; first 1–2 alphanumeric chars become the avatar initials."),
        size: z.number().int().min(64).max(2048).default(512).describe("SVG viewBox size (square)."),
      },
      outputSchema: {
        avatarCID: z.string(),
        avatarFileName: z.string(),
        avatarUrl: z.string(),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({ daoName, size = 512 }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const svg = buildIdenticonSvg(daoName, size);
        const bytes = Buffer.from(svg, "utf8");
        // Frontend reader looks for an extension; we keep .jpeg to stay
        // consistent with what `dexe_ipfs_upload_avatar` returns even though
        // the bytes themselves are SVG. The subdomain gateway serves it by
        // CID; content negotiation handles the type.
        const fileName = "avatar.jpeg";
        const res = await client.pinFile(bytes, {
          fileName,
          contentType: "image/svg+xml",
          name: fileName,
        });
        const avatarCID = toCidV1(res.cid);
        const avatarUrl = buildAvatarUrl(avatarCID, fileName);
        const structured = {
          avatarCID,
          avatarFileName: fileName,
          avatarUrl,
          size: res.size,
          pinnedAt: res.pinnedAt,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Generated avatar for "${daoName}" → ${avatarUrl}`,
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

/** djb2-style hash → unsigned 32-bit. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function buildIdenticonSvg(daoName: string, size: number): string {
  const cleaned = daoName.replace(/[^\p{L}\p{N}]/gu, "");
  const initials = (cleaned.slice(0, 2) || "?").toUpperCase();
  const h = hashString(daoName);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >>> 8) % 80)) % 360;
  const c1 = `hsl(${hue1} 70% 55%)`;
  const c2 = `hsl(${hue2} 70% 35%)`;
  const fontSize = Math.round(size * 0.46);
  // Plain SVG — no <foreignObject>, no JS. Safe to pin and serve via subdomain gateway.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n  <defs>\n    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0%" stop-color="${c1}"/>\n      <stop offset="100%" stop-color="${c2}"/>\n    </linearGradient>\n  </defs>\n  <rect width="100%" height="100%" fill="url(#g)"/>\n  <text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="white">${initials}</text>\n</svg>\n`;
}

// ---------- dexe_ipfs_update_dao_metadata (fetch + merge + re-upload) ----------

/**
 * Smart helper for "Modify DAO Profile" proposals. Fetches the DAO's existing
 * metadata JSON, applies user-supplied partial overrides, re-pins the result.
 *
 * Returns the new outer CID so callers can feed it into
 * `dexe_proposal_build_modify_dao_profile` as `newDescriptionURL`.
 *
 * Without this tool, callers had to re-specify every unchanged field
 * (daoName, websiteUrl, socialLinks, …) on every edit, and any forgotten
 * field would silently disappear from the profile.
 */
function registerUpdateDaoMetadata(server: McpServer, ctx: ToolContext, gateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_update_dao_metadata",
    {
      title: "Fetch DAO metadata, apply partial overrides, re-upload",
      description:
        "Reads the existing DAO metadata JSON from IPFS via the configured gateway, applies only the fields you pass in `overrides`, " +
        "and re-pins the merged result. Returns the new outer `descriptionURL` ready for `dexe_proposal_build_modify_dao_profile`. " +
        "Unspecified fields are preserved verbatim (so you can change just the avatar without re-typing the website or social links).",
      inputSchema: {
        currentDescriptionURL: z
          .string()
          .describe("Current DAO descriptionURL — `ipfs://<cid>` or bare CID. Fetched via the configured IPFS gateway."),
        overrides: z
          .object({
            daoName: z.string().optional(),
            websiteUrl: z.string().optional(),
            description: z
              .string()
              .optional()
              .describe("Markdown or plain text. If provided, replaces the description content (re-uploaded as its own pin)."),
            avatarCID: z.string().optional().describe("New avatar CID (any version). Pair with avatarFileName to set, or pass empty string to clear."),
            avatarFileName: z.string().optional(),
            socialLinks: z.array(z.tuple([z.string(), z.string()])).optional(),
            documents: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
          })
          .describe("Only the fields you want to change. Anything omitted is kept from the current metadata."),
        timeoutMs: z.number().int().min(500).max(30_000).default(6000),
      },
      outputSchema: {
        descriptionURL: z.string().describe("New outer CID — pass to dexe_proposal_build_modify_dao_profile.newDescriptionURL."),
        previousDescriptionURL: z.string(),
        cid: z.string(),
        descriptionCid: z.string().optional(),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({ currentDescriptionURL, overrides, timeoutMs = 6000 }) => {
      if (gateways.length === 0) return errorResult(NO_GATEWAY_HINT);
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const fetched = await fetchIpfs(currentDescriptionURL, {
          gateways,
          perRequestTimeoutMs: timeoutMs,
        });
        if (!fetched.json || typeof fetched.json !== "object") {
          return errorResult(
            `Current descriptionURL did not resolve to JSON metadata (content-type=${fetched.contentType}). ` +
              `Got ${fetched.bytes.length} bytes from ${fetched.gateway}.`,
          );
        }
        const current = fetched.json as Record<string, unknown>;

        // Per-field merge, with explicit semantics for the trickier ones.
        const daoName =
          typeof overrides.daoName === "string" ? overrides.daoName : (current.daoName as string) ?? "";
        const websiteUrl =
          typeof overrides.websiteUrl === "string" ? overrides.websiteUrl : (current.websiteUrl as string) ?? "";
        const socialLinks =
          overrides.socialLinks ?? ((current.socialLinks as [string, string][]) ?? []);
        const documents =
          overrides.documents ?? ((current.documents as { name: string; url: string }[]) ?? []);

        // Avatar: empty-string avatarCID means "clear". Otherwise normalize to v1.
        let avatarUrl = "";
        let avatarCidV1: string | undefined;
        let avatarFileName = "";
        if (overrides.avatarCID === undefined && overrides.avatarFileName === undefined) {
          // Unchanged — copy avatarCID + filename from current, but rebuild
          // avatarUrl with the configured gateway. Carrying the old URL
          // verbatim leaves stale 4everland references in DAOs that have
          // only had a name/website update; the cache backend then fails
          // to fetch the avatar binary and serves a 404 for `<cid>.jpeg`.
          const currCID = (current.avatarCID as string) || "";
          const currFile = (current.avatarFileName as string) || "";
          if (currCID && currFile) {
            avatarCidV1 = toCidV1(currCID);
            avatarFileName = currFile;
            avatarUrl = buildAvatarUrl(avatarCidV1, avatarFileName);
          } else {
            avatarUrl = (current.avatarUrl as string) ?? "";
            avatarCidV1 = currCID || undefined;
            avatarFileName = currFile;
          }
        } else if (overrides.avatarCID && overrides.avatarFileName) {
          avatarCidV1 = toCidV1(overrides.avatarCID);
          avatarFileName = overrides.avatarFileName;
          avatarUrl = buildAvatarUrl(avatarCidV1, avatarFileName);
        } else if (overrides.avatarCID === "") {
          // Explicit clear.
          avatarUrl = "";
          avatarCidV1 = undefined;
          avatarFileName = "";
        } else {
          return errorResult(
            "Avatar overrides require BOTH avatarCID and avatarFileName (or empty string for avatarCID to clear).",
          );
        }

        // Description: re-upload only if changed.
        let descriptionIpfsPath: string;
        let descriptionCid: string | undefined;
        if (typeof overrides.description === "string") {
          const payload = markdownToSlate(overrides.description);
          const descRes = await client.pinJson(payload, {
            name: `dao-desc:${daoName.slice(0, 40)}`,
          });
          descriptionIpfsPath = `ipfs://${descRes.cid}`;
          descriptionCid = descRes.cid;
        } else {
          descriptionIpfsPath = (current.description as string) ?? "";
        }

        const outerPayload = {
          avatarUrl,
          daoName,
          websiteUrl,
          description: descriptionIpfsPath,
          socialLinks,
          documents,
        };
        void avatarCidV1;
        void avatarFileName;
        const metadataRes = await client.pinJson(outerPayload, {
          name: `dao:${daoName.slice(0, 48)}`,
        });

        // Prewarm DeXe ipfs-cache so app.dexe.io renders the new metadata
        // immediately after the modify-profile proposal executes.
        const warmed = await warmDexeIpfsCache(metadataRes.cid);

        const structured = {
          descriptionURL: metadataRes.cid,
          previousDescriptionURL: fetched.cid,
          cid: metadataRes.cid,
          descriptionCid,
          size: metadataRes.size,
          pinnedAt: metadataRes.pinnedAt,
          cachePrewarmed: warmed.ok,
        };
        const changed = Object.keys(overrides).filter((k) => (overrides as Record<string, unknown>)[k] !== undefined);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Updated DAO metadata (${changed.length ? changed.join(", ") : "no changes"}):\n` +
                `  previous → ${fetched.cid}\n` +
                `  new      → ${metadataRes.cid}\n` +
                `  ipfs-cache.dexe.io prewarm → ${warmed.ok ? "ok" : `skipped (${warmed.status ?? warmed.error})`}\n` +
                `Pass "${metadataRes.cid}" to dexe_proposal_build_modify_dao_profile.newDescriptionURL.`,
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
