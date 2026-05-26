import { describe, expect, it } from "vitest";
import {
  compareStateEnum,
  mapTallyStatusToIndex,
  tallyGovernorId,
  fetchTallyProposals,
  type TallyProposalSnapshot,
} from "../../src/governor/tally.js";
import { JsonRpcProvider } from "ethers";
import { loadGovernorConfigs } from "../../src/governor/loader.js";
import { governorContract } from "../../src/governor/adapter.js";

const TIER1_GOVERNORS: { id: string; sample: number }[] = [
  { id: "uniswap", sample: 10 },
  { id: "compound", sample: 10 },
  { id: "optimism", sample: 10 },
];

const TALLY_API_KEY = process.env.TALLY_API_KEY?.trim();
const MAINNET_RPC = process.env.DEXE_RPC_URL_MAINNET?.trim();
const OPTIMISM_RPC = process.env.DEXE_RPC_URL_OPTIMISM?.trim();

describe("tally — state enum mapper (unit, no network)", () => {
  it("maps OZ canonical strings to numeric indices", () => {
    expect(mapTallyStatusToIndex("PENDING")).toBe(0);
    expect(mapTallyStatusToIndex("ACTIVE")).toBe(1);
    expect(mapTallyStatusToIndex("CANCELED")).toBe(2);
    expect(mapTallyStatusToIndex("CANCELLED")).toBe(2);
    expect(mapTallyStatusToIndex("DEFEATED")).toBe(3);
    expect(mapTallyStatusToIndex("SUCCEEDED")).toBe(4);
    expect(mapTallyStatusToIndex("QUEUED")).toBe(5);
    expect(mapTallyStatusToIndex("EXPIRED")).toBe(6);
    expect(mapTallyStatusToIndex("EXECUTED")).toBe(7);
  });

  it("treats Tally pre-Pending states (DRAFT, SUBMITTED) as Pending(0)", () => {
    expect(mapTallyStatusToIndex("DRAFT")).toBe(0);
    expect(mapTallyStatusToIndex("SUBMITTED")).toBe(0);
  });

  it("returns null for unknown Tally state", () => {
    expect(mapTallyStatusToIndex("FOOBAR")).toBeNull();
  });

  it("compareStateEnum reports match/mismatch correctly", () => {
    const t: TallyProposalSnapshot = { onchainId: "1", status: "EXECUTED" };
    const ok = compareStateEnum("1", t, 7);
    expect(ok.match).toBe(true);

    const bad = compareStateEnum("1", t, 4);
    expect(bad.match).toBe(false);
    expect(bad.expected.mappedIndex).toBe(7);
    expect(bad.actual.index).toBe(4);
  });

  it("tallyGovernorId formats as eip155:chain:address (lowercased)", () => {
    expect(tallyGovernorId(1, "0xc0Da02939E1441F497fd74F78cE7Decb17B66529"))
      .toBe("eip155:1:0xc0da02939e1441f497fd74f78ce7decb17b66529");
  });
});

/**
 * Live mode — requires TALLY_API_KEY + appropriate RPC env vars. Per plan
 * §2 metric: 100% match for 30 sampled live proposals (10 per Tier-1 DAO).
 *
 * Skipped by default (CI shouldn't burn the user's Tally rate budget). Run
 * locally with:
 *
 *   $env:TALLY_API_KEY="..."
 *   $env:DEXE_RPC_URL_MAINNET="..."
 *   $env:DEXE_RPC_URL_OPTIMISM="..."
 *   npx vitest run tests/governor/parity.test.ts
 */
const liveMode = Boolean(TALLY_API_KEY);
describe.skipIf(!liveMode)("tally parity — live (30 sampled proposals)", () => {
  for (const { id, sample } of TIER1_GOVERNORS) {
    it(`${id}: ${sample} most-recent proposals match Tally`, async () => {
      const cfg = loadGovernorConfigs().get(id)!;
      const rpcUrl = cfg.chainId === 1 ? MAINNET_RPC : OPTIMISM_RPC;
      if (!rpcUrl) {
        throw new Error(`missing RPC env var for chainId=${cfg.chainId}; skipping ${id}`);
      }
      const provider = new JsonRpcProvider(rpcUrl);
      const govC = governorContract(provider, cfg);
      const snapshots = await fetchTallyProposals(
        { apiKey: TALLY_API_KEY! },
        tallyGovernorId(cfg.chainId, cfg.governorAddress),
        sample,
      );
      expect(snapshots.length).toBeGreaterThan(0);

      const rows = [];
      for (const snap of snapshots) {
        const idx = Number(await govC.getFunction("state").staticCall(BigInt(snap.onchainId)));
        rows.push(compareStateEnum(snap.onchainId, snap, idx));
      }
      const mismatches = rows.filter(r => !r.match);
      if (mismatches.length > 0) {
        console.error(`[parity:${id}] mismatches:`, JSON.stringify(mismatches, null, 2));
      }
      expect(mismatches).toEqual([]);
    }, 60_000);
  }
});
