import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * 0.34.0 — the two backend list tools emitted a `nextPageToken` the caller had
 * no way to send back, advertised a `pageSize` four times the backend's real
 * cap, and gave no truncation signal at all.
 *
 * Live on chain 56: `dexe_read_token_holders {token: 0x9f5d…, pageSize: 3}`
 * returned `count: 3` plus a 684-char `nextPageToken`, with a text body reading
 * "Holders of 0x9f5d… (chain 56): 3" — a page presented as the complete list.
 * `pageSize: 101` returned `backend HTTP 400` blamed on a backend outage, and
 * chain 97 returned a SILENT empty 200, i.e. "this token has no holders".
 */

const TOKEN = "0x9f5d4479b783327b61718fa13b3a0583869a80c1";
const HOLDER = "0xb562127efdc97b417b3116eff2c23a29857c0f0b";
// Shaped like the real cursor: base64 with padding, long enough to matter.
const CURSOR = `eyJwcm92aWRlcl9uYW1lIjoiTW9yYWxpcyIsInRva2VuIjoi${"A".repeat(600)}+/==`;

interface Out {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Out> {
  process.env.DEXE_TOOLSETS = "core,read";
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      text: (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n"),
      structured: (res.structuredContent ?? {}) as Record<string, unknown>,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Rejects out of band (McpError), not as an isError result — see the SDK. */
async function callRaw(name: string, args: Record<string, unknown>) {
  process.env.DEXE_TOOLSETS = "core,read";
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

function stub(reply: (url: URL) => { status?: number; body: unknown }) {
  fetchMock = vi.fn(async (u: unknown) => {
    const url = new URL(String(u));
    const out = reply(url);
    const status = out.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

const urls = () => fetchMock.mock.calls.map((c) => new URL(String(c[0])));

beforeEach(() => {
  fetchMock = vi.fn();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DEXE_TOOLSETS;
});

const CASES = [
  {
    tool: "dexe_read_token_holders",
    args: { token: TOKEN },
    body: (n: number, next: string) => ({
      holders_balances: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`0x${String(i).padStart(40, "1")}`, String(n - i)]),
      ),
      next_page_token: next,
    }),
    warn: "MORE HOLDERS EXIST",
    rows: "holders",
  },
  {
    tool: "dexe_read_nfts",
    args: { holder: HOLDER },
    body: (n: number, next: string) => ({
      nft_data: Array.from({ length: n }, (_, i) => ({ name: `NFT ${i}`, token_id: String(i) })),
      next_page_token: next,
    }),
    warn: "MORE NFTs EXIST",
    rows: "nfts",
  },
] as const;

describe("backend paging is a round trip, not a dead end", () => {
  for (const c of CASES) {
    it(`${c.tool}: pageToken is sent back as the backend's own snake_case param`, async () => {
      // A camelCase key is silently IGNORED by this backend and page 1 comes
      // back again with HTTP 200 — an infinite loop that looks like success.
      // So assert the exact literal, not merely that the token appears.
      stub(() => ({ body: c.body(2, "") }));
      await call(c.tool, { ...c.args, chainId: 56, pageToken: CURSOR });
      expect(urls()[0]!.searchParams.get("page_token")).toBe(CURSOR);
    });

    it(`${c.tool}: omitting pageToken sends no page_token key at all`, async () => {
      stub(() => ({ body: c.body(2, "") }));
      await call(c.tool, { ...c.args, chainId: 56 });
      expect(urls()[0]!.searchParams.has("page_token")).toBe(false);
    });

    it(`${c.tool}: a continuation cursor means truncated, and the text says so`, async () => {
      stub(() => ({ body: c.body(2, "TOK2") }));
      const r = await call(c.tool, { ...c.args, chainId: 56 });
      expect(r.structured.truncated).toBe(true);
      expect(r.structured.count).toBe(2);
      expect(r.structured.nextPageToken).toBe("TOK2");
      expect(r.text).toContain(c.warn);
      expect(r.text).toContain("pageToken");
    });

    it(`${c.tool}: the truncation flag comes from the cursor, NOT from rows === pageSize`, async () => {
      // Observed live on nfts-by-wallet: pageSize 2 → 1 row WITH a cursor.
      stub(() => ({ body: c.body(1, "TOK2") }));
      const r = await call(c.tool, { ...c.args, chainId: 56, pageSize: 2 });
      expect(r.structured.truncated).toBe(true);
    });

    it(`${c.tool}: the last page carries no warning`, async () => {
      stub(() => ({ body: c.body(2, "") }));
      const r = await call(c.tool, { ...c.args, chainId: 56 });
      expect(r.structured.truncated).toBe(false);
      expect(r.text).not.toContain("MORE");
    });

    it(`${c.tool}: back-compat — count and nextPageToken keep their meaning`, async () => {
      stub(() => ({ body: c.body(3, "TOK2") }));
      const r = await call(c.tool, { ...c.args, chainId: 56 });
      expect(r.structured.count).toBe(3);
      expect((r.structured[c.rows] as unknown[]).length).toBe(3);
      expect(r.structured).not.toHaveProperty("returned");
    });

    it(`${c.tool}: pageSize above the backend cap is refused before any HTTP call`, async () => {
      // The schema bound is the point: the caller learns the real limit without
      // spending a round trip on a deterministic HTTP 400.
      stub(() => ({ body: c.body(1, "") }));
      const r = await callRaw(c.tool, { ...c.args, chainId: 56, pageSize: 101 });
      expect(r.isError).toBe(true);
      expect(
        (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n"),
      ).toMatch(/less than or equal to 100/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${c.tool}: the boundary value 100 is still allowed`, async () => {
      stub(() => ({ body: c.body(1, "") }));
      await call(c.tool, { ...c.args, chainId: 56, pageSize: 100 });
      expect(urls()[0]!.searchParams.get("page_size")).toBe("100");
    });

    it(`${c.tool}: an unindexed chain is refused, never answered with an empty list`, async () => {
      stub(() => ({ body: c.body(0, "") }));
      for (const chainId of [97, 10]) {
        const r = await call(c.tool, { ...c.args, chainId });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("not indexed by the DeXe backend");
        expect(r.text).toContain("dexe_read_multicall");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${c.tool}: a 400 is not blamed on an outage, and never echoes the cursor`, async () => {
      stub(() => ({ status: 400, body: { meta: { PageToken: "base64" } } }));
      const r = await call(c.tool, { ...c.args, chainId: 56, pageToken: CURSOR });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("HTTP 400");
      expect(r.text).toContain("bad request");
      // The old generic backend remedy is wrong in every clause here.
      expect(r.text).not.toContain("the Bearer token expired");
      // A 600-char JWT must not land in the transcript on every hiccup.
      expect(r.text).not.toContain(CURSOR);
    });

    it(`${c.tool}: a 5xx still gets the transient backend remedy`, async () => {
      stub(() => ({ status: 503, body: {} }));
      const r = await call(c.tool, { ...c.args, chainId: 56 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("The DeXe backend API");
    });
  }

  it("dexe_read_token_holders: a 700-char base64 cursor survives the trip byte-identical", async () => {
    stub(() => ({ body: { holders_balances: { "0x1": "1" }, next_page_token: CURSOR } }));
    const r = await call("dexe_read_token_holders", { token: TOKEN, chainId: 56 });
    expect(r.structured.nextPageToken).toBe(CURSOR);
  });
});
