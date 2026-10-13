import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZeroHash, type JsonRpcProvider } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { multicall, RpcProvider, tokenSaleResult, type Call } from "@dexe-network/dexe-mcp/core";
import { createReadServer, loadReadConfig } from "@dexe-network/dexe-mcp";
import { VESTING_WITHDRAW_ADVISORY } from "../../src/lib/protocolAdvisories.js";
import { attachVestingWithdrawAdvisory } from "../../src/tools/tokenSaleF15.js";

/**
 * M1 — F15 on `dexe_read_token_sale_position` (and its alias
 * `dexe_otc_buyer_status`) in the WRITE server.
 *
 * The tool is the read edition's; for a vested tier it says only a neutral
 * `vestingNote` (by design: the read edition does not describe upstream
 * defects). This server sells and claims through those tiers, so it replaces
 * that note with the F15 DANGER block — the vested leg cannot be withdrawn on
 * current pools — exactly as the tool returned it before the read code moved
 * out (src/tools/tokenSaleF15.ts, wired in registerAll).
 *
 * The tool calls multicall from inside @dexe-network/dexe-mcp, so the stub
 * replaces the package's own multicall module (vitest.config.ts inlines the
 * package, which is what makes the path mockable).
 */

vi.mock("../../node_modules/@dexe-network/dexe-mcp/dist/lib/multicall.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dexe-network/dexe-mcp/core")>();
  return { ...real, multicall: vi.fn() };
});

const TSP = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const PURCHASE = "0x5555555555555555555555555555555555555555";
const USER = "0x6666666666666666666666666666666666666666";

const tier = (name: string, vestingPercentage: bigint) => ({
  tierInitParams: {
    metadata: { name, description: `${name} tier` },
    totalTokenProvided: 1_000n,
    saleStartTime: 1_700_000_000n,
    saleEndTime: 1_700_086_400n,
    claimLockDuration: 0n,
    saleTokenAddress: TOKEN,
    purchaseTokenAddresses: [PURCHASE],
    exchangeRates: [10n],
    minAllocationPerUser: 0n,
    maxAllocationPerUser: 0n,
    vestingSettings: { vestingPercentage, vestingDuration: 86_400n, cliffPeriod: 0n, unlockStep: 3_600n },
    participationDetails: [],
  },
  tierInfo: { isOff: false, totalSold: 0n, uri: "", vestingTierInfo: { vestingStartTime: 0n, vestingEndTime: 0n } },
  tierAdditionalInfo: { merkleRoot: ZeroHash, merkleUri: "", lastModified: 0n },
});

const USER_VIEW = {
  canParticipate: true,
  purchaseView: { isClaimed: false, canClaim: false, claimUnlockTime: 0n, claimTotalAmount: 0n, boughtTotalAmount: 0n },
  vestingUserView: {
    latestVestingWithdraw: 0n,
    nextUnlockTime: 0n,
    nextUnlockAmount: 0n,
    vestingTotalAmount: 10n,
    vestingWithdrawnAmount: 0n,
    amountToWithdraw: 4n,
    lockedAmount: 6n,
  },
};

function answer(call: Call): { success: boolean; raw: string; value: unknown } {
  const value = (v: unknown) => ({ success: true, raw: "0x", value: v });
  if (call.method === "getTierViews") return value([tier("Vested", 25n * 10n ** 25n), tier("Instant", 0n)]);
  if (call.method === "getUserViews") return value([USER_VIEW, USER_VIEW]);
  return { success: false, raw: "0x", value: null };
}

const ARGS = { tokenSaleProposal: TSP, user: USER, tierIds: ["1", "2"] };
const F15_BLOCK = { reason: VESTING_WITHDRAW_ADVISORY.text, upstream: VESTING_WITHDRAW_ADVISORY.upstream };

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
type Tier = Record<string, unknown>;
const tiersOf = (r: ToolResult) => (r.structuredContent!.tiers as Tier[]);

const savedEnv = { ...process.env };
let restoreRpc: () => void = () => {};

beforeAll(() => {
  const fake = { getBlock: async () => ({ timestamp: 1_700_000_100 }), getBalance: async () => 0n } as unknown as JsonRpcProvider;
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

async function call(server: McpServer, name: string): Promise<ToolResult> {
  const client = new Client({ name: "f15-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return (await client.callTool({ name, arguments: ARGS })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

async function writeServer(): Promise<McpServer> {
  process.env.DEXE_TOOLSETS = "full";
  const { loadConfig } = await import("../../src/config.js");
  const { registerAll } = await import("../../src/tools/index.js");
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, await loadConfig());
  return server;
}

describe("the write server attaches F15 to vested tiers", () => {
  it.each(["dexe_read_token_sale_position", "dexe_otc_buyer_status"])("%s", async (name) => {
    const res = await call(await writeServer(), name);
    expect(res.isError, JSON.stringify(res)).toBeFalsy();
    const [vested, instant] = tiersOf(res);
    // the vested tier: F15 in place of the read edition's note, after `user`, before anything else
    expect(vested!.vestingWithdrawBlocked).toEqual(F15_BLOCK);
    expect(vested).not.toHaveProperty("vestingNote");
    const keys = Object.keys(vested!);
    expect(keys.indexOf("vestingWithdrawBlocked")).toBe(keys.indexOf("user") + 1);
    expect(String((vested!.vestingWithdrawBlocked as Tier).reason)).toMatch(/UPSTREAM PROTOCOL DEFECT F15/);
    // the instant tier: nothing to warn about
    expect(instant).not.toHaveProperty("vestingWithdrawBlocked");
    expect(instant).not.toHaveProperty("vestingNote");
    // both channels say the same thing
    expect(JSON.parse(res.content[0]!.text!)).toEqual(res.structuredContent);
    expect(res.content[0]!.text).toContain("UPSTREAM PROTOCOL DEFECT F15");
  });
});

describe("the read edition keeps its own note (by design)", () => {
  it("dexe-mcp-read's dexe_read_token_sale_position carries vestingNote, not F15", async () => {
    const server = createReadServer(await loadReadConfig(), { remote: false, version: "0.0.0" });
    const res = await call(server, "dexe_read_token_sale_position");
    const [vested] = tiersOf(res);
    expect(vested).toHaveProperty("vestingNote");
    expect(vested).not.toHaveProperty("vestingWithdrawBlocked");
    expect(res.content[0]!.text).not.toContain("F15");
  });
});

describe("attachVestingWithdrawAdvisory", () => {
  const payload = (tiers: Tier[]) => tokenSaleResult({ tokenSaleProposal: TSP, user: USER, tiers });

  it("swaps the note on vested tiers only, keeps every other key and the provenance line", () => {
    const before = payload([
      { tierId: "1", vestingSettings: { vestingPercentage: 5n }, user: {}, vestingNote: "neutral", merkle: { root: "0x" } },
      { tierId: "2", vestingSettings: { vestingPercentage: 0n }, user: {} },
    ]);
    const after = attachVestingWithdrawAdvisory(before);
    const [a, b] = (after.structuredContent as { tiers: Tier[] }).tiers;
    expect(Object.keys(a!)).toEqual(["tierId", "vestingSettings", "user", "vestingWithdrawBlocked", "merkle"]);
    expect(a!.vestingWithdrawBlocked).toEqual(F15_BLOCK);
    expect(b).toEqual((before.structuredContent as { tiers: Tier[] }).tiers[1]);
    expect((after.structuredContent as Tier)._untrustedContent).toBe((before.structuredContent as Tier)._untrustedContent);
    expect(JSON.parse(after.content[0]!.text)).toEqual(after.structuredContent);
  });

  it("adds the block to a vested tier that has no note, and leaves errors alone", () => {
    const after = attachVestingWithdrawAdvisory(payload([{ tierId: "1", vestingSettings: { vestingPercentage: "7" } }]));
    expect((after.structuredContent as { tiers: Tier[] }).tiers[0]!.vestingWithdrawBlocked).toEqual(F15_BLOCK);
    const error = { isError: true, content: [{ type: "text", text: "boom" }] };
    expect(attachVestingWithdrawAdvisory(error)).toBe(error);
  });
});
