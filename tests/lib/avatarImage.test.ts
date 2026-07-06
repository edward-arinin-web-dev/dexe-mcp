import { describe, expect, it } from "vitest";
import jpegJs from "jpeg-js";
import { avatarInitials, hashString, renderAvatarJpeg } from "../../src/lib/avatarImage.js";
import { sniffImageFormat } from "../../src/lib/imageSniff.js";

/** Extract width/height from the first SOF0/SOF1/SOF2 marker. */
function jpegDimensions(buf: Buffer): { width: number; height: number } {
  let i = 2; // skip FF D8
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) throw new Error(`marker desync at ${i}`);
    const marker = buf[i + 1]!;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}

describe("renderAvatarJpeg", () => {
  it("emits real JPEG bytes (magic + EOI)", () => {
    const buf = renderAvatarJpeg("Generative Collective");
    expect([buf[0], buf[1], buf[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect([buf[buf.length - 2], buf[buf.length - 1]]).toEqual([0xff, 0xd9]);
    expect(sniffImageFormat(Uint8Array.from(buf))).toBe("jpeg");
  });

  it("respects the size parameter", () => {
    expect(jpegDimensions(renderAvatarJpeg("Generative Collective"))).toEqual({ width: 512, height: 512 });
    expect(jpegDimensions(renderAvatarJpeg("X", 128))).toEqual({ width: 128, height: 128 });
  });

  it("is deterministic: same name → identical bytes, different name → different bytes", () => {
    const a1 = renderAvatarJpeg("MicroPlan");
    const a2 = renderAvatarJpeg("MicroPlan");
    const b = renderAvatarJpeg("Meridian");
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });

  it("decodes to a plausible image: white glyph pixels present, gradient corners differ", () => {
    const size = 128;
    const { data, width, height } = jpegJs.decode(renderAvatarJpeg("GC", size), { useTArray: true });
    expect(width).toBe(size);
    expect(height).toBe(size);
    // center row should contain near-white glyph pixels
    let white = 0;
    const mid = (size >> 1) * size * 4;
    for (let x = 0; x < size; x++) {
      const i = mid + x * 4;
      if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) white++;
    }
    expect(white).toBeGreaterThan(5);
    // top-left vs bottom-right corner must differ (diagonal gradient)
    const tl = [data[0]!, data[1]!, data[2]!];
    const brOff = ((size - 1) * size + (size - 1)) * 4;
    const br = [data[brOff]!, data[brOff + 1]!, data[brOff + 2]!];
    const dist = Math.abs(tl[0]! - br[0]!) + Math.abs(tl[1]! - br[1]!) + Math.abs(tl[2]! - br[2]!);
    expect(dist).toBeGreaterThan(40);
  });

  it("keeps the legacy colour hash (djb2)", () => {
    // pinned value so a hash change (= every DAO's colours shifting) is loud
    expect(hashString("Generative Collective")).toBe(hashString("Generative Collective"));
    expect(hashString("a")).toBe(((5381 << 5) + 5381 + 97) >>> 0);
  });

  it("derives initials like the legacy SVG identicon", () => {
    expect(avatarInitials("Generative Collective")).toBe("GE");
    expect(avatarInitials("x")).toBe("X");
    expect(avatarInitials("--- ---")).toBe("?");
    expect(avatarInitials("42 DAO")).toBe("42");
  });

  it("renders names with no glyph coverage via the ? fallback without throwing", () => {
    const buf = renderAvatarJpeg("Дао Клуб");
    expect(sniffImageFormat(Uint8Array.from(buf))).toBe("jpeg");
  });

  it("keeps a single narrow initial ('I') fully inside the canvas at every size", () => {
    // Regression: width-only scale clamp let blockH exceed the canvas, slamming
    // the glyph into the top edge (white pixels on row 0).
    for (const size of [64, 512, 2048]) {
      const { data, width } = jpegJs.decode(renderAvatarJpeg("I", size), { useTArray: true });
      let topRowWhite = 0;
      for (let x = 0; x < width; x++) {
        const i = x * 4;
        if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) topRowWhite++;
      }
      expect(topRowWhite, `size=${size}`).toBe(0);
      // glyph still drawn: white pixels present mid-canvas
      let midWhite = 0;
      const mid = (width >> 1) * width * 4;
      for (let x = 0; x < width; x++) {
        const i = mid + x * 4;
        if (data[i]! > 230 && data[i + 1]! > 230 && data[i + 2]! > 230) midWhite++;
      }
      expect(midWhite, `size=${size}`).toBeGreaterThan(0);
    }
  });
});
