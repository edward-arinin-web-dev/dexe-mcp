import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * Live finding, 2026-09-24: every OTC tool demanded `tokenSaleProposal`, an
 * address that is not readable back from the GovPool — the only places it ever
 * appears are `dexe_dao_create`'s `predicted.govTokenSale` and
 * `dexe_dao_predict_addresses(deployer, name)`. A user who deployed a DAO in
 * one session and opened a sale in the next had to have kept the receipt.
 *
 * The deploy now records the TokenSaleProposal (and DistributionProposal) on
 * the KnownDao, and `dexe_otc_list_sales_for_dao` / `dexe_otc_dao_open_sale`
 * default `tokenSaleProposal` from that record. For a DAO this install did not
 * deploy, the error says where the address comes from.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { RpcProvider } from "../../src/rpc.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import { StateStore, findKnownDao } from "../../src/lib/stateStore.js";

const mc = vi.mocked(multicall);

const GOV = "0xb0Ca396b0441630A6506a1A2bA14dAbF0BD32145";
const TSP = "0x818a913719129CB42c4456C575ebeC36617F2f75";
const SETTINGS = "0x1111111111111111111111111111111111111111";

function config(): DexeConfig {
  return {
    defaultChainId: 97,
    chainId: 97,
    usingPublicRpcFallback: false,
    chains: new Map([[97, { chainId: 97, rpcUrl: "https://rpc.example/97", rpcUrls: ["https://rpc.example/97"] }]]),
    subgraphUrls: new Map(),
  } as unknown as DexeConfig;
}

function stateWith(daos: Array<{ govPool: string; chainId: number; tokenSaleProposal?: string }>): StateStore {
  const store = new StateStore(join(mkdtempSync(join(tmpdir(), "dexe-otc-")), "state.json"));
  for (const d of daos) {
    store.recordDao({ name: "Recorded DAO", deployedAt: "2026-09-24T00:00:00.000Z", ...d });
  }
  return store;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function listSales(args: Record<string, unknown>, state?: StateStore): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerSubgraphTools(server, { config: config() } as unknown as ToolContext, state);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name: "dexe_otc_list_sales_for_dao", arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

beforeEach(() => {
  mc.mockReset();
  vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: {} as never });
  // A GovPool that answers getHelperContracts, and a sale with zero tiers —
  // enough to prove WHICH TokenSaleProposal the tool read.
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string; target: string }>) =>
    calls.map((c) => {
      if (c.method === "getHelperContracts") {
        return { success: true, value: [SETTINGS, SETTINGS, SETTINGS, SETTINGS, SETTINGS] as never, raw: "0x" };
      }
      if (c.method === "latestTierId" && c.target.toLowerCase() === TSP.toLowerCase()) {
        return { success: true, value: 0n as never, raw: "0x" };
      }
      return { success: false, value: null, raw: "0x", error: "not under test" };
    }),
  );
});

describe("findKnownDao", () => {
  it("matches on chain + case-insensitive govPool and never throws", () => {
    const state = stateWith([{ govPool: GOV, chainId: 97, tokenSaleProposal: TSP }]);
    expect(findKnownDao(state, 97, GOV.toLowerCase())?.tokenSaleProposal).toBe(TSP);
    expect(findKnownDao(state, 56, GOV)).toBeNull();
    expect(findKnownDao(undefined, 97, GOV)).toBeNull();
  });
});

describe("dexe_otc_list_sales_for_dao without tokenSaleProposal", () => {
  it("uses the TokenSaleProposal recorded at deploy for this DAO", async () => {
    const state = stateWith([{ govPool: GOV, chainId: 97, tokenSaleProposal: TSP }]);
    const res = await listSales({ govPool: GOV, chainId: 97 }, state);
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain(TSP);
    expect(text(res)).toContain("zero tiers");
  });

  it("an explicit tokenSaleProposal still wins over the record", async () => {
    const OTHER = "0x2222222222222222222222222222222222222222";
    const state = stateWith([{ govPool: GOV, chainId: 97, tokenSaleProposal: TSP }]);
    const res = await listSales({ govPool: GOV, chainId: 97, tokenSaleProposal: OTHER }, state);
    // The mock only answers latestTierId for TSP, so OTHER reverts — which is
    // exactly the evidence that OTHER was the address read.
    expect(text(res)).toContain(OTHER);
    expect(text(res)).not.toContain(TSP);
  });

  it("a DAO this install did not deploy gets told where the address comes from", async () => {
    const state = stateWith([{ govPool: GOV, chainId: 97 }]); // recorded, but pre-0.34.1 (no TSP)
    const res = await listSales({ govPool: GOV, chainId: 97 }, state);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("tokenSaleProposal is required");
    expect(text(res)).toContain("dexe_dao_predict_addresses");
    expect(text(res)).toContain("predicted.govTokenSale");
    expect(mc).not.toHaveBeenCalled();
  });

  it("no state at all behaves the same", async () => {
    const res = await listSales({ govPool: GOV, chainId: 97 });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("tokenSaleProposal is required");
  });
});
