import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { defaultToolNames, StateStore } from "@dexe-network/dexe-mcp/core";
import { INSTRUCTIONS_MAX_CHARS } from "@dexe-network/dexe-mcp/testing";
import { registerAll } from "../../src/tools/index.js";
import { isWriteStandalone, loadConfig } from "../../src/config.js";
import { instructionsFor, serverInstructions, writeInstructions } from "../../src/instructionsWrite.js";
import { READ_SERVER_LABEL, READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { DEPRECATED_ALIASES } from "../../src/tools/aliases.js";
import { SINGLE_SERVER_TOOLSETS, WRITE_EDITION_TOOLSETS } from "../../src/tools/gate.js";
import { FLOWS } from "../../src/knowledge/write/flows.js";
import { nextAfter } from "../../src/knowledge/write/nextSteps.js";
import { envFileRows } from "../../src/diag/writeDoctor.js";
import { markReadTools } from "../../src/tools/readServerMarks.js";
import { listTools } from "../helpers/listTools.js";

/**
 * 1.0.0 (D1/D2): this server registers WRITE_TOOLS by default — including
 * `dexe_write_guide` and `dexe_write_doctor`, which replace the read server's
 * `dexe_guide` / `dexe_doctor` here — and, with `DEXE_WRITE_STANDALONE=1`, the
 * READ tools too (the pre-1.0 single server plus the two write tools).
 */

const ALIASES = Object.keys(DEPRECATED_ALIASES);

describe("tools/list per mode", () => {
  it("write-only default: the write edition's core profile — 25 tools", async () => {
    const { names } = await listTools(undefined, "write-only");
    expect(names).toEqual([...defaultToolNames(WRITE_EDITION_TOOLSETS)].sort());
    expect(names).toHaveLength(25);
    for (const t of ["dexe_write_context", "dexe_write_guide", "dexe_write_doctor", "dexe_proposal_create"]) {
      expect(names, t).toContain(t);
    }
  });

  it("write-only full: exactly WRITE_TOOLS — 118, no read tool, no alias", async () => {
    const { names } = await listTools("full", "write-only");
    expect(names).toEqual([...WRITE_TOOLS].sort());
    expect(names).toHaveLength(118);
    for (const t of [...READ_TOOLS, ...ALIASES]) expect(names, t).not.toContain(t);
  });

  it("standalone default: the single server's core plus the write trio — 48 tools (+2 aliases)", async () => {
    const { names } = await listTools(undefined, "standalone");
    const tools = names.filter((n) => !ALIASES.includes(n));
    expect(tools).toEqual([...defaultToolNames(SINGLE_SERVER_TOOLSETS)].sort());
    expect(tools).toHaveLength(48);
    for (const t of ["dexe_context", "dexe_guide", "dexe_doctor", "dexe_write_guide", "dexe_write_doctor"]) {
      expect(names, t).toContain(t);
    }
  });

  it("standalone full: every read and write tool — 172 (+2 aliases)", async () => {
    const { names } = await listTools("full", "standalone");
    expect(names.filter((n) => !ALIASES.includes(n))).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(names).toHaveLength(172 + ALIASES.length);
  });

  it("the write-only table keeps every profile but the read tools", () => {
    expect(Object.keys(WRITE_EDITION_TOOLSETS.sets).sort()).toEqual(Object.keys(SINGLE_SERVER_TOOLSETS.sets).sort());
    for (const [set, names] of Object.entries(WRITE_EDITION_TOOLSETS.sets)) {
      for (const n of names) expect(WRITE_TOOLS, `${set}: ${n}`).toContain(n);
    }
    expect([...WRITE_EDITION_TOOLSETS.sets.read!]).toEqual(["dexe_ipfs_cid_for_json"]);
  });
});

describe("DEXE_WRITE_STANDALONE", () => {
  it("is on for 1 / true only", () => {
    for (const v of ["1", "true", "TRUE", " 1 "]) expect(isWriteStandalone({ DEXE_WRITE_STANDALONE: v }), v).toBe(true);
    for (const v of [undefined, "", "0", "false", "yes"]) expect(isWriteStandalone({ DEXE_WRITE_STANDALONE: v }), String(v)).toBe(false);
  });
});

describe("the handshake per mode", () => {
  it("write-only: the write edition's text, inside the budget", () => {
    const text = instructionsFor({});
    expect(text).toBe(writeInstructions());
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(text).toContain("dexe_write_guide FIRST");
    expect(text).toContain("dexe_write_context");
    expect(text).toContain("dexe_write_doctor");
    expect(text).toContain("read server (dexe-mcp-read)");
    expect(text).toContain(`default 'core' — ${defaultToolNames(WRITE_EDITION_TOOLSETS).size} tools`);
  });

  it("standalone: the single server's text, inside the budget", () => {
    const text = instructionsFor({ writeStandalone: true });
    expect(text).toBe(serverInstructions());
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });
});

/** One write-only or standalone server over an in-memory pair, with a state file. */
async function boot(standalone: boolean, statePath: string) {
  process.env.DEXE_STATE_PATH = statePath;
  delete process.env.DEXE_TOOLSETS;
  delete process.env.DEXE_PINATA_JWT;
  const config = { ...(await loadConfig()), writeStandalone: standalone };
  const server = new McpServer({ name: "surface", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "surface-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
    return { text: res.content.map((x) => x.text ?? "").join("\n"), structured: res.structuredContent };
  };
  return { client, call, close: async () => (await client.close(), await server.close()) };
}

describe("the write-only server", () => {
  let dir: string;
  let s: Awaited<ReturnType<typeof boot>>;
  let tools: Tool[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dexe-surface-"));
    const statePath = join(dir, "state.json");
    new StateStore(statePath).recordDao({
      name: "Meridian Collective",
      govPool: "0xf113630C0000000000000000000000000000abcd",
      chainId: 97,
    } as Parameters<StateStore["recordDao"]>[0]);
    s = await boot(false, statePath);
    tools = (await s.client.listTools()).tools;
  });

  afterAll(async () => {
    await s.close();
    delete process.env.DEXE_STATE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("always loads its two entry points: dexe_write_guide and dexe_write_context", () => {
    const loaded = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true);
    expect(loaded.map((t) => t.name).sort()).toEqual(["dexe_write_context", "dexe_write_guide"]);
  });

  it("marks every read tool a published description names", () => {
    const govPool = tools.find((t) => t.name === "dexe_vote_build_deposit")!;
    const text = JSON.stringify(govPool.inputSchema);
    // GOV_POOL_DESC is the read package's shared parameter text.
    expect(text).toContain("dexe_dao_registry_lookup (read server)");
  });

  it("dexe_write_guide serves the eight write flows, reads located on the read server", async () => {
    const guide = tools.find((t) => t.name === "dexe_write_guide")!;
    const flowEnum = (guide.inputSchema.properties as Record<string, { enum?: string[] }>).flow!.enum!;
    expect([...flowEnum].sort()).toEqual(FLOWS.map((f) => f.id).sort());

    const index = JSON.parse((await s.call("dexe_write_guide")).text) as { flows: { flow: string }[]; next: string };
    expect(index.flows.map((f) => f.flow).sort()).toEqual(FLOWS.map((f) => f.id).sort());
    expect(index.next).toContain("dexe_guide (read server)");

    const staking = JSON.parse((await s.call("dexe_write_guide", { flow: "staking_setup" })).text) as {
      steps: { id: string; tool: string; providedBy?: string; requiresToolset?: string }[];
    };
    const verify = staking.steps.find((x) => x.id === "verify")!;
    expect(verify.tool).toBe("dexe_read_staking_info");
    expect(verify.providedBy).toBe(READ_SERVER_LABEL);
    expect(verify.requiresToolset).toBeUndefined();

    const launch = JSON.parse((await s.call("dexe_write_guide", { flow: "launch_token_economy" })).text) as {
      steps: { tool: string }[];
    };
    expect(launch.steps.filter((x) => x.tool.includes("guide")).map((x) => x.tool)).toEqual([
      "dexe_write_guide",
      "dexe_write_guide",
      "dexe_write_guide",
    ]);
  });

  it("next pointers carry the same location as the guide's steps", () => {
    // registerAll (beforeAll) put this mode's locator in force for the process.
    const all = FLOWS.flatMap((f) => f.steps.flatMap((st) => nextAfter(f.id, st.id)?.next ?? []));
    const reads = all.filter((p) => READ_TOOLS.includes(p.tool));
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) expect(p.providedBy, p.tool).toBe(READ_SERVER_LABEL);
  });

  it("dexe_write_doctor: write checks only, the surface row, and the pin probe input", async () => {
    const doctor = tools.find((t) => t.name === "dexe_write_doctor")!;
    expect(Object.keys((doctor.inputSchema.properties ?? {}) as object)).toEqual(["probePin"]);
    const { structured } = await s.call("dexe_write_doctor");
    const ids = ((structured?.checks ?? []) as { id: string; message: string }[]).map((c) => c.id);
    expect(ids).toContain("surface.mode");
    expect(ids).toContain("signer.mode");
    expect(ids).toContain("env.file");
    expect(ids).toContain("state.path");
    // RPC / subgraph / backend / IPFS gateway reachability is the read server's doctor.
    expect(ids.filter((id) => /^(rpc|subgraph|backend|ipfs)\./.test(id))).toEqual([]);
    const surface = (structured!.checks as { id: string; message: string }[]).find((c) => c.id === "surface.mode")!;
    expect(surface.message).toMatch(/^write-only/);
    expect(structured!.surface).toBe("write-only");
  });

  it("dexe_write_context reports the DAOs this install recorded", async () => {
    const json = JSON.parse(
      (await s.call("dexe_write_context", { includeDepositedPower: false, includeAgentBalances: false })).text,
    ) as { recorded: { knownDaos: { name: string }[]; knownDaosTotal: number } };
    expect(json.recorded.knownDaosTotal).toBe(1);
    expect(json.recorded.knownDaos[0]!.name).toBe("Meridian Collective");
  });
});

describe("the standalone server", () => {
  let dir: string;
  let s: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dexe-surface-sa-"));
    s = await boot(true, join(dir, "state.json"));
  });

  afterAll(async () => {
    await s.close();
    delete process.env.DEXE_STATE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("dexe_write_guide locates read steps locally, by toolset", async () => {
    const staking = JSON.parse((await s.call("dexe_write_guide", { flow: "staking_setup" })).text) as {
      steps: { id: string; providedBy?: string; requiresToolset?: string }[];
    };
    const verify = staking.steps.find((x) => x.id === "verify")!;
    expect(verify.providedBy).toBeUndefined();
    expect(verify.requiresToolset).toContain("read");
  });

  it("dexe_write_doctor says standalone", async () => {
    const { structured } = await s.call("dexe_write_doctor");
    const surface = (structured!.checks as { id: string; message: string }[]).find((c) => c.id === "surface.mode")!;
    expect(surface.message).toMatch(/^standalone/);
  });

  it("publishes descriptions unmarked — the read tools are registered here", async () => {
    const deposit = (await s.client.listTools()).tools.find((t) => t.name === "dexe_vote_build_deposit")!;
    expect(JSON.stringify(deposit.inputSchema)).toContain("(dexe_dao_registry_lookup)");
  });
});

describe("dexe_write_doctor env-file rows", () => {
  it("says so when the startup record is missing", () => {
    const rows = envFileRows(null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "env.file", status: "warn" });
  });

  it("names the loaded file, the losers and the shadowed keys", () => {
    const report = (path: string, exists: boolean, extra: Record<string, unknown> = {}) => ({
      envFilePath: path,
      envFileExists: exists,
      envFileLoaded: exists,
      loadedNodeVersion: "22.0.0",
      parseIssues: [],
      fileKeys: [],
      keysApplied: ["DEXE_PINATA_JWT"],
      keysShadowed: [],
      keysDropped: [],
      unknownDexeVars: [],
      missingButEnablesFlows: [],
      preExistingVars: [],
      ...extra,
    });
    const rows = envFileRows({
      candidates: ["/a/.env", "/b/.env"],
      reports: [report("/a/.env", true, { keysShadowed: ["DEXE_RPC_URL"] }), report("/b/.env", true)],
    });
    expect(rows.map((r) => r.id)).toEqual(["env.file", "env.file.precedence", "env.shadowedKeys"]);
    expect(rows[0]!.message).toContain("loaded /a/.env");
  });
});

describe("markReadTools", () => {
  it("marks bare read names once, leaves write names and marked names alone", () => {
    expect(markReadTools("(dexe_dao_info) and dexe_tx_send")).toBe("(dexe_dao_info (read server)) and dexe_tx_send");
    expect(markReadTools("dexe_dao_info (read server)")).toBe("dexe_dao_info (read server)");
    expect(markReadTools("`dexe_proposal_state`")).toBe("`dexe_proposal_state` (read server)");
    expect(markReadTools("dexe_read_*")).toBe("dexe_read_*");
    const once = markReadTools("dexe_proposal_list then dexe_proposal_list");
    expect(markReadTools(once)).toBe(once);
  });
});
