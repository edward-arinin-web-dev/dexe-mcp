/**
 * Deterministic raster avatar renderer.
 *
 * Replaces the old SVG identicon: the DeXe serving chain (Go ipfs-cache →
 * R2 `<descCid>.jpeg` with hardcoded image/jpeg) only renders real raster
 * bytes, so we rasterize the same design — 1–2 initials over a hash-coloured
 * diagonal gradient — and encode an actual JPEG. Pure JS: RGBA buffer +
 * embedded 8x8 bitmap font + jpeg-js. No canvas, no native deps.
 *
 * Same daoName → byte-identical output (all constants fixed, no randomness).
 */

import jpegJs from "jpeg-js";

/** djb2-style hash → unsigned 32-bit. Kept identical to the legacy SVG identicon so re-generated avatars keep their colours. */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/** First 1–2 alphanumeric characters of the DAO name, uppercased ("?" fallback). */
export function avatarInitials(daoName: string): string {
  const cleaned = daoName.replace(/[^\p{L}\p{N}]/gu, "");
  return (cleaned.slice(0, 2) || "?").toUpperCase();
}

/**
 * 8x8 bitmap font (font8x8_basic, public domain — Daniel Hepper).
 * Row bytes top→bottom; bit n of a row = pixel at x=n (LSB is the LEFT column).
 */
const FONT_8X8: Record<string, readonly number[]> = {
  "0": [0x3e, 0x63, 0x73, 0x7b, 0x6f, 0x67, 0x3e, 0x00],
  "1": [0x0c, 0x0e, 0x0c, 0x0c, 0x0c, 0x0c, 0x3f, 0x00],
  "2": [0x1e, 0x33, 0x30, 0x1c, 0x06, 0x33, 0x3f, 0x00],
  "3": [0x1e, 0x33, 0x30, 0x1c, 0x30, 0x33, 0x1e, 0x00],
  "4": [0x38, 0x3c, 0x36, 0x33, 0x7f, 0x30, 0x78, 0x00],
  "5": [0x3f, 0x03, 0x1f, 0x30, 0x30, 0x33, 0x1e, 0x00],
  "6": [0x1c, 0x06, 0x03, 0x1f, 0x33, 0x33, 0x1e, 0x00],
  "7": [0x3f, 0x33, 0x30, 0x18, 0x0c, 0x0c, 0x0c, 0x00],
  "8": [0x1e, 0x33, 0x33, 0x1e, 0x33, 0x33, 0x1e, 0x00],
  "9": [0x1e, 0x33, 0x33, 0x3e, 0x30, 0x18, 0x0e, 0x00],
  A: [0x0c, 0x1e, 0x33, 0x33, 0x3f, 0x33, 0x33, 0x00],
  B: [0x3f, 0x66, 0x66, 0x3e, 0x66, 0x66, 0x3f, 0x00],
  C: [0x3c, 0x66, 0x03, 0x03, 0x03, 0x66, 0x3c, 0x00],
  D: [0x1f, 0x36, 0x66, 0x66, 0x66, 0x36, 0x1f, 0x00],
  E: [0x7f, 0x46, 0x16, 0x1e, 0x16, 0x46, 0x7f, 0x00],
  F: [0x7f, 0x46, 0x16, 0x1e, 0x16, 0x06, 0x0f, 0x00],
  G: [0x3c, 0x66, 0x03, 0x03, 0x73, 0x66, 0x7c, 0x00],
  H: [0x33, 0x33, 0x33, 0x3f, 0x33, 0x33, 0x33, 0x00],
  I: [0x1e, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x1e, 0x00],
  J: [0x78, 0x30, 0x30, 0x30, 0x33, 0x33, 0x1e, 0x00],
  K: [0x67, 0x66, 0x36, 0x1e, 0x36, 0x66, 0x67, 0x00],
  L: [0x0f, 0x06, 0x06, 0x06, 0x46, 0x66, 0x7f, 0x00],
  M: [0x63, 0x77, 0x7f, 0x7f, 0x6b, 0x63, 0x63, 0x00],
  N: [0x63, 0x67, 0x6f, 0x7b, 0x73, 0x63, 0x63, 0x00],
  O: [0x1c, 0x36, 0x63, 0x63, 0x63, 0x36, 0x1c, 0x00],
  P: [0x3f, 0x66, 0x66, 0x3e, 0x06, 0x06, 0x0f, 0x00],
  Q: [0x1e, 0x33, 0x33, 0x33, 0x3b, 0x1e, 0x38, 0x00],
  R: [0x3f, 0x66, 0x66, 0x3e, 0x36, 0x66, 0x67, 0x00],
  S: [0x1e, 0x33, 0x07, 0x0e, 0x38, 0x33, 0x1e, 0x00],
  T: [0x3f, 0x2d, 0x0c, 0x0c, 0x0c, 0x0c, 0x1e, 0x00],
  U: [0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x3f, 0x00],
  V: [0x33, 0x33, 0x33, 0x33, 0x33, 0x1e, 0x0c, 0x00],
  W: [0x63, 0x63, 0x63, 0x6b, 0x7f, 0x77, 0x63, 0x00],
  X: [0x63, 0x63, 0x36, 0x1c, 0x1c, 0x36, 0x63, 0x00],
  Y: [0x33, 0x33, 0x33, 0x1e, 0x0c, 0x0c, 0x1e, 0x00],
  Z: [0x7f, 0x63, 0x31, 0x18, 0x4c, 0x66, 0x7f, 0x00],
  "?": [0x1e, 0x33, 0x30, 0x18, 0x0c, 0x00, 0x0c, 0x00],
};

/** hsl (deg, 0–1, 0–1) → [r, g, b] 0–255. Matches CSS hsl() as used by the legacy SVG. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const GLYPH_GAP_COLS = 2; // font-pixel columns between two initials
const BLOCK_WIDTH_RATIO = 0.62; // initials block ≈ 62% of image width
const JPEG_QUALITY = 90;
const SUPERSAMPLE = 2;

/**
 * Render the avatar and encode as JPEG. `size` is the output square in px.
 * Renders at 2x and box-downscales, so glyph edges pick up light smoothing
 * when the pixel scale is odd.
 */
export function renderAvatarJpeg(daoName: string, size = 512): Buffer {
  const h = hashString(daoName);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >>> 8) % 80)) % 360;
  const c1 = hslToRgb(hue1, 0.7, 0.55);
  const c2 = hslToRgb(hue2, 0.7, 0.35);

  const big = size * SUPERSAMPLE;
  const rgba = new Uint8Array(big * big * 4);

  // Diagonal gradient, top-left c1 → bottom-right c2 (same axis as the old
  // SVG linearGradient x1=0,y1=0 → x2=1,y2=1).
  const denom = 2 * (big - 1) || 1;
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const t = (x + y) / denom;
      const i = (y * big + x) * 4;
      rgba[i] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      rgba[i + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      rgba[i + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      rgba[i + 3] = 255;
    }
  }

  // Initials, centered, white. font8x8 glyphs lean into the low columns, so
  // crop each glyph to its used column range before laying out — otherwise
  // the block sits visibly off-center.
  const initials = avatarInitials(daoName);
  const glyphs = [...initials].map((ch) => FONT_8X8[ch] ?? FONT_8X8["?"]!);
  const bounds = glyphs.map((glyph) => {
    let mask = 0;
    for (const row of glyph) mask |= row;
    if (mask === 0) return { minCol: 0, width: 8 };
    let minCol = 0;
    while (((mask >> minCol) & 1) === 0) minCol++;
    let maxCol = 7;
    while (((mask >> maxCol) & 1) === 0) maxCol--;
    return { minCol, width: maxCol - minCol + 1 };
  });
  const blockCols = bounds.reduce((sum, b) => sum + b.width, 0) + (glyphs.length - 1) * GLYPH_GAP_COLS;
  // Clamp by height too: a single narrow glyph (e.g. "I", cropped width 4)
  // would otherwise scale past the canvas vertically and clip at the top.
  // Same ratio on both axes keeps margins consistent.
  const scale = Math.max(
    1,
    Math.min(Math.floor((big * BLOCK_WIDTH_RATIO) / blockCols), Math.floor((big * BLOCK_WIDTH_RATIO) / 8)),
  );
  const blockW = blockCols * scale;
  const blockH = 8 * scale;
  const originX = (big - blockW) >> 1;
  const originY = (big - blockH) >> 1;

  let glyphX = originX;
  glyphs.forEach((glyph, gi) => {
    const { minCol, width } = bounds[gi]!;
    for (let row = 0; row < 8; row++) {
      const bits = glyph[row]!;
      if (bits === 0) continue;
      for (let col = minCol; col < minCol + width; col++) {
        if (((bits >> col) & 1) === 0) continue;
        const px = glyphX + (col - minCol) * scale;
        const py = originY + row * scale;
        for (let dy = 0; dy < scale; dy++) {
          const rowBase = (py + dy) * big;
          for (let dx = 0; dx < scale; dx++) {
            const i = (rowBase + px + dx) * 4;
            rgba[i] = 255;
            rgba[i + 1] = 255;
            rgba[i + 2] = 255;
          }
        }
      }
    }
    glyphX += (width + GLYPH_GAP_COLS) * scale;
  });

  // Box-downscale SUPERSAMPLE× → final size.
  const out = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const i = ((y * SUPERSAMPLE + dy) * big + x * SUPERSAMPLE + dx) * 4;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }

  return jpegJs.encode({ data: out, width: size, height: size }, JPEG_QUALITY).data;
}
