import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import {
  editDistance,
  graphQueryGuard,
  namedType,
  suggestEntities,
  summarizeRootFields,
  topLevelDefinitions,
  typeRefLabel,
  withSchemaRecoveryHint,
  type GraphFieldInfo,
} from "../../src/tools/subgraph.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * 0.31.0 — the graph surface has to be recoverable without a human.
 *
 * Two failures motivated this file. (1) The read-only guard rejected any
 * document starting with `fragment`, which is ordinary GraphQL — the caller saw
 * "Query must start with 'query' or '{'" for a query that was fine. (2) An
 * agent that hit "Type 'Proposal' has no field 'creationTime'" had no supported
 * way to find the right field: introspection worked but was documented nowhere,
 * so the usual next move was to invent a name.
 */

const URLS = {
  pools: "https://gw.example/56/pools",
  validators: "https://gw.example/56/validators",
  interactions: "https://gw.example/56/interactions",
} as const;

function config(urls: Record<number, SubgraphEndpoints> = { 56: { ...URLS } }, defaultChainId = 56): DexeConfig {
  return {
    defaultChainId,
    subgraphUrls: new Map(Object.entries(urls).map(([k, v]) => [Number(k), v])),
  } as unknown as DexeConfig;
}

// ---------- read-only guard ----------

describe("topLevelDefinitions", () => {
  it("reads the operation keyword of each top-level definition", () => {
    expect(topLevelDefinitions("{ daoPools { id } }")).toEqual(["query"]);
    expect(topLevelDefinitions("query A { a } query B { b }")).toEqual(["query", "query"]);
    expect(topLevelDefinitions("fragment F on Proposal { id } query { ...F }")).toEqual(["fragment", "query"]);
  });

  it("does not mistake nested selections or variable definitions for definitions", () => {
    // `mutation` here is a FIELD name and `subscription` a variable name —
    // neither is a write, and a first-token or bare-keyword test gets both wrong.
    expect(topLevelDefinitions("query Q($subscription: String!) { pool { mutation } }")).toEqual(["query"]);
    expect(topLevelDefinitions("{ a(where: { mutation: 1 }) { b } }")).toEqual(["query"]);
  });

  it("ignores comments and string literals", () => {
    expect(topLevelDefinitions("# mutation { drain }\nquery { a }")).toEqual(["query"]);
    expect(topLevelDefinitions('{ pools(where: { name: "mutation" }) { id } }')).toEqual(["query"]);
  });

  it("survives a brace default value inside a variable definition", () => {
    expect(topLevelDefinitions("query Q($f: F = {a: 1}) { pools { id } }")).toEqual(["query"]);
  });
});

describe("graphQueryGuard", () => {
  it("accepts query documents and bare selection sets", () => {
    expect(graphQueryGuard("{ daoPools(first: 5) { id } }")).toBeNull();
    expect(graphQueryGuard("query X($a: BigInt!) { proposals(first: 1) { id } }")).toBeNull();
    expect(graphQueryGuard("# comment\nquery { transactions(first: 1) { id } }")).toBeNull();
  });

  it("accepts fragment-first documents (the 0.31.0 fix)", () => {
    expect(
      graphQueryGuard("fragment P on Proposal { proposalId votersVoted }\nquery { proposals(first: 2) { ...P } }"),
    ).toBeNull();
    // Fragment between two operations, and a fragment after the operation.
    expect(graphQueryGuard("query { proposals(first: 1) { ...P } } fragment P on Proposal { id }")).toBeNull();
  });

  it("rejects mutations and subscriptions wherever they sit in the document", () => {
    expect(graphQueryGuard("mutation { x }")).toMatch(/read/i);
    expect(graphQueryGuard("subscription { x }")).toMatch(/read/i);
    // The pre-0.31.0 first-token regex passed this straight through to the gateway.
    expect(graphQueryGuard("query { a } mutation Evil { drain }")).toMatch(/read/i);
    expect(graphQueryGuard("fragment F on P { id } mutation { drain }")).toMatch(/read/i);
  });

  it("rejects empty and non-GraphQL input", () => {
    expect(graphQueryGuard("   ")).toMatch(/empty/i);
    expect(graphQueryGuard("# only a comment")).toMatch(/empty/i);
    expect(graphQueryGuard("SELECT * FROM daos")).toMatch(/must start/i);
  });

  it("rejects a fragment-only document, saying what is missing", () => {
    const err = graphQueryGuard("fragment P on Proposal { id }");
    expect(err).toMatch(/only fragment/i);
    expect(err).toMatch(/query/);
  });
});

// ---------- introspection helpers ----------

const listOf = (name: string) => ({
  kind: "NON_NULL",
  name: null,
  ofType: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name } } },
});
const objectOf = (name: string) => ({ kind: "OBJECT", name, ofType: null });

describe("typeRefLabel / namedType", () => {
  it("spells wrappers the way SDL does", () => {
    expect(typeRefLabel(listOf("Proposal"))).toBe("[Proposal!]!");
    expect(typeRefLabel(objectOf("DaoPool"))).toBe("DaoPool");
    expect(typeRefLabel({ kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "BigInt" } })).toBe("BigInt!");
  });

  it("unwraps to the named type", () => {
    expect(namedType(listOf("Proposal"))).toBe("Proposal");
    expect(namedType(null)).toBeNull();
  });
});

describe("summarizeRootFields", () => {
  const fields: GraphFieldInfo[] = [
    { name: "daoPool", type: objectOf("DaoPool") },
    { name: "daoPools", type: listOf("DaoPool") },
    { name: "proposalSettings", type: objectOf("ProposalSettings") },
    { name: "proposalSettings_collection", type: listOf("ProposalSettings") },
    { name: "dpcontracts", type: listOf("DPContract") },
    { name: "_meta", type: objectOf("_Meta_") },
  ];

  it("pairs the singular and list root fields per entity", () => {
    const out = summarizeRootFields(fields);
    expect(out).toContainEqual({ entity: "DaoPool", single: "daoPool", list: "daoPools" });
    // The name no agent guesses, and the reason this tool exists.
    expect(out).toContainEqual({
      entity: "ProposalSettings",
      single: "proposalSettings",
      list: "proposalSettings_collection",
    });
    expect(out).toContainEqual({ entity: "DPContract", single: null, list: "dpcontracts" });
  });

  it("drops introspection plumbing (_meta / _logs)", () => {
    expect(summarizeRootFields(fields).map((r) => r.entity)).not.toContain("_Meta_");
  });
});

describe("suggestEntities", () => {
  const known = ["DaoPool", "Proposal", "ProposalSettings", "VoterInPool", "VoterInPoolPair"];

  it("puts the case-corrected name first", () => {
    expect(suggestEntities("daopool", known)[0]).toBe("DaoPool");
    expect(suggestEntities("proposal", known)[0]).toBe("Proposal");
  });

  it("recovers the entity from the root field name an agent typed instead", () => {
    expect(suggestEntities("daoPools", known)[0]).toBe("DaoPool");
    expect(suggestEntities("voterInPools", known)).toContain("VoterInPool");
  });

  it("tolerates a typo", () => {
    expect(suggestEntities("Propsal", known)).toContain("Proposal");
  });

  it("returns nothing for input with no relation to the schema", () => {
    expect(suggestEntities("zzzzzzzzqqqq", known)).toEqual([]);
  });
});

describe("editDistance", () => {
  it("counts single edits", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "abd")).toBe(1);
    expect(editDistance("abc", "ab")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("withSchemaRecoveryHint", () => {
  it("names the introspection call on a schema rejection", () => {
    const out = withSchemaRecoveryHint(
      "Subgraph errors: Type `Proposal` has no field `creationTime`",
      "pools",
    );
    expect(out).toContain("dexe_graph_schema");
    expect(out).toContain('subgraph: "pools"');
    expect(out).toMatch(/_filter/);
  });

  it("leaves unrelated failures alone", () => {
    const msg = "Subgraph HTTP 429 — rate-limited.";
    expect(withSchemaRecoveryHint(msg, "pools")).toBe(msg);
  });
});

// ---------- dexe_graph_schema over the protocol ----------

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function callTool(cfg: DexeConfig, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerSubgraphTools(server, { config: cfg } as unknown as ToolContext);
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

const ROOT_FIELDS = [
  { name: "daoPool", type: objectOf("DaoPool") },
  { name: "daoPools", type: listOf("DaoPool") },
  { name: "proposal", type: objectOf("Proposal") },
  { name: "proposals", type: listOf("Proposal") },
  { name: "proposalSettings", type: objectOf("ProposalSettings") },
  { name: "proposalSettings_collection", type: listOf("ProposalSettings") },
  { name: "_meta", type: objectOf("_Meta_") },
];

const PROPOSAL_TYPE = {
  name: "Proposal",
  kind: "OBJECT",
  fields: [
    { name: "proposalId", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "BigInt" } }, args: [] },
    { name: "votersVoted", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "BigInt" } }, args: [] },
    { name: "voters", type: listOf("Voter"), args: [{ name: "first" }, { name: "where" }] },
  ],
  inputFields: null,
  enumValues: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;
let respond: () => unknown;

beforeEach(() => {
  respond = () => ({ __schema: { queryType: { fields: ROOT_FIELDS } } });
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ data: respond() }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("dexe_graph_schema", () => {
  it("without an entity returns the root query field map", async () => {
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools" });
    expect(res.isError).toBeFalsy();
    const roots = res.structuredContent!.rootFields as Array<Record<string, unknown>>;
    expect(roots).toContainEqual({ entity: "DaoPool", single: "daoPool", list: "daoPools" });
    // The whole point: the caller learns the field name, not just the entity.
    expect(text(res)).toContain("proposalSettings_collection");
    expect(text(res)).not.toContain("_Meta_");
    expect(res.structuredContent!.indexedChainId).toBe(56);
  });

  it("with an entity returns its fields, their types and how to query it", async () => {
    respond = () => ({ __schema: { queryType: { fields: ROOT_FIELDS } }, __type: PROPOSAL_TYPE });
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools", entity: "Proposal" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.entity).toBe("Proposal");
    expect(res.structuredContent!.fields).toContainEqual({ name: "votersVoted", type: "BigInt!" });
    expect(res.structuredContent!.fields).toContainEqual({
      name: "voters",
      type: "[Voter!]!",
      args: ["first", "where"],
    });
    expect(text(res)).toContain("Query it as proposals / proposal");
  });

  it("answers an unknown entity with ranked candidates, not a dead end", async () => {
    respond = () => ({ __schema: { queryType: { fields: ROOT_FIELDS } }, __type: null });
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools", entity: "daoPools" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Did you mean: DaoPool");
    expect(text(res)).toContain("dexe_graph_schema");
  });

  it("expands a _filter input type from inputFields", async () => {
    respond = () => ({
      __schema: { queryType: { fields: ROOT_FIELDS } },
      __type: {
        name: "Proposal_filter",
        kind: "INPUT_OBJECT",
        fields: null,
        inputFields: [{ name: "votersVoted_gt", type: { kind: "SCALAR", name: "BigInt" } }],
        enumValues: null,
      },
    });
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools", entity: "Proposal_filter" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.fields).toContainEqual({ name: "votersVoted_gt", type: "BigInt" });
    expect(text(res)).toContain("Not a root query field");
  });

  it("expands an _orderBy enum from enumValues", async () => {
    respond = () => ({
      __schema: { queryType: { fields: ROOT_FIELDS } },
      __type: {
        name: "Proposal_orderBy",
        kind: "ENUM",
        fields: null,
        inputFields: null,
        enumValues: [{ name: "votersVoted" }, { name: "quorumReachedTimestamp" }],
      },
    });
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools", entity: "Proposal_orderBy" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.enumValues).toEqual(["votersVoted", "quorumReachedTimestamp"]);
  });

  it("is chain-explicit: a chain with no endpoint errors without querying", async () => {
    const res = await callTool(config(), "dexe_graph_schema", { subgraph: "pools", chainId: 97 });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("chain 97");
    expect(text(res)).toContain("DEXE_SUBGRAPH_POOLS_URL_97");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("introspects the endpoint of the requested kind, not always pools", async () => {
    await callTool(config(), "dexe_graph_schema", { subgraph: "validators", chainId: 56 });
    expect(fetchMock.mock.calls[0]![0]).toBe(URLS.validators);
  });
});

/**
 * Same opt-in flag as the docs drift check (see docs/GRAPH.md): the mocked
 * tests above prove the shaping, only a real gateway proves that the
 * introspection DOCUMENT is accepted — `@include(if:)` on `__type`, the
 * fragment on `__Type`, and the nested `ofType` depth all have to be right.
 */
describe.skipIf(process.env.DEXE_GRAPH_DRIFT_CHECK !== "1")("dexe_graph_schema (live gateway)", () => {
  let liveConfig: DexeConfig;

  beforeEach(async () => {
    globalThis.fetch = realFetch; // undo the module-level mock
    const { loadConfig } = await import("../../src/config.js");
    liveConfig = await loadConfig();
  });

  it("returns the real root field map, including the unguessable names", async () => {
    const res = await callTool(liveConfig, "dexe_graph_schema", { subgraph: "pools", chainId: 56 });
    expect(res.isError).toBeFalsy();
    const roots = res.structuredContent!.rootFields as Array<{ entity: string; list: string | null }>;
    expect(roots.find((r) => r.entity === "DaoPool")?.list).toBe("daoPools");
    expect(roots.find((r) => r.entity === "ProposalSettings")?.list).toBe("proposalSettings_collection");
  }, 30_000);

  it("expands a real entity and its filter vocabulary", async () => {
    const entity = await callTool(liveConfig, "dexe_graph_schema", {
      subgraph: "pools",
      entity: "Proposal",
      chainId: 56,
    });
    expect(entity.isError).toBeFalsy();
    const names = (entity.structuredContent!.fields as Array<{ name: string }>).map((f) => f.name);
    expect(names).toContain("votersVoted");
    // The field the shipped docs used to imply existed — its absence is what an
    // agent has to be able to discover for itself.
    expect(names).not.toContain("creationTime");

    const filter = await callTool(liveConfig, "dexe_graph_schema", {
      subgraph: "pools",
      entity: "Proposal_filter",
      chainId: 56,
    });
    expect(filter.isError).toBeFalsy();
    expect((filter.structuredContent!.fields as Array<{ name: string }>).map((f) => f.name)).toContain("id_gt");
  }, 30_000);

  it("a fragment-first query reaches the real gateway and returns rows", async () => {
    const res = await callTool(liveConfig, "dexe_graph_query", {
      subgraph: "pools",
      chainId: 56,
      query:
        "fragment P on Proposal { proposalId votersVoted }\n" +
        "query { proposals(first: 2, orderBy: votersVoted, orderDirection: desc) { ...P } }",
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent!.data as { proposals: unknown[] };
    expect(data.proposals.length).toBeGreaterThan(0);
  }, 30_000);

  it("a bad field is rejected by the gateway and answered with the recovery pointer", async () => {
    const res = await callTool(liveConfig, "dexe_graph_query", {
      subgraph: "pools",
      chainId: 56,
      query: "{ proposals(first: 1) { creationTime } }",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("dexe_graph_schema");
  }, 30_000);
});

describe("dexe_graph_query after the guard fix", () => {
  it("sends a fragment-first document to the gateway instead of rejecting it", async () => {
    respond = () => ({ proposals: [{ proposalId: "1" }] });
    const res = await callTool(config(), "dexe_graph_query", {
      subgraph: "pools",
      query: "fragment P on Proposal { proposalId }\nquery { proposals(first: 1) { ...P } }",
    });
    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.structuredContent!.indexedChainId).toBe(56);
  });

  it("still refuses a mutation buried after a valid query, without a network call", async () => {
    const res = await callTool(config(), "dexe_graph_query", {
      subgraph: "pools",
      query: "query { proposals(first: 1) { id } } mutation Evil { drain }",
    });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points a schema rejection at dexe_graph_schema", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({ errors: [{ message: "Type `Proposal` has no field `creationTime`" }] }),
    }));
    const res = await callTool(config(), "dexe_graph_query", {
      subgraph: "pools",
      query: "{ proposals(first: 1) { creationTime } }",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("dexe_graph_schema");
    expect(text(res)).toContain("Do NOT guess");
  });
});
