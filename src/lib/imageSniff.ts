/**
 * Magic-byte sniffing for avatar uploads.
 *
 * The DeXe serving chain is unforgiving about content type: the Go
 * `ipfs-cache` service copies DAO avatar bytes to R2 under `<descCid>.jpeg`
 * with a hardcoded `image/jpeg` content-type and no byte inspection, and the
 * app.dexe.io `<img>` has no error fallback after a successful GET. Raster
 * bytes (JPEG/PNG/WebP/GIF) survive that because browsers content-sniff
 * rasters inside `<img>`; SVG does not — browsers never sniff SVG, so SVG
 * bytes labeled `image/jpeg` render as a broken image. Hence: validate what
 * the caller claims against what the bytes actually are.
 */

export type SniffedImageFormat = "jpeg" | "png" | "webp" | "gif" | "svg" | "html" | "unknown";

export type RasterFormat = Extract<SniffedImageFormat, "jpeg" | "png" | "webp" | "gif">;

const RASTER_MIME: Record<RasterFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Identify an image (or image impostor) by its magic bytes. */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, PNG_SIG)) return "png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "gif";
  }
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  // Text-based impostors: skip BOM + leading whitespace (trimStart strips
  // U+FEFF too — it's spec whitespace), look at the first tag.
  const head = Buffer.from(bytes.slice(0, 512))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "svg";
  if (head.startsWith("<!doctype")) {
    // `<!DOCTYPE svg ...>` is a legal SVG prologue — don't call it HTML.
    return /^<!doctype\s+svg/.test(head) ? "svg" : "html";
  }
  if (head.startsWith("<html")) return "html";
  return "unknown";
}

/**
 * Gate for every avatar upload path. Returns the detected raster format and
 * its true MIME type, or throws an actionable error for anything that would
 * end up as a permanently broken avatar on app.dexe.io.
 */
export function assertRasterAvatar(bytes: Uint8Array): { format: RasterFormat; mime: string } {
  const format = sniffImageFormat(bytes);
  switch (format) {
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
      return { format, mime: RASTER_MIME[format] };
    case "svg":
      throw new Error(
        "Avatar bytes are SVG, which never renders on app.dexe.io: the ipfs-cache service serves DAO avatars " +
          "with a hardcoded image/jpeg content-type and browsers refuse SVG bytes labeled image/jpeg. " +
          "Provide real raster bytes (JPEG/PNG/WebP/GIF), or use dexe_dao_generate_avatar to get a valid JPEG.",
      );
    case "html":
      throw new Error(
        "Avatar bytes look like an HTML page, not an image — most likely a gateway error/directory-listing page " +
          "was downloaded instead of the image file. Re-fetch the image (use the full <cid>/<fileName> path, " +
          "not the bare CID) and upload the actual raster bytes.",
      );
    default:
      throw new Error(
        "Avatar bytes are not a recognized raster image — expected JPEG (FF D8 FF), PNG, WebP, or GIF magic bytes. " +
          "Check that the base64 payload is the image file itself (not a data: URL wrapper or a truncated buffer).",
      );
  }
}

/**
 * Best-effort remote validation for avatar CIDs passed **by reference**
 * (dexe_ipfs_upload_dao_metadata / dexe_ipfs_update_dao_metadata /
 * dexe_dao_create take an avatarCID that was pinned elsewhere, so the local
 * byte gate never saw it). Fetches the first KB of `<cid>/<fileName>` off the
 * gateway chain and sniffs it.
 *
 * Verdicts:
 * - `{ ok: true }`                 — bytes fetched, real raster.
 * - `{ ok: false, error }`         — bytes fetched, NOT a raster → hard-block.
 * - `{ ok: true, warning }`        — unreachable/timeout (fresh pins often
 *   haven't propagated to gateways yet) → proceed, surface the warning.
 */
export async function checkAvatarCidBytes(
  cid: string,
  fileName: string,
  gateways: string[],
  perRequestTimeoutMs = 4000,
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const pinataGatewayToken = process.env.DEXE_PINATA_GATEWAY_TOKEN?.trim();
  for (const gw of gateways.slice(0, 3)) {
    const base = gw.replace(/\/+$/, "").replace(/\/ipfs$/, "");
    const url = `${base}/ipfs/${cid}/${fileName}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), perRequestTimeoutMs);
    try {
      const headers: Record<string, string> = { Range: "bytes=0-1023" };
      let host: string | null = null;
      try {
        host = new URL(base).hostname;
      } catch {
        host = null;
      }
      if (pinataGatewayToken && host && (host === "mypinata.cloud" || host.endsWith(".mypinata.cloud"))) {
        headers["x-pinata-gateway-token"] = pinataGatewayToken;
      }
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) continue;
      const head = new Uint8Array(await res.arrayBuffer());
      try {
        assertRasterAvatar(head);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `avatarCID ${cid}/${fileName} does not contain a usable avatar: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } catch {
      // gateway unreachable/timeout — try the next one
    } finally {
      clearTimeout(t);
    }
  }
  return {
    ok: true,
    warning:
      `avatar bytes at ${cid}/${fileName} were not reachable on any configured gateway (fresh pins can take a while ` +
      `to propagate) — byte validation skipped. If this CID did not come from dexe_ipfs_upload_avatar or ` +
      `dexe_dao_generate_avatar, verify it is a real raster image.`,
  };
}
