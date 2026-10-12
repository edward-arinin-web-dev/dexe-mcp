import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteToolContext } from "./writeContext.js";
import { cidForJson, fetchIpfs, pinataCidForJson, toCidV1, DEFAULT_IPFS_HOP_TIMEOUT_MS } from "../lib/ipfs.js";
import { PinataClient } from "../lib/ipfsPin.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { pinataUploadHint } from "../lib/pinata.js";
import { renderAvatarJpeg } from "../lib/avatarImage.js";
import { assertRasterAvatar, checkAvatarCidBytes } from "../lib/imageSniff.js";
import { buildAvatarUrl, pinAvatarFromInput } from "../lib/avatarUpload.js";
import { redactUrlCredentials, safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/writeErrors.js";
import { ipfsToolError as ipfsReadToolError, NO_GATEWAY_HINT, resolveGateways } from "./ipfsRead.js";
import { readFile } from "node:fs/promises";

/**
 * The write half of the IPFS tools: the Pinata uploads, the generated avatar,
 * the profile re-upload, and the local CID preview for what an upload will
 * return. The fetch / CID-info reads are in ./ipfsRead.ts.
 *
 * Two register functions because the single server lists the IPFS tools in one
 * historical order — the six uploads, then the two reads, then
 * `dexe_ipfs_cid_for_json` — and src/tools/index.ts calls the three in turn.
 */
export function registerIpfsUploadTools(server: McpServer, ctx: WriteToolContext): void {
  const gateways = resolveGateways(ctx);

  registerUploadProposalMetadata(server, ctx);
  registerUploadDaoMetadata(server, ctx);
  registerUploadFile(server, ctx);
  registerUploadAvatar(server, ctx);
  registerGenerateAvatar(server, ctx);
  registerUpdateDaoMetadata(server, ctx, gateways);
}

/** `dexe_ipfs_cid_for_json` — listed after the IPFS reads. */
export function registerIpfsCidForJsonTool(server: McpServer): void {
  registerCidForJson(server);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** The shared IPFS error sink (./ipfsRead.ts), classifying with the write remedy table. */
function ipfsToolError(err: unknown, step: string): string {
  return ipfsReadToolError(err, step, toActionableError);
}

// avatarSubdomainHost/buildAvatarUrl live in ../lib/avatarUpload.ts (shared
// with the proposal_create and dao_create composites).

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
    // Surfaced in the tool text as `prewarm → skipped (<error>)`, so it needs
    // the same redaction as a hard failure.
    return { ok: false, error: safeErrorMessage(err) };
  }
}

function requirePinata(ctx: WriteToolContext): PinataClient | { error: string } {
  if (!ctx.config.pinataJwt) {
    return { error: pinataUploadHint("to upload to IPFS") };
  }
  return new PinataClient(ctx.config.pinataJwt);
}

// ---------- dexe_ipfs_upload_proposal_metadata ----------

function registerUploadProposalMetadata(server: McpServer, ctx: WriteToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_proposal_metadata",
    {
      title: "Upload proposal metadata JSON to IPFS (Pinata)",
      description:
        "Writes to a remote service. Pins `{proposalName, proposalDescription}` to IPFS via Pinata; returns the CID for `descriptionURL` in `GovPool.createProposal`.",
      inputSchema: {
        title: z.string().min(1).describe("Proposal title; becomes `proposalName`."),
        description: z.string().default("").describe(
          "Proposal body; Markdown supported, converted to the Slate format the frontend expects.",
        ),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extra fields merged into the metadata object."),
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
        return errorResult(ipfsToolError(err, "dexe_ipfs_upload_proposal_metadata"));
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
function registerUploadDaoMetadata(server: McpServer, ctx: WriteToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_dao_metadata",
    {
      title: "Upload DAO metadata to IPFS (frontend-compatible nested format)",
      description:
        "Writes to a remote service. Pins DAO metadata in the frontend's nested shape (description pin + outer " +
        "wrapper); returns the outer CID for `descriptionURL` in `deployGovPool`.",
      inputSchema: {
        daoName: z.string().min(1).describe("DAO name (displayed in UI)"),
        description: z.string().default("").describe(
          "DAO description; Markdown supported, converted to the Slate node format the frontend expects.",
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
          .array(
            z.object({
              name: z.string().describe("Document label shown in the UI."),
              url: z.string().describe("Link to the document (http(s) or ipfs://)."),
            }),
          )
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
        let avatarWarning: string | undefined;
        if (avatarCID && avatarFileName) {
          // Normalize to CID v1 base32 — subdomain gateway only resolves v1.
          avatarCidV1 = toCidV1(avatarCID);
          avatarUrl = buildAvatarUrl(avatarCidV1, avatarFileName);
          // By-reference CID: the local byte gate never saw these bytes, so
          // best-effort fetch + sniff. Confirmed non-raster → hard block.
          const check = await checkAvatarCidBytes(avatarCidV1, avatarFileName, resolveGateways(ctx));
          // Both strings embed the gateway URL and the raw fetch failure (see
          // checkAvatarCidBytes' `attempts` list), so they bypass ipfsToolError
          // and need the same scrub — the warning too, since it rides out on
          // the SUCCESS path.
          if (!check.ok) {
            return errorResult(redactUrlCredentials(check.error ?? "avatarCID failed raster validation"));
          }
          avatarWarning = check.warning ? redactUrlCredentials(check.warning) : undefined;
        }

        const outerPayload = {
          avatarUrl,
          avatarCID: avatarCidV1,
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
                (avatarWarning ? `  ⚠ ${avatarWarning}\n` : "") +
                `Use "${metadataRes.cid}" as descriptionURL in deployGovPool.`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(ipfsToolError(err, "dexe_ipfs_upload_dao_metadata"));
      }
    },
  );
}

// ---------- dexe_ipfs_upload_file ----------

function registerUploadFile(server: McpServer, ctx: WriteToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_file",
    {
      title: "Upload raw bytes (avatar, attachment, etc.) to IPFS (Pinata)",
      description:
        "Writes to a remote service. Pins a file to IPFS; PREFER `filePath` over base64. Returns CID v1 (base32) " +
        "+ filename. Images are magic-byte gated to rasters and renamed `.jpeg` unless `normalizeImageExt: false`.",
      inputSchema: {
        filePath: z.string().optional().describe(
          "Absolute path to a local file, max 25 MB — the server reads it. Preferred over base64.",
        ),
        base64: z.string().optional().describe("Base64 file bytes — only when the content isn't a local file."),
        fileName: z.string().default("file").describe("Filename to pin it under, with extension."),
        contentType: z.string().default("application/octet-stream").describe("MIME type of the bytes."),
        normalizeImageExt: z
          .boolean()
          .default(true)
          .describe("If contentType starts with image/, rename the extension to .jpeg."),
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
      filePath,
      base64,
      fileName = "file",
      contentType = "application/octet-stream",
      normalizeImageExt = true,
    }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        if (filePath && base64) return errorResult("Pass either `filePath` or `base64`, not both.");
        if (!filePath && !base64) return errorResult("Provide the file as `filePath` (preferred for local files) or `base64`.");
        let bytes: Uint8Array;
        if (filePath) {
          let buf: Buffer;
          try {
            buf = await readFile(filePath);
          } catch (e) {
            return errorResult(
              `Cannot read file at "${filePath}": ${safeErrorMessage(e)}. Pass an absolute path to an existing file.`,
            );
          }
          const MAX_FILE_BYTES = 25 * 1024 * 1024;
          if (buf.length > MAX_FILE_BYTES) {
            return errorResult(`File is ${(buf.length / 1024 / 1024).toFixed(1)} MB — max 25 MB for this tool.`);
          }
          bytes = Uint8Array.from(buf);
        } else {
          bytes = Uint8Array.from(Buffer.from(base64!, "base64"));
        }
        const isImage = contentType.toLowerCase().startsWith("image/");
        const effectiveFileName =
          normalizeImageExt && isImage
            ? `${fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName}.jpeg`
            : fileName;
        // On the .jpeg-normalized path the file is destined for the DeXe
        // avatar pipeline, so hold the caller to real raster bytes and pin
        // with the sniffed MIME (SVG named .jpeg renders as a permanently
        // broken avatar on app.dexe.io). normalizeImageExt:false is the
        // generic-attachment escape hatch — no rename, no gate.
        const gateAsAvatar = isImage && normalizeImageExt;
        const effectiveContentType = gateAsAvatar ? assertRasterAvatar(bytes).mime : contentType;
        const res = await client.pinFile(bytes, {
          fileName: effectiveFileName,
          contentType: effectiveContentType,
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
        return errorResult(ipfsToolError(err, "dexe_ipfs_upload_file"));
      }
    },
  );
}

// ---------- dexe_ipfs_cid_for_json ----------

function registerCidForJson(server: McpServer): void {
  server.registerTool(
    "dexe_ipfs_cid_for_json",
    {
      title: "Compute a JSON value's IPFS CIDs locally — no network, nothing pinned",
      description:
        "Read-only, local. Hashes a JSON value offline, pinning NOTHING — content stays unfetchable until you " +
        "upload it. `pinataCid` is the dag-pb CIDv0 a real Pinata upload returns: use it wherever a CID goes " +
        "on-chain. `cid` is the json-codec CIDv1.",
      inputSchema: {
        value: z.unknown().optional().describe("Any JSON value to hash locally."),
      },
      outputSchema: {
        cid: z.string(),
        codec: z.string(),
        pinataCid: z.string(),
        pinataCidExact: z.boolean(),
        pinned: z.literal(false),
      },
    },
    async ({ value }) => {
      try {
        const cid = await cidForJson(value);
        const pin = await pinataCidForJson(value);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Pinata-equivalent CID (dag-pb, what an upload returns): ${pin.cid}\n` +
                `CID (json codec, sha-256): ${cid}\n` +
                `Nothing was pinned — these are local hashes.`,
            },
          ],
          structuredContent: { cid, codec: "json", pinataCid: pin.cid, pinataCidExact: pin.exact, pinned: false as const },
        };
      } catch (err) {
        return errorResult(ipfsToolError(err, "dexe_ipfs_cid_for_json"));
      }
    },
  );
}

// ---------- dexe_ipfs_upload_avatar (one-shot composite) ----------

/**
 * Convenience wrapper around `dexe_ipfs_upload_file` that returns the
 * exact triple `dexe_ipfs_upload_dao_metadata` (and `*_modify_dao_profile`)
 * expect: { avatarCID (v1), avatarFileName (.jpeg), avatarUrl }.
 *
 * Single call replaces: pinFile → toV1 → rename → build subdomain URL.
 */
function registerUploadAvatar(server: McpServer, ctx: WriteToolContext): void {
  server.registerTool(
    "dexe_ipfs_upload_avatar",
    {
      title: "Upload a DAO avatar (one-shot: pins + returns avatarCID/avatarFileName/avatarUrl)",
      description:
        "Writes to a remote service. Pins an image, returning {avatarCID, avatarFileName, avatarUrl}. PREFER " +
        "`filePath`; never pass base64 through the conversation. Magic-byte validated (JPEG/PNG/WebP/GIF only — " +
        "SVG/HTML render broken on app.dexe.io); renamed `.jpeg`; CID v1 base32.",
      inputSchema: {
        filePath: z.string().optional().describe(
          "Absolute path to a local image (JPEG/PNG/WebP/GIF, max 10 MB). Preferred over base64.",
        ),
        base64: z.string().optional().describe("Base64 image bytes — only when the image isn't a local file."),
        fileName: z.string().default("avatar").describe("Base filename; extension will be normalized to .jpeg"),
        contentType: z
          .string()
          .default("image/jpeg")
          .describe("Caller-claimed MIME type. Informational only — the pinned MIME comes from byte sniffing."),
      },
      outputSchema: {
        avatarCID: z.string().describe("CID v1 base32 — pass to upload_dao_metadata as avatarCID."),
        avatarFileName: z.string().describe("Filename (always ends with .jpeg)."),
        avatarUrl: z.string().describe("Full subdomain-gateway URL — what the frontend stores verbatim."),
        detectedFormat: z.string().describe("Raster format detected from magic bytes (jpeg|png|webp|gif)."),
        size: z.number(),
        pinnedAt: z.string(),
      },
    },
    async ({ filePath, base64, fileName = "avatar" }) => {
      const client = requirePinata(ctx);
      if ("error" in client) return errorResult(client.error);
      try {
        const pinned = await pinAvatarFromInput({ filePath, base64, fileName, pinata: client });
        const structured = {
          avatarCID: pinned.avatarCID,
          avatarFileName: pinned.avatarFileName,
          avatarUrl: pinned.avatarUrl,
          detectedFormat: pinned.detectedFormat,
          size: pinned.size,
          pinnedAt: pinned.pinnedAt,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Avatar pinned: ${pinned.avatarUrl} (cidV1=${pinned.avatarCID}, ${pinned.byteLength} bytes, detected ${pinned.detectedFormat})`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(ipfsToolError(err, "dexe_ipfs_upload_avatar"));
      }
    },
  );
}

// ---------- dexe_dao_generate_avatar (no external provider) ----------

/**
 * Deterministic placeholder avatar: 1–2 letter initials over a hash-coloured
 * gradient, rasterized to a real JPEG (`renderAvatarJpeg`). Must be raster:
 * the DeXe ipfs-cache service re-serves avatar bytes as hardcoded image/jpeg
 * and browsers refuse SVG bytes under that label (bug #34).
 */
function registerGenerateAvatar(server: McpServer, ctx: WriteToolContext): void {
  server.registerTool(
    "dexe_dao_generate_avatar",
    {
      title: "Generate a deterministic placeholder avatar for a DAO",
      description:
        "Writes to a remote service. Renders a real JPEG of the DAO's initials over a hash-coloured gradient " +
        "and pins it, returning {avatarCID, avatarFileName, avatarUrl}. Deterministic.",
      inputSchema: {
        daoName: z.string().min(1).describe("DAO name; first 1–2 alphanumeric chars become the avatar initials."),
        size: z.number().int().min(64).max(2048).default(512).describe("Output image size in px (square)."),
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
        const bytes = renderAvatarJpeg(daoName, size);
        const fileName = "avatar.jpeg";
        const res = await client.pinFile(bytes, {
          fileName,
          contentType: "image/jpeg",
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
        return errorResult(ipfsToolError(err, "dexe_dao_generate_avatar"));
      }
    },
  );
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
function registerUpdateDaoMetadata(server: McpServer, ctx: WriteToolContext, gateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_update_dao_metadata",
    {
      title: "Fetch DAO metadata, apply partial overrides, re-upload",
      description:
        "Writes to a remote service. Fetches the current DAO metadata from IPFS, applies only `overrides`, " +
        "re-pins the merge (omitted fields kept) and returns the new outer `descriptionURL`.",
      inputSchema: {
        currentDescriptionURL: z
          .string()
          .describe("Current DAO descriptionURL — `ipfs://<cid>` or bare CID. Fetched via the configured IPFS gateway."),
        overrides: z
          .object({
            daoName: z.string().optional().describe("New DAO name (displayed in UI)."),
            websiteUrl: z.string().optional().describe("New DAO website URL."),
            description: z
              .string()
              .optional()
              .describe("Markdown or plain text. If provided, replaces the description content (re-uploaded as its own pin)."),
            avatarCID: z.string().optional().describe("New avatar CID (any version). Pair with avatarFileName to set, or pass empty string to clear."),
            avatarFileName: z.string().optional().describe("New avatar filename with extension, e.g. 'logo.jpeg'."),
            socialLinks: z
              .array(z.tuple([z.string(), z.string()]))
              .optional()
              .describe("Replacement [platform, url] tuples."),
            documents: z
              .array(
                z.object({
                  name: z.string().describe("Document label shown in the UI."),
                  url: z.string().describe("Link to the document (http(s) or ipfs://)."),
                }),
              )
              .optional()
              .describe("Replacement external-document list."),
          })
          .describe("Only the fields you want to change. Anything omitted is kept from the current metadata."),
        timeoutMs: z.number().int().min(500).max(30_000).default(DEFAULT_IPFS_HOP_TIMEOUT_MS).describe("Per-gateway timeout in ms (default 10000)."),
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
    async ({ currentDescriptionURL, overrides, timeoutMs = DEFAULT_IPFS_HOP_TIMEOUT_MS }) => {
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
          // New avatar passed by reference — best-effort fetch + sniff so an
          // SVG/HTML CID can't be wired into the profile (hard block only on
          // confirmed non-raster bytes; unreachable → proceed).
          const check = await checkAvatarCidBytes(avatarCidV1, avatarFileName, gateways);
          // Carries the gateway URL + raw fetch failure — scrub before it is
          // shown (same reason as in dexe_ipfs_upload_dao_metadata).
          if (!check.ok) {
            return errorResult(redactUrlCredentials(check.error ?? "avatarCID failed raster validation"));
          }
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
          avatarCID: avatarCidV1,
          avatarFileName,
          daoName,
          websiteUrl,
          description: descriptionIpfsPath,
          socialLinks,
          documents,
        };
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
        return errorResult(ipfsToolError(err, "dexe_ipfs_update_dao_metadata"));
      }
    },
  );
}
