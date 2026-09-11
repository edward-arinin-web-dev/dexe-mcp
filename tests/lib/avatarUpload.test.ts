import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_AVATAR_BYTES,
  buildAvatarUrl,
  pinAvatarFromInput,
  previewAvatarFromInput,
  readAvatarInput,
} from "../../src/lib/avatarUpload.js";
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

/**
 * The preview half, split out in 0.34.0 so a dryRun can validate an avatar
 * without publishing it. It returns NO CID on purpose: Pinata's `pinFile` wraps
 * the image in a directory, so the real `avatarCID` is a dag-pb directory CID —
 * a locally derived raw-codec CID would produce an `avatarUrl` that can never
 * resolve (a raw block has no path children), and that string lands in DAO
 * metadata and gets echoed to users as a link.
 */
describe("previewAvatarFromInput", () => {
  const pinFile = vi.fn(async () => {
    throw new Error("a preview must never pin");
  });
  const pinata = { pinFile } as unknown as PinataClient;

  afterEach(() => pinFile.mockClear());

  it("validates and normalizes without touching the network", async () => {
    const p = await previewAvatarFromInput({ filePath: jpegPath });
    expect(p.detectedFormat).toBe("jpeg");
    expect(p.avatarFileName).toBe("avatar.jpeg");
    expect(p.byteLength).toBe(JPEG_BYTES.length);
    expect(pinFile).not.toHaveBeenCalled();
    expect(p).not.toHaveProperty("avatarCID");
  });

  it("normalizes a custom fileName exactly like the pinning path", async () => {
    const preview = await previewAvatarFromInput({ filePath: jpegPath, fileName: "logo.png" });
    expect(preview.avatarFileName).toBe("logo.jpeg");
  });

  it("still rejects an SVG — the whole point of running it in the preview", async () => {
    await expect(previewAvatarFromInput({ filePath: svgPath })).rejects.toThrow(/SVG/);
  });

  it("still rejects a path that does not exist", async () => {
    await expect(previewAvatarFromInput({ filePath: join(dir, "missing.jpeg") })).rejects.toThrow(
      /Cannot read avatar file/,
    );
  });

  it("agrees with pinAvatarFromInput on the filename, so daoMeta cannot drift", async () => {
    const okPin = vi.fn(async () => ({ cid: "QmSLwX3b5hpMK57vtaReB35EKog2xxMRskmLicK92L8EAD", size: 1, pinnedAt: "x" }));
    const real = await pinAvatarFromInput({
      filePath: jpegPath,
      fileName: "brand.webp",
      pinata: { pinFile: okPin } as unknown as PinataClient,
    });
    const preview = await previewAvatarFromInput({ filePath: jpegPath, fileName: "brand.webp" });
    expect(preview.avatarFileName).toBe(real.avatarFileName);
    expect(preview.detectedFormat).toBe(real.detectedFormat);
    expect(pinata).toBeDefined();
  });
});

describe("a relative avatar path says WHERE the server looked, and why", () => {
  /**
   * D12-12. Neither tool schema requires an absolute path ("Local avatar image
   * path", "Local image path for the new avatar"), so a relative one is an
   * invited input. It resolves against `process.cwd()`, which for an MCP server
   * is the HOST's directory — Claude Code's plugin loader starts it wherever it
   * likes, which is the same surprise that once broke .env loading. On POSIX
   * the error then echoed only what the user typed, so they checked the
   * directory they meant, found the file there, and had nothing to go on.
   */

  it("reports the RESOLVED absolute path, not the bare input", async () => {
    const err = await readAvatarInput({ filePath: "definitely-not-here.png" }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain(resolve("definitely-not-here.png"));
  });

  it("explains that a relative path resolved against the host's cwd", async () => {
    // The primary assertion: this is the half that is missing on EVERY
    // platform (Node already puts the absolute path in ENOENT on win32).
    const err = await readAvatarInput({ filePath: "definitely-not-here.png" }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/RELATIVE/);
    expect(err.message).toContain(process.cwd());
  });

  it("adds no such note for an absolute path", async () => {
    const err = await readAvatarInput({ filePath: join(dir, "nope.png") }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toMatch(/RELATIVE/);
  });

  it("points at the no-file escape hatch", async () => {
    const err = await readAvatarInput({ filePath: join(dir, "nope.png") }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("dexe_dao_generate_avatar");
  });

  it("an empty file is reported at its resolved path too", async () => {
    const emptyPath = join(dir, "empty.jpeg");
    await writeFile(emptyPath, Buffer.alloc(0));
    const err = await readAvatarInput({ filePath: emptyPath }).catch((e: unknown) => e as Error);
    expect(err.message).toContain(resolve(emptyPath));
  });

  it("a path that DOES resolve still works — resolve() is the identity on an absolute one", async () => {
    const bytes = await readAvatarInput({ filePath: jpegPath });
    expect(Buffer.from(bytes).equals(JPEG_BYTES)).toBe(true);
  });
});
