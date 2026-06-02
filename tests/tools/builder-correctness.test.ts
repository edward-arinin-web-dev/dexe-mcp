import { describe, expect, it } from "vitest";
import { Interface, parseUnits } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import {
  TOKEN_SALE_PROPOSAL_ABI,
  buildTokenSaleMultiActions,
  registerProposalBuildComplexTools,
  tierSchema,
} from "../../src/tools/proposalBuildComplex.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const PURCHASE = "0x2222222222222222222222222222222222222222";
const TSP = "0x3333333333333333333333333333333333333333";
const RECEIVER = "0x4444444444444444444444444444444444444444";

const ERC20 = new Interface([
  "function transfer(address to, uint256 amount)",
  "function mint(address to, uint256 amount)",
]);

function baseTier(vestingPercentage: string) {
  return tierSchema.parse({
    name: "T1",
    totalTokenProvided: "1000000000000000000",
    saleStartTime: "1000",
    saleEndTime: "2000",
    saleTokenAddress: TOKEN,
    purchaseTokenAddresses: [PURCHASE],
    purchaseRatios: ["0.10"],
    vestingSettings: { vestingPercentage, vestingDuration: "100", cliffPeriod: "0", unlockStep: "10" },
  });
}

/**
 * H-10 guardrail. The OTC tier builder encoded vestingPercentage raw ("50"),
 * but the contract reads it as percent × PRECISION (MathHelper.percentage /
 * PERCENTAGE_100 = 1e27). Raw "50" is ~0% vesting on-chain. It must be scaled
 * by PRECISION (1e25), exactly like exchangeRates.
 */
describe("H-10 vesting percentage scaling", () => {
  it("scales vestingPercentage by PRECISION (1e25) in createTiers", () => {
    const { actions } = buildTokenSaleMultiActions({ tokenSaleProposal: TSP, tiers: [baseTier("50")] });
    const createTiers = actions.find((a) => a.data.startsWith("0x6a6effda"));
    expect(createTiers).toBeDefined();
    const decoded = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]).decodeFunctionData(
      "createTiers",
      createTiers!.data,
    );
    const tier0 = decoded[0][0]; // tiers[0]
    const vestingSettings = tier0[10]; // [vestingPercentage, vestingDuration, cliffPeriod, unlockStep]
    expect(vestingSettings[0]).toBe(parseUnits("50", 25)); // 5e26, NOT raw 50
    expect(vestingSettings[0]).not.toBe(50n);
  });

  it("rejects an out-of-range vesting percent (>100)", () => {
    expect(() => buildTokenSaleMultiActions({ tokenSaleProposal: TSP, tiers: [baseTier("150")] })).toThrow(
      /vestingPercentage/,
    );
  });
});

function captureComplexTools() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent: { actions: { executor: string; value: string; data: string }[] } }>>();
  const fake = {
    registerTool: (name: string, _cfg: unknown, cb: (args: Record<string, unknown>) => Promise<never>) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  // config.rpcUrl undefined → checkBlacklist returns "skipped" (no network).
  registerProposalBuildComplexTools(fake, { config: { rpcUrl: undefined } } as unknown as ToolContext);
  return tools as never as Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent: { actions: { executor: string; value: string; data: string }[] } }>>;
}

/**
 * H-4 guardrail. apply_to_dao's short-treasury branch transferred the FULL
 * amount and minted the shortfall — so transfer(total) reverted on-chain when
 * the treasury held less than `total`. It must transfer only what the treasury
 * holds (`have`) and mint the shortfall.
 */
describe("H-4 apply_to_dao transfer amount", () => {
  it("uses a single transfer of the full amount when the treasury covers it", async () => {
    const apply = captureComplexTools().get("dexe_proposal_build_apply_to_dao")!;
    const res = await apply({ token: TOKEN, receiver: RECEIVER, amount: "100", treasuryBalance: "100" });
    const actions = res.structuredContent.actions;
    expect(actions.length).toBe(1);
    expect(ERC20.decodeFunctionData("transfer", actions[0]!.data)[1]).toBe(100n);
  });

  it("transfers only `have` (not `total`) and mints the shortfall when short", async () => {
    const apply = captureComplexTools().get("dexe_proposal_build_apply_to_dao")!;
    const res = await apply({ token: TOKEN, receiver: RECEIVER, amount: "100", treasuryBalance: "30" });
    const actions = res.structuredContent.actions;
    expect(actions.length).toBe(2);
    expect(actions[0]!.data.startsWith("0xa9059cbb")).toBe(true); // transfer
    expect(ERC20.decodeFunctionData("transfer", actions[0]!.data)[1]).toBe(30n); // have, not 100
    expect(ERC20.decodeFunctionData("transfer", actions[0]!.data)[1]).not.toBe(100n);
    expect(actions[1]!.data.startsWith("0x40c10f19")).toBe(true); // mint
    expect(ERC20.decodeFunctionData("mint", actions[1]!.data)[1]).toBe(70n); // shortfall
  });

  it("mints only (no zero-value transfer) when the treasury is empty", async () => {
    const apply = captureComplexTools().get("dexe_proposal_build_apply_to_dao")!;
    const res = await apply({ token: TOKEN, receiver: RECEIVER, amount: "100", treasuryBalance: "0" });
    const actions = res.structuredContent.actions;
    expect(actions.length).toBe(1);
    expect(actions[0]!.data.startsWith("0x40c10f19")).toBe(true); // mint(receiver, 100)
    expect(ERC20.decodeFunctionData("mint", actions[0]!.data)[1]).toBe(100n);
  });
});
