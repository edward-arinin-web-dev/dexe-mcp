import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { multicall } from "../../src/lib/multicall.js";
import { defaultProfileToolNames, resolveToolsets, TOOLSETS } from "../../src/tools/gate.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * F3 (0.31.0) — `dexe_dao_report`'s degradation advice must be actionable IN THE
 * PROFILE THAT PRODUCED IT.
 *
 * Narrowing `DEFAULT_TOOLSETS` to `["core"]` moved the default-profile boundary
 * underneath every hand-written tool name in this file. A live chain-97 run
 * proved the cost: of the ten tools the partial report named in
 * `unavailable[].followUp` / `followUps[]`, SIX were not registered in the
 * session that printed them (`dexe_proposal_voters`, `dexe_read_dao_experts`,
 * `dexe_read_expert_status`, `dexe_read_gov_state`, `dexe_read_multicall`,
 * `dexe_read_user_activity`). A user following that advice hits six 404s and
 * concludes the server is broken — a confident 404 is worse than no advice.
 *
 * So the contract pinned here is: every tool this report can NAME is either in
 * the default profile or carries the `DEXE_TOOLSETS=…` value that unlocks it,
 * and that value must actually work — it has to resolve to a profile that
 * CONTAINS the tool and still contains `dexe_dao_report` itself.
 *
 * The default profile is derived at runtime from the gate. Hardcoding the list
 * here would reproduce exactly the bug under test the next time the boundary
 * moves.
 */

// ---------- the profile under test, derived — never hardcoded ----------

const DEFAULT_PROFILE: ReadonlySet<string> = defaultProfileToolNames();

/** Every tool name the server knows about, across all named sets. */
const ALL_TOOLS: ReadonlySet<string> = new Set(
  Object.values(TOOLSETS).flatMap((s) => [...s]),
);

const TOOL_TOKEN = /dexe_[a-z0-9_]+/g;
const HINT = /DEXE_TOOLSETS=([a-z,]+)/;

/**
 * A followUp is free-form prose naming one or more tools. Split it so each tool
 * owns the text that follows it, up to the next tool name — that span is where
 * its annotation has to live for a reader to attach it to the right tool.
 */
function segments(text: string): Array<{ tool: string; tail: string }> {
  const hits = [...text.matchAll(TOOL_TOKEN)];
  return hits.map((m, i) => ({
    tool: m[0],
    tail: text.slice(
      m.index! + m[0].length,
      i + 1 < hits.length ? hits[i + 1]!.index! : text.length,
    ),
  }));
}

function assertActionable(text: string, where: string): string[] {
  const named: string[] = [];
  for (const { tool, tail } of segments(text)) {
    named.push(tool);
    if (DEFAULT_PROFILE.has(tool)) continue;
    const hint = HINT.exec(tail);
    expect(
      hint,
      `${where}: "${text}"\n  names ${tool}, which the DEFAULT profile does not register, ` +
        `with no DEXE_TOOLSETS annotation — an agent following this advice gets a 404.`,
    ).toBeTruthy();
    const profile = resolveToolsets(hint![1]!.split(","));
    expect(
      profile.names?.has(tool) ?? profile.full,
      `${where}: ${tool} is annotated "${hint![0]}", but that profile does not contain it.`,
    ).toBe(true);
    // The advice must not take away the tool that gave it: DEXE_TOOLSETS
    // REPLACES the profile, it does not extend it.
    expect(
      profile.names?.has("dexe_dao_report") ?? profile.full,
      `${where}: "${hint![0]}" would unregister dexe_dao_report itself.`,
    ).toBe(true);
  }
  return named;
}

// ---------- on-chain mock ----------

const DAO = "0xbb1918019Af8C6A26fF34Ce8FB8305976E1F626d";
const DAO_LC = DAO.toLowerCase();
const SETTINGS = "0x1111111111111111111111111111111111111111";
const USER_KEEPER = "0x2222222222222222222222222222222222222222";
const VALIDATORS = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x6666666666666666666666666666666666666666";
const VOTER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const NOW = 1_800_000_000;

const ok = (value: unknown) => ({ success: true, value, raw: "0x" });
const failed = (error: string) => ({ success: false, value: null, raw: "0x", error });

let helpersRevert = false;

const settingsTuple = () => [
  true,
  false,
  true,
  86_400n,
  43_200n,
  3_600n,
  10n ** 25n * 51n,
  10n ** 25n * 60n,
  10n ** 18n,
  10n ** 19n,
  [TOKEN, 0n, 0n, 0n],
  "DEFAULT",
];

function proposalView(id: number) {
  return {
    proposal: {
      core: {
        voteEnd: BigInt(NOW + 3_600 * id),
        executeAfter: BigInt(NOW + 7_200),
        executed: false,
        votesFor: BigInt(id) * 100n,
        votesAgainst: 0n,
      },
      descriptionURL: `ipfs://proposal-${id}`,
    },
    validatorProposal: { core: { voteEnd: BigInt(NOW + 1_800), executeAfter: 0n } },
    proposalState: 0,
    requiredQuorum: 1_000n,
  };
}

function answerCall(c: { method: string; args: readonly unknown[] }) {
  switch (c.method) {
    case "getHelperContracts":
      return helpersRevert
        ? failed("call reverted")
        : ok({
            settings: SETTINGS,
            userKeeper: USER_KEEPER,
            validators: VALIDATORS,
            poolRegistry: SETTINGS,
            votePower: SETTINGS,
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
      return ok(2n);
    case "getDefaultSettings":
    case "getInternalSettings":
      return ok(settingsTuple());
    case "validatorsCount":
      return ok(3n);
    case "tokenAddress":
      return ok(TOKEN);
    case "getCreditInfo":
      return ok([]);
    case "getProposals":
      return ok([proposalView(1), proposalView(2)]);
    case "symbol":
      return ok("PST");
    case "decimals":
      return ok(18n);
    case "totalSupply":
      return ok(10n ** 24n);
    case "balanceOf":
      return ok(10n ** 21n);
    default:
      return failed(`unmocked method ${c.method}`);
  }
}

vi.mock("../../src/lib/multicall.js", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  multicall: vi.fn(async (_provider: unknown, calls: unknown[]) =>
    (calls as Array<{ method: string; args: readonly unknown[] }>).map(answerCall),
  ),
}));

const multicallMock = vi.mocked(multicall);

// ---------- RPC mock ----------

let rpcChains = new Set<number>([56, 97]);

const fakeProvider = {
  getBalance: vi.fn(async () => 5n * 10n ** 18n),
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
    requireProvider() {
      return fakeProvider;
    }
  }
  return { ...actual, RpcProvider: MockRpcProvider };
});

// ---------- subgraph mock ----------

function poolsResponse() {
  return {
    daoPools: [
      {
        id: DAO_LC,
        name: "Polaris Assembly",
        userKeeper: USER_KEEPER,
        erc20Token: TOKEN,
        erc721Token: "0x0000000000000000000000000000000000000000",
        nftMultiplier: "0x0000000000000000000000000000000000000000",
        votersCount: "12",
        proposalCount: "2",
        creationTime: String(NOW - 1_000_000),
        creationBlock: "61000000",
        totalCurrentTokenDelegated: "1000",
        totalCurrentTokenDelegatees: "2",
        totalCurrentTokenDelegatedTreasury: "0",
      },
    ],
    members: [
      {
        joinedTimestamp: String(NOW - 100),
        receivedDelegation: "0",
        receivedTreasuryDelegation: "0",
        engagedProposalsCount: "1",
        currentDelegateesCount: "0",
        currentDelegatorsCount: "0",
        totalClaimedUSD: "0",
        totalLockedUSD: "0",
        expertNft: null,
        voter: {
          id: VOTER_A,
          totalProposalsCreated: "1",
          totalVotedProposals: "1",
          totalVotes: "1",
          currentVotesReceived: "0",
          currentVotesDelegated: "0",
        },
      },
    ],
    experts: [],
    proposals: [
      {
        proposalId: "1",
        votersVoted: "2",
        currentVotesFor: "100",
        currentVotesAgainst: "0",
        quorum: "1000",
        quorumReachedTimestamp: "0",
        executionTimestamp: "0",
        isFor: true,
        creator: { id: VOTER_A },
      },
    ],
    delegations: [],
  };
}

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
      return poolsResponse();
    case "activity":
      return {
        proposalsCreated: [],
        votes: [],
        executions: [],
        delegations: [],
        rewardClaims: [],
        deposits: [],
      };
    case "validators":
      return { validatorInPools: [] };
    default:
      return {};
  }
}

const realFetch = globalThis.fetch;

// ---------- harness ----------

function config(opts: {
  subgraphs?: Record<number, Partial<SubgraphEndpoints>>;
  defaultChainId?: number;
  statePath: string;
}): DexeConfig {
  return {
    defaultChainId: opts.defaultChainId ?? 56,
    statePath: opts.statePath,
    chains: new Map([56, 97].map((c) => [c, { chainId: c, rpcUrl: `https://rpc.example/${c}` }])),
    subgraphUrls: new Map(
      Object.entries(opts.subgraphs ?? {}).map(([k, v]) => [Number(k), v] as const),
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

/**
 * Every follow-up string the payload can carry: the top-level `followUps[]`, the
 * `unavailable[]` entries, and ANY `followUp` key nested inside a section —
 * `membership.data.tokenHolders.followUp` is one, so a shallow read would miss
 * it.
 */
function followUpsOf(res: ToolResult): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const sc = (res.structuredContent ?? {}) as Record<string, unknown>;

  for (const f of (sc.followUps as string[] | undefined) ?? []) {
    out.push({ where: "followUps[]", text: f });
  }
  for (const u of (sc.unavailable as Array<{ section: string; followUp?: string }>) ?? []) {
    if (u.followUp) out.push({ where: `unavailable[${u.section}].followUp`, text: u.followUp });
  }
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "followUp" && typeof v === "string") out.push({ where: `${path}.${k}`, text: v });
      else walk(v, `${path}.${k}`);
    }
  };
  walk(sc.sections, "sections");
  return out;
}

let tmp: string;

// Transforming report.ts + its dependency graph costs several seconds on a cold
// run, which would otherwise land entirely inside whichever test imports it
// first and blow the default 5s budget. Pay it once, in a hook.
beforeAll(async () => {
  await import("../../src/tools/report.js");
}, 60_000);

beforeEach(() => {
  helpersRevert = false;
  rpcChains = new Set([56, 97]);
  multicallMock.mockClear();
  tmp = mkdtempSync(join(tmpdir(), "dexe-report-followup-"));
  globalThis.fetch = vi.fn(async (_url: string, init?: { body?: string }) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: graphAnswer(documentOf(init)) }),
  })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

const statePath = () => join(tmp, "state.json");

// ---------- 1. the chain-97 degraded path, where followUps actually fire ----

describe("dexe_dao_report — chain-97 partial report names only callable tools", () => {
  it("annotates every follow-up the default profile cannot call", async () => {
    // The exact shape the verifier ran: an RPC for chain 97, no indexer, so the
    // subgraph-backed sections degrade and every followUp path fires.
    const res = await callReport(
      config({ subgraphs: { 56: { pools: "https://gw.example/56/pools" } }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    expect(res.isError).toBeFalsy();

    const followUps = followUpsOf(res);
    // The degraded path must actually have produced advice — a green assertion
    // over an empty list would prove nothing.
    expect(followUps.length).toBeGreaterThanOrEqual(7);

    const named = new Set<string>();
    for (const f of followUps) for (const t of assertActionable(f.text, f.where)) named.add(t);

    // The six the live run named and the session could not call. Each must now
    // either be gone from the advice or carry a working annotation — checked
    // above; here we prove they are still NAMED (the advice was not "fixed" by
    // deleting it) and that the report knows they are not in this profile.
    for (const tool of [
      "dexe_proposal_voters",
      "dexe_read_dao_experts",
      "dexe_read_expert_status",
      "dexe_read_gov_state",
      "dexe_read_multicall",
      "dexe_read_user_activity",
    ]) {
      expect(DEFAULT_PROFILE.has(tool), `${tool} is in the default profile now — update this test`).toBe(false);
      expect([...named], `${tool} disappeared from the advice`).toContain(tool);
    }
  });

  it("leads with a default-profile tool wherever one answers the same question", async () => {
    const res = await callReport(
      config({ subgraphs: { 56: { pools: "https://gw.example/56/pools" } }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    const bySection = new Map(
      followUpsOf(res)
        .filter((f) => f.where.startsWith("unavailable["))
        .map((f) => [f.where.slice("unavailable[".length, f.where.indexOf("]")), f.text]),
    );
    // Every degraded section that has a same-question answer in the default
    // profile must name it FIRST — an annotation is the fallback, not the lead.
    for (const section of ["membership", "delegation", "experts", "turnout", "activity"]) {
      const advice = bySection.get(section);
      expect(advice, `no follow-up for ${section}`).toBeTruthy();
      const first = segments(advice!)[0]!;
      expect(
        DEFAULT_PROFILE.has(first.tool),
        `${section}: leads with ${first.tool}, which this session cannot call — "${advice}"`,
      ).toBe(true);
    }
  });

  it("prints the annotation in the human body, not only in the payload", async () => {
    const res = await callReport(
      config({ subgraphs: { 56: { pools: "https://gw.example/56/pools" } }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    const body = text(res);
    expect(body).toContain("SECTIONS NOT RENDERED");
    expect(body).toContain("dexe_proposal_voters (one call per proposal; DEXE_TOOLSETS=core,read)");
    // A tool this session HAS is named bare — no annotation noise.
    expect(body).toMatch(/dexe_proposal_list(?! \(DEXE_TOOLSETS)/);
  });
});

// ---------- 2. the other degraded shapes ----------

describe("dexe_dao_report — every degraded shape names callable tools", () => {
  it("holds when the RPC is what is missing (on-chain sections degrade)", async () => {
    rpcChains = new Set([56]);
    const res = await callReport(
      config({
        subgraphs: {
          97: { pools: "https://gw.example/97/pools", interactions: "https://gw.example/97/int" },
        },
        statePath: statePath(),
      }),
      { govPool: DAO, chainId: 97 },
    );
    expect(res.isError).toBeFalsy();
    const followUps = followUpsOf(res);
    const sections = followUps
      .filter((f) => f.where.startsWith("unavailable["))
      .map((f) => f.where.slice("unavailable[".length, f.where.indexOf("]")));
    // This shape is the only one that exercises the settings / treasury /
    // proposals / deadlines / validators follow-ups.
    expect(sections).toEqual(
      expect.arrayContaining(["settings", "treasury", "proposals", "deadlines", "validators"]),
    );
    for (const f of followUps) assertActionable(f.text, f.where);
    // …and the nested one inside a section that DID render.
    expect(followUps.map((f) => f.where)).toContain(
      "sections.membership.data.tokenHolders.followUp",
    );
  });

  it("holds when the address is not a GovPool and there is no indexer either", async () => {
    helpersRevert = true;
    const res = await callReport(
      config({ subgraphs: { 56: { pools: "https://gw.example/56/pools" } }, statePath: statePath() }),
      { govPool: DAO, chainId: 97 },
    );
    const followUps = followUpsOf(res);
    expect(followUps.map((f) => f.where)).toContain("unavailable[identity].followUp");
    for (const f of followUps) assertActionable(f.text, f.where);
  });

  it("holds on a fully-served mainnet run (the followUps[] that always fire)", async () => {
    const res = await callReport(
      config({
        subgraphs: {
          56: {
            pools: "https://gw.example/56/pools",
            validators: "https://gw.example/56/validators",
            interactions: "https://gw.example/56/int",
          },
        },
        statePath: statePath(),
      }),
      { govPool: DAO },
    );
    expect(res.structuredContent!.unavailable).toEqual([]);
    const followUps = followUpsOf(res);
    expect(followUps.length).toBeGreaterThan(0);
    for (const f of followUps) assertActionable(f.text, f.where);
  });
});

// ---------- 3. the annotator itself ----------

describe("toolRef / toolsetHint", () => {
  it("annotates exactly the tools outside the default profile", async () => {
    const { toolRef, toolsetHint } = await import("../../src/tools/report.js");
    for (const tool of ALL_TOOLS) {
      const hint = toolsetHint(tool);
      if (DEFAULT_PROFILE.has(tool)) {
        expect(hint, `${tool} is default-visible but was annotated`).toBeNull();
        expect(toolRef(tool)).toBe(tool);
        continue;
      }
      expect(hint, `${tool} is not default-visible but got no hint`).toMatch(/^DEXE_TOOLSETS=/);
      const profile = resolveToolsets(hint!.replace("DEXE_TOOLSETS=", "").split(","));
      expect(profile.names?.has(tool) ?? profile.full, `${hint} does not expose ${tool}`).toBe(true);
      expect(
        profile.names?.has("dexe_dao_report") ?? profile.full,
        `${hint} would unregister dexe_dao_report itself`,
      ).toBe(true);
      expect(toolRef(tool)).toBe(`${tool} (${hint})`);
      expect(toolRef(tool, "why")).toBe(`${tool} (why; ${hint})`);
    }
  });

  it("falls back to `full` for a name no named set carries", async () => {
    const { toolsetHint } = await import("../../src/tools/report.js");
    expect(toolsetHint("dexe_not_a_real_tool")).toBe("DEXE_TOOLSETS=full");
  });
});

// ---------- 4. structural guard ----------

describe("src/tools/report.ts", () => {
  it("routes every tool name it can print through the annotator", async () => {
    // The runtime tests above can only cover the follow-up paths a scenario
    // reaches. This closes the rest: a bare "dexe_…" literal is a name that
    // would reach a user un-annotated, so it must go through toolRef().
    const src = readFileSync(
      fileURLToPath(new URL("../../src/tools/report.ts", import.meta.url)),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bare: string[] = [];
    for (const m of code.matchAll(/(toolRef\(\s*")?(dexe_[a-z0-9_]+)/g)) {
      // The tool's own name: its registration and its error-context labels.
      if (!m[1] && m[2] !== "dexe_dao_report") bare.push(m[2]!);
    }
    expect(
      bare,
      "these tool names are printed literally — wrap them in toolRef() so the " +
        "reader is told which DEXE_TOOLSETS value makes them callable",
    ).toEqual([]);
  });
});
