import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JsonRpcProvider } from "ethers";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { RpcProvider } from "../../src/rpc.js";
import { labelProposalSettings } from "../../src/tools/read.js";

/**
 * 0.34.0 — read tools emitted bare wei with no human sibling, so the agent had
 * to do 18-decimal arithmetic in its head. The units rule is NOT uniform and
 * getting it backwards is the same digit-shift bug:
 *
 *   - raw ERC20 balances (treasury rows, backend holder lists) are in the
 *     TOKEN's decimals, which must be READ — never guessed;
 *   - everything held inside DeXe governance (voting power, deposits, rewards,
 *     credit limits, minVotesFor*) is ALWAYS 18-decimal-normalized, because
 *     GovUserKeeper stores `balanceOf(voter).to18(token)` and TokenBalance
 *     applies `from18` only on payout.
 */

const HOLDER = "0xb562127efdc97b417b3116eff2c23a29857c0f0b";
// DeXe DAO's real native balance on BSC: 0.0000730011 BNB.
const NATIVE_WEI = 73001100000000n;

function fakeProvider(): JsonRpcProvider {
  return {
    getBalance: async () => NATIVE_WEI,
    call: async () => {
      throw new Error("no RPC in this test");
    },
  } as unknown as JsonRpcProvider;
}

async function call(name: string, args: Record<string, unknown>) {
  process.env.DEXE_TOOLSETS = "core,read";
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.listTools();
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

const realFetch = globalThis.fetch;

/** The exact backend wallet-balances shape, with the live DeXe DAO rows. */
function stubBalances(rows: Array<Record<string, unknown>>) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ balances: rows, next_page_token: "" }),
    text: async () => "",
  })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: fakeProvider() });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.DEXE_TOOLSETS;
});

describe("dexe_read_treasury renders amounts without losing a digit", () => {
  it("adds a formatted sibling per row and leaves the wei byte-identical", async () => {
    stubBalances([
      {
        token_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        symbol: "BNB",
        name: "Binance Chain Native Token",
        decimals: "18",
        balance: "73001100000000",
        usd_price: "728.4056241955111",
      },
      {
        token_address: "0x6e88056e8376ae7709496ba64d37fa2f8015ce3e",
        symbol: "DEXE",
        name: "Dexe",
        decimals: "18",
        balance: "1282179760730788225547277",
        usd_price: "1.8746876342632222",
      },
      // 8-decimal token from the same live treasury — the case a blanket 18
      // would render 1e10 times too small.
      {
        token_address: "0x9f8b8fe01b26957cf3dcd6fbd3675053ba2c02c8",
        symbol: "CARIB",
        name: "Carib DAO",
        decimals: "8",
        balance: "28189512038297",
        usd_price: "0",
      },
    ]);
    const r = await call("dexe_read_treasury", { holder: HOLDER, chainId: 56 });
    expect(r.isError).toBe(false);
    const tokens = r.structured.tokens as Array<Record<string, unknown>>;

    // Back-compat: the wei strings are untouched.
    expect(tokens[1]!.balance).toBe("1282179760730788225547277");
    expect(tokens[1]!.balanceFormatted).toBe("1282179.760730788225547277 DEXE");
    expect(tokens[2]!.balanceFormatted).toBe("281895.12038297 CARIB");
    expect(r.structured.native).toBe("73001100000000");
    expect(r.structured.nativeFormatted).toBe("0.0000730011 BNB");
  });

  it("computes USD from the exact balance, not from Number(wei)", async () => {
    // Number("8521112653712523724538372026") is 8521112653.712523 — the low
    // digits are gone before the division ever happens.
    stubBalances([
      {
        token_address: "0x9f5d4479b783327b61718fa13b3a0583869a80c1",
        symbol: "BOXY",
        decimals: "18",
        balance: "8521112653712523724538372026",
        usd_price: "1",
      },
    ]);
    const r = await call("dexe_read_treasury", { holder: HOLDER, chainId: 56 });
    expect(r.structured.totalUsd).toBeCloseTo(8521112653.712524, 5);
    expect(r.text).toContain("8521112653.712523724538372026");
  });

  it("NEVER guesses 18 when the token does not report decimals", async () => {
    stubBalances([
      {
        token_address: "0x0368827ed3a4dd82d20c1efea3b53b3c9b4d1f45",
        symbol: "DiyTronORG",
        balance: "8888",
      },
    ]);
    const r = await call("dexe_read_treasury", { holder: HOLDER, chainId: 56 });
    const tokens = r.structured.tokens as Array<Record<string, unknown>>;
    expect(tokens[0]!.decimals).toBeNull();
    expect(tokens[0]).not.toHaveProperty("balanceFormatted");
  });

  it("flags a wallet cut off by the backend page ceiling instead of reporting it whole", async () => {
    let page = 0;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [
          { token_address: `0x${String(page).padStart(40, "0")}`, symbol: "T", decimals: "18", balance: "1" },
        ],
        // A fresh cursor on every page: the loop exits on its own 20-page bound.
        next_page_token: `cursor-${page++}`,
      }),
      text: async () => "",
    })) as unknown as typeof globalThis.fetch;
    const r = await call("dexe_read_treasury", { holder: HOLDER, chainId: 56 });
    expect(r.structured.degraded).toBe(true);
    expect(r.text).toContain("PARTIAL");
  });
});

describe("governance amounts are 18-decimal-normalized, never the token's decimals", () => {
  it("labelProposalSettings renders minVotesForVoting / minVotesForCreating", () => {
    // GovUserKeeper.to18 means these are power units even for a 6-dec gov
    // token. This is the number behind "low creating power".
    const out = labelProposalSettings([
      true, true, true, "3600", "3600", "0", "50000000000000000000000000",
      "50000000000000000000000000", "1000000000000000000", "2500000000000000000",
      ["0x0000000000000000000000000000000000000000", "0", "0", "0"],
      "default",
    ]) as Record<string, unknown>;
    expect(out.minVotesForVotingFormatted).toBe("1.0");
    expect(out.minVotesForCreatingFormatted).toBe("2.5");
    // The existing derived percentages are untouched.
    expect(out.quorumPct).toBe(5);
  });
});
