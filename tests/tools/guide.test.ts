import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { matchIntent, bestMatch, flowDetail, flowIndex } from "../../src/knowledge/index.js";

/** The canonical weak-model user story — MUST resolve to the end-to-end flow. */
const CANONICAL_INTENT =
  "I want to create a token, distribute 20% of it to this list of addresses, then create an OTC sale and staking";

describe("intent matching", () => {
  it("canonical multi-leg intent → launch_token_economy", () => {
    expect(bestMatch(CANONICAL_INTENT)).toBe("launch_token_economy");
  });

  it("single-leg intents match their flow", () => {
    expect(bestMatch("please create a dao for my community")).toBe("create_dao");
    expect(bestMatch("vote on proposal 3 and execute it")).toBe("vote_execute");
  });

  it("ambiguous text returns no confident match (menu instead of a wrong guess)", () => {
    expect(bestMatch("do something with my tokens")).toBeNull();
  });

  it("data-read intents match the read_dao_data topic", () => {
    expect(bestMatch("how do I query the subgraph for dao analytics")).toBe("read_dao_data");
    expect(bestMatch("show me the token holders and protocol stats")).toBe("read_dao_data");
  });

  it("matchIntent scores are sorted descending", () => {
    const m = matchIntent(CANONICAL_INTENT);
    for (let i = 1; i < m.length; i++) expect(m[i - 1]!.score).toBeGreaterThanOrEqual(m[i]!.score);
  });
});

describe("flow detail tiers", () => {
  it("unknown flow id → null", () => {
    expect(flowDetail("nope")).toBeNull();
  });

  it("detail carries the agent protocol and danger-first gotchas", () => {
    const d = flowDetail("create_dao", { chainId: 97 })!;
    expect(d.agentProtocol).toMatch(/confirmation BEFORE any broadcast/);
    const severities = d.gotchas.map((g) => g.severity);
    const firstWarn = severities.indexOf("warn");
    const lastDanger = severities.lastIndexOf("danger");
    if (firstWarn !== -1 && lastDanger !== -1) expect(lastDanger).toBeLessThan(firstWarn);
  });

  it("index tier lists every flow", () => {
    const ids = flowIndex().map((f) => f.flow);
    expect(ids).toContain("create_dao");
    expect(ids).toContain("launch_token_economy");
    expect(ids).toContain("staking_setup");
  });

  it("steps referencing non-default tools are annotated with the required toolset", () => {
    const d = flowDetail("staking_setup")!;
    const verify = d.steps.find((s) => s.id === "verify")!;
    expect(verify.tool).toBe("dexe_read_staking_info");
    expect(verify.requiresToolset).toContain("read");
  });

  it("chaining composites get flowContext pre-filled in their paramsTemplate (Phase B)", () => {
    const d = flowDetail("otc_sale")!;
    const open = d.steps.find((s) => s.id === "open")!;
    expect(open.paramsTemplate.flowContext).toBe('{"flow":"otc_sale","step":"open"}');
    const verify = d.steps.find((s) => s.id === "verify")!;
    expect(verify.paramsTemplate.flowContext).toBeUndefined(); // read tool — no chaining
  });
});

describe("dexe_guide (real server)", () => {
  let client: Client;
  let server: McpServer;
  let stateDir: string;

  async function callGuide(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "dexe_guide", arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as Record<string, any>;
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "dexe-guide-test-"));
    const statePath = join(stateDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        knownDaos: [
          {
            name: "Evergreen Commons",
            govPool: "0x1111111111111111111111111111111111111111",
            chainId: 97,
            deployedAt: "2026-07-01T00:00:00Z",
          },
        ],
        lastChainId: 97,
        recentProposals: [],
        walletLabels: {},
        activeFlow: {
          flow: "launch_token_economy",
          step: "leg_distribute",
          chainId: 97,
          startedAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T01:00:00.000Z",
        },
      }),
    );
    process.env.DEXE_STATE_PATH = statePath;
    delete process.env.DEXE_TOOLSETS;
    const config = await loadConfig();
    server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerAll(server, config);
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    delete process.env.DEXE_STATE_PATH;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is registered under the default toolset profile (CORE)", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("dexe_guide");
  });

  it("no args → index tier with session context + known DAO prefill", async () => {
    const out = await callGuide({});
    expect(out.mode).toBe("flow-index");
    expect(out.flows.length).toBeGreaterThanOrEqual(7);
    expect(out.context.chainId).toBe(97);
    expect(out.context.chainIdSource).toBe("last-used");
    expect(out.context.knownDao.govPool).toBe("0x1111111111111111111111111111111111111111");
  });

  it("index tier lists the reference topics next to the flows", async () => {
    const out = await callGuide({});
    const ids = out.topics.map((t: any) => t.topic);
    expect(ids).toContain("read_dao_data");
  });

  it("flow:read_dao_data → topic-detail with sections, gated tools, and the mainnet gotcha", async () => {
    const out = await callGuide({ flow: "read_dao_data", chainId: 97 });
    expect(out.mode).toBe("topic-detail");
    expect(out.topic).toBe("read_dao_data");
    expect(out.sections.length).toBeGreaterThanOrEqual(5);
    expect(out.gotchas.some((g: any) => g.id === "subgraph-backend-mainnet-only")).toBe(true);
    const graphQuery = out.tools.find((t: any) => t.tool === "dexe_graph_query");
    expect(graphQuery.requiresToolset).toContain("read");
    // Reference material must NOT carry the flow interview/broadcast framing.
    expect(out.agentProtocol).toBeUndefined();
    expect(out.interview).toBeUndefined();
  });

  it("mid-journey activeFlow surfaces with progress + next pointer (Phase B)", async () => {
    const out = await callGuide({});
    expect(out.context.activeFlow.flow).toBe("launch_token_economy");
    expect(out.context.activeFlow.progress).toMatch(/2 of 4/);
    expect(out.context.activeFlow.next.length).toBeGreaterThan(0);
  });

  it("per-flow MCP prompts are registered", async () => {
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name);
    expect(names).toContain("dexe-flow-launch_token_economy");
    expect(names).toContain("dexe-flow-staking_setup");
    const got = await client.getPrompt({ name: "dexe-flow-staking_setup", arguments: {} });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/STAKING DOES NOT EXIST ON TESTNET/i);
  });

  it("canonical intent → launch_token_economy detail with the testnet staking note", async () => {
    const out = await callGuide({ intent: CANONICAL_INTENT, chainId: 97 });
    expect(out.mode).toBe("flow-detail");
    expect(out.flow).toBe("launch_token_economy");
    expect(out.chainNote.note).toMatch(/staking/i);
    expect(out.agentProtocol).toMatch(/interview/);
  });

  it("flow:staking_setup on chain 97 → hard testnet warning", async () => {
    const out = await callGuide({ flow: "staking_setup", chainId: 97 });
    expect(out.mode).toBe("flow-detail");
    expect(out.chainNote.note).toMatch(/DOES NOT EXIST/i);
    expect(out.gotchas.some((g: any) => g.id === "staking-not-on-testnet")).toBe(true);
  });

  it("unknown flow id → index tier with a note", async () => {
    const out = await callGuide({ flow: "not_a_flow" });
    expect(out.mode).toBe("flow-index");
    expect(out.note).toMatch(/Unknown flow/);
  });
});
