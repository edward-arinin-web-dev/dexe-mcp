import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { multicall } from "../../src/lib/multicall.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * 0.31.0 — `dexe_dao_report`, the one call that replaces 12-18.
 *
 * What is pinned here is the contract a scheduled report depends on:
 *
 *  1. a full report renders every section from a mocked stack, and the
 *     structured payload validates against the tool's OWN declared
 *     outputSchema — the thing every existing subgraph tool omits, which is
 *     why nothing downstream can be typed against them;
 *  2. a chain with no subgraph still renders every on-chain section, and the
 *     ones it cannot render are NAMED with a reason and a follow-up tool. A
 *     half-report that silently drops sections is the failure mode this whole
 *     release train has been fixing, so "absent" is never acceptable;
 *  3. `since` yields DELTAS — new proposals, proposals that moved state,
 *     members joined, delegation shifts, treasury deltas — rather than
 *     restating the same numbers, which is what makes an hourly run signal
 *     instead of noise;
 *  4. per-proposal turnout arrives for ALL proposals in one query, where
 *     `dexe_proposal_voters` costs one call per proposal.
 */

// ---------- fixture addresses ----------

const DAO = "0xbb1918019Af8C6A26fF34Ce8FB8305976E1F626d";
const DAO_LC = DAO.toLowerCase();
const SETTINGS = "0x1111111111111111111111111111111111111111";
const USER_KEEPER = "0x2222222222222222222222222222222222222222";
const VALIDATORS = "0x3333333333333333333333333333333333333333";
const REGISTRY = "0x4444444444444444444444444444444444444444";
const VOTE_POWER = "0x5555555555555555555555555555555555555555";
const TOKEN = "0x6666666666666666666666666666666666666666";
const VOTER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const VOTER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const VOTER_C = "0xccccccccccccccccccccccccccccccccccccccc3";
const USER = "0xDDDdDdDddDdDddddDdDddDdDddDdDdddddDDddD4";

/** Fixed clock so deadlines and `since` windows are deterministic. */
const NOW = 1_800_000_000;

const MAINNET_URLS: SubgraphEndpoints = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
};

// ---------- on-chain mock ----------

/**
 * State of the mocked chain. Tests mutate `chain` between runs to make the
 * second report see a moved proposal / a changed balance — which is exactly
 * what the `since` diff has to notice.
 */
interface MockChain {
  latestProposalId: bigint;
  /** proposalState index per proposal id (1-based). */
  states: number[];
  native: bigint;
  daoTokenBalance: bigint;
  validatorsCount: bigint;
  helpersRevert: boolean;
  /** getTotalVotes → voterRawVoted, per proposal id. */
  userVotes: Record<string, bigint>;
  pendingRewards: boolean;
}

let chain: MockChain;

function freshChain(): MockChain {
  return {
    latestProposalId: 4n,
    // #1 ExecutedFor(7), #2 Voting(0), #3 SucceededFor(4), #4 Voting(0)
    states: [7, 0, 4, 0],
    native: 5_000_000_000_000_000_000n,
    daoTokenBalance: 1_000n * 10n ** 18n,
    validatorsCount: 3n,
    helpersRevert: false,
    userVotes: { "2": 0n, "4": 12n },
    pendingRewards: true,
  };
}

const ok = (value: unknown) => ({ success: true, value, raw: "0x" });
const failed = (error: string) => ({ success: false, value: null, raw: "0x", error });

/** A ProposalSettings tuple in IGovSettings field order (12 entries). */
const settingsTuple = () => [
  true, // earlyCompletion
  false, // delegatedVotingAllowed
  true, // validatorsVote
  86_400n, // duration
  43_200n, // durationValidators
  3_600n, // executionDelay
  10n ** 25n * 51n, // quorum → 51%
  10n ** 25n * 60n, // quorumValidators
  10n ** 18n, // minVotesForVoting
  10n ** 19n, // minVotesForCreating
  [TOKEN, 0n, 0n, 0n], // rewardsInfo
  "DEFAULT",
];

function proposalView(id: number, stateIdx: number) {
  return {
    proposal: {
      core: {
        voteEnd: BigInt(NOW + 3_600 * id),
        executeAfter: BigInt(NOW + 7_200),
        executed: stateIdx === 7 || stateIdx === 8,
        votesFor: BigInt(id) * 100n,
        votesAgainst: BigInt(id) * 10n,
      },
      descriptionURL: `ipfs://proposal-${id}`,
    },
    validatorProposal: { core: { voteEnd: BigInt(NOW + 1_800), executeAfter: 0n } },
    proposalState: stateIdx,
    requiredQuorum: 1_000n,
  };
}

function answerCall(c: { method: string; target: string; args: readonly unknown[] }) {
  switch (c.method) {
    case "getHelperContracts":
      return chain.helpersRevert
        ? failed("call reverted")
        : ok({
            settings: SETTINGS,
            userKeeper: USER_KEEPER,
            validators: VALIDATORS,
            poolRegistry: REGISTRY,
            votePower: VOTE_POWER,
          });
    case "getNftContracts":
      return ok({
        nftMultiplier: "0x0000000000000000000000000000000000000000",
        expertNft: "0x7777777777777777777777777777777777777777",
        dexeExpertNft: "0x8888888888888888888888888888888888888888",
        babt: "0x9999999999999999999999999999999999999999",
      });
    case "descriptionURL":
      return ok("ipfs://dao-metadata");
    case "latestProposalId":
      return ok(chain.latestProposalId);
    case "getDefaultSettings":
    case "getInternalSettings":
      return ok(settingsTuple());
    case "validatorsCount":
      return ok(chain.validatorsCount);
    case "tokenAddress":
      return ok(TOKEN);
    case "getCreditInfo":
      return ok([{ token: TOKEN, monthLimit: 100n, currentWithdrawLimit: 40n }]);
    case "getProposals": {
      const offset = Number(c.args[0]);
      const limit = Number(c.args[1]);
      const out = [];
      for (let i = offset; i < Math.min(offset + limit, chain.states.length); i++) {
        out.push(proposalView(i + 1, chain.states[i]!));
      }
      return ok(out);
    }
    case "symbol":
      return ok("PST");
    case "decimals":
      return ok(18n);
    case "totalSupply":
      return ok(10n ** 24n);
    case "balanceOf":
      return ok(chain.daoTokenBalance);
    case "getTotalVotes": {
      const id = String(c.args[0]);
      return ok({ voterRawVoted: chain.userVotes[id] ?? 0n });
    }
    case "getPendingRewards":
      return chain.pendingRewards
        ? ok({
            onchainTokens: [TOKEN, TOKEN, TOKEN, TOKEN],
            staticRewards: [50n, 0n, 0n, 0n],
            votingRewards: [
              { personal: 5n, micropool: 0n, treasury: 0n },
              { personal: 0n, micropool: 0n, treasury: 0n },
              { personal: 0n, micropool: 0n, treasury: 0n },
              { personal: 0n, micropool: 0n, treasury: 0n },
            ],
            offchainRewards: [],
            offchainTokens: [],
          })
        : failed("not supported");
    default:
      return failed(`unmocked method ${c.method}`);
  }
}

vi.mock("../../src/lib/multicall.js", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  multicall: vi.fn(async (_provider: unknown, calls: unknown[]) =>
    (calls as Array<{ method: string; target: string; args: readonly unknown[] }>).map(answerCall),
  ),
}));

const multicallMock = vi.mocked(multicall);

// ---------- RPC mock ----------

/** Chains that have an RPC in the current test. */
let rpcChains = new Set<number>([56, 97]);

const fakeProvider = {
  getBalance: vi.fn(async () => chain.native),
  getBlock: vi.fn(async () => ({ number: 62_000_000, timestamp: NOW })),
};

vi.mock("../../src/rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rpc.js")>();
  class MockRpcProvider {
    constructor(private readonly cfg: { defaultChainId: number }) {}
    resolveChainId(chainId?: number): number {
      return chainId ?? this.cfg.defaultChainId;
    }
    tryProvider(chainId?: number) {
      const id = this.resolveChainId(chainId);
      if (!rpcChains.has(id)) {
        return { error: `No RPC for chain ${id}.`, remediation: "Set DEXE_RPC_URL_<chainId>." };
      }
      return { ok: fakeProvider };
    }
    requireProvider(chainId?: number) {
      return fakeProvider;
    }
  }
  return { ...actual, RpcProvider: MockRpcProvider };
});

// ---------- subgraph mock ----------

interface GraphState {
  votersCount: string;
  proposalCount: string;
  totalCurrentTokenDelegated: string;
  members: Array<{ address: string; joinedTimestamp: number }>;
  proposals: Array<{ id: number; votersVoted: number }>;
  /** Rows the delta document returns (already assumed to satisfy the `_gt`). */
  joinedSince: Array<{ address: string; at: number }>;
  newDelegationsSince: number;
  activityEvents: number;
}

let graph: GraphState;

function freshGraph(): GraphState {
  return {
    votersCount: "12",
    proposalCount: "4",
    totalCurrentTokenDelegated: "1000",
    members: [
      { address: VOTER_A, joinedTimestamp: NOW - 100 },
      { address: VOTER_B, joinedTimestamp: NOW - 200 },
      { address: VOTER_C, joinedTimestamp: NOW - 300 },
    ],
    proposals: [
      { id: 4, votersVoted: 2 },
      { id: 3, votersVoted: 5 },
      { id: 2, votersVoted: 0 },
      { id: 1, votersVoted: 7 },
    ],
    joinedSince: [],
    newDelegationsSince: 0,
    activityEvents: 0,
  };
}

function poolsBaseResponse() {
  return {
    daoPools: [
      {
        id: DAO_LC,
        name: "Polaris Assembly",
        userKeeper: USER_KEEPER,
        erc20Token: TOKEN,
        erc721Token: "0x0000000000000000000000000000000000000000",
        nftMultiplier: "0x0000000000000000000000000000000000000000",
        votersCount: graph.votersCount,
        proposalCount: graph.proposalCount,
        creationTime: String(NOW - 1_000_000),
        creationBlock: "61000000",
        totalCurrentTokenDelegated: graph.totalCurrentTokenDelegated,
        totalCurrentTokenDelegatees: "2",
        totalCurrentTokenDelegatedTreasury: "0",
      },
    ],
    members: graph.members.map((m) => ({
      joinedTimestamp: String(m.joinedTimestamp),
      receivedDelegation: "0",
      receivedTreasuryDelegation: "0",
      engagedProposalsCount: "2",
      currentDelegateesCount: "0",
      currentDelegatorsCount: "0",
      totalClaimedUSD: "0",
      totalLockedUSD: "0",
      expertNft: null,
      voter: {
        id: m.address,
        totalProposalsCreated: "1",
        totalVotedProposals: "2",
        totalVotes: "3",
        currentVotesReceived: "0",
        currentVotesDelegated: "0",
      },
    })),
    experts: [
      {
        receivedDelegation: "500",
        receivedTreasuryDelegation: "0",
        expertNft: { tokenId: "1", tags: ["defi"] },
        voter: { id: VOTER_A },
      },
    ],
    proposals: graph.proposals.map((p) => ({
      proposalId: String(p.id),
      votersVoted: String(p.votersVoted),
      currentVotesFor: String(p.id * 100),
      currentVotesAgainst: String(p.id * 10),
      quorum: "1000",
      quorumReachedTimestamp: p.votersVoted > 0 ? String(NOW - 5_000) : "0",
      executionTimestamp: p.id === 1 ? String(NOW - 4_000) : "0",
      isFor: true,
      creator: { id: VOTER_B },
    })),
    delegations: [
      {
        creationTimestamp: String(NOW - 50_000),
        delegatedAmount: "700",
        delegatedVotes: "700",
        delegatedUSD: "0",
        delegatedNfts: [],
        delegator: { voter: { id: VOTER_C } },
        delegatee: { voter: { id: VOTER_A }, expertNft: { tokenId: "1" } },
      },
    ],
  };
}

function poolsDeltaResponse() {
  return {
    joined: graph.joinedSince.map((j) => ({
      joinedTimestamp: String(j.at),
      voter: { id: j.address },
    })),
    newDelegations: Array.from({ length: graph.newDelegationsSince }, (_v, i) => ({
      creationTimestamp: String(NOW - 10 - i),
      delegatedAmount: "250",
      delegatedVotes: "250",
      delegator: { voter: { id: VOTER_B } },
      delegatee: { voter: { id: VOTER_A } },
    })),
    delegationEvents: [],
  };
}

function activityResponse() {
  const tx = (i: number) => ({ timestamp: String(NOW - 60 * i), user: VOTER_A, block: "62000000" });
  return {
    proposalsCreated: Array.from({ length: Math.min(graph.activityEvents, 2) }, (_v, i) => ({
      proposalId: String(i + 1),
      transaction: tx(i),
    })),
    votes: Array.from({ length: graph.activityEvents }, (_v, i) => ({
      interactionType: "1",
      totalVote: "100",
      transaction: tx(i + 5),
    })),
    executions: [],
    delegations: [],
    rewardClaims: [],
    deposits: [],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

/** Which GraphQL document a request body carries. */
function documentOf(init: { body?: unknown } | undefined): string {
  const body = String((init as { body?: string } | undefined)?.body ?? "");
  if (body.includes("query DaoReportDelta")) return "delta";
  if (body.includes("query DaoActivity")) return "activity";
  if (body.includes("query DaoValidators")) return "validators";
  if (body.includes("query DaoReport")) return "pools";
  return "unknown";
}

function graphAnswer(doc: string): unknown {
  switch (doc) {
    case "pools":
      return poolsBaseResponse();
    case "delta":
      return poolsDeltaResponse();
    case "activity":
      return activityResponse();
    case "validators":
      return {
        validatorInPools: [
          { validatorAddress: VOTER_A, balance: "900" },
          { validatorAddress: VOTER_B, balance: "100" },
        ],
      };
    default:
      return {};
  }
}

// ---------- harness ----------

function config(opts: {
  subgraphs?: Record<number, SubgraphEndpoints>;
  defaultChainId?: number;
  statePath: string;
}): DexeConfig {
  return {
    defaultChainId: opts.defaultChainId ?? 56,
    statePath: opts.statePath,
    chains: new Map(
      [56, 97].map((c) => [c, { chainId: c, rpcUrl: `https://rpc.example/${c}` }]),
    ),
    subgraphUrls: new Map(
      Object.entries(opts.subgraphs ?? { 56: MAINNET_URLS }).map(
        ([k, v]) => [Number(k), v] as const,
      ),
    ),
    subgraphChainId: 56,
    usingPublicRpcFallback: false,
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callReport(cfg: DexeConfig, args: Record<string, unknown>): Promise<ToolResult> {
  const { registerReportTools } = await import("../../src/tools/report.js");
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerReportTools(server, { config: cfg } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({
      name: "dexe_dao_report",
      arguments: args,
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const sect = (r: ToolResult, name: string) =>
  (r.structuredContent?.sections as Record<string, { available: boolean; reason?: string; followUp?: string; data: Record<string, unknown> | null }>)[
    name
  ];

let tmp: string;

beforeEach(() => {
  chain = freshChain();
  graph = freshGraph();
  rpcChains = new Set([56, 97]);
  multicallMock.mockClear();
  fakeProvider.getBalance.mockClear();
  fakeProvider.getBlock.mockClear();
  tmp = mkdtempSync(join(tmpdir(), "dexe-report-"));
  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: graphAnswer(documentOf(init)) }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

const statePath = () => join(tmp, "state.json");

// ---------- 1. full report ----------

describe("dexe_dao_report — full report over a mocked stack", () => {
  it("renders every section from one call", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    expect(res.isError).toBeFalsy();
    const sections = res.structuredContent!.sections as Record<string, { available: boolean }>;
    for (const name of [
      "identity",
      "settings",
      "treasury",
      "membership",
      "delegation",
      "experts",
      "validators",
      "proposals",
      "turnout",
      "activity",
      "deadlines",
    ]) {
      expect(sections[name], `section ${name} missing`).toBeDefined();
      expect(sections[name]!.available, `section ${name} not available`).toBe(true);
    }
    expect(res.structuredContent!.unavailable).toEqual([]);
  });

  it("costs one call where the old flow cost 12-18 plus one per proposal", async () => {
    await callReport(config({ statePath: statePath() }), { govPool: DAO });
    // Three subgraph documents total (pools / validators / interactions) — the
    // pools one carries turnout for ALL proposals, so the per-proposal
    // dexe_proposal_voters round-trip is gone.
    const docs = fetchMock.mock.calls.map((c) => documentOf(c[1] as { body?: string }));
    expect(docs.sort()).toEqual(["activity", "pools", "validators"]);
    expect(docs.filter((d) => d === "pools")).toHaveLength(1);
  });

  it("carries per-proposal turnout for every proposal at once", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    const turnout = sect(res, "turnout").data!;
    expect(turnout.proposalsMeasured).toBe(4);
    expect(turnout.averageVotersPerProposal).toBe(3.5); // (2+5+0+7)/4
    expect(turnout.maxVotersOnAProposal).toBe(7);
    expect(turnout.zeroVoteProposals).toBe(1);
    expect((turnout.perProposal as unknown[]).length).toBe(4);
  });

  it("answers who-delegated-to-whom without being handed an address list", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    const pairs = sect(res, "delegation").data!.pairs as Array<Record<string, unknown>>;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.delegator).toBe(VOTER_C);
    expect(pairs[0]!.delegatee).toBe(VOTER_A);
    expect(pairs[0]!.delegateeIsExpert).toBe(true);
    // The DAO address is the only input the caller supplied.
    const poolsCall = fetchMock.mock.calls.find(
      (c) => documentOf(c[1] as { body?: string }) === "pools",
    )!;
    const body = JSON.parse(String((poolsCall[1] as { body: string }).body));
    expect(body.variables).toMatchObject({ pool: DAO_LC, poolId: DAO_LC });
  });

  it("surfaces deadlines sorted by urgency, with executable proposals included", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    const items = sect(res, "deadlines").data!.items as Array<Record<string, unknown>>;
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("votingEnds");
    expect(kinds).toContain("executable");
    const remaining = items.map((i) => Number(i.secondsRemaining));
    expect([...remaining].sort((a, b) => a - b)).toEqual(remaining);
    expect(text(res)).toContain("NEEDS ATTENTION");
  });

  it("adds per-user deadline items when `user` is supplied", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO, user: USER });
    const personal = sect(res, "deadlines").data!.personal as {
      user: string;
      items: Array<Record<string, unknown>>;
    };
    expect(personal.user.toLowerCase()).toBe(USER.toLowerCase());
    // #2 is in Voting and the user has zero personal votes on it; #4 they voted.
    const unvoted = personal.items.filter((i) => i.kind === "unvoted");
    expect(unvoted.map((i) => i.proposalId)).toEqual(["2"]);
    expect(personal.items.some((i) => i.kind === "claimableRewards")).toBe(true);
  });

  it("classifies proposal outcomes from on-chain state", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    const p = sect(res, "proposals").data!;
    expect(p.latestProposalId).toBe("4");
    expect(p.outcomes).toMatchObject({ executedFor: 1, defeated: 0, inFlight: 3 });
  });

  it("narrows the work when `sections` is given", async () => {
    const res = await callReport(config({ statePath: statePath() }), {
      govPool: DAO,
      sections: ["proposals", "deadlines"],
    });
    const sections = res.structuredContent!.sections as Record<string, unknown>;
    expect(Object.keys(sections).sort()).toEqual(["deadlines", "proposals"]);
    // No subgraph section was asked for, so no subgraph request was issued.
    expect(fetchMock).not.toHaveBeenCalled();
    // A narrowed run must not become the baseline for the next diff.
    expect(res.structuredContent!.snapshotPersisted).toBe(false);
  });
});

// ---------- 2. the payload validates against its own outputSchema ----------

describe("dexe_dao_report — structured payload is typed", () => {
  it("validates against the tool's declared outputSchema", async () => {
    const { DAO_REPORT_OUTPUT_SHAPE } = await import("../../src/tools/report.js");
    const schema = z.object(DAO_REPORT_OUTPUT_SHAPE);
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    const parsed = schema.safeParse(res.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it("validates in the degraded and since-diff shapes too", async () => {
    const { DAO_REPORT_OUTPUT_SHAPE } = await import("../../src/tools/report.js");
    const schema = z.object(DAO_REPORT_OUTPUT_SHAPE);

    const degraded = await callReport(config({ subgraphs: {}, statePath: statePath() }), {
      govPool: DAO,
    });
    expect(schema.safeParse(degraded.structuredContent).success).toBe(true);

    const diff = await callReport(config({ statePath: statePath() }), {
      govPool: DAO,
      since: "last",
    });
    const parsed = schema.safeParse(diff.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it("advertises an outputSchema in tools/list", async () => {
    const { registerReportTools } = await import("../../src/tools/report.js");
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerReportTools(server, {
      config: config({ statePath: statePath() }),
    } as unknown as ToolContext);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const listed = (await client.listTools()).tools.find((t) => t.name === "dexe_dao_report")!;
    await client.close();
    await server.close();
    expect(listed.outputSchema).toBeDefined();
    const props = (listed.outputSchema as { properties?: Record<string, unknown> }).properties!;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["sections", "unavailable", "changes", "sources"]),
    );
  });
});

// ---------- 3. degradation ----------

describe("dexe_dao_report — degrades by section, never silently", () => {
  it("renders the on-chain sections on a chain with no subgraph and NAMES the rest", async () => {
    // chain 97 has an RPC but no indexer — the shape a testnet user hits.
    const res = await callReport(
      config({ subgraphs: { 56: MAINNET_URLS }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    expect(res.isError).toBeFalsy();

    // On-chain sections still render.
    for (const name of ["identity", "settings", "treasury", "validators", "proposals", "deadlines"]) {
      expect(sect(res, name).available, `${name} should still render on-chain`).toBe(true);
    }
    // Subgraph-only sections are absent AND named.
    const unavailable = res.structuredContent!.unavailable as Array<{
      section: string;
      reason: string;
      followUp?: string;
    }>;
    const named = unavailable.map((u) => u.section).sort();
    expect(named).toEqual(["activity", "delegation", "experts", "membership", "turnout"]);
    for (const u of unavailable) {
      expect(u.reason).toContain("chain 97");
      expect(u.reason).toContain("DEXE_SUBGRAPH_");
      expect(u.followUp, `${u.section} has no follow-up`).toBeTruthy();
    }
    // And the human body says so rather than looking complete.
    expect(text(res)).toContain("SECTIONS NOT RENDERED");
    expect(text(res)).toContain("this report is partial");
    // No mainnet row can have leaked into a chain-97 report.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(res)).not.toContain("Polaris Assembly");
  });

  it("renders the subgraph sections when the RPC is the thing that is missing", async () => {
    rpcChains = new Set([56]);
    const res = await callReport(
      config({ subgraphs: { 97: MAINNET_URLS }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    expect(res.isError).toBeFalsy();
    expect(sect(res, "membership").available).toBe(true);
    expect(sect(res, "turnout").available).toBe(true);
    const unavailable = res.structuredContent!.unavailable as Array<{
      section: string;
      reason: string;
    }>;
    expect(unavailable.map((u) => u.section)).toEqual(
      expect.arrayContaining(["settings", "treasury", "proposals", "deadlines"]),
    );
    expect(unavailable[0]!.reason).toContain("No RPC for chain 97");
  });

  it("names the section when a configured subgraph FAILS mid-report", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      if (documentOf(init) === "pools") {
        return { ok: false, status: 500, statusText: "err", text: async () => "boom", json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ data: graphAnswer(documentOf(init)) }),
      };
    });
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    expect(res.isError).toBeFalsy();
    expect(sect(res, "proposals").available).toBe(true); // on-chain, unaffected
    const membership = sect(res, "membership");
    expect(membership.available).toBe(false);
    // A failed indexer is NOT "the DAO has no members" — the reason has to say so.
    expect(membership.reason).toContain("Subgraph HTTP 500");
    expect(text(res)).toContain("SECTIONS NOT RENDERED");
  });

  it("errors outright only when there is no source at all", async () => {
    rpcChains = new Set();
    const res = await callReport(config({ subgraphs: {}, statePath: statePath() }), {
      govPool: DAO,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("neither an RPC nor any subgraph");
  });

  it("says so when the address is not a GovPool instead of reporting an empty DAO", async () => {
    chain.helpersRevert = true;
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    expect(res.isError).toBeFalsy();
    expect(sect(res, "settings").reason).toContain("not a DeXe GovPool");
    expect(sect(res, "proposals").available).toBe(false);
  });
});

// ---------- 4. the since diff ----------

describe("dexe_dao_report — `since` returns what CHANGED", () => {
  it("has no changes block without `since`", async () => {
    const res = await callReport(config({ statePath: statePath() }), { govPool: DAO });
    expect(res.structuredContent!.changes).toBeNull();
    expect(res.structuredContent!.snapshotPersisted).toBe(true);
  });

  it("reports new proposals, moved states and treasury deltas against the stored run", async () => {
    const cfg = config({ statePath: statePath() });
    // Run 1 lays down the baseline.
    const first = await callReport(cfg, { govPool: DAO });
    expect(first.structuredContent!.snapshotPersisted).toBe(true);

    // The DAO moves on: #2 passes, a 5th proposal opens, treasury grows,
    // two members join, one new delegation.
    chain.states = [7, 4, 7, 0, 0];
    chain.latestProposalId = 5n;
    chain.native = chain.native + 1_000_000n;
    chain.daoTokenBalance = chain.daoTokenBalance - 10n ** 18n;
    chain.validatorsCount = 4n;
    graph.votersCount = "14";
    graph.totalCurrentTokenDelegated = "1250";
    graph.joinedSince = [
      { address: VOTER_B, at: NOW - 10 },
      { address: USER, at: NOW - 5 },
    ];
    graph.newDelegationsSince = 1;

    const second = await callReport(cfg, { govPool: DAO, since: "last" });
    expect(second.isError).toBeFalsy();
    const changes = second.structuredContent!.changes as Record<string, unknown>;
    expect(changes).not.toBeNull();
    expect(changes.baseline).toBe("snapshot");

    expect((changes.newProposals as Array<{ proposalId: string }>).map((p) => p.proposalId)).toEqual(["5"]);
    expect(changes.proposalStateChanges).toEqual([
      { proposalId: "2", from: "Voting", to: "SucceededFor" },
      { proposalId: "3", from: "SucceededFor", to: "ExecutedFor" },
    ]);
    expect((changes.membersJoined as unknown[]).length).toBe(2);
    expect(changes.membersCountDelta).toBe(2);
    expect(changes.delegationTotalDelta).toBe("250");
    expect((changes.delegationChanges as unknown[]).length).toBe(1);
    expect(changes.validatorsCountDelta).toBe(1);
    expect(changes.treasuryDeltas).toEqual([
      { asset: "native", delta: "1000000", now: String(chain.native) },
      {
        asset: "PST",
        token: TOKEN,
        delta: (-(10n ** 18n)).toString(),
        now: String(chain.daoTokenBalance),
      },
    ]);
    // The readable body leads with the diff, not with restated totals.
    expect(text(second)).toContain("CHANGES SINCE");
    expect(text(second)).toContain("proposal #2: Voting -> SucceededFor");
  });

  it("reports 'nothing changed' rather than restating the same numbers", async () => {
    const cfg = config({ statePath: statePath() });
    await callReport(cfg, { govPool: DAO });
    const second = await callReport(cfg, { govPool: DAO, since: "last" });
    const changes = second.structuredContent!.changes as Record<string, unknown>;
    expect(changes.newProposals).toEqual([]);
    expect(changes.proposalStateChanges).toEqual([]);
    expect(changes.membersJoined).toEqual([]);
    expect(changes.treasuryDeltas).toEqual([]);
    expect(changes.membersCountDelta).toBe(0);
    expect(text(second)).toContain("nothing changed in this window");
  });

  it("scopes the subgraph delta queries to the resolved `since` timestamp", async () => {
    const cfg = config({ statePath: statePath() });
    const at = NOW - 3_600;
    await callReport(cfg, { govPool: DAO, since: new Date(at * 1000).toISOString() });
    const delta = fetchMock.mock.calls.find(
      (c) => documentOf(c[1] as { body?: string }) === "delta",
    )!;
    expect(JSON.parse(String((delta[1] as { body: string }).body)).variables).toMatchObject({
      pool: DAO_LC,
      since: String(at),
    });
    // The activity window follows `since` too, instead of the 7-day default.
    const activity = fetchMock.mock.calls.find(
      (c) => documentOf(c[1] as { body?: string }) === "activity",
    )!;
    expect(JSON.parse(String((activity[1] as { body: string }).body)).variables.since).toBe(
      String(at),
    );
  });

  it("still diffs what the indexer can date when there is no stored baseline", async () => {
    // No prior run: state changes are impossible, and the payload says why
    // rather than reporting an empty diff as "nothing happened".
    graph.joinedSince = [{ address: USER, at: NOW - 5 }];
    const res = await callReport(config({ statePath: statePath() }), {
      govPool: DAO,
      since: "2026-01-01T00:00:00Z",
    });
    const changes = res.structuredContent!.changes as Record<string, unknown>;
    expect(changes.baseline).toBe("timestampOnly");
    expect((changes.membersJoined as unknown[]).length).toBe(1);
    expect(changes.proposalStateChanges).toEqual([]);
    expect((changes.notes as string[]).join(" ")).toContain("No stored snapshot");
  });

  it("refuses since:'last' with no stored run instead of inventing a window", async () => {
    const res = await callReport(config({ statePath: statePath() }), {
      govPool: DAO,
      since: "last",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("needs a previous report");
  });

  it("keeps snapshots per chain and per DAO", async () => {
    const cfg = config({ subgraphs: { 56: MAINNET_URLS, 97: MAINNET_URLS }, statePath: statePath() });
    await callReport(cfg, { govPool: DAO, chainId: 56 });
    // The same DAO address on another chain has no baseline of its own.
    const other = await callReport(cfg, { govPool: DAO, chainId: 97, since: "last" });
    expect(other.isError).toBe(true);
    expect(text(other)).toContain("chain 97");
  });

  it("resolves a block number through the RPC", async () => {
    const cfg = config({ statePath: statePath() });
    const res = await callReport(cfg, { govPool: DAO, since: "block:62000000" });
    expect(res.isError).toBeFalsy();
    const since = res.structuredContent!.since as { mode: string; unix: number };
    expect(since.mode).toBe("block");
    expect(since.unix).toBe(NOW);
  });
});

// ---------- 5. pure helpers ----------

describe("parseSince", () => {
  it("reads ISO-8601, Unix seconds, blocks and 'last'", async () => {
    const { parseSince } = await import("../../src/tools/report.js");
    expect(parseSince("last")).toEqual({ kind: "lastRun" });
    expect(parseSince("2026-01-01T00:00:00Z")).toEqual({
      kind: "timestamp",
      unix: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    });
    expect(parseSince("1785000000")).toEqual({ kind: "timestamp", unix: 1_785_000_000 });
    expect(parseSince("unix:1785000000")).toEqual({ kind: "timestamp", unix: 1_785_000_000 });
    // A bare integer below 1e9 cannot be a modern timestamp, so it is a block.
    expect(parseSince("62000000")).toEqual({ kind: "block", block: 62_000_000 });
    expect(parseSince("block:62000000")).toEqual({ kind: "block", block: 62_000_000 });
  });

  it("explains itself on garbage instead of silently defaulting", async () => {
    const { parseSince } = await import("../../src/tools/report.js");
    const bad = parseSince("yesterday");
    expect(bad.kind).toBe("error");
    expect((bad as { message: string }).message).toContain("ISO-8601");
  });
});

describe("ReportStore", () => {
  it("round-trips per chain+DAO and tolerates a missing/corrupt file", async () => {
    const { ReportStore } = await import("../../src/tools/report.js");
    const path = join(tmp, "reports.json");
    const store = new ReportStore(path);
    expect(store.get(56, DAO)).toBeNull();

    const snap = {
      govPool: DAO,
      chainId: 56,
      at: NOW,
      blockNumber: 1,
      latestProposalId: "4",
      proposalStates: { "1": "ExecutedFor" },
      memberIds: [VOTER_A],
      memberWindowFull: false,
      membersTotal: "12",
      delegationTotal: "1000",
      delegateesTotal: "2",
      treasuryNative: "1",
      treasuryToken: "2",
      validatorsCount: "3",
      expertCount: 1,
    };
    store.put(snap);
    expect(new ReportStore(path).get(56, DAO)).toMatchObject({ latestProposalId: "4" });
    // Same address, different chain — a separate record, never a fallback.
    expect(new ReportStore(path).get(97, DAO)).toBeNull();

    // An unwritable path degrades to "no baseline", it does not throw.
    const dead = new ReportStore(join(tmp, "no", "such", "dir", "x", "reports.json"));
    expect(() => dead.put({ ...snap, chainId: 97 })).not.toThrow();
  });
});
