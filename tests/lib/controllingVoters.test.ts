import { describe, it, expect, beforeEach, vi } from "vitest";
import { Interface } from "ethers";

// Mock the lib's two external dependencies. The controlling-set is enumerated
// via gqlRequest (subgraph) and each member's vote confirmed via multicall
// (on-chain) — both are faked here so the test is pure/offline.
// `resolveSubgraphUrl` is deliberately NOT mocked: which chain's endpoint gets
// used is the property under test, so it runs for real against the stub config.
vi.mock("../../src/lib/subgraph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/subgraph.js")>()),
  gqlRequest: vi.fn(),
}));
vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { gqlRequest } from "../../src/lib/subgraph.js";
import { multicall } from "../../src/lib/multicall.js";
import {
  resolveControllingHoldersVotedFor,
  GET_TOTAL_VOTES_FRAGMENT,
} from "../../src/lib/controllingVoters.js";

const gql = vi.mocked(gqlRequest);
const mc = vi.mocked(multicall);

const MAINNET = { pools: "https://gw.example/56/pools", validators: "https://gw.example/56/validators" };
const TESTNET = { pools: "https://gw.example/97/pools", validators: "https://gw.example/97/validators" };

/**
 * Minimal DexeConfig stub. Endpoints are keyed by the chain they index — the
 * real `subgraphUrls` shape — because WHICH chain's endpoint the lib picks is
 * the thing under test. The flat `subgraph*Url` fields are deliberately absent:
 * reading them was the bug (they carry one chain's endpoint, whichever chain
 * DEXE_SUBGRAPH_CHAIN_ID names).
 */
function cfg(
  urls: Record<number, { pools?: string; validators?: string }> = { 56: MAINNET },
  overrides: Record<string, unknown> = {},
): any {
  return {
    defaultChainId: 56,
    subgraphUrls: new Map(Object.entries(urls).map(([k, v]) => [Number(k), v])),
    controllingTopN: 5,
    ...overrides,
  };
}

/** Endpoints the gqlRequest mock was actually pointed at, in call order. */
const queriedUrls = () => gql.mock.calls.map((c) => c[0]);

const PROVIDER: any = {};
const GOV = "0x1111111111111111111111111111111111111111";

/** Branch the gqlRequest mock by query so validators vs holders are distinct. */
function mockSubgraph(
  validators: string[],
  holders: { addr: string; votes?: string; deleg?: string }[],
) {
  gql.mockImplementation(async (_url: string, query: string) => {
    if (query.includes("validatorInPools")) {
      return { validatorInPools: validators.map((a) => ({ validatorAddress: a })) } as any;
    }
    return {
      voterInPools: holders.map((h) => ({
        receivedDelegation: h.deleg ?? "0",
        voter: { id: h.addr, totalVotes: h.votes ?? "0" },
      })),
    } as any;
  });
}

/**
 * votes[memberLowercase][voteType] === true ⇒ that member voted For via that
 * vote type. The mock derives each result straight from the call args, so call
 * ordering doesn't matter.
 */
function mockVotes(votes: Record<string, Partial<Record<number, boolean>>>) {
  mc.mockImplementation(async (_p: any, calls: any[]) =>
    calls.map((c) => {
      const [, member, vt] = c.args as [number, string, number];
      const votedFor = votes[String(member).toLowerCase()]?.[vt] === true;
      return {
        success: true,
        // [totalVoted, totalRawVoted, votesForNow, isVoteFor]
        value: [0n, 0n, votedFor ? 100n : 0n, votedFor] as any,
        raw: "0x",
      };
    }),
  );
}

beforeEach(() => {
  gql.mockReset();
  mc.mockReset();
});

describe("GET_TOTAL_VOTES_FRAGMENT", () => {
  it("is a valid ethers fragment (ethers silently drops malformed ones)", () => {
    expect(new Interface([GET_TOTAL_VOTES_FRAGMENT]).getFunction("getTotalVotes")).not.toBeNull();
  });
});

describe("resolveControllingHoldersVotedFor", () => {
  it("returns true when ≥1 controlling member voted For (personal)", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 0: true } });
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBe(true);
  });

  it("counts a delegated/micropool vote (OR across vote types)", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    // No personal vote (0), but a micropool (1) For — must still count.
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 1: true } });
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBe(true);
  });

  it("returns false when the set is non-empty and nobody voted For", async () => {
    mockSubgraph(
      ["0xAAA0000000000000000000000000000000000001"],
      [{ addr: "0xBBB0000000000000000000000000000000000002", votes: "10" }],
    );
    mockVotes({}); // nobody voted For
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBe(false);
  });

  it("returns null on a chain with no index of its own", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg({ 56: MAINNET }), chainId: 97,
    });
    expect(r).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });

  it("returns null when no subgraph is configured at all", async () => {
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg({}), chainId: 56,
    });
    expect(r).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });

  it("returns null when the controlling set is empty", async () => {
    mockSubgraph([], []);
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBeNull();
    expect(mc).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when the subgraph errors", async () => {
    gql.mockRejectedValue(new Error("subgraph 500"));
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBeNull();
  });

  it("returns null (never throws) when the on-chain read errors", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    mc.mockRejectedValue(new Error("rpc down"));
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56,
    });
    expect(r).toBeNull();
  });

  it("honours topN — only the heaviest holders are checked", async () => {
    // 3 holders by weight; topN=1 keeps only the heaviest (0xCCC, weight 30).
    mockSubgraph([], [
      { addr: "0xAAA0000000000000000000000000000000000001", votes: "10" },
      { addr: "0xBBB0000000000000000000000000000000000002", votes: "20" },
      { addr: "0xCCC0000000000000000000000000000000000003", votes: "30" },
    ]);
    // Only the lightest holder voted For — excluded by topN=1 ⇒ false.
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 0: true } });
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 56, topN: 1,
    });
    expect(r).toBe(false);
  });
});

/**
 * M1 — the advisory used to gate on `chainId === 56` and then read the FLAT
 * cfg.subgraph*Url pair. That pairing held only while the flat fields were
 * unconditionally BSC mainnet. `DEXE_SUBGRAPH_CHAIN_ID=97` files them under
 * testnet, at which point a chain-56 treasury verdict would have been computed
 * from chain-97 rows — and because this path is fail-soft, silently.
 */
describe("resolveControllingHoldersVotedFor — chain correctness", () => {
  it("does not consume a chain-97 endpoint when analyzing chain 56", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 0: true } });
    // The DEXE_SUBGRAPH_CHAIN_ID=97 shape: the only configured index is testnet.
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg({ 97: TESTNET }), chainId: 56,
    });
    // Unknown, not a verdict borrowed from testnet's controlling set.
    expect(r).toBeNull();
    expect(gql).not.toHaveBeenCalled();
    expect(mc).not.toHaveBeenCalled();
  });

  it("queries the analyzed chain's own endpoints when it is indexed", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 0: true } });
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3,
      cfg: cfg({ 56: MAINNET, 97: TESTNET }), chainId: 97,
    });
    expect(r).toBe(true);
    expect(queriedUrls().sort()).toEqual([TESTNET.pools, TESTNET.validators].sort());
    expect(queriedUrls()).not.toContain(MAINNET.pools);
    expect(queriedUrls()).not.toContain(MAINNET.validators);
  });

  it("keeps chain 56 on the mainnet endpoints when both chains are indexed", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    mockVotes({ "0xaaa0000000000000000000000000000000000001": { 0: true } });
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3,
      cfg: cfg({ 56: MAINNET, 97: TESTNET }), chainId: 56,
    });
    expect(r).toBe(true);
    expect(queriedUrls().sort()).toEqual([MAINNET.pools, MAINNET.validators].sort());
  });

  it("treats a half-indexed chain as unknown rather than filling the gap from another chain", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3,
      cfg: cfg({ 56: MAINNET, 97: { pools: TESTNET.pools } }), chainId: 97,
    });
    expect(r).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });

  it("never throws when the resolver rejects the chain (a risk check must not abort)", async () => {
    await expect(
      resolveControllingHoldersVotedFor({
        provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg({ 56: MAINNET }), chainId: 1337,
      }),
    ).resolves.toBeNull();
  });
});
