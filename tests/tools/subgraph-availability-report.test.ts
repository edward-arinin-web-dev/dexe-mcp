import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * 0.30.2 / L2 — subgraph availability is per chain, so the diagnostics that
 * report it must be too.
 *
 * `dexe_get_config` and `dexe_context` used to answer from the flat
 * `config.subgraphPoolsUrl`, which holds only the slot named by
 * DEXE_SUBGRAPH_CHAIN_ID. Point that var at any chain without unsuffixed URLs
 * and the field is undefined — so both tools announced "no subgraph reads"
 * while chain 56 was answering perfectly, and the shared-Graph-key advisory
 * disappeared with it. An agent that believes there is no indexer stops asking.
 */

const dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

/**
 * Snapshot and clear the whole DEXE_* surface. These tests assert on a fully
 * resolved config (default chain, covered chains, signer mode), so a stray var
 * in the developer's shell must not decide the outcome.
 */
function isolateEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (/^(DEXE_|AGENT_PK_\d|AGENT_FUNDER_PK)/.test(k)) {
      savedEnv.set(k, process.env[k]);
      delete process.env[k];
    }
  }
}

beforeEach(() => {
  isolateEnv();
  const dir = mkdtempSync(join(tmpdir(), "dexe-sgavail-"));
  dirs.push(dir);
  process.env.DEXE_STATE_PATH = join(dir, "state.json");
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (/^(DEXE_|AGENT_PK_\d|AGENT_FUNDER_PK)/.test(k)) delete process.env[k];
  }
  for (const [k, v] of savedEnv) {
    if (v !== undefined) process.env[k] = v;
  }
  savedEnv.clear();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Boot a server on the current env and read both diagnostics off it. */
async function callTools() {
  const config = await loadConfig();
  const server = new McpServer({ name: "sgavail-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const read = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
    };
    return JSON.parse(res.content[0]!.text);
  };
  const getConfig = await read("dexe_get_config", {});
  const context = await read("dexe_context", { includeDepositedPower: false });

  await client.close();
  await server.close();
  return { getConfig, context, flatPoolsUrl: config.subgraphPoolsUrl };
}

describe("dexe_get_config subgraph coverage", () => {
  it("reports chain 56 as covered even when the flat field is undefined", async () => {
    // The exact reproduction: the unsuffixed vars are declared to describe
    // chain 97, and there are none — so the flat alias is empty while the baked
    // mainnet endpoints are still there and still work.
    process.env.DEXE_SUBGRAPH_CHAIN_ID = "97";

    const { getConfig, flatPoolsUrl } = await callTools();
    expect(flatPoolsUrl).toBeUndefined();

    expect(getConfig.subgraph.chainsCovered).toEqual([56]);
    expect(getConfig.subgraph.byKind.pools).toEqual([56]);
    expect(getConfig.subgraph.byKind.validators).toEqual([56]);
    expect(getConfig.subgraph.byKind.interactions).toEqual([56]);
    // The default chain (public RPC fallback → 56) is fully indexed.
    expect(getConfig.subgraph.missingForDefaultChain).toEqual([]);
    // And it says which chain the unsuffixed vars were filed under.
    expect(getConfig.subgraph.unsuffixedVarsChainId).toBe(97);
  });

  it("lists the kinds missing for the DEFAULT chain rather than a bare boolean", async () => {
    // Only a testnet RPC → default chain 97, which no subgraph indexes.
    process.env.DEXE_RPC_URL_TESTNET = "https://rpc.invalid";

    const { getConfig } = await callTools();
    expect(getConfig.defaultChainId).toBe(97);
    expect(getConfig.subgraph.chainsCovered).toEqual([56]);
    expect(getConfig.subgraph.missingForDefaultChain).toEqual([
      "pools",
      "validators",
      "interactions",
    ]);
  });

  it("counts a per-chain endpoint towards that chain's coverage, per kind", async () => {
    process.env.DEXE_SUBGRAPH_POOLS_URL_97 = "https://indexer.example/testnet/pools";

    const { getConfig } = await callTools();
    expect(getConfig.subgraph.chainsCovered).toEqual([56, 97]);
    expect(getConfig.subgraph.byKind.pools).toEqual([56, 97]);
    // 97 has a pools indexer and nothing else — absence must stay visible.
    expect(getConfig.subgraph.byKind.validators).toEqual([56]);
  });
});

describe("dexe_context env readiness", () => {
  it("reports subgraph reads available, and for which chains, with no flat field", async () => {
    process.env.DEXE_SUBGRAPH_CHAIN_ID = "97";

    const { context, flatPoolsUrl } = await callTools();
    expect(flatPoolsUrl).toBeUndefined();
    expect(context.env.subgraphReads).toBe(true);
    expect(context.env.subgraphChains).toEqual([56]);
    expect(context.env.subgraphDefaultChainCovered).toBe(true);
  });

  it("keeps the shared-Graph-key advisory when the unsuffixed vars are retargeted", async () => {
    // The baked endpoints (and their shared, billable Graph key) are still what
    // chain 56 reads on — retargeting DEXE_SUBGRAPH_CHAIN_ID does not change
    // that, so the advisory must not vanish with the flat field.
    process.env.DEXE_SUBGRAPH_CHAIN_ID = "97";

    const { context } = await callTools();
    expect(context.env.usingSharedDefaults).toContain("subgraph");
  });

  it("drops the shared-defaults advisory once chain 56 runs on the operator's own endpoint", async () => {
    process.env.DEXE_SUBGRAPH_POOLS_URL_56 = "https://indexer.example/mainnet/pools";

    const { context } = await callTools();
    expect(context.env.usingSharedDefaults).not.toContain("subgraph");
  });

  it("says the default chain is uncovered while still reporting reads as possible", async () => {
    process.env.DEXE_RPC_URL_TESTNET = "https://rpc.invalid";

    const { context } = await callTools();
    expect(context.chain.defaultChainId).toBe(97);
    expect(context.env.subgraphReads).toBe(true);
    expect(context.env.subgraphChains).toEqual([56]);
    expect(context.env.subgraphDefaultChainCovered).toBe(false);
  });
});
