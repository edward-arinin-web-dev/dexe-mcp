/**
 * QR rendering for WalletConnect pairing URIs.
 *
 * `qrcode` is **lazily imported** (mirrors the WalletConnect provider in
 * `walletconnect.ts`) so read-only / EOA installs that never pair pay no cost,
 * and a missing/broken install degrades gracefully to `null` — callers then
 * fall back to the raw `uri` string plus the external QR-image URL.
 */

/** Minimal shape of the bits of the `qrcode` module we use. */
interface QrCodeLike {
  toString(text: string, opts: unknown): Promise<string>;
  toDataURL(text: string, opts: unknown): Promise<string>;
}

export interface RenderedQr {
  /** Scannable ASCII/half-block QR for a monospace terminal, or null. */
  ascii: string | null;
  /** Base64 PNG (no data-URL prefix) for an MCP `image` content block, or null. */
  pngBase64: string | null;
}

let cached: QrCodeLike | null | undefined;

async function loadQrCode(): Promise<QrCodeLike | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("qrcode")) as Record<string, unknown>;
    // ESM/CJS interop: the published package is CJS, so the callable API can
    // hang off `default` depending on the loader.
    const def = mod.default as Record<string, unknown> | undefined;
    const candidate =
      (typeof (mod as { toString?: unknown }).toString === "function" ? (mod as unknown as QrCodeLike) : undefined) ??
      (def && typeof (def as { toString?: unknown }).toString === "function" ? (def as unknown as QrCodeLike) : undefined);
    cached = candidate ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Render `text` (a WalletConnect `wc:` URI) as both a terminal ASCII QR and a
 * base64 PNG. Never throws — any failure yields `{ ascii: null, pngBase64: null }`.
 */
export async function renderQr(text: string): Promise<RenderedQr> {
  const qr = await loadQrCode();
  if (!qr) return { ascii: null, pngBase64: null };

  let ascii: string | null = null;
  let pngBase64: string | null = null;
  try {
    // `small: true` uses half-block glyphs — ~half the rows, fits an 80-col terminal.
    ascii = await qr.toString(text, { type: "terminal", small: true });
  } catch {
    ascii = null;
  }
  try {
    const dataUrl = await qr.toDataURL(text, { margin: 1, errorCorrectionLevel: "M" });
    pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  } catch {
    pngBase64 = null;
  }
  return { ascii, pngBase64 };
}

/** External fallback image URL for clients that can render neither ASCII nor an image block. */
export function qrFallbackUrl(uri: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(uri)}`;
}

/** One MCP `content[]` item — text or image. Kept loose to match the tool call sites. */
type PairingContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Build the MCP `content[]` for a WalletConnect pairing response, shared by
 * `dexe_wc_connect` and `dexe_tx_send`'s auto-pairing branch so the QR + the
 * fallbacks stay identical everywhere.
 *
 *   1. An ASCII QR text block (captioned) — scannable in a bare terminal.
 *   2. An `image/png` block — a crisp QR in GUI MCP clients.
 *   3. A JSON block with `uri`, `chainId`, the external fallback URL, and a
 *      `renderHint` telling the assistant to echo the ASCII block verbatim.
 */
export async function wcPairingContent(
  uri: string,
  chainId: number,
  extra?: Record<string, unknown>,
): Promise<PairingContent[]> {
  const { ascii, pngBase64 } = await renderQr(uri);
  const content: PairingContent[] = [];

  if (ascii) {
    content.push({
      type: "text",
      text: `📱 Scan with your phone wallet (MetaMask / Trust / Rainbow):\n\n${ascii}`,
    });
  }
  if (pngBase64) {
    content.push({ type: "image", data: pngBase64, mimeType: "image/png" });
  }

  content.push({
    type: "text",
    text: JSON.stringify(
      {
        status: "pairing",
        chainId,
        uri,
        qrFallbackUrl: qrFallbackUrl(uri),
        renderHint: ascii
          ? "Echo the ASCII QR block above VERBATIM in a code block so the user can scan it. Do not summarize or redraw it."
          : "QR rendering unavailable — show the user `qrFallbackUrl` to open a scannable image, or `uri` to paste into their wallet.",
        next: "Approve the session on your phone, then poll dexe_wc_status until `connected` is true.",
        ...extra,
      },
      null,
      2,
    ),
  });

  return content;
}
