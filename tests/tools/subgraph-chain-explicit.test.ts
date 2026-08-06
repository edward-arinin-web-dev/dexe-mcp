import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import { registerProposalTools } from "../../src/tools/proposal.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints, SubgraphKind } from "../../src/config.js";

/**
 * 0.30.2 — "right chain or no answer" for every subgraph-backed tool.
 *
 * Before this, six of these tools took no `chainId` at all and one declared it
 * and threw it away, while the endpoints they used are BSC MAINNET by default.
 * A user on testnet (chain 97 — the chain this repo tells people to validate
 * on) got mainnet DAOs, members and voters returned as if they were theirs.
 * Nothing in the response said otherwise, so an agent would act on them.
 *
 * The two properties asserted here are exactly that failure and its fix:
 *   1. a chain with no endpoint produces an actionable error and NO rows —
 *      proven by the fetch mock never being called, so no other chain's data
 *      can have reached the caller;
 *   2. a successful read states the chain it came from (`indexedChainId`).
 */

const POOL = "0xbb1918019af8c6a26ff34ce8fb8305976e1f626d";
const VOTER = "0xca543e570e4a1f6da7cf9c4c7211692bc105a00a";

const MAINNET_URLS = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
} as const;

const TESTNET_URLS = {
  pools: "https://gw.example/97/pools",
  validators: "https://gw.example/97/validators",
  interactions: "https://gw.example/97/interactions",
} as const;

/** Row ids that only exist on the mainnet endpoint — a leak marker. */
const MAINNET_ROWS = {
  daoPools: [{ id: "0xmainnetdao000000000000000000000000000001", name: "Mainnet Only DAO" }],
  voterInPools: [{ id: "0xmainnetvoter00000000000000000000000000001" }],
  voterInPoolPairs: [{ id: "0xmainnetpair000000000000000000000000000001" }],
  validatorInPools: [{ id: "0xmainnetval000000000000000000000000000001", balance: "1" }],
  transactions: [{ id: "0xmainnettx0000000000000000000000000000001", type: ["4"] }],
  proposalInteractions: [
    {
      id: "0xmainnetpi0000000000000000000000000000001",
      hash: "0xmainnethash",
      timestamp: "1",
      interactionType: "1",
      totalVote: "1",
      voter: { id: `${VOTER}${POOL.slice(2)}`, voter: { id: VOTER } },
    },
  ],
};

function config(
  urls: Record<number, SubgraphEndpoints>,
  defaultChainId = 56,
): DexeConfig {
  return {
    defaultChainId,
    subgraphUrls: new Map(Object.entries(urls).map(([k, v]) => [Number(k), v])),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

type Register = (server: McpServer, ctx: ToolContext) => void;

async function callTool(
  register: Register,
  cfg: DexeConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  register(server, { config: cfg } as unknown as ToolContext);
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

/** Every subgraph read in the file, with the kind it must resolve against. */
const SUBGRAPH_TOOLS: Array<{
  name: string;
  kind: SubgraphKind;
  register: Register;
  args: Record<string, unknown>;
}> = [
  {
    name: "dexe_graph_query",
    kind: "pools",
    register: registerSubgraphTools,
    args: { subgraph: "pools", query: "{ daoPools(first: 1) { id } }" },
  },
  { name: "dexe_read_dao_list", kind: "pools", register: registerSubgraphTools, args: {} },
  {
    name: "dexe_read_dao_members",
    kind: "pools",
    register: registerSubgraphTools,
    args: { govPool: POOL },
  },
  {
    name: "dexe_read_delegation_map",
    kind: "pools",
    register: registerSubgraphTools,
    args: { addresses: [VOTER] },
  },
  {
    name: "dexe_read_dao_experts",
    kind: "pools",
    register: registerSubgraphTools,
    args: { govPool: POOL },
  },
  {
    name: "dexe_read_validator_list",
    kind: "validators",
    register: registerSubgraphTools,
    args: { govPool: POOL },
  },
  {
    name: "dexe_read_user_activity",
    kind: "interactions",
    register: registerSubgraphTools,
    args: { user: VOTER },
  },
  {
    name: "dexe_proposal_voters",
    kind: "pools",
    register: registerProposalTools,
    args: { govPool: POOL, proposalId: 1 },
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: MAINNET_ROWS }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("subgraph tools refuse a chain they do not index", () => {
  for (const t of SUBGRAPH_TOOLS) {
    it(`${t.name}: chainId 97 with only mainnet configured errors and returns no rows`, async () => {
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS } }),
        t.name,
        { ...t.args, chainId: 97 },
      );
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("chain 97");
      expect(text(res)).toContain(`DEXE_SUBGRAPH_${t.kind.toUpperCase()}_URL_97`);
      // The whole point: no query was issued, so no mainnet row can have been
      // served under a testnet request.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.structuredContent).toBeUndefined();
      expect(text(res)).not.toContain("Mainnet Only DAO");
      expect(text(res)).not.toContain("0xmainnet");
    });

    it(`${t.name}: the error offers mainnet and the on-chain alternatives`, async () => {
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS } }),
        t.name,
        { ...t.args, chainId: 97 },
      );
      expect(text(res)).toContain("chainId: 56");
      expect(text(res)).toContain("dexe_read_gov_state");
    });

    it(`${t.name}: chainId 56 reports indexedChainId 56 and queries the mainnet endpoint`, async () => {
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS }, 97: { ...TESTNET_URLS } }),
        t.name,
        { ...t.args, chainId: 56 },
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.indexedChainId).toBe(56);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(MAINNET_URLS[t.kind]);
    });

    it(`${t.name}: chainId 97 hits the chain-97 endpoint once one is configured`, async () => {
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS }, 97: { ...TESTNET_URLS } }),
        t.name,
        { ...t.args, chainId: 97 },
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.indexedChainId).toBe(97);
      expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_URLS[t.kind]);
    });

    it(`${t.name}: omitting chainId follows the default chain, never a substitute`, async () => {
      // A testnet-default install with only mainnet endpoints — the exact shape
      // of the silent-wrong-data bug. Omitting chainId must not fall back to
      // whatever endpoint happens to exist.
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS } }, 97),
        t.name,
        t.args,
      );
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("chain 97");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${t.name}: omitting chainId on a default chain that IS indexed answers for it`, async () => {
      const res = await callTool(
        t.register,
        config({ 56: { ...MAINNET_URLS }, 97: { ...TESTNET_URLS } }, 97),
        t.name,
        t.args,
      );
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.indexedChainId).toBe(97);
      expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_URLS[t.kind]);
    });
  }
});

describe("per-kind resolution", () => {
  it("dexe_graph_query routes each subgraph independently", async () => {
    // pools indexed on 97, validators not — asking for validators on 97 must
    // fail even though the same chain has a pools endpoint.
    const cfg = config({ 56: { ...MAINNET_URLS }, 97: { pools: TESTNET_URLS.pools } });
    const ok = await callTool(registerSubgraphTools, cfg, "dexe_graph_query", {
      subgraph: "pools",
      query: "{ daoPools(first: 1) { id } }",
      chainId: 97,
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent?.indexedChainId).toBe(97);

    const bad = await callTool(registerSubgraphTools, cfg, "dexe_graph_query", {
      subgraph: "validators",
      query: "{ validatorInPools(first: 1) { id } }",
      chainId: 97,
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("DEXE_SUBGRAPH_VALIDATORS_URL_97");
  });

  it("dexe_read_validator_list uses the validators endpoint, not pools", async () => {
    const res = await callTool(
      registerSubgraphTools,
      config({ 56: { ...MAINNET_URLS } }),
      "dexe_read_validator_list",
      { govPool: POOL, chainId: 56 },
    );
    expect(res.isError).toBeFalsy();
    expect(fetchMock.mock.calls[0]![0]).toBe(MAINNET_URLS.validators);
  });
});

describe("dexe_read_delegation_map no longer warns instead of switching", () => {
  it("resolves the requested chain rather than serving the default with a warning", async () => {
    const res = await callTool(
      registerSubgraphTools,
      config({ 56: { ...MAINNET_URLS }, 97: { ...TESTNET_URLS } }, 56),
      "dexe_read_delegation_map",
      { addresses: [VOTER], chainId: 97 },
    );
    expect(res.isError).toBeFalsy();
    // Pre-0.30.2 this call returned mainnet pairs plus a `warnings` array
    // explaining that the URL could not be switched. It can be now.
    expect(res.structuredContent?.warnings).toBeUndefined();
    expect(res.structuredContent?.indexedChainId).toBe(97);
    expect(fetchMock.mock.calls[0]![0]).toBe(TESTNET_URLS.pools);
  });

  it("still validates addresses before touching the network", async () => {
    const res = await callTool(
      registerSubgraphTools,
      config({ 56: { ...MAINNET_URLS } }),
      "dexe_read_delegation_map",
      { addresses: ["not-an-address"], chainId: 56 },
    );
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tool descriptions state the chain contract", () => {
  it("advertises the chains that actually have an endpoint on this install", async () => {
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerSubgraphTools(server, {
      config: config({ 56: { ...MAINNET_URLS }, 97: { pools: TESTNET_URLS.pools } }),
    } as unknown as ToolContext);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const daoList = byName.get("dexe_read_dao_list")!;
    expect(daoList.description).toContain("chains with a pools endpoint here: 56, 97");
    expect(daoList.description).toContain("indexedChainId");
    expect(daoList.inputSchema.properties).toHaveProperty("chainId");

    // Only chain 56 has validators — the note must not claim 97.
    expect(byName.get("dexe_read_validator_list")!.description).toContain(
      "chains with a validators endpoint here: 56",
    );

    // The stale claim this release removes.
    for (const t of tools) {
      expect(t.description ?? "", `${t.name} still claims a single env-bound chain`).not.toContain(
        "env-bound",
      );
    }
    await client.close();
    await server.close();
  });
});
