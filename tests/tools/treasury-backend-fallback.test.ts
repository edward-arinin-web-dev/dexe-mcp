import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JsonRpcProvider } from "ethers";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { RpcProvider } from "../../src/rpc.js";

/**
 * 0.30.2 — dexe_read_treasury used to `return errorResult(...)` when the DeXe
 * backend fetch failed, while its own description, docs/PLAYBOOK.md and the
 * knowledge corpus all promised an on-chain fallback. The on-chain code existed
 * a few lines below and was simply unreachable. These tests pin the fallback and
 * the `degraded` / `backendError` signal a caller needs to tell the two apart.
 */

const HOLDER = "0x2546f00b2cb0e1ba0e63c1a5b4b0b0e0e0e0e0e0";
const NATIVE_WEI = 4_200_000_000_000_000n;

interface TreasuryOut {
  holder: string;
  chainId: number;
  source: "backend" | "rpc";
  degraded: boolean;
  native: string;
  totalUsd: number | null;
  tokens: unknown[];
}

/**
 * Minimal ContractRunner. `getBalance` is the only call the RPC treasury path
 * makes without a token list; `call` must exist and throw so the GovPool
 * gov-token discovery multicall takes its documented "not a GovPool" branch
 * instead of hitting a real network.
 */
function fakeProvider(): JsonRpcProvider {
  return {
    getBalance: async () => NATIVE_WEI,
    call: async () => {
      throw new Error("no RPC in this test");
    },
  } as unknown as JsonRpcProvider;
}

async function callTreasury(args: Record<string, unknown>) {
  process.env.DEXE_TOOLSETS = "core";
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const res = await client.callTool({ name: "dexe_read_treasury", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: res.isError === true, text, out: res.structuredContent as unknown as TreasuryOut };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("dexe_read_treasury backend fallback", () => {
  beforeEach(() => {
    vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: fakeProvider() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.DEXE_TOOLSETS;
  });

  it("falls through to the RPC path when the backend errors", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("backend exploded");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { isError, out, text } = await callTreasury({ holder: HOLDER, chainId: 56 });

    expect(fetchSpy).toHaveBeenCalled(); // the backend really was attempted
    expect(isError).toBe(false);
    expect(out.source).toBe("rpc");
    expect(out.degraded).toBe(true);
    expect(out.native).toBe(NATIVE_WEI.toString());
    expect(out.chainId).toBe(56);
    // The backend's own failure reason must reach the caller, not just "degraded".
    expect(text).toMatch(/DEGRADED/);
    expect(text).toMatch(/backend exploded/);
  });

  it("reports a degraded answer as such instead of passing it off as complete", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("backend HTTP 503");
    });

    const { out, text } = await callTreasury({ holder: HOLDER, chainId: 56 });

    // No USD and no token discovery on this path — the caller must be able to
    // see that, otherwise an empty `tokens` array reads as "empty treasury".
    expect(out.totalUsd).toBeNull();
    expect(out.tokens).toEqual([]);
    expect(text).toMatch(/token auto-discovery is unavailable on this path \(the backend fetch failed\)/);
  });

  it("does not mark the answer degraded when the backend succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            balances: [
              {
                token_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                symbol: "BNB",
                decimals: "18",
                balance: NATIVE_WEI.toString(),
                usd_price: "600",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { isError, out, text } = await callTreasury({ holder: HOLDER, chainId: 56 });

    expect(isError).toBe(false);
    expect(out.source).toBe("backend");
    expect(out.degraded).toBe(false);
    expect(out.native).toBe(NATIVE_WEI.toString());
    expect(text).not.toMatch(/DEGRADED/);
  });

  it("never marks chain 97 degraded — the backend is not expected to cover testnet", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { isError, out, text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isError).toBe(false);
    expect(out.source).toBe("rpc");
    expect(out.degraded).toBe(false);
    expect(text).not.toMatch(/DEGRADED/);
    expect(text).toMatch(/the backend covers mainnets only/);
  });
});
