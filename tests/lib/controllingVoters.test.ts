import { describe, it, expect, beforeEach, vi } from "vitest";
import { Interface } from "ethers";

// Mock the lib's two external dependencies. The controlling-set is enumerated
// via gqlRequest (subgraph) and each member's vote confirmed via multicall
// (on-chain) — both are faked here so the test is pure/offline.
vi.mock("../../src/lib/subgraph.js", () => ({ gqlRequest: vi.fn() }));
vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { gqlRequest } from "../../src/lib/subgraph.js";
import { multicall } from "../../src/lib/multicall.js";
import {
  resolveControllingHoldersVotedFor,
  GET_TOTAL_VOTES_FRAGMENT,
} from "../../src/lib/controllingVoters.js";

const gql = vi.mocked(gqlRequest);
const mc = vi.mocked(multicall);

/** Minimal DexeConfig stub — only the fields the lib reads. */
function cfg(overrides: Record<string, unknown> = {}): any {
  return {
    subgraphValidatorsUrl: "https://validators.example",
    subgraphPoolsUrl: "https://pools.example",
    controllingTopN: 5,
    ...overrides,
  };
}

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

  it("returns null off mainnet (testnet has no subgraph)", async () => {
    mockSubgraph(["0xAAA0000000000000000000000000000000000001"], []);
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3, cfg: cfg(), chainId: 97,
    });
    expect(r).toBeNull();
    expect(gql).not.toHaveBeenCalled();
  });

  it("returns null when subgraph URLs are not configured", async () => {
    const r = await resolveControllingHoldersVotedFor({
      provider: PROVIDER, govPool: GOV, proposalId: 3,
      cfg: cfg({ subgraphValidatorsUrl: undefined, subgraphPoolsUrl: undefined }),
      chainId: 56,
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
