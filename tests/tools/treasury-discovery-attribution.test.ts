import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AbiCoder, type JsonRpcProvider } from "ethers";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { RpcProvider } from "../../src/rpc.js";

/**
 * 0.30.4 — "everything explains itself", discovery edition.
 *
 * dexe_read_treasury's gov-token auto-discovery had a bare `catch {}`. Whatever
 * went wrong — a dead RPC, an unreachable Multicall3, a keyed endpoint 401ing —
 * the caller got one sentence: "token auto-discovery is unavailable on this path
 * (the backend covers mainnets only)". That blames a benign structural fact for
 * a transport failure, so the user goes and configures a backend that was never
 * the problem. It is the same misattribution shape 0.30.2 was burned by.
 *
 * The distinction is real and cheap to make: both discovery calls use
 * `allowFailure`, so a non-GovPool address comes back as `success: false` and
 * CANNOT throw. A throw is therefore always transport.
 */

const HOLDER = "0x2546f00b2cb0e1ba0e63c1a5b4b0b0e0e0e0e0e0";
const USER_KEEPER = "0x3333333333333333333333333333333333333333";
const GOV_TOKEN = "0x4444444444444444444444444444444444444444";
const NATIVE_WEI = 4_200_000_000_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000";

const coder = AbiCoder.defaultAbiCoder();

/** Encode a Multicall3 `aggregate3` return: (bool success, bytes returnData)[]. */
function aggregate3Return(rows: Array<{ success: boolean; returnData: string }>): string {
  return coder.encode(["tuple(bool,bytes)[]"], [rows.map((r) => [r.success, r.returnData])]);
}

const FAILED_CALL = { success: false, returnData: "0x" };

/**
 * Provider whose `call` (the Multicall3 staticCall) is driven by `onCall`, so a
 * test can choose between "reverted inner call" and "transport blew up".
 */
function fakeProvider(onCall: (n: number) => string): JsonRpcProvider {
  let n = 0;
  return {
    getBalance: async () => NATIVE_WEI,
    call: async () => onCall(n++),
  } as unknown as JsonRpcProvider;
}

interface TreasuryOut {
  holder: string;
  chainId: number;
  source: "backend" | "rpc";
  degraded: boolean;
  native: string;
  tokens: Array<{ token: string }>;
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

function useProvider(onCall: (n: number) => string): void {
  vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: fakeProvider(onCall) });
}

beforeEach(() => {
  // Chain 97 keeps the backend out of the way: `useBackend` is false, so the
  // ONLY thing that can go wrong is the on-chain discovery read. That isolates
  // the attribution under test.
  vi.stubGlobal("fetch", async () => {
    throw new Error("no backend in this test");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DEXE_TOOLSETS;
});

describe("dexe_read_treasury — gov-token discovery attribution", () => {
  it("reports a transport failure as a transport failure, not as backend scope", async () => {
    useProvider(() => {
      throw new Error("could not detect network");
    });

    const { isError, text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    expect(isError).toBe(false);
    // The real cause, named.
    expect(text).toMatch(/DISCOVERY FAILED/);
    expect(text).toMatch(/could not detect network/);
    expect(text).toMatch(/transport error/);
    // And the explicit denial of the wrong conclusion the old text invited.
    expect(text).toMatch(/NOT evidence that .* is not a\s+GovPool/s);
    expect(text).toMatch(/Re-run once the RPC/s);
    // It must NOT claim the address simply isn't a GovPool — nothing was proven.
    expect(text).not.toMatch(/is not a DeXe GovPool/);
  });

  it("reports a non-GovPool holder as exactly that — no transport blame", async () => {
    // aggregate3 itself succeeds; the inner getHelperContracts call reverts.
    useProvider(() => aggregate3Return([FAILED_CALL]));

    const { isError, text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    expect(isError).toBe(false);
    expect(text).toMatch(/is not a DeXe GovPool \(getHelperContracts reverted\)/);
    expect(text).not.toMatch(/DISCOVERY FAILED/);
    expect(text).not.toMatch(/transport error/);
  });

  it("distinguishes a GovPool whose UserKeeper has no ERC20 gov token", async () => {
    useProvider((n) =>
      n === 0
        ? aggregate3Return([
            {
              success: true,
              returnData: coder.encode(
                ["address", "address", "address", "address", "address"],
                [ZERO, USER_KEEPER, ZERO, ZERO, ZERO],
              ),
            },
          ])
        : aggregate3Return([{ success: true, returnData: coder.encode(["address"], [ZERO]) }]),
    );

    const { text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    // An NFT-governed DAO is a real, benign answer — and a THIRD outcome, which
    // the single swallowed catch could never express.
    expect(text).toMatch(/no ERC20 gov token/);
    expect(text).toMatch(/NFT-governed or not initialized/);
    expect(text).not.toMatch(/DISCOVERY FAILED/);
  });

  it("still auto-discovers the gov token when the reads succeed", async () => {
    useProvider((n) => {
      if (n === 0) {
        return aggregate3Return([
          {
            success: true,
            returnData: coder.encode(
              ["address", "address", "address", "address", "address"],
              [ZERO, USER_KEEPER, ZERO, ZERO, ZERO],
            ),
          },
        ]);
      }
      if (n === 1) {
        return aggregate3Return([{ success: true, returnData: coder.encode(["address"], [GOV_TOKEN]) }]);
      }
      // Final balanceOf/symbol/decimals batch for the discovered token.
      return aggregate3Return([FAILED_CALL, FAILED_CALL, FAILED_CALL]);
    });

    const { out, text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    expect(out.tokens.map((t) => t.token)).toEqual([GOV_TOKEN]);
    expect(text).toMatch(/showing the DAO's own gov token only/);
    expect(text).not.toMatch(/DISCOVERY FAILED/);
  });

  it("keeps the backend-scope note alongside the discovery cause — they are separate facts", async () => {
    useProvider(() => {
      throw new Error("multicall3 unreachable");
    });

    const { text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    // Why the backend was not used (structural) AND what actually failed here
    // (transport). Printing only the first is what made the bug.
    expect(text).toMatch(/the backend covers mainnets only/);
    expect(text).toMatch(/multicall3 unreachable/);
  });

  it("redacts a credentialed RPC URL out of the discovery reason", async () => {
    // W36: ethers appends the request URL to err.message on any non-2xx, so an
    // un-redacted reason would put the operator's billable key in the transcript.
    useProvider(() => {
      throw new Error(
        "server response 401 Unauthorized (url=https://bsc.example.io/v2/SUPERSECRETKEY123)",
      );
    });

    const { text } = await callTreasury({ holder: HOLDER, chainId: 97 });

    expect(text).toMatch(/DISCOVERY FAILED/);
    expect(text).not.toContain("SUPERSECRETKEY123");
    expect(text).toContain("bsc.example.io");
  });
});
