/**
 * Shared avatar-ingestion helper: one implementation behind
 * `dexe_ipfs_upload_avatar`, `dexe_proposal_create` (modify_dao_profile), and
 * `dexe_dao_create`.
 *
 * Accepts the image either as a local file path (preferred — the server reads
 * the bytes itself, so the agent never round-trips base64 through its context)
 * or as base64. Every path goes through the same magic-byte raster gate before
 * pinning, so an SVG/HTML impostor can't reach IPFS under a `.jpeg` name.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertRasterAvatar, type RasterFormat } from "./imageSniff.js";
import { toCidV1, type PinataClient } from "./ipfs.js";
import { safeErrorMessage } from "./redact.js";

/** Avatars render at ≤512px on app.dexe.io — 10 MB is already generous. */
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/**
 * Subdomain-gateway host used to build the `avatarUrl` field stored inside
 * DAO metadata. Must speak the `<cidV1>.ipfs.<host>/<filename>` schema so the
 * DeXe frontend's `parseAvatarFromIpfsResponse` can round-trip the URL.
 *
 * Default is `dweb.link` — the frontend's historical `4everland.io` fails to
 * discover freshly-pinned CIDs for tens of minutes, during which the backend
 * cache can't fetch the avatar. Configurable via `DEXE_IPFS_AVATAR_GATEWAY`
 * (host, no scheme).
 */
export function avatarSubdomainHost(): string {
  const override = process.env.DEXE_IPFS_AVATAR_GATEWAY?.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return override || "dweb.link";
}

export function buildAvatarUrl(cidV1: string, fileName: string): string {
  return `https://${cidV1}.ipfs.${avatarSubdomainHost()}/${fileName}`;
}

export interface AvatarInput {
  /** Absolute path to a local image file — preferred over base64. */
  filePath?: string;
  /** Base64-encoded image bytes (no data-URL prefix). */
  base64?: string;
}

/** Resolve an avatar input to raw bytes, with actionable errors. */
export async function readAvatarInput({ filePath, base64 }: AvatarInput): Promise<Uint8Array> {
  if (filePath && base64) {
    throw new Error("Pass either `filePath` or `base64`, not both.");
  }
  if (filePath) {
    // Resolve explicitly. A relative path resolves against `process.cwd()`,
    // which for an MCP server is the HOST's working directory (Claude Code's
    // plugin loader starts it wherever it likes — see src/index.ts's
    // cwd-independence rule for .env) and is invisible to the user. On POSIX
    // the ENOENT text then echoes only what they typed, so "Cannot read avatar
    // file at \"avatar.png\"" is unactionable: they check the directory they
    // meant, the file is right there, and nothing says the server looked
    // somewhere else. Neither tool schema requires absoluteness, so a relative
    // path is an invited input, not a user error — it keeps working when it
    // happens to resolve; only the FAILURE gets the diagnosis.
    const resolved = resolve(filePath);
    let buf: Buffer;
    try {
      buf = await readFile(resolved);
    } catch (e) {
      const relativeNote = isAbsolute(filePath)
        ? ""
        : ` The path you passed was RELATIVE, so it resolved against this server's working directory ` +
          `(${process.cwd()}) — the MCP host's directory, not your project's.`;
      throw new Error(
        `Cannot read avatar file at "${resolved}": ${safeErrorMessage(e)}.${relativeNote} ` +
          "Pass an absolute path to an existing image file (JPEG/PNG/WebP/GIF), " +
          "or omit the avatar and generate one with dexe_dao_generate_avatar.",
      );
    }
    if (buf.length === 0) throw new Error(`Avatar file at "${resolved}" is empty.`);
    if (buf.length > MAX_AVATAR_BYTES) {
      throw new Error(
        `Avatar file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — max ${MAX_AVATAR_BYTES / 1024 / 1024} MB. ` +
          "Resize/compress the image first (it renders at 512px or less).",
      );
    }
    return Uint8Array.from(buf);
  }
  if (base64) {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    if (bytes.length === 0) throw new Error("`base64` decoded to zero bytes — check the payload.");
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw new Error(`Avatar is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — max ${MAX_AVATAR_BYTES / 1024 / 1024} MB.`);
    }
    return bytes;
  }
  throw new Error("Provide the avatar image as `filePath` (preferred for local files) or `base64`.");
}

export interface PinnedAvatar {
  avatarCID: string;
  avatarFileName: string;
  avatarUrl: string;
  detectedFormat: RasterFormat;
  /** Pin size reported by Pinata (includes the directory wrapper block). */
  size: number;
  pinnedAt: string;
  /** Actual image byte length that was pinned. */
  byteLength: number;
}

/** What a dryRun preview can honestly say about an avatar: everything but the CID. */
export interface PreviewedAvatar {
  avatarFileName: string;
  detectedFormat: RasterFormat;
  byteLength: number;
}

/**
 * The local half of `pinAvatarFromInput`: read → validate (magic bytes) →
 * normalize the filename. No network.
 *
 * This is what a dryRun runs. Before 0.34.0 a preview skipped the avatar step
 * entirely, so a missing path, an oversized file or an SVG impostor (the bug
 * #34 gate) passed the preview and failed only on the broadcast call — the one
 * call the preview existed to de-risk.
 *
 * It deliberately returns NO CID. Pinata's `pinFile` wraps the image in a
 * directory, so the real `avatarCID` is a dag-pb directory CID whose child is
 * the filename; a locally computed raw-codec CID of the bytes would produce an
 * `avatarUrl` that can never resolve (a raw block has no path children) and
 * would land in `daoMeta`. Omitting it keeps the preview honest.
 */
export async function previewAvatarFromInput(input: AvatarInput & { fileName?: string }): Promise<PreviewedAvatar> {
  const bytes = await readAvatarInput(input);
  const sniffed = assertRasterAvatar(bytes);
  return { avatarFileName: normalizeAvatarFileName(input.fileName), detectedFormat: sniffed.format, byteLength: bytes.length };
}

/** `.jpeg` is the frontend contract — the serving chain keys off that extension. */
function normalizeAvatarFileName(fileName: string | undefined): string {
  const raw = fileName ?? "avatar";
  const base = raw.includes(".") ? raw.substring(0, raw.lastIndexOf(".")) : raw;
  return `${base || "avatar"}.jpeg`;
}

/**
 * Read → validate (magic bytes) → pin → return the
 * `{avatarCID, avatarFileName, avatarUrl}` triple DAO metadata expects.
 * The filename is normalized to `.jpeg` to match the frontend contract
 * (the serving chain keys off that extension); the pinned MIME is the
 * format actually sniffed from the bytes.
 *
 * Shares its read+validate+normalize half with `previewAvatarFromInput`, so a
 * dryRun preview and the real run can never disagree about whether an image is
 * acceptable or what it will be called.
 */
export async function pinAvatarFromInput(
  input: AvatarInput & { fileName?: string; pinata: PinataClient },
): Promise<PinnedAvatar> {
  const bytes = await readAvatarInput(input);
  const sniffed = assertRasterAvatar(bytes);
  const normalized = normalizeAvatarFileName(input.fileName);
  const res = await input.pinata.pinFile(bytes, {
    fileName: normalized,
    contentType: sniffed.mime,
    name: normalized,
  });
  const avatarCID = toCidV1(res.cid);
  return {
    avatarCID,
    avatarFileName: normalized,
    avatarUrl: buildAvatarUrl(avatarCID, normalized),
    detectedFormat: sniffed.format,
    size: res.size,
    pinnedAt: res.pinnedAt,
    byteLength: bytes.length,
  };
}
