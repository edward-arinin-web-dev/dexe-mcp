import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AVATAR_BYTES, buildAvatarUrl, pinAvatarFromInput, readAvatarInput } from "../../src/lib/avatarUpload.js";
import { renderAvatarJpeg } from "../../src/lib/avatarImage.js";
import type { PinataClient } from "../../src/lib/ipfs.js";

let dir: string;
let jpegPath: string;
let svgPath: string;

const JPEG_BYTES = renderAvatarJpeg("Fixture", 64);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "avatar-upload-"));
  jpegPath = join(dir, "logo.jpeg");
  svgPath = join(dir, "logo.svg");
  await writeFile(jpegPath, JPEG_BYTES);
  await writeFile(svgPath, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readAvatarInput", () => {
  it("reads bytes from a local file path", async () => {
    const bytes = await readAvatarInput({ filePath: jpegPath });
    expect(Buffer.from(bytes).equals(JPEG_BYTES)).toBe(true);
  });

  it("rejects both inputs at once, and neither", async () => {
    await expect(readAvatarInput({ filePath: jpegPath, base64: "aGk=" })).rejects.toThrow(/not both/);
    await expect(readAvatarInput({})).rejects.toThrow(/filePath.*or.*base64/i);
  });

  it("gives an actionable error for a missing file", async () => {
    await expect(readAvatarInput({ filePath: join(dir, "nope.png") })).rejects.toThrow(/Cannot read avatar file/);
  });

  it("enforces the size cap", async () => {
    const bigPath = join(dir, "big.jpeg");
    await writeFile(bigPath, Buffer.alloc(MAX_AVATAR_BYTES + 1, 0xff));
    await expect(readAvatarInput({ filePath: bigPath })).rejects.toThrow(/max 10 MB/);
  });

  it("still accepts base64", async () => {
    const bytes = await readAvatarInput({ base64: JPEG_BYTES.toString("base64") });
    expect(Buffer.from(bytes).equals(JPEG_BYTES)).toBe(true);
  });
});

describe("pinAvatarFromInput", () => {
  const pinFile = vi.fn(async () => ({
    cid: "QmSLwX3b5hpMK57vtaReB35EKog2xxMRskmLicK92L8EAD",
    size: 571,
    pinnedAt: "2026-07-06T00:00:00.000Z",
  }));
  const pinata = { pinFile } as unknown as PinataClient;

  afterEach(() => pinFile.mockClear());

  it("pins a JPEG from filePath and returns the metadata triple", async () => {
    const pinned = await pinAvatarFromInput({ filePath: jpegPath, pinata });
    expect(pinned.detectedFormat).toBe("jpeg");
    expect(pinned.avatarFileName).toBe("avatar.jpeg");
    expect(pinned.avatarCID).toMatch(/^bafy/);
    expect(pinned.avatarUrl).toBe(buildAvatarUrl(pinned.avatarCID, "avatar.jpeg"));
    expect(pinned.byteLength).toBe(JPEG_BYTES.length);
    const [bytes, opts] = pinFile.mock.calls[0]! as unknown as [Uint8Array, { contentType: string; fileName: string }];
    expect(Buffer.from(bytes).equals(JPEG_BYTES)).toBe(true);
    expect(opts.contentType).toBe("image/jpeg");
    expect(opts.fileName).toBe("avatar.jpeg");
  });

  it("rejects an SVG file by path without pinning", async () => {
    await expect(pinAvatarFromInput({ filePath: svgPath, pinata })).rejects.toThrow(/SVG/);
    expect(pinFile).not.toHaveBeenCalled();
  });

  it("normalizes a custom fileName to .jpeg", async () => {
    const pinned = await pinAvatarFromInput({ filePath: jpegPath, fileName: "logo.png", pinata });
    expect(pinned.avatarFileName).toBe("logo.jpeg");
  });
});
