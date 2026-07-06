import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIpfsTools } from "../../src/tools/ipfs.js";
import type { ToolContext } from "../../src/tools/context.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

const PIN_RESULT = {
  IpfsHash: "QmSLwX3b5hpMK57vtaReB35EKog2xxMRskmLicK92L8EAD",
  PinSize: 571,
  Timestamp: "2026-07-06T00:00:00.000Z",
};

function captureTools(): { tools: Map<string, ToolHandler>; server: McpServer } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { tools, server };
}

const ctx = { config: { pinataJwt: "test-jwt" } } as unknown as ToolContext;

const SVG_BASE64 = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString("base64");

describe("avatar tool pipeline", () => {
  let tools: Map<string, ToolHandler>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const captured = captureTools();
    registerIpfsTools(captured.server, ctx);
    tools = captured.tools;
    fetchMock = vi.fn(async () => new Response(JSON.stringify(PIN_RESULT), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function pinnedFileBytes(): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const form = init.body as FormData;
    const file = form.get("file") as File;
    return { bytes: Buffer.from(await file.arrayBuffer()), fileName: file.name, contentType: file.type };
  }

  it("dexe_dao_generate_avatar pins real JPEG bytes named avatar.jpeg", async () => {
    const res = await tools.get("dexe_dao_generate_avatar")!({ daoName: "Generative Collective" });
    expect(res.isError).toBeFalsy();
    const { bytes, fileName, contentType } = await pinnedFileBytes();
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(fileName).toBe("avatar.jpeg");
    expect(contentType).toBe("image/jpeg");
    expect(res.structuredContent?.avatarFileName).toBe("avatar.jpeg");
    expect(String(res.structuredContent?.avatarCID)).toMatch(/^bafy/);
  });

  it("dexe_ipfs_upload_avatar rejects SVG bytes without pinning", async () => {
    const res = await tools.get("dexe_ipfs_upload_avatar")!({ base64: SVG_BASE64, contentType: "image/jpeg" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SVG/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dexe_ipfs_upload_avatar accepts real JPEG and reports detectedFormat", async () => {
    const res = await tools.get("dexe_ipfs_upload_avatar")!({ base64: JPEG_BASE64, contentType: "image/png" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.detectedFormat).toBe("jpeg");
    const { contentType } = await pinnedFileBytes();
    expect(contentType).toBe("image/jpeg"); // sniffed, not the caller's claim
  });

  it("dexe_ipfs_upload_file rejects SVG bytes claiming to be an image", async () => {
    const res = await tools.get("dexe_ipfs_upload_file")!({
      base64: SVG_BASE64,
      fileName: "avatar.svg",
      contentType: "image/svg+xml",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SVG/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dexe_ipfs_upload_file allows SVG when normalizeImageExt:false (generic attachment path)", async () => {
    const res = await tools.get("dexe_ipfs_upload_file")!({
      base64: SVG_BASE64,
      fileName: "logo.svg",
      contentType: "image/svg+xml",
      normalizeImageExt: false,
    });
    expect(res.isError).toBeFalsy();
    const { fileName, contentType } = await pinnedFileBytes();
    expect(fileName).toBe("logo.svg");
    expect(contentType).toBe("image/svg+xml");
  });

  it("dexe_ipfs_upload_file still pins non-image files untouched", async () => {
    const res = await tools.get("dexe_ipfs_upload_file")!({
      base64: Buffer.from("plain text attachment").toString("base64"),
      fileName: "notes.txt",
      contentType: "text/plain",
    });
    expect(res.isError).toBeFalsy();
    const { fileName, contentType } = await pinnedFileBytes();
    expect(fileName).toBe("notes.txt");
    expect(contentType).toBe("text/plain");
  });
});
