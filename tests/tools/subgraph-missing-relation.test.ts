import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import { registerProposalTools } from "../../src/tools/proposal.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.34.0 — one orphaned Voter record used to make a DAO completely unreadable.
 *
 * Live on BSC mainnet: `dexe_read_dao_members {govPool: BOXY, chainId: 56}`
 * fails identically at limit=20, at limit=1/offset=0 and at limit=5/offset=1
 * with "Subgraph errors: Null value resolved for non-null field `voter`". The
 * FIRST row is broken, so no offset walks around it, and ~5% of the first 1000
 * VoterInPool rows on mainnet are orphaned — this is index-wide, not a BOXY
 * anomaly. GraphQL non-null propagation returns errors with NO `data` key at
 * all, so the healthy rows in the same document die with the broken one.
 *
 * The fix is a second pass with `voter` gated off by `@include(if: $withVoter)`
 * and the wallet recovered from the row id. These tests pin that the rows come
 * back, that the degrade is ANNOUNCED (not silently partial), and that the
 * happy path still costs exactly one round trip.
 */

const POOL = "0x927980153ef1743a3e9f3549eb307e06c74b5571";
const W1 = "0x00e2e87370600d9626de6573d1e95b2205ec6ac2";
const W2 = "0x02de61a5c1f2a0e0b5c5e5e5e5e5e5e5e5e5e5a6";
const ORPHAN_BODY = {
  errors: [{ locations: [{ column: 116, line: 2 }], message: "Null value resolved for non-null field `voter`" }],
};

const URLS = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
} as const;

function config(): DexeConfig {
  return {
    defaultChainId: 56,
    subgraphUrls: new Map([[56, { ...URLS }]]),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

type Register = (server: McpServer, ctx: ToolContext) => void;

/**
 * Drives a REAL McpServer + Client, and calls listTools() first so the SDK
 * caches the advertised output validator. Without that, an undeclared
 * structuredContent field on `dexe_proposal_voters` (which DOES declare an
 * outputSchema, unlike the subgraph tools) would ship undetected.
 */
async function callTool(
  register: Register,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  register(server, { config: config() } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.listTools();
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

/** Replies are chosen by the request's own `withVoter` variable / operation. */
function routeFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown) {
  fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as {
      query: string;
      variables: Record<string, unknown>;
    };
    const out = handler(body) as { status?: number; body: unknown };
    const status = out.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

const bodies = () =>
  fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as {
    query: string;
    variables: Record<string, unknown>;
  });

beforeEach(() => {
  fetchMock = vi.fn();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("dexe_read_dao_members survives an orphaned Voter record", () => {
  it("returns the rows, backfills the stats it can, and says what is missing", async () => {
    routeFetch((b) => {
      if (b.query.includes("getVotersByIds")) {
        // Only W2 has a Voter entity — W1 is the genuine orphan.
        return { body: { data: { voters: [{ id: W2, totalVotes: "500000000000000000000" }] } } };
      }
      if (b.variables.withVoter === true) return { body: ORPHAN_BODY };
      return {
        body: {
          data: {
            daoPools: [{ votersCount: "104" }],
            voterInPools: [
              { id: `${W1}${POOL.slice(2)}`, receivedDelegation: "0" },
              { id: `${W2}${POOL.slice(2)}`, receivedDelegation: "1418654903463600902264" },
            ],
          },
        },
      };
    });

    const res = await callTool(registerSubgraphTools, "dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
      limit: 20,
    });

    expect(res.isError).toBeFalsy();
    const members = res.structuredContent!.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(2);
    // The orphan: wallet recovered from the row id, flagged as stats-less.
    expect((members[0]!.voter as { id: string }).id).toBe(W1);
    expect(members[0]!.voterStatsUnavailable).toBe(true);
    // The healthy row: backfilled from the voters(id_in:) query.
    expect((members[1]!.voter as { totalVotes: string }).totalVotes).toBe("500000000000000000000");
    expect(members[1]!.voterStatsUnavailable).toBe(false);
    // 18-dec power formatting rides along.
    expect(members[1]!.receivedDelegationFormatted).toBe("1418.654903463600902264");

    expect(String(res.structuredContent!.indexerWarning)).toMatch(/DEGRADED/);
    expect(String(res.structuredContent!.indexerWarning)).toMatch(/NOT transient/);
    // It must reach the TEXT channel too, not hide in structuredContent.
    expect(text(res)).toContain("DEGRADED");
    expect(text(res)).toContain("dexe_vote_user_power");
  });

  it("costs exactly one round trip when the index is healthy", async () => {
    routeFetch(() => ({
      body: {
        data: {
          daoPools: [{ votersCount: "104" }],
          voterInPools: [{ id: `${W2}${POOL.slice(2)}`, voter: { id: W2, totalVotes: "1" } }],
        },
      },
    }));
    const res = await callTool(registerSubgraphTools, "dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
      limit: 20,
    });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0]!.variables.withVoter).toBe(true);
    expect(res.structuredContent!.indexerWarning).toBeNull();
  });

  it("does not retry a transient 429, and never sends withVoter:false for one", async () => {
    routeFetch(() => ({ status: 429, body: { message: "slow down" } }));
    const res = await callTool(registerSubgraphTools, "dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
    });
    expect(res.isError).toBe(true);
    // gqlRequest itself retries a transient status once; the orphan fallback
    // must not add a third attempt.
    expect(bodies().every((b) => b.variables.withVoter === true)).toBe(true);
  });

  it("does not waste a round trip on a DIFFERENT broken relation", async () => {
    routeFetch(() => ({
      body: { errors: [{ message: "Null value resolved for non-null field `expertNft`" }] },
    }));
    const res = await callTool(registerSubgraphTools, "dexe_read_dao_members", {
      govPool: POOL,
      chainId: 56,
    });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("dexe_read_dao_experts survives the same fault", () => {
  it("returns rows with derived wallets and no fabricated total", async () => {
    routeFetch((b) => {
      if (b.variables.withVoter === true) return { body: ORPHAN_BODY };
      return {
        body: {
          data: {
            voterInPools: [{ id: `${W1}${POOL.slice(2)}`, receivedDelegation: "0" }],
          },
        },
      };
    });
    const res = await callTool(registerSubgraphTools, "dexe_read_dao_experts", {
      govPool: POOL,
      chainId: 56,
      limit: 50,
    });
    expect(res.isError).toBeFalsy();
    const experts = res.structuredContent!.experts as Array<Record<string, unknown>>;
    expect((experts[0]!.voter as { id: string }).id).toBe(W1);
    expect(experts[0]!.voterStatsUnavailable).toBe(true);
    // `votersCount` counts voters, not expert-NFT holders — it must never be
    // reported here (live: BOXY is 0 experts vs 104 voters).
    expect("total" in res.structuredContent!).toBe(false);
    expect(text(res)).toContain("DEGRADED");
  });

  it("an empty expert list is complete, not a page-0 loop", async () => {
    routeFetch(() => ({ body: { data: { voterInPools: [] } } }));
    const res = await callTool(registerSubgraphTools, "dexe_read_dao_experts", {
      govPool: POOL,
      chainId: 56,
    });
    expect(res.structuredContent!.truncated).toBe(false);
    expect(res.structuredContent!.nextOffset).toBeUndefined();
    expect(text(res)).not.toContain("PARTIAL LIST");
  });
});

describe("dexe_proposal_voters survives the same fault", () => {
  it("keeps the wallet from the outer composite id and declares every field it emits", async () => {
    routeFetch((b) => {
      if (b.variables.withVoter === true) return { body: ORPHAN_BODY };
      return {
        body: {
          data: {
            proposalInteractions: [
              {
                id: "0xabc",
                hash: "0xdeadbeef",
                timestamp: "1719405970",
                interactionType: "1",
                totalVote: "100000000000000000000000000",
                // Inner `voter` gated off; the OUTER composite id survives.
                voter: { id: `${W1}${POOL.slice(2)}deadbeef` },
              },
            ],
          },
        },
      };
    });
    const res = await callTool(registerProposalTools, "dexe_proposal_voters", {
      govPool: POOL,
      proposalId: 1,
      chainId: 56,
      first: 50,
    });
    // A validating client throws on an undeclared structuredContent key, so
    // reaching here at all is the outputSchema regression guard.
    expect(res.isError).toBeFalsy();
    const voters = res.structuredContent!.voters as Array<Record<string, unknown>>;
    expect(voters[0]!.voter).toBe(W1);
    expect(voters[0]!.totalVoteFormatted).toBe("100000000.0");
    expect(text(res)).toContain("DEGRADED");
  });
});
