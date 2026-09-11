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

/**
 * Per-chain RPC, the canonical `DEXE_RPC_URL_<chainId>` spelling (src/config.ts
 * registers any of them). Resolved generically so a fourth fixture on a new
 * chain fails loudly instead of silently reusing another chain's endpoint.
 *
 * The old `DEXE_RPC_URL_MAINNET` / `DEXE_RPC_URL_OPTIMISM` are kept only as a
 * deprecated fallback for contributors who already exported them: in this
 * project `DEXE_RPC_URL_MAINNET` means **BSC chain 56** (src/env/schema.ts), so
 * following the old recipe pointed an Ethereum governor read at a BSC node, and
 * `DEXE_RPC_URL_OPTIMISM` was never a variable src/config.ts recognized.
 */
const LEGACY_RPC_ENV: Record<number, string> = {
  1: "DEXE_RPC_URL_MAINNET",
  10: "DEXE_RPC_URL_OPTIMISM",
};
function rpcForChain(chainId: number): string | undefined {
  const legacyName = LEGACY_RPC_ENV[chainId];
  return (
    process.env[`DEXE_RPC_URL_${chainId}`]?.trim() ||
    (legacyName ? process.env[legacyName]?.trim() : undefined) ||
    undefined
  );
}

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
    // Compound's post-migration governor — pure string formatting, but keeping
    // the retired 0xc0Da…6529 here was the last place in tests/ that implied it
    // was current.
    expect(tallyGovernorId(1, "0x309a862bbC1A00e45506cB8A802D1ff10004c8C0"))
      .toBe("eip155:1:0x309a862bbc1a00e45506cb8a802d1ff10004c8c0");
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
 *   $env:DEXE_RPC_URL_1="https://eth.drpc.org"
 *   $env:DEXE_RPC_URL_10="https://optimism.drpc.org"
 *   npx vitest run tests/governor/parity.test.ts
 */
const liveMode = Boolean(TALLY_API_KEY);
describe.skipIf(!liveMode)("tally parity — live (30 sampled proposals)", () => {
  for (const { id, sample } of TIER1_GOVERNORS) {
    it(`${id}: ${sample} most-recent proposals match Tally`, async () => {
      const cfg = loadGovernorConfigs().get(id)!;
      const rpcUrl = rpcForChain(cfg.chainId);
      if (!rpcUrl) {
        throw new Error(`set DEXE_RPC_URL_${cfg.chainId} to run the ${id} parity sweep`);
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
