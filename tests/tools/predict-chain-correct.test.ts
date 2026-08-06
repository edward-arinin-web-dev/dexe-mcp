import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * 0.30.2 / M1 — `dexe_proposal_forecast` must not splice one chain's proposal
 * history into another chain's forecast.
 *
 * The tool gated on `resolvedChainId === 56` and then read the FLAT
 * `config.subgraphPoolsUrl`. That pairing was only safe while the flat field
 * was unconditionally BSC mainnet; `DEXE_SUBGRAPH_CHAIN_ID` can now file it
 * under any chain, so the gate and the endpoint could disagree. The failure was
 * silent — the subgraph leg is soft-fail, so foreign rows would have arrived
 * inside a normal-looking forecast.
 *
 * Everything here is offline: `multicall` is mocked (the on-chain half) and
 * `fetch` is mocked (the subgraph half), so which endpoint — if any — the tool
 * reaches for is directly observable.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { registerPredictTools } from "../../src/tools/predict.js";

const mc = vi.mocked(multicall);

const GOV = "0xbb1918019af8c6a26ff34ce8fb8305976e1f626d";
const SETTINGS = "0x1111111111111111111111111111111111111111";

const MAINNET_POOLS = "https://gw.example/56/pools";
const TESTNET_POOLS = "https://gw.example/97/pools";

/** A row id that exists ONLY on the mainnet endpoint — a cross-chain leak marker. */
const MAINNET_PROPOSAL_ROW = { id: "0xmainnetproposal0000000000000000000000001", proposalId: "9" };

function config(urls: Record<number, SubgraphEndpoints>, defaultChainId = 56): DexeConfig {
  const chain = (chainId: number) => ({
    chainId,
    rpcUrl: `https://rpc.example/${chainId}`,
    rpcUrls: [`https://rpc.example/${chainId}`],
  });
  return {
    defaultChainId,
    chainId: defaultChainId,
    usingPublicRpcFallback: false,
    chains: new Map([
      [56, chain(56)],
      [97, chain(97)],
    ]),
    subgraphUrls: new Map(Object.entries(urls).map(([k, v]) => [Number(k), v])),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function forecast(cfg: DexeConfig, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerPredictTools(server, { config: cfg } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({
      name: "dexe_proposal_forecast",
      arguments: { govPool: GOV, ...args },
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const payload = (r: ToolResult) => JSON.parse(text(r)) as Record<string, unknown>;

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // On-chain half: helpers + latestProposalId, then settings + one executed
  // proposal. Enough for the forecast to complete on any chain.
  mc.mockImplementation(async (_p: unknown, calls: Array<{ method: string }>) =>
    calls.map((c) => {
      switch (c.method) {
        case "getHelperContracts":
          return { success: true, value: { settings: SETTINGS } as never, raw: "0x" };
        case "latestProposalId":
          return { success: true, value: 1n as never, raw: "0x" };
        case "getDefaultSettings":
          return { success: true, value: { quorum: 100n } as never, raw: "0x" };
        case "getProposals":
          return {
            success: true,
            value: [
              {
                proposal: { core: { executed: true, votesFor: 500n, votesAgainst: 0n } },
                proposalState: 7, // ExecutedFor
              },
            ] as never,
            raw: "0x",
          };
        default:
          return { success: false, error: `unexpected ${c.method}`, raw: "0x" };
      }
    }),
  );

  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: { proposals: [MAINNET_PROPOSAL_ROW] } }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mc.mockReset();
});

describe("dexe_proposal_forecast resolves the pools subgraph per chain", () => {
  it("chain 56 uses the mainnet endpoint and reports indexedChainId 56", async () => {
    const res = await forecast(config({ 56: { pools: MAINNET_POOLS }, 97: { pools: TESTNET_POOLS } }), {
      chainId: 56,
    });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.indexedChainId).toBe(56);
    expect(fetchMock.mock.calls[0]![0]).toBe(MAINNET_POOLS);
    expect(p.subgraphHistory).toEqual([MAINNET_PROPOSAL_ROW]);
  });

  it("chain 97 uses the chain-97 endpoint once one is configured", async () => {
    const res = await forecast(config({ 56: { pools: MAINNET_POOLS }, 97: { pools: TESTNET_POOLS } }), {
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(payload(res).indexedChainId).toBe(97);
    expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_POOLS);
  });

  it("a chain with no endpoint stops with the env var to set, and reads nothing", async () => {
    const res = await forecast(config({ 56: { pools: MAINNET_POOLS } }), { chainId: 97 });
    const p = payload(res);
    expect(p.error).toBe("subgraph required");
    expect(String(p.hint)).toContain("chain 97");
    expect(String(p.hint)).toContain("DEXE_SUBGRAPH_POOLS_URL_97");
    expect(String(p.hint)).toContain("forceRpcOnly");
    // The point: no mainnet history can have reached a chain-97 caller.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(res)).not.toContain("0xmainnetproposal");
  });

  it("forceRpcOnly forecasts an unindexed chain WITHOUT borrowing another chain's history", async () => {
    const res = await forecast(config({ 56: { pools: MAINNET_POOLS } }), {
      chainId: 97,
      forceRpcOnly: true,
    });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.chain).toBe(97);
    // On-chain half still answers…
    expect((p.historicalPassRate as { total: number }).total).toBe(1);
    // …and the history block is visibly absent rather than mainnet's.
    expect(p.subgraphHistory).toBeNull();
    expect(p.indexedChainId).toBeNull();
    expect(String(p.subgraphNote)).toContain("chain 97");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(res)).not.toContain("0xmainnetproposal");
  });
});

describe("DEXE_SUBGRAPH_CHAIN_ID=97 no longer falsifies the chain-56 path", () => {
  // The flat config.subgraphPoolsUrl now points at a TESTNET indexer. The old
  // `chainId === 56` gate would have passed and then queried it.
  const testnetOnly = () => config({ 97: { pools: TESTNET_POOLS } });

  it("a chain-56 forecast refuses instead of querying the chain-97 indexer", async () => {
    const res = await forecast(testnetOnly(), { chainId: 56 });
    const p = payload(res);
    expect(p.error).toBe("subgraph required");
    expect(String(p.hint)).toContain("chain 56");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with forceRpcOnly the chain-56 forecast still never touches the chain-97 indexer", async () => {
    const res = await forecast(testnetOnly(), { chainId: 56, forceRpcOnly: true });
    expect(res.isError).toBeFalsy();
    expect(payload(res).indexedChainId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("chain 97 IS answered from that indexer — it is the chain it indexes", async () => {
    const res = await forecast(testnetOnly(), { chainId: 97 });
    expect(res.isError).toBeFalsy();
    expect(payload(res).indexedChainId).toBe(97);
    expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_POOLS);
  });
});

describe("omitting chainId follows the default chain", () => {
  it("a testnet-default install with only mainnet endpoints does not fall back to mainnet", async () => {
    const res = await forecast(config({ 56: { pools: MAINNET_POOLS } }, 97), {});
    const p = payload(res);
    expect(p.error).toBe("subgraph required");
    expect(p.chain).toBe(97);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
