import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerInboxTools } from "../../src/tools/inbox.js";
import { multicall } from "../../src/lib/multicall.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * 0.30.2 finding H1 — `dexe_user_inbox` discovered DAOs on one chain and
 * scanned them on another.
 *
 * The tool took `chainId`, ran its per-DAO scan on that chain's provider, and
 * then read the FLAT `config.subgraphPoolsUrl` for DAO discovery — an endpoint
 * that indexes BSC mainnet regardless of what was asked for. Proven live with a
 * real mainnet voter: `chainId: 97` returned isError=false and
 * `{"totalDaos":1,"daosWithItems":0}` for a user who belongs to ZERO testnet
 * DAOs. It had found a MAINNET DAO, scanned it on testnet where the contract
 * does not exist, and called that "nothing pending" — a wrong answer shaped
 * like a successful read, which an agent then acts on.
 *
 * Asserted here:
 *   1. a chain with no pools endpoint refuses discovery — no subgraph request
 *      is issued at all, so no other chain's DAO can reach the caller;
 *   2. the refusal still points at the subgraph-free path (`daos[]`), because
 *      the scan itself is pure on-chain;
 *   3. every answer states where its DAO list came from (`indexedChainId`,
 *      `daoSource`), and a caller-supplied list on an unindexed chain says out
 *      loud that discovery was skipped.
 */

const USER = "0xadd0130c0f0dee44d0b0e6d5e9b1f5f1c9c0a0b1";
/** Only ever returned by the mainnet endpoint — a leak marker. */
const MAINNET_DAO = "0xdad0000000000000000000000000000000000056";
const TESTNET_DAO = "0xdad0000000000000000000000000000000000097";

const MAINNET_URLS: SubgraphEndpoints = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
};

const TESTNET_URLS: SubgraphEndpoints = {
  pools: "https://gw.example/97/pools",
  validators: "https://gw.example/97/validators",
  interactions: "https://gw.example/97/interactions",
};

// The per-DAO scan is not under test here — only which DAOs it is handed and
// which chain they were discovered on. Every batch fails softly, which the tool
// reports as `scanErrors` while still producing its summary.
vi.mock("../../src/lib/multicall.js", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  multicall: vi.fn(async (_provider: unknown, calls: unknown[]) =>
    (calls as unknown[]).map(() => ({
      success: false,
      value: null,
      raw: "0x",
      error: "mocked: scan not under test",
    })),
  ),
}));

const multicallMock = vi.mocked(multicall);

function config(opts: {
  subgraphs: Record<number, SubgraphEndpoints>;
  defaultChainId?: number;
}): DexeConfig {
  return {
    defaultChainId: opts.defaultChainId ?? 56,
    chains: new Map(
      [56, 97].map((c) => [
        c,
        { chainId: c, rpcUrl: `https://rpc.example/${c}`, rpcUrls: [`https://rpc.example/${c}`] },
      ]),
    ),
    subgraphUrls: new Map(
      Object.entries(opts.subgraphs).map(([k, v]) => [Number(k), v] as const),
    ),
    // The flat back-compat aliases, filed under DEXE_SUBGRAPH_CHAIN_ID (56) —
    // present here precisely because the H1 bug was reading THESE while working
    // on another chain. A fixture without them could not reproduce it.
    subgraphChainId: 56,
    subgraphPoolsUrl: opts.subgraphs[56]?.pools,
    usingPublicRpcFallback: false,
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callInbox(cfg: DexeConfig, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerInboxTools(server, { config: cfg } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({
      name: "dexe_user_inbox",
      arguments: args,
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

/** The subgraph answers with whichever DAO belongs to the endpoint queried. */
function daoForEndpoint(url: string): string {
  return url === TESTNET_URLS.pools ? TESTNET_DAO : MAINNET_DAO;
}

beforeEach(() => {
  multicallMock.mockClear();
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: { voterInPools: [{ pool: { id: daoForEndpoint(url) } }] } }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("dexe_user_inbox discovers on the chain it scans", () => {
  it("chainId 97 with only a mainnet pools subgraph refuses instead of reporting mainnet DAOs", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 97,
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("chain 97");
    expect(text(res)).toContain("DEXE_SUBGRAPH_POOLS_URL_97");
    // The live symptom: a mainnet DAO reported under a testnet request. No
    // subgraph request was issued, so none could have been discovered, and no
    // on-chain scan ran against a DAO that does not exist on this chain.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(multicallMock).not.toHaveBeenCalled();
    expect(text(res).toLowerCase()).not.toContain(MAINNET_DAO);
    expect(res.structuredContent).toBeUndefined();
  });

  it("the refusal never claims a DAO count", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 97,
    });
    // Pre-fix this same call returned {"totalDaos":1,"daosWithItems":0}.
    expect(text(res)).not.toContain("totalDaos");
    expect(text(res)).not.toContain("daosWithItems");
  });

  it("the refusal offers the subgraph-free path and the mainnet alternative", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 97,
    });
    expect(text(res)).toContain("daos:");
    expect(text(res)).toContain("chainId: 56");
  });

  it("omitting chainId on a testnet-default install refuses rather than discovering on mainnet", async () => {
    const res = await callInbox(
      config({ subgraphs: { 56: MAINNET_URLS }, defaultChainId: 97 }),
      { user: USER },
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("chain 97");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("chainId 56 discovers from the mainnet endpoint and reports indexedChainId 56", async () => {
    const res = await callInbox(
      config({ subgraphs: { 56: MAINNET_URLS, 97: TESTNET_URLS } }),
      { user: USER, chainId: 56 },
    );
    expect(res.isError).toBeFalsy();
    expect(fetchMock.mock.calls[0]![0]).toBe(MAINNET_URLS.pools);
    expect(res.structuredContent?.indexedChainId).toBe(56);
    expect(res.structuredContent?.chainId).toBe(56);
    expect(res.structuredContent?.daoSource).toBe("subgraph");
  });

  it("chainId 97 discovers from the chain-97 endpoint once one is configured", async () => {
    const res = await callInbox(
      config({ subgraphs: { 56: MAINNET_URLS, 97: TESTNET_URLS } }),
      { user: USER, chainId: 97 },
    );
    expect(res.isError).toBeFalsy();
    expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_URLS.pools);
    expect(res.structuredContent?.indexedChainId).toBe(97);
    expect(res.structuredContent?.chainId).toBe(97);
    // Discovery and scan agree: only the testnet DAO was scanned.
    expect(text(res).toLowerCase()).toContain(TESTNET_DAO);
    expect(text(res).toLowerCase()).not.toContain(MAINNET_DAO);
  });

  it("omitting chainId follows the default chain's endpoint, never a substitute", async () => {
    const res = await callInbox(
      config({ subgraphs: { 56: MAINNET_URLS, 97: TESTNET_URLS }, defaultChainId: 97 }),
      { user: USER },
    );
    expect(res.isError).toBeFalsy();
    expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_URLS.pools);
    expect(res.structuredContent?.indexedChainId).toBe(97);
  });
});

describe("dexe_user_inbox degrades discovery only, never the scan", () => {
  it("caller-supplied daos still scan a chain with no subgraph", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 97,
      daos: [TESTNET_DAO],
    });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(multicallMock).toHaveBeenCalled();
    expect(res.structuredContent?.daoSource).toBe("caller");
    expect(res.structuredContent?.indexedChainId).toBeNull();
    expect((res.structuredContent?.summary as { totalDaos: number }).totalDaos).toBe(1);
  });

  it("says out loud that auto-discovery was off, so an empty inbox is not read as 'all clear'", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 97,
      daos: [TESTNET_DAO],
    });
    expect(String(res.structuredContent?.discoveryUnavailable)).toContain("Chain 97");
    expect(String(res.structuredContent?.discoveryUnavailable)).toContain("auto-discovery is off");
  });

  it("adds no such note on a chain that IS indexed", async () => {
    const res = await callInbox(
      config({ subgraphs: { 56: MAINNET_URLS, 97: TESTNET_URLS } }),
      { user: USER, chainId: 97, daos: [TESTNET_DAO] },
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.discoveryUnavailable).toBeUndefined();
    expect(res.structuredContent?.daoSource).toBe("caller");
  });

  it("rejects an unconfigured RPC chain before any subgraph work", async () => {
    const res = await callInbox(config({ subgraphs: { 56: MAINNET_URLS } }), {
      user: USER,
      chainId: 1,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("chainId=1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dexe_user_inbox description states the chain contract", () => {
  it("advertises the chains that can actually discover on this install", async () => {
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerInboxTools(server, {
      config: config({ subgraphs: { 56: MAINNET_URLS, 97: { pools: TESTNET_URLS.pools } } }),
    } as unknown as ToolContext);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    const inbox = tools.find((t) => t.name === "dexe_user_inbox")!;

    expect(inbox.description).toContain("chains that can auto-discover here: 56, 97");
    expect(inbox.description).toContain("indexedChainId");
    // The stale claim this release removes: discovery capability is a property
    // of the configured endpoints, not of "mainnet vs testnet".
    expect(inbox.description).not.toContain("Testnet: `daos[]` required");
    await client.close();
    await server.close();
  });

  it("reports no discovery chains when nothing is configured", async () => {
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerInboxTools(server, {
      config: config({ subgraphs: {} }),
    } as unknown as ToolContext);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "dexe_user_inbox")!.description).toContain(
      "NO chain can auto-discover here",
    );
    await client.close();
    await server.close();
  });
});
