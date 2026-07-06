import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRasterAvatar, checkAvatarCidBytes, sniffImageFormat } from "../../src/lib/imageSniff.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const GIF87 = Uint8Array.from(Buffer.from("GIF87a\x01\x00\x01\x00", "latin1"));
const GIF89 = Uint8Array.from(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"));
const WEBP = Uint8Array.from(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"));

describe("sniffImageFormat", () => {
  it("detects rasters by magic bytes", () => {
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(GIF87)).toBe("gif");
    expect(sniffImageFormat(GIF89)).toBe("gif");
    expect(sniffImageFormat(WEBP)).toBe("webp");
  });

  it("detects SVG with XML declaration (the exact bytes that broke Generative Collective)", () => {
    const svg = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageFormat(Uint8Array.from(svg))).toBe("svg");
  });

  it("detects bare <svg>, with leading whitespace and BOM", () => {
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("<svg></svg>")))).toBe("svg");
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("  \n\t<svg/>")))).toBe("svg");
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("﻿<svg/>", "utf8")))).toBe("svg");
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("<SVG WIDTH='1'/>")))).toBe("svg");
  });

  it("detects HTML (gateway error/directory pages)", () => {
    expect(sniffImageFormat(Uint8Array.from(Buffer.from('<!doctype html>\n<html lang="en"></html>')))).toBe("html");
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("<HTML><body/></HTML>")))).toBe("html");
  });

  it("classifies '<!DOCTYPE svg' as svg, not html", () => {
    const doctypeSvg = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>';
    expect(sniffImageFormat(Uint8Array.from(Buffer.from(doctypeSvg)))).toBe("svg");
    expect(() => assertRasterAvatar(Uint8Array.from(Buffer.from(doctypeSvg)))).toThrowError(/SVG/);
  });

  it("returns unknown for garbage and empty input", () => {
    expect(sniffImageFormat(Uint8Array.from(Buffer.from("hello world")))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
    // truncated JPEG magic (2 of 3 bytes)
    expect(sniffImageFormat(Uint8Array.from([0xff, 0xd8]))).toBe("unknown");
  });
});

describe("assertRasterAvatar", () => {
  it("returns format + true mime for rasters", () => {
    expect(assertRasterAvatar(JPEG)).toEqual({ format: "jpeg", mime: "image/jpeg" });
    expect(assertRasterAvatar(PNG)).toEqual({ format: "png", mime: "image/png" });
    expect(assertRasterAvatar(WEBP)).toEqual({ format: "webp", mime: "image/webp" });
    expect(assertRasterAvatar(GIF89)).toEqual({ format: "gif", mime: "image/gif" });
  });

  it("rejects SVG with an actionable message", () => {
    const svg = Uint8Array.from(Buffer.from('<?xml version="1.0"?><svg/>'));
    expect(() => assertRasterAvatar(svg)).toThrowError(/SVG.*never renders|never renders.*SVG/is);
    expect(() => assertRasterAvatar(svg)).toThrowError(/dexe_dao_generate_avatar/);
  });

  it("rejects HTML and unknown bytes", () => {
    expect(() => assertRasterAvatar(Uint8Array.from(Buffer.from("<!doctype html><html/>")))).toThrowError(/HTML/i);
    expect(() => assertRasterAvatar(Uint8Array.from(Buffer.from("not an image")))).toThrowError(/magic bytes/i);
  });
});

describe("checkAvatarCidBytes (by-reference CID validation)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const CID = "bafybeib3qhaqqfop2v445c66srdr4ttzkgs3xrxjyjp5aswdlitxgwcj2i";

  it("passes when the gateway serves raster bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from(JPEG), { status: 200 })));
    const res = await checkAvatarCidBytes(CID, "avatar.jpeg", ["https://ipfs.io"]);
    expect(res).toEqual({ ok: true });
  });

  it("hard-blocks when the gateway serves SVG bytes (the Generative Collective case)", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg/>');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(svg, { status: 200 })));
    const res = await checkAvatarCidBytes(CID, "avatar.jpeg", ["https://ipfs.io"]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SVG/);
  });

  it("proceeds with a warning when no gateway can serve the bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const res = await checkAvatarCidBytes(CID, "avatar.jpeg", ["https://ipfs.io", "https://dweb.link"]);
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/not reachable/);
  });

  it("treats network errors as unreachable, not as failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const res = await checkAvatarCidBytes(CID, "avatar.jpeg", ["https://ipfs.io"]);
    expect(res.ok).toBe(true);
    expect(res.warning).toBeTruthy();
  });
});
