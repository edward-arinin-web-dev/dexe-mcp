import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * D1-3 — the read surface used to hand agents votes with no target.
 *
 * `dexe_proposal_list` computed `requiredQuorum` and then dropped it from the
 * text an agent quotes; `dexe_proposal_state` returned `requiredQuorum` but no
 * votes, so neither tool alone could answer "is quorum met". Both now carry the
 * attainment of BOTH sides, because DeXe quorum is per-side: GovPoolVote.sol
 * :367-375 is true when EITHER votesFor OR votesAgainst clears the target,
 * never their sum.
 *
 * Everything runs through McpServer + Client + InMemoryTransport so the SDK's
 * outputSchema validation actually executes — a non-nullable field on a leg that
 * is allowed to fail would turn a working read into a hard error.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { registerProposalTools } from "../../src/tools/proposal.js";

const mc = vi.mocked(multicall);

const GOV = "0xbb1918019af8c6a26ff34ce8fb8305976e1f626d";

interface Row {
  votesFor: bigint;
  votesAgainst: bigint;
  executeAfter: bigint;
  requiredQuorum?: bigint;
  state?: number;
  executed?: boolean;
}

function view(r: Row) {
  return {
    proposal: {
      core: {
        voteEnd: 1_700_000_000n,
        executeAfter: r.executeAfter,
        executed: r.executed ?? false,
        votesFor: r.votesFor,
        votesAgainst: r.votesAgainst,
      },
      descriptionURL: "ipfs://Qm-description",
    },
    proposalState: r.state ?? 0,
    ...(r.requiredQuorum === undefined ? {} : { requiredQuorum: r.requiredQuorum }),
  };
}

let captured: Array<{ method: string; args: readonly unknown[] }> = [];

/** `listValue` of `null` makes the getProposals leg fail (allowFailure). */
function mockChain(opts: {
  rows?: Row[] | "fail" | "empty";
  stateIndex?: number;
  requiredQuorum?: bigint;
}): void {
  mc.mockImplementation(async (_p: unknown, calls: Array<{ method: string; args: readonly unknown[] }>) => {
    captured.push(...calls.map((c) => ({ method: c.method, args: c.args })));
    return calls.map((c) => {
      switch (c.method) {
        case "getProposalState":
          return { success: true, value: BigInt(opts.stateIndex ?? 0) as never, raw: "0x" };
        case "getProposalRequiredQuorum":
          return { success: true, value: (opts.requiredQuorum ?? 0n) as never, raw: "0x" };
        case "getProposals":
          if (opts.rows === "fail") return { success: false, value: null, raw: "0x", error: "call reverted" };
          if (opts.rows === "empty" || opts.rows === undefined)
            return { success: true, value: [] as never, raw: "0x" };
          return { success: true, value: opts.rows.map(view) as never, raw: "0x" };
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
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalTools(server, { config: config() } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const rows = (r: ToolResult) => r.structuredContent!.proposals as Array<Record<string, unknown>>;

beforeEach(() => {
  captured = [];
});
afterEach(() => mc.mockReset());

describe("dexe_proposal_list reports quorum progress, not bare vote totals", () => {
  it("a For-carried proposal past quorum: 185.71%, nothing short", async () => {
    mockChain({
      rows: [
        {
          votesFor: 2_051_925_536_089_401_709_423_372n,
          votesAgainst: 0n,
          executeAfter: 1n,
          requiredQuorum: 1_104_905_130_258_978_500_000_000n,
          state: 7,
          executed: true,
        },
      ],
    });
    const res = await call("dexe_proposal_list", { govPool: GOV, offset: 0, limit: 1 });
    expect(res.isError).toBeFalsy();
    const p = rows(res)[0]!;
    expect(p.quorumAttainmentForPct as number).toBeCloseTo(185.71, 1);
    expect(p.quorumAttainmentAgainstPct).toBe(0);
    expect(p.votesShortOfQuorum).toBe("0");
    expect(p.quorumReached).toBe(true);
    expect(text(res)).toContain("185");
    expect(text(res)).toContain("quorum REACHED");
  });

  it("a proposal short of quorum names the exact shortfall", async () => {
    mockChain({
      rows: [
        {
          votesFor: 73_528_733_728_891_976_396_172n,
          votesAgainst: 0n,
          executeAfter: 0n,
          requiredQuorum: 500_000_000_000_000_000_000_000n,
          state: 3,
        },
      ],
    });
    const res = await call("dexe_proposal_list", { govPool: GOV, offset: 0, limit: 1 });
    const p = rows(res)[0]!;
    expect(p.quorumAttainmentForPct as number).toBeCloseTo(14.7, 1);
    expect(p.votesShortOfQuorum).toBe("426471266271108023603828");
    expect(p.quorumReached).toBe(false);
    expect(text(res)).toContain("short by 426471266271108023603828");
  });

  it("an AGAINST-carried proposal has reached quorum and is never 'short by'", async () => {
    // The case a votesFor-only attainment model gets wrong.
    mockChain({
      rows: [
        {
          votesFor: 1n,
          votesAgainst: 600_000_000_000_000_000_000_000n,
          executeAfter: 9n,
          requiredQuorum: 500_000_000_000_000_000_000_000n,
          state: 5,
        },
      ],
    });
    const res = await call("dexe_proposal_list", { govPool: GOV, offset: 0, limit: 1 });
    const p = rows(res)[0]!;
    expect(p.quorumReached).toBe(true);
    expect(p.quorumAttainmentAgainstPct).toBe(120);
    expect(p.votesShortOfQuorum).toBe("0");
    expect(text(res)).not.toContain("short by");
  });

  it("requiredQuorum 0 → every quorum number null, never Infinity or NaN", async () => {
    mockChain({ rows: [{ votesFor: 5n, votesAgainst: 0n, executeAfter: 0n, requiredQuorum: 0n }] });
    const res = await call("dexe_proposal_list", { govPool: GOV, offset: 0, limit: 1 });
    const p = rows(res)[0]!;
    expect(p.quorumAttainmentForPct).toBeNull();
    expect(p.quorumAttainmentAgainstPct).toBeNull();
    expect(p.votesShortOfQuorum).toBeNull();
    expect(p.quorumReached).toBe(false);
    const json = JSON.stringify(res.structuredContent);
    expect(json).not.toContain("Infinity");
    expect(json).not.toContain("NaN");
  });

  it("a row with no requiredQuorum field at all still validates against the schema", async () => {
    mockChain({ rows: [{ votesFor: 5n, votesAgainst: 0n, executeAfter: 0n }] });
    const res = await call("dexe_proposal_list", { govPool: GOV, offset: 0, limit: 1 });
    expect(res.isError).toBeFalsy();
    expect(rows(res)[0]!.requiredQuorum).toBe("0");
  });
});

describe("dexe_proposal_state answers 'is quorum met' on its own", () => {
  it("carries votes on both sides plus the attainment of each", async () => {
    mockChain({
      stateIndex: 7,
      requiredQuorum: 1_104_905_130_258_978_500_000_000n,
      rows: [
        {
          votesFor: 2_051_925_536_089_401_709_423_372n,
          votesAgainst: 0n,
          executeAfter: 1n,
          requiredQuorum: 1_104_905_130_258_978_500_000_000n,
        },
      ],
    });
    const res = await call("dexe_proposal_state", { govPool: GOV, proposalId: "28" });
    expect(res.isError).toBeFalsy();
    const s = res.structuredContent!;
    expect(s.votesFor).toBe("2051925536089401709423372");
    expect(s.votesAgainst).toBe("0");
    expect(s.quorumReached).toBe(true);
    expect(s.quorumAttainmentForPct as number).toBeCloseTo(185.71, 1);
    expect(s.votesShortOfQuorum).toBe("0");
    expect(text(res)).toContain("absolute vote weight");
    expect(text(res)).toContain("quorum REACHED");
    // The votes ride in the SAME batch: 3 calls, one round-trip.
    expect(captured.map((c) => c.method)).toEqual([
      "getProposalState",
      "getProposalRequiredQuorum",
      "getProposals",
    ]);
    expect(captured[2]!.args).toEqual([27n, 1n]);
  });

  it.each([
    ["the getProposals leg reverts", "fail" as const],
    ["the id is past latestProposalId (empty array, not a revert)", "empty" as const],
  ])("degrades to nulls when %s", async (_label, rowsSpec) => {
    mockChain({ stateIndex: 3, requiredQuorum: 500n, rows: rowsSpec });
    const res = await call("dexe_proposal_state", { govPool: GOV, proposalId: "999" });
    // Still a successful read — the pre-existing fields are unchanged.
    expect(res.isError).toBeFalsy();
    const s = res.structuredContent!;
    expect(s.state).toBe("Defeated");
    expect(s.stateIndex).toBe(3);
    expect(s.requiredQuorum).toBe("500");
    expect(s.votesFor).toBeNull();
    expect(s.votesAgainst).toBeNull();
    expect(s.quorumReached).toBeNull();
    expect(s.quorumAttainmentForPct).toBeNull();
    expect(s.quorumAttainmentAgainstPct).toBeNull();
    expect(s.votesShortOfQuorum).toBeNull();
  });

  it("proposalId 0 never encodes a negative offset", async () => {
    // getProposals(0 - 1, 1) would be -1n: ethers refuses to encode it and the
    // throw escapes multicall's per-call allowFailure entirely.
    mockChain({ stateIndex: 9, requiredQuorum: 0n });
    const res = await call("dexe_proposal_state", { govPool: GOV, proposalId: "0" });
    expect(res.isError).toBeFalsy();
    expect(captured.map((c) => c.method)).toEqual(["getProposalState", "getProposalRequiredQuorum"]);
    expect(captured.every((c) => (c.args as bigint[]).every((a) => a >= 0n))).toBe(true);
    expect(res.structuredContent!.state).toBe("Undefined");
  });

  it("requiredQuorum 0 says what 0 means instead of implying 'quorum is nothing'", async () => {
    mockChain({ stateIndex: 9, requiredQuorum: 0n });
    const res = await call("dexe_proposal_state", { govPool: GOV, proposalId: "4242" });
    expect(text(res)).toContain("does not exist or has not started");
  });
});
