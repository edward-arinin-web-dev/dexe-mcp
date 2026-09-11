import { describe, it, expect, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerIntrospectTools } from "../../src/tools/introspect.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.34.0 — two response-size guards that measured the wrong channel.
 *
 * `dexe_get_abi` had a polite one-line `content[].text` and shipped the whole
 * ABI in `structuredContent` — which is what the model actually receives.
 * GovPool's ABI alone is 61 entries / 21,758 chars.
 *
 * `dexe_graph_query` refused over its cap with "Narrow the selection set or
 * paginate with first/skip" — the round trip was already paid for, the rows
 * were in hand and thrown away, and the caller had to re-issue blind with no
 * number to aim at.
 */

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTools(): { tools: Map<string, ToolHandler>; server: McpServer } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => tools.set(name, handler),
    tool: (name: string, ...rest: unknown[]) => tools.set(name, rest[rest.length - 1] as ToolHandler),
  } as unknown as McpServer;
  return { tools, server };
}

/** An ABI padded past the 16k soft cap, with a distinctive function to filter on. */
function bigAbi() {
  const events = Array.from({ length: 200 }, (_v, i) => ({
    type: "event",
    name: `Event${i}WithAVeryLongNameToPadTheJsonPayload`,
    inputs: [
      { name: "aVeryLongParameterName", type: "address", indexed: true },
      { name: "anotherVeryLongParameterName", type: "uint256", indexed: false },
    ],
    anonymous: false,
  }));
  return [
    { type: "function", name: "vote", stateMutability: "nonpayable", inputs: [], outputs: [] },
    { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [], outputs: [] },
    ...events,
  ];
}

function introspectCtx(abi: unknown[]): ToolContext {
  const artifact = { contractName: "GovPool", sourceName: "contracts/gov/GovPool.sol", abi };
  return {
    config: {} as unknown as DexeConfig,
    artifacts: {
      requireArtifactsExist: () => undefined,
      getOne: () => artifact,
      get: () => [artifact],
      all: () => [artifact],
      list: () => [artifact],
    },
    selectors: { find: () => [] },
  } as unknown as ToolContext;
}

async function getAbi(abi: unknown[], args: Record<string, unknown>) {
  const { tools, server } = captureTools();
  registerIntrospectTools(server, introspectCtx(abi));
  return tools.get("dexe_get_abi")!(args);
}

describe("dexe_get_abi measures the channel the model actually reads", () => {
  it("a small ABI is returned unchanged, with no size warning", async () => {
    const abi = [{ type: "function", name: "vote", inputs: [], outputs: [] }];
    const res = await getAbi(abi, { contract: "GovPool" });
    expect((res.structuredContent!.abi as unknown[]).length).toBe(1);
    expect(res.structuredContent!.totalEntries).toBe(1);
    expect(res.structuredContent!.filtered).toBe(false);
    expect(res.content[0]!.text).not.toContain("chars of JSON");
  });

  it("an oversized ABI is SERVED, with the narrowing that actually works named", async () => {
    // Deliberately not a refusal: kind:"function" does not bring GovPool under
    // any sane cap (functions-only is still ~20k chars) and dexe_get_methods is
    // LARGER than the raw ABI — a hard refusal would name two remedies that
    // also fail, on the flagship contract, in a tool called "get ABI".
    const res = await getAbi(bigAbi(), { contract: "GovPool" });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent!.abi as unknown[]).length).toBe(202);
    expect(res.content[0]!.text).toContain("chars of JSON");
    expect(res.content[0]!.text).toContain("nameFilter");
    expect(res.content[0]!.text).toContain("dexe_get_selectors");
    // The one honest thing to say about dexe_get_methods here.
    expect(res.content[0]!.text).toContain("NOT smaller");
  });

  it("kind narrows the payload and reports what it narrowed from", async () => {
    const res = await getAbi(bigAbi(), { contract: "GovPool", kind: "function" });
    const abi = res.structuredContent!.abi as Array<{ type: string }>;
    expect(abi).toHaveLength(2);
    expect(abi.every((e) => e.type === "function")).toBe(true);
    expect(res.structuredContent!.totalEntries).toBe(202);
    expect(res.structuredContent!.filtered).toBe(true);
    expect(res.content[0]!.text).toContain("filtered from 202");
  });

  it("nameFilter matches case-insensitively", async () => {
    const res = await getAbi(bigAbi(), { contract: "GovPool", nameFilter: "VOTE" });
    const abi = res.structuredContent!.abi as Array<{ name: string }>;
    expect(abi).toHaveLength(1);
    expect(abi[0]!.name).toBe("vote");
  });
});

// ---------------------------------------------------------------------------

const URLS = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
} as const;

function sgCtx(): ToolContext {
  return {
    config: {
      defaultChainId: 56,
      subgraphUrls: new Map([[56, { ...URLS }]]),
    } as unknown as DexeConfig,
  } as unknown as ToolContext;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubRows(n: number, pad: number) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      data: {
        daoPools: Array.from({ length: n }, (_v, i) => ({
          id: `0x${String(i).padStart(40, "0")}`,
          blob: "x".repeat(pad),
        })),
      },
    }),
  })) as unknown as typeof globalThis.fetch;
}

describe("dexe_graph_query refuses with arithmetic, not with a shrug", () => {
  it("suggests a first: value that would actually fit", async () => {
    stubRows(2000, 400);
    const { tools, server } = captureTools();
    registerSubgraphTools(server, sgCtx());
    const res = await tools.get("dexe_graph_query")!({
      subgraph: "pools",
      query: "{ daoPools(first: 2000) { id blob } }",
      chainId: 56,
    });
    expect(res.isError).toBe(true);
    const msg = res.content[0]!.text;
    expect(msg).toMatch(/first: \d+/);
    expect(msg).toContain("row(s)");
    // The caller must know nothing was silently truncated for them.
    expect(msg).toContain("NO rows were returned");
    expect(msg).toContain("dexe_graph_schema");
    const suggested = Number(/first: (\d+)/.exec(msg)![1]);
    // Half the cap's worth of rows, by construction — genuine headroom.
    expect(suggested).toBeGreaterThan(0);
    expect(suggested).toBeLessThan(2000);
  });

  it("says 'add pagination' instead of 'first: 0' when there are no rows to count", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ data: { blob: "y".repeat(200_000) } }),
    })) as unknown as typeof globalThis.fetch;
    const { tools, server } = captureTools();
    registerSubgraphTools(server, sgCtx());
    const res = await tools.get("dexe_graph_query")!({
      subgraph: "pools",
      query: "{ blob }",
      chainId: 56,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Add first:/skip: pagination");
    expect(res.content[0]!.text).not.toContain("first: 0");
  });

  it("serves a response under the cap untouched", async () => {
    stubRows(3, 10);
    const { tools, server } = captureTools();
    registerSubgraphTools(server, sgCtx());
    const res = await tools.get("dexe_graph_query")!({
      subgraph: "pools",
      query: "{ daoPools(first: 3) { id blob } }",
      chainId: 56,
    });
    expect(res.isError).toBeFalsy();
    expect(((res.structuredContent!.data as { daoPools: unknown[] }).daoPools).length).toBe(3);
  });
});
