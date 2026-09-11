import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * D1-1 / D1-4 — `dexe_proposal_forecast` units and pass-rate denominator.
 *
 * The shipped tool compared token-wei `votesFor` against the 1e25-scaled quorum
 * SETTING, so every verdict on a real DAO was wrong by totalPower/1e27 — in
 * either direction. Every fixture here uses REAL magnitudes (18-decimal supply,
 * 5% as 5e25) because at toy scale (`quorum: 100n`, `votesFor: 500n`) the unit
 * mismatch is arithmetically invisible.
 *
 * Offline: `multicall` is mocked, `fetch` is mocked, and the calls array is
 * captured so the TARGET of `getTotalPower` is asserted — sending it to the
 * GovPool (which has no such function) would revert under allowFailure and make
 * every forecast permanently "unknown", the same silent-wrong-answer class that
 * let the original bug ship.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { registerPredictTools } from "../../src/tools/predict.js";

const mc = vi.mocked(multicall);

const GOV = "0xbb1918019af8c6a26ff34ce8fb8305976e1f626d";
const SETTINGS = "0x1111111111111111111111111111111111111111";
const USER_KEEPER = "0x2222222222222222222222222222222222222222";

const QUORUM_5_PCT = 50_000_000_000_000_000_000_000_000n;
const QUORUM_10_PCT = 10n ** 26n;

/** DeXe Protocol DAO 0xb562…0f0b, chain 56 — read live 2026-09-11. */
const DEXE_TOTAL_POWER = 22_098_102_605_179_570_000_000_000n;
const DEXE_REQUIRED = 1_104_905_130_258_978_500_000_000n;
const DEXE_VOTES_FOR = 2_051_925_536_089_401_709_423_372n;

/** BOXY 0x9279…5571, chain 56 — getProposalRequiredQuorum(7) = 5e26. */
const BOXY_TOTAL_POWER = 10n ** 28n;
const BOXY_REQUIRED = 500_000_000_000_000_000_000_000_000n;
const BOXY_VOTES_FOR = 201_453_367_961_961_270_282_342_310n;

interface ProposalRow {
  state: number;
  votesFor: bigint;
  votesAgainst?: bigint;
  requiredQuorum?: bigint;
  executed?: boolean;
}

interface MockSpec {
  quorum?: bigint;
  totalPower?: bigint | "revert";
  rows: ProposalRow[];
  /** Drop `userKeeper` from getHelperContracts (a malformed/partial decode). */
  noUserKeeper?: boolean;
}

let captured: Array<{ method: string; target: string }> = [];

function mockChain(spec: MockSpec): void {
  mc.mockImplementation(async (_p: unknown, calls: Array<{ method: string; target: string }>) => {
    captured.push(...calls.map((c) => ({ method: c.method, target: c.target })));
    return calls.map((c) => {
      switch (c.method) {
        case "getHelperContracts":
          return {
            success: true,
            value: (spec.noUserKeeper ? { settings: SETTINGS } : { settings: SETTINGS, userKeeper: USER_KEEPER }) as never,
            raw: "0x",
          };
        case "latestProposalId":
          return { success: true, value: BigInt(spec.rows.length) as never, raw: "0x" };
        case "getDefaultSettings":
          return { success: true, value: { quorum: spec.quorum ?? QUORUM_5_PCT } as never, raw: "0x" };
        case "getTotalPower":
          return spec.totalPower === "revert" || spec.totalPower === undefined
            ? { success: false, value: null, raw: "0x", error: "call reverted" }
            : { success: true, value: spec.totalPower as never, raw: "0x" };
        case "getProposals":
          return {
            success: true,
            value: spec.rows.map((r) => ({
              proposal: {
                core: {
                  executed: r.executed ?? false,
                  votesFor: r.votesFor,
                  votesAgainst: r.votesAgainst ?? 0n,
                },
              },
              proposalState: r.state,
              ...(r.requiredQuorum === undefined ? {} : { requiredQuorum: r.requiredQuorum }),
            })) as never,
            raw: "0x",
          };
        default:
          return { success: false, value: null, raw: "0x", error: `unexpected ${c.method}` };
      }
    });
  });
}

function config(): DexeConfig {
  return {
    defaultChainId: 56,
    chainId: 56,
    usingPublicRpcFallback: false,
    chains: new Map([[56, { chainId: 56, rpcUrl: "https://rpc.example/56", rpcUrls: ["https://rpc.example/56"] }]]),
    subgraphUrls: new Map(),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function forecast(args: Record<string, unknown> = {}): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerPredictTools(server, { config: config() } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({
      name: "dexe_proposal_forecast",
      arguments: { govPool: GOV, chainId: 56, forceRpcOnly: true, ...args },
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const payload = (r: ToolResult) => JSON.parse(text(r)) as Record<string, unknown>;
const quorumOf = (r: ToolResult) => payload(r).quorum as Record<string, unknown>;

const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = [];
  globalThis.fetch = vi.fn(async () => {
    throw new Error("no subgraph in this suite");
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mc.mockReset();
});

describe("quorum is an absolute weight, not the 1e25 percentage setting", () => {
  it("DeXe-Protocol-shaped, 5% quorum, 10/10 executed → likelyPass (shipped: likelyFail)", async () => {
    mockChain({
      quorum: QUORUM_5_PCT,
      totalPower: DEXE_TOTAL_POWER,
      rows: Array.from({ length: 10 }, () => ({
        state: 7, // ExecutedFor
        executed: true,
        votesFor: DEXE_VOTES_FOR,
        requiredQuorum: DEXE_REQUIRED,
      })),
    });
    const res = await forecast();
    expect(res.isError).toBeFalsy();
    const q = quorumOf(res);
    expect(q.requiredWeight).toBe(DEXE_REQUIRED.toString());
    // Back-compat name now carries the value it always claimed.
    expect(q.required).toBe(DEXE_REQUIRED.toString());
    expect(q.settingRaw).toBe(QUORUM_5_PCT.toString());
    expect(q.quorumPct).toBe(5);
    expect(q.totalPower).toBe(DEXE_TOTAL_POWER.toString());
    expect(q.projectedPct as number).toBeCloseTo(185.71, 1);
    expect(q.hitProbability).toBe(1);
    expect(payload(res).recommendation).toBe("likelyPass");
    expect(payload(res).risks).not.toContain("quorumGap");
    expect(payload(res).quorumNote).toBeNull();
  });

  it("BOXY-shaped → likelyFail (shipped: likelyPass — the dangerous direction)", async () => {
    mockChain({
      quorum: QUORUM_5_PCT,
      totalPower: BOXY_TOTAL_POWER,
      rows: [{ state: 3, votesFor: BOXY_VOTES_FOR, requiredQuorum: BOXY_REQUIRED }],
    });
    const res = await forecast();
    const q = quorumOf(res);
    expect(q.requiredWeight).toBe(BOXY_REQUIRED.toString());
    expect(q.projectedPct as number).toBeCloseTo(40.29, 1);
    expect(payload(res).recommendation).toBe("likelyFail");
    expect(payload(res).risks).toContain("quorumGap");
  });

  it("round 10% quorum on a 1000-token, 18-decimal DAO", async () => {
    mockChain({
      quorum: QUORUM_10_PCT,
      totalPower: 1000n * 10n ** 18n,
      rows: [{ state: 7, executed: true, votesFor: 100n * 10n ** 18n, requiredQuorum: 100n * 10n ** 18n }],
    });
    const res = await forecast();
    const q = quorumOf(res);
    expect(q.requiredWeight).toBe((100n * 10n ** 18n).toString());
    expect(q.quorumPct).toBe(10);
    expect(q.projectedPct).toBe(100);
    expect(q.hitProbability).toBe(1);
    expect(payload(res).recommendation).toBe("likelyPass");
  });

  it("getTotalPower is addressed to the userKeeper, never the GovPool", async () => {
    mockChain({ totalPower: DEXE_TOTAL_POWER, rows: [{ state: 7, votesFor: 1n }] });
    await forecast();
    const tp = captured.find((c) => c.method === "getTotalPower");
    expect(tp).toBeDefined();
    expect(tp!.target.toLowerCase()).toBe(USER_KEEPER.toLowerCase());
    expect(tp!.target.toLowerCase()).not.toBe(GOV.toLowerCase());
  });

  it("the basis string names the formula, the default-settings limit and the per-side rule", async () => {
    mockChain({ totalPower: DEXE_TOTAL_POWER, rows: [{ state: 7, votesFor: 1n }] });
    const basis = String(quorumOf(await forecast()).basis);
    expect(basis).toContain("getTotalPower");
    expect(basis).toContain("1e27");
    expect(basis).toContain("DEFAULT settings");
    expect(basis).toContain("votesFor OR votesAgainst");
  });
});

describe("unknown total power degrades to 'unknown', it never guesses or throws", () => {
  it.each([
    ["getTotalPower reverts", { totalPower: "revert" as const }],
    ["getTotalPower returns 0", { totalPower: 0n }],
    ["getHelperContracts carries no userKeeper", { noUserKeeper: true, totalPower: DEXE_TOTAL_POWER }],
  ])("%s", async (_label, extra) => {
    mockChain({ rows: [{ state: 7, executed: true, votesFor: DEXE_VOTES_FOR }], ...extra });
    const res = await forecast();
    expect(res.isError).toBeFalsy();
    const q = quorumOf(res);
    expect(q.requiredWeight).toBeNull();
    expect(q.required).toBeNull();
    expect(q.projectedPct).toBeNull();
    expect(q.hitProbability).toBeNull();
    expect(payload(res).recommendation).toBe("unknown");
    expect(payload(res).risks).toContain("quorumUnknown");
    // 0 must never become a divisor, and no Infinity/NaN may reach the caller.
    expect(text(res)).not.toContain("Infinity");
    expect(text(res)).not.toContain("NaN");
  });

  it("the remediation is factually right: depositing does NOT change getTotalPower", async () => {
    mockChain({ totalPower: "revert", rows: [{ state: 7, votesFor: 1n }] });
    const note = String(payload(await forecast()).quorumNote);
    expect(note).toContain("total supply");
    expect(note).toContain("depositing does NOT change it");
    expect(note).toContain(USER_KEEPER);
    expect(note).toContain("chain 56");
    // Still useful: the pass-rate is on-chain and survives an unknown quorum.
    expect(note).toContain("in flight");
    expect(note).not.toContain("dexe_vote_build_deposit");
  });

  it("a missing userKeeper is skipped, not sent as target: undefined", async () => {
    mockChain({ noUserKeeper: true, rows: [{ state: 7, votesFor: 1n }] });
    const res = await forecast();
    expect(res.isError).toBeFalsy();
    expect(captured.filter((c) => c.method === "getTotalPower")).toHaveLength(0);
    expect(captured.every((c) => typeof c.target === "string" && c.target.length > 0)).toBe(true);
  });
});

describe("per-proposal quorum attainment survives a mid-history quorum change", () => {
  it("each row is measured against ITS OWN requiredQuorum", async () => {
    // BOXY's real pattern: the setting moved 1e25 → 5e25 between proposals.
    mockChain({
      totalPower: 1000n * 10n ** 18n,
      quorum: QUORUM_10_PCT,
      rows: [
        { state: 7, executed: true, votesFor: 50n * 10n ** 18n, requiredQuorum: 100n * 10n ** 18n }, // 50%
        { state: 7, executed: true, votesFor: 300n * 10n ** 18n, requiredQuorum: 200n * 10n ** 18n }, // 150%
      ],
    });
    const res = await forecast();
    const history = payload(res).history as Array<Record<string, unknown>>;
    expect(history[0]!.quorumAttainmentPct).toBe(50);
    expect(history[0]!.requiredQuorum).toBe((100n * 10n ** 18n).toString());
    expect(history[1]!.quorumAttainmentPct).toBe(150);
    expect(payload(res).historicalQuorumAttainmentPct).toBe(100);
  });

  it("rows with requiredQuorum 0 or absent are null and excluded from the mean", async () => {
    mockChain({
      totalPower: 1000n * 10n ** 18n,
      rows: [
        { state: 0, votesFor: 5n }, // no requiredQuorum field at all
        { state: 7, executed: true, votesFor: 1n, requiredQuorum: 0n },
        { state: 7, executed: true, votesFor: 40n * 10n ** 18n, requiredQuorum: 100n * 10n ** 18n },
      ],
    });
    const res = await forecast();
    const history = payload(res).history as Array<Record<string, unknown>>;
    expect(history[0]!.quorumAttainmentPct).toBeNull();
    expect(history[0]!.requiredQuorum).toBe("0");
    expect(history[1]!.quorumAttainmentPct).toBeNull();
    expect(history[2]!.quorumAttainmentPct).toBe(40);
    // The mean covers only the row that has a target — not 13.33, not NaN.
    expect(payload(res).historicalQuorumAttainmentPct).toBe(40);
    expect(text(res)).not.toContain("NaN");
  });

  it("null (not 0) when no row carries a target", async () => {
    mockChain({ totalPower: 1000n * 10n ** 18n, rows: [{ state: 0, votesFor: 5n }] });
    expect(payload(await forecast()).historicalQuorumAttainmentPct).toBeNull();
  });
});

describe("the pass-rate denominator is DECIDED proposals only", () => {
  const row = (state: number, executed = false): ProposalRow => ({
    state,
    executed,
    votesFor: 10n ** 18n,
    requiredQuorum: 10n ** 18n,
  });

  it("6 ExecutedFor + 1 Defeated + 2 Voting + 1 Locked → 6/7, not 6/10", async () => {
    mockChain({
      totalPower: 1000n * 10n ** 18n,
      rows: [
        ...Array.from({ length: 6 }, () => row(7, true)), // ExecutedFor
        row(3), // Defeated
        row(0), // Voting
        row(0), // Voting
        row(6), // Locked — post-quorum but not settled For/Against
      ],
    });
    const res = await forecast();
    expect(payload(res).historicalPassRate).toEqual({
      last10: 6,
      passed: 6,
      decided: 7,
      pending: 3,
      total: 10,
      ratio: 6 / 7,
    });
    expect(payload(res).risks).not.toContain("voterApathy");
  });

  it("an all-Voting window asserts nothing about apathy", async () => {
    mockChain({ totalPower: 1000n * 10n ** 18n, rows: Array.from({ length: 10 }, () => row(0)) });
    const res = await forecast();
    const hp = payload(res).historicalPassRate as Record<string, number>;
    expect(hp.decided).toBe(0);
    expect(hp.pending).toBe(10);
    expect(hp.ratio).toBe(0);
    expect(payload(res).risks).not.toContain("voterApathy");
  });

  it("a genuinely apathetic DAO still trips voterApathy", async () => {
    mockChain({
      totalPower: 1000n * 10n ** 18n,
      rows: [row(7, true), row(3), row(3), row(3), row(3)],
    });
    expect(payload(await forecast()).risks).toContain("voterApathy");
  });

  it("an Against win is not a pass", async () => {
    mockChain({ totalPower: 1000n * 10n ** 18n, rows: [row(8, true), row(5)] }); // Executed/SucceededAgainst
    const hp = payload(await forecast()).historicalPassRate as Record<string, number>;
    expect(hp.passed).toBe(0);
    expect(hp.decided).toBe(2);
    expect(hp.ratio).toBe(0);
  });

  it("each history row reports its outcome class", async () => {
    mockChain({ totalPower: 1000n * 10n ** 18n, rows: [row(7, true), row(0), row(3)] });
    const history = payload(await forecast()).history as Array<Record<string, unknown>>;
    expect(history.map((h) => h.outcome)).toEqual(["passedFor", "pending", "notPassed"]);
  });
});
