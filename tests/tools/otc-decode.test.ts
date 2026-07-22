import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  ETHEREUM_ADDRESS,
  GET_TIER_VIEWS_FRAGMENT,
  isNativeSentinel,
} from "../../src/tools/otc.js";
import {
  TOKEN_SALE_PROPOSAL_ABI,
  buildTierTuple,
} from "../../src/tools/proposalBuildComplex.js";

/**
 * OTC alignment guardrails (2026-07-03 contract/frontend audit):
 *
 * 1. Native-coin sentinel — `TokenSaleProposalBuy` keys exchange rates by
 *    `Globals.sol::ETHEREUM_ADDRESS` (0xEeee…EEeE) and reverts
 *    "TSP: incorrect token" for the zero address. Buy builders must emit
 *    ETHEREUM_ADDRESS in calldata even when the caller passes 0x000…000.
 *
 * 2. TierView decode — `getTierViews` returns the NESTED
 *    `{ tierInitParams, tierInfo, tierAdditionalInfo }` struct. The old flat
 *    decode ABI (saleTokenAddress before claimLockDuration, reversed
 *    VestingSettings) silently decoded garbage against live tiers.
 */

describe("native-coin sentinel", () => {
  it("matches the protocol ETHEREUM_ADDRESS constant (Globals.sol)", () => {
    expect(ETHEREUM_ADDRESS).toBe("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
  });

  it("accepts zero address and ETHEREUM_ADDRESS (any case) as native", () => {
    expect(isNativeSentinel("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isNativeSentinel(ETHEREUM_ADDRESS)).toBe(true);
    expect(isNativeSentinel(ETHEREUM_ADDRESS.toLowerCase())).toBe(true);
    expect(isNativeSentinel(`0x${ETHEREUM_ADDRESS.slice(2).toUpperCase()}`)).toBe(true);
  });

  it("rejects ordinary ERC20 addresses", () => {
    expect(isNativeSentinel("0x55d398326f99059fF775485246999027B3197955")).toBe(false);
  });

  it("tier builder rejects a zero-address purchase token (unbuyable tier)", () => {
    const tier = {
      name: "Native Tier",
      description: "",
      totalTokenProvided: "1000",
      saleStartTime: String(Math.floor(Date.now() / 1000) + 3600),
      saleEndTime: String(Math.floor(Date.now() / 1000) + 7 * 86400),
      claimLockDuration: "0",
      saleTokenAddress: "0x77a6Ce0E5166d4c129E07951aD1c56210b66C763",
      purchaseTokenAddresses: ["0x0000000000000000000000000000000000000000"],
      exchangeRates: ["10000000000000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "0",
        vestingDuration: "0",
        cliffPeriod: "0",
        unlockStep: "0",
      },
      participation: [],
    };
    expect(() => buildTierTuple(tier)).toThrow(/ETHEREUM_ADDRESS/);
    // The sentinel itself is a valid purchase token.
    expect(() =>
      buildTierTuple({ ...tier, purchaseTokenAddresses: [ETHEREUM_ADDRESS] }),
    ).not.toThrow();
  });
});

describe("TierView decode ABI (nested — mirrors ITokenSaleProposal.TierView)", () => {
  const iface = new Interface([GET_TIER_VIEWS_FRAGMENT]);

  it("tierInitParams layout is byte-identical to createTiers' TierInitParams", () => {
    // createTiers encoding is byte-locked against the frontend (Bug #25 +
    // tests/compat fixtures). The read-side tierInitParams component must be
    // the exact same tuple or reads decode garbage.
    const createIface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
    const initParams = createIface.getFunction("createTiers")!.inputs[0]!.arrayChildren!;
    const viewInit = iface.getFunction("getTierViews")!.outputs[0]!.arrayChildren!
      .components![0]!;
    expect(viewInit.format()).toBe(initParams.format());
  });

  it("round-trips a TierView with fields landing on the right names", () => {
    const SALE_TOKEN = "0x77a6Ce0E5166d4c129E07951aD1c56210b66C763";
    const ROOT = `0x${"ab".repeat(32)}`;
    const tierView = [
      [
        ["Tier 1", "desc"],
        1000n, // totalTokenProvided
        111n, // saleStartTime
        222n, // saleEndTime
        333n, // claimLockDuration — the flat ABI put saleTokenAddress here
        SALE_TOKEN,
        [ETHEREUM_ADDRESS],
        [10n ** 25n],
        1n, // minAllocationPerUser
        2n, // maxAllocationPerUser
        [7n, 8n, 9n, 10n], // vestingPercentage, vestingDuration, cliffPeriod, unlockStep
        [[5, "0x1234"]], // MerkleWhitelist participation detail
      ],
      [true, 42n, "ipfs://tier", [1n, 2n]], // tierInfo
      [ROOT, "ipfs://wl", 777n], // tierAdditionalInfo
    ];

    const encoded = iface.encodeFunctionResult("getTierViews", [[tierView]]);
    const [views] = iface.decodeFunctionResult("getTierViews", encoded);
    const v = views[0];

    expect(v.tierInitParams.saleTokenAddress).toBe(SALE_TOKEN);
    expect(v.tierInitParams.claimLockDuration).toBe(333n);
    expect(v.tierInitParams.saleStartTime).toBe(111n);
    expect(v.tierInitParams.saleEndTime).toBe(222n);
    expect(v.tierInitParams.vestingSettings.vestingPercentage).toBe(7n);
    expect(v.tierInitParams.vestingSettings.vestingDuration).toBe(8n);
    expect(v.tierInitParams.vestingSettings.cliffPeriod).toBe(9n);
    expect(v.tierInitParams.vestingSettings.unlockStep).toBe(10n);
    expect(Number(v.tierInitParams.participationDetails[0].participationType)).toBe(5);
    expect(v.tierInfo.isOff).toBe(true);
    expect(v.tierInfo.totalSold).toBe(42n);
    expect(v.tierInfo.uri).toBe("ipfs://tier");
    expect(v.tierAdditionalInfo.merkleRoot).toBe(ROOT);
    expect(v.tierAdditionalInfo.lastModified).toBe(777n);
  });
});
