import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.34.0 — every offset-paged list tool now states whether its page is the
 * whole set.
 *
 * Before this, `dexe_read_dao_members` on BOXY DAO returned 20 rows and a
 * summary reading "20 member(s) in 0x9279… (offset=0, limit=20)". The DAO has
 * 104 members. Nothing in either channel distinguished a full page from a
 * complete list, and `rows.length === limit` — the only cue available — was
 * never spelled out.
 */

const POOL = "0x927980153ef1743a3e9f3549eb307e06c74b5571";
const WALLET = "0xca543e570e4a1f6da7cf9c4c7211692bc105a00a";

const URLS = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
} as const;

function config(): DexeConfig {
  return {
    defaultChainId: 56,
    subgraphUrls: new Map([[56, { ...URLS }]]),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerSubgraphTools(server, { config: config() } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.listTools();
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const realFetch = globalThis.fetch;
let rowsFor: (n: number) => unknown;

function stub(make: (rootField: string, n: number) => Record<string, unknown>) {
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    const { query, variables } = JSON.parse(init?.body ?? "{}") as {
      query: string;
      variables: Record<string, unknown>;
    };
    const n = Number(variables.limit ?? variables.first ?? 0);
    const root = query.includes("daoPools(\n")
      ? "daoPools"
      : query.includes("voterInPoolPairs")
        ? "voterInPoolPairs"
        : query.includes("validatorInPools")
          ? "validatorInPools"
          : query.includes("transactions")
            ? "transactions"
            : query.includes("voterInPools")
              ? "voterInPools"
              : "daoPools";
    return { ok: true, status: 200, json: async () => ({ data: make(root, n) }), text: async () => "" };
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  rowsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0x${String(i).padStart(40, "0")}` }));
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every offset-paged subgraph list tool, with the args that page it. */
const TOOLS: Array<{ name: string; noun: string; args: Record<string, unknown> }> = [
  { name: "dexe_read_dao_list", noun: "DAO", args: { chainId: 56 } },
  { name: "dexe_read_dao_members", noun: "member", args: { govPool: POOL, chainId: 56 } },
  {
    name: "dexe_read_delegation_map",
    noun: "delegation",
    args: { addresses: [WALLET], chainId: 56 },
  },
  { name: "dexe_read_validator_list", noun: "validator", args: { govPool: POOL, chainId: 56 } },
  { name: "dexe_read_user_activity", noun: "transaction", args: { user: WALLET, chainId: 56 } },
  { name: "dexe_read_dao_experts", noun: "expert", args: { govPool: POOL, chainId: 56 } },
];

describe("offset-paged list tools state whether the page is the whole set", () => {
  for (const t of TOOLS) {
    it(`${t.name}: a FULL page is flagged truncated with a usable nextOffset`, async () => {
      stub((root, n) => ({ [root]: rowsFor(n) }));
      const res = await callTool(t.name, { ...t.args, limit: 5, offset: 0 });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent!.returned).toBe(5);
      expect(res.structuredContent!.truncated).toBe(true);
      expect(res.structuredContent!.nextOffset).toBe(5);
      expect(text(res)).toContain("PARTIAL LIST");
      expect(text(res)).toContain("offset: 5");
      expect(text(res)).toContain(t.noun);
    });

    it(`${t.name}: a SHORT page is the end, with no warning`, async () => {
      stub((root, n) => ({ [root]: rowsFor(Math.max(0, n - 1)) }));
      const res = await callTool(t.name, { ...t.args, limit: 5, offset: 0 });
      expect(res.structuredContent!.truncated).toBe(false);
      expect(res.structuredContent!.nextOffset).toBeUndefined();
      expect(text(res)).not.toContain("PARTIAL LIST");
    });

    it(`${t.name}: back-compat — offset and limit are still echoed`, async () => {
      stub((root, n) => ({ [root]: rowsFor(n) }));
      const res = await callTool(t.name, { ...t.args, limit: 5, offset: 10 });
      expect(res.structuredContent!.offset).toBe(10);
      expect(res.structuredContent!.limit).toBe(5);
      expect(res.structuredContent!.indexedChainId).toBe(56);
    });
  }

  it("dexe_read_dao_members reports the real total from the same round trip", async () => {
    stub((_root, n) => ({ daoPools: [{ votersCount: "104" }], voterInPools: rowsFor(n) }));
    const res = await callTool("dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
      limit: 20,
      offset: 0,
    });
    expect(res.structuredContent!.total).toBe(104);
    expect(res.structuredContent!.truncated).toBe(true);
    expect(text(res)).toContain("showing 20 of 104 member");
  });

  it("dexe_read_dao_members stops at the last page instead of paging past it", async () => {
    stub(() => ({ daoPools: [{ votersCount: "104" }], voterInPools: rowsFor(4) }));
    const res = await callTool("dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
      limit: 20,
      offset: 100,
    });
    expect(res.structuredContent!.truncated).toBe(false);
    expect(text(res)).not.toContain("PARTIAL LIST");
  });
});
