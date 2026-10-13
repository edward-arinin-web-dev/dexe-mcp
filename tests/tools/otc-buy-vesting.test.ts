import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZeroHash, type JsonRpcProvider } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { multicall, RpcProvider, type Call } from "@dexe-network/dexe-mcp/core";
import { VESTING_WITHDRAW_ADVISORY } from "../../src/lib/protocolAdvisories.js";

/**
 * F15 at the point of purchase (1.0.0). On the default two-server setup the
 * position view is the read server's, which names no upstream defect — so
 * `dexe_otc_buyer_buy` itself reads the tier's vesting settings and, for a tier
 * with a vested share, attaches the F15 DANGER block (dryRun included) and
 * refuses a real buy unless `acknowledgeVesting: true`. Non-vesting buys are
 * unchanged. Both surfaces: write-only and standalone.
 */

vi.mock("../../node_modules/@dexe-network/dexe-mcp/dist/lib/multicall.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dexe-network/dexe-mcp/core")>();
  return { ...real, multicall: vi.fn() };
});

const TSP = "0x3333333333333333333333333333333333333333";
const USER = "0x6666666666666666666666666666666666666666";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const tier = (vestingPercentage: bigint) => ({
  tierInitParams: {
    metadata: { name: "T", description: "" },
    totalTokenProvided: 1_000n,
    saleStartTime: 0n,
    saleEndTime: 0n,
    claimLockDuration: 0n,
    saleTokenAddress: TSP,
    purchaseTokenAddresses: [NATIVE],
    exchangeRates: [10n],
    minAllocationPerUser: 0n,
    maxAllocationPerUser: 0n,
    vestingSettings: { vestingPercentage, vestingDuration: 86_400n, cliffPeriod: 0n, unlockStep: 3_600n },
    participationDetails: [],
  },
  tierInfo: { isOff: false, totalSold: 0n, uri: "", vestingTierInfo: { vestingStartTime: 0n, vestingEndTime: 0n } },
  tierAdditionalInfo: { merkleRoot: ZeroHash, merkleUri: "", lastModified: 0n },
});

/** Tier 1 vests 25 % (on-chain ×1e25), tier 2 vests nothing. */
function answer(call: Call): { success: boolean; raw: string; value: unknown } {
  if (call.method === "getTierViews") {
    const offset = (call.args as bigint[])[0]!;
    return { success: true, raw: "0x", value: [tier(offset === 0n ? 25n * 10n ** 25n : 0n)] };
  }
  return { success: false, raw: "0x", value: null };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

const savedEnv = { ...process.env };
let restoreRpc: () => void = () => {};

beforeAll(() => {
  process.env.DEXE_SIGNER_MODE = "readonly"; // payloads only: nothing pairs, nothing signs
  const fake = { getBlock: async () => ({ timestamp: 1 }), getBalance: async () => 0n } as unknown as JsonRpcProvider;
  const a = vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: fake } as never);
  const b = vi.spyOn(RpcProvider.prototype, "requireProvider").mockReturnValue(fake);
  restoreRpc = () => {
    a.mockRestore();
    b.mockRestore();
  };
});

afterAll(() => {
  restoreRpc();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

beforeEach(() => {
  vi.mocked(multicall).mockReset();
  vi.mocked(multicall).mockImplementation(async (_p, calls: Call[]) => calls.map(answer) as never);
});

async function buy(standalone: boolean, args: Record<string, unknown>): Promise<ToolResult> {
  const { loadConfig } = await import("../../src/config.js");
  const { registerAll } = await import("../../src/tools/index.js");
  const server = new McpServer({ name: "otc-buy-vesting", version: "0" }, {});
  registerAll(server, { ...(await loadConfig()), writeStandalone: standalone });
  const client = new Client({ name: "c", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.callTool({
      name: "dexe_otc_buyer_buy",
      arguments: { tokenSaleProposal: TSP, tokenToBuyWith: NATIVE, amount: "1.0", user: USER, chainId: 97, ...args },
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

for (const standalone of [false, true]) {
  describe(`dexe_otc_buyer_buy F15 (${standalone ? "standalone" : "write-only"})`, () => {
    it("dryRun into a vesting tier: the DANGER block, not acknowledged, nothing refused", async () => {
      const r = await buy(standalone, { tierId: "1", dryRun: true });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent!.vestingBlocked).toMatchObject({
        tierId: "1",
        vestingPercentage: "25",
        acknowledged: false,
        reason: VESTING_WITHDRAW_ADVISORY.text,
      });
      expect(text(r)).toContain("DANGER");
    });

    it("a real buy into a vesting tier is refused without acknowledgeVesting", async () => {
      const r = await buy(standalone, { tierId: "1" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("acknowledgeVesting: true");
      expect(text(r)).toContain("F15");
    });

    it("acknowledgeVesting: true builds it, carrying the block", async () => {
      const r = await buy(standalone, { tierId: "1", acknowledgeVesting: true });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent!.vestingBlocked).toMatchObject({ acknowledged: true, vestingPercentage: "25" });
    });

    it("a tier with no vested share is unchanged: no block, no acknowledgement needed", async () => {
      const r = await buy(standalone, { tierId: "2" });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent!.vestingBlocked).toBeUndefined();
      expect(r.structuredContent!.vestingCheck).toBeUndefined();
    });
  });
}
