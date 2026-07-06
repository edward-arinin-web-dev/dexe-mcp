import { describe, expect, it } from "vitest";
import { renderQr, wcPairingContent, wcQrBlocks, qrFallbackUrl } from "../../src/lib/qr.js";
import { attachPairingQr } from "../../src/tools/flow.js";

const SAMPLE_URI =
  "wc:7f6e2a1b3c4d5e6f@2?relay-protocol=irn&symKey=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("renderQr", () => {
  it("renders both an ASCII QR and a base64 PNG for a WalletConnect URI", async () => {
    const { ascii, pngBase64 } = await renderQr(SAMPLE_URI);
    expect(ascii).toBeTruthy();
    // half-block glyphs used by `type: terminal, small: true`
    expect(ascii!).toMatch(/[█▀▄ ]/u);
    expect(pngBase64).toBeTruthy();
    // no data-URL prefix should remain
    expect(pngBase64!.startsWith("data:")).toBe(false);
    // valid-looking base64 PNG (starts with the PNG magic `iVBORw0KGgo`)
    expect(pngBase64!.startsWith("iVBORw0KGgo")).toBe(true);
  });
});

describe("qrFallbackUrl", () => {
  it("URL-encodes the uri into the external QR image service", () => {
    const url = qrFallbackUrl(SAMPLE_URI);
    expect(url).toContain("api.qrserver.com");
    expect(url).toContain(encodeURIComponent(SAMPLE_URI));
  });
});

describe("wcPairingContent", () => {
  it("builds an ASCII text block, a PNG image block, and a JSON block with fallbacks", async () => {
    const content = await wcPairingContent(SAMPLE_URI, 97, { keyPrecedenceNote: "note" });

    const textBlocks = content.filter((c) => c.type === "text") as { type: "text"; text: string }[];
    const imageBlocks = content.filter((c) => c.type === "image") as {
      type: "image";
      data: string;
      mimeType: string;
    }[];

    // 1. scannable ASCII QR, captioned
    expect(textBlocks.some((t) => t.text.includes("📱 Scan with your phone wallet"))).toBe(true);

    // 2. crisp PNG for GUI clients
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]!.mimeType).toBe("image/png");
    expect(imageBlocks[0]!.data.length).toBeGreaterThan(100);

    // 3. JSON block carries uri, chainId, external fallback, renderHint + extras
    const json = JSON.parse(textBlocks[textBlocks.length - 1]!.text) as Record<string, unknown>;
    expect(json).toMatchObject({
      status: "pairing",
      chainId: 97,
      uri: SAMPLE_URI,
      keyPrecedenceNote: "note",
    });
    expect(json.qrFallbackUrl).toContain("api.qrserver.com");
    expect(String(json.renderHint)).toMatch(/verbatim/i);
  });
});

describe("wcQrBlocks", () => {
  it("returns just the scannable blocks (ASCII caption + PNG image), no JSON envelope", async () => {
    const blocks = await wcQrBlocks(SAMPLE_URI);
    expect(blocks).toHaveLength(2);
    const text = blocks.find((b) => b.type === "text") as { type: "text"; text: string };
    const image = blocks.find((b) => b.type === "image") as { type: "image"; data: string; mimeType: string };
    expect(text.text).toContain("📱 Scan with your phone wallet");
    expect(image.mimeType).toBe("image/png");
    expect(image.data.startsWith("iVBORw0KGgo")).toBe(true);
    // no block should parse as the pairing JSON envelope
    expect(blocks.some((b) => b.type === "text" && b.text.trimStart().startsWith("{"))).toBe(false);
  });
});

describe("attachPairingQr (composite no-signer responses)", () => {
  const jsonRes = { content: [{ type: "text" as const, text: '{"mode":"payloads"}' }] };

  it("prepends the QR blocks so the image renders before the JSON body", async () => {
    const blocks = await wcQrBlocks(SAMPLE_URI);
    const res = attachPairingQr(jsonRes, blocks);
    expect(res.content).toHaveLength(jsonRes.content.length + blocks.length);
    expect(res.content[0]).toBe(blocks[0]);
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    const last = res.content[res.content.length - 1] as { type: "text"; text: string };
    expect(last.text).toBe('{"mode":"payloads"}');
  });

  it("is a no-op when there is nothing to attach", () => {
    expect(attachPairingQr(jsonRes, undefined)).toBe(jsonRes);
    expect(attachPairingQr(jsonRes, [])).toBe(jsonRes);
  });
});
