import { describe, it, expect, beforeEach, vi } from "vitest";
import { Interface } from "ethers";

/**
 * Live regression, 2026-09-24: `dexe_proposal_create { proposalType:
 * "change_voting_settings" }` refused with "govSettings: Required" — an address
 * the composite can read from its own `govPool` via `getHelperContracts()`.
 * `govSettings` is now optional on `change_voting_settings` and
 * `new_proposal_type`; omitted, it is resolved from the pool. An explicit value
 * still wins and is still validated.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { RpcProvider } from "../../src/rpc.js";
import { PROPOSAL_BUILDERS } from "../../src/lib/proposalBuilders.js";

const mc = vi.mocked(multicall);

const GOVPOOL = "0x3333333333333333333333333333333333333333";
const SETTINGS = "0x8888888888888888888888888888888888888888";
const KEEPER = "0x9999999999999999999999999999999999999999";
const DIST = "0x6666666666666666666666666666666666666666";

const settings = {
  earlyCompletion: true,
  delegatedVotingAllowed: false,
  validatorsVote: true,
  duration: "43200",
  durationValidators: "86400",
  executionDelay: "0",
  quorum: "510000000000000000000000000",
  quorumValidators: "510000000000000000000000000",
  minVotesForVoting: "1000000000000000000",
  minVotesForCreating: "1000000000000000000",
  rewardsInfo: { rewardToken: "0x0000000000000000000000000000000000000000", creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
  executorDescription: "ipfs://QmKeep",
};

const deps = {
  ctx: { config: { chains: new Map([[97, { chainId: 97, rpcUrl: "https://rpc.example/97", rpcUrls: ["https://rpc.example/97"] }]]), defaultChainId: 97 } } as never,
  govPool: GOVPOOL,
  chainId: 97,
};

beforeEach(() => {
  mc.mockReset();
  vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: {} as never });
});

describe("change_voting_settings without govSettings", () => {
  it("reads GovSettings from GovPool.getHelperContracts and targets it", async () => {
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
      calls.map((c) =>
        c.method === "getHelperContracts"
          ? { success: true, value: [SETTINGS, KEEPER, KEEPER, KEEPER, KEEPER] as never, raw: "0x" }
          : { success: false, value: null, raw: "0x", error: "not under test" },
      ),
    );
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    const out = await b.build(b.schema.parse({ settings: [settings], settingsIds: ["0"] }), deps);
    expect(out.actionsOnFor[0]!.executor).toBe(SETTINGS);
    const helperCalls = mc.mock.calls.flatMap(([, calls]) => (calls as Array<{ method: string; target: string }>));
    expect(helperCalls.some((c) => c.method === "getHelperContracts" && c.target === GOVPOOL)).toBe(true);
  });

  it("an explicit govSettings is used as given and never read from chain", async () => {
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
      calls.map(() => ({ success: false, value: null, raw: "0x", error: "must not be called" })),
    );
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    const out = await b.build(b.schema.parse({ govSettings: SETTINGS, settings: [settings] }), deps);
    expect(out.actionsOnFor[0]!.executor).toBe(SETTINGS);
    const helperCalls = mc.mock.calls.flatMap(([, calls]) => (calls as Array<{ method: string }>));
    expect(helperCalls.some((c) => c.method === "getHelperContracts")).toBe(false);
  });

  it("an explicit but malformed govSettings is still rejected", async () => {
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    await expect(b.build(b.schema.parse({ govSettings: "0xnope", settings: [settings] }), deps)).rejects.toThrow(
      /Invalid govSettings/,
    );
  });

  it("when the pool does not answer, the error names the fallback (pass it explicitly)", async () => {
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
      calls.map(() => ({ success: false, value: null, raw: "0x", error: "revert" })),
    );
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    await expect(b.build(b.schema.parse({ settings: [settings] }), deps)).rejects.toThrow(/Pass govSettings explicitly/);
  });
});

describe("new_proposal_type without govSettings", () => {
  it("resolves the same way and emits addSettings + changeExecutors against it", async () => {
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
      calls.map((c) =>
        c.method === "getHelperContracts"
          ? { success: true, value: [SETTINGS, KEEPER, KEEPER, KEEPER, KEEPER] as never, raw: "0x" }
          : { success: false, value: null, raw: "0x", error: "not under test" },
      ),
    );
    const b = PROPOSAL_BUILDERS.new_proposal_type!;
    const out = await b.build(b.schema.parse({ settings, executors: [DIST], newSettingId: "5" }), deps);
    expect(out.actionsOnFor.map((a) => a.executor)).toEqual([SETTINGS, SETTINGS]);
    const sel = new Interface(["function addSettings(tuple(bool,bool,bool,uint64,uint64,uint64,uint128,uint128,uint256,uint256,tuple(address,uint256,uint256,uint256),string)[])"]).getFunction("addSettings")!.selector;
    expect(out.actionsOnFor[0]!.data.startsWith(sel)).toBe(true);
  });
});
