import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLSETS, resolveToolsets, DEFAULT_TOOLSETS } from "../../src/tools/gate.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/** Boot a real server with the given DEXE_TOOLSETS and return listed tools. */
async function listTools(toolsetsEnv: string | undefined) {
  if (toolsetsEnv === undefined) delete process.env.DEXE_TOOLSETS;
  else process.env.DEXE_TOOLSETS = toolsetsEnv;
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = await client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify(res.tools), "utf8");
  await client.close();
  await server.close();
  return { names: res.tools.map((t) => t.name).sort(), tools: res.tools, bytes };
}

describe("resolveToolsets", () => {
  it("defaults to core,proposals when empty", () => {
    const r = resolveToolsets([]);
    expect(r.full).toBe(false);
    expect(r.requested).toEqual([...DEFAULT_TOOLSETS]);
    expect(r.names!.size).toBeGreaterThan(0);
  });
  it("explicit full bypasses filtering", () => {
    const r = resolveToolsets(["full"]);
    expect(r.full).toBe(true);
    expect(r.names).toBeNull();
  });
  it("unknown set name falls back to full (never silently strips)", () => {
    const r = resolveToolsets(["core", "typo"]);
    expect(r.full).toBe(true);
    expect(r.unknown).toContain("typo");
  });
  it("unions the requested sets", () => {
    const r = resolveToolsets(["core", "vote"]);
    expect(r.full).toBe(false);
    expect(r.names!.has("dexe_dao_create")).toBe(true); // core
    expect(r.names!.has("dexe_vote_build_delegate")).toBe(true); // vote
    expect(r.names!.has("dexe_compile")).toBe(false); // dev
  });
});

describe("tool gating (real server)", () => {
  let fullNames: string[];
  let fullBytes: number;
  let defaultNames: string[];
  let defaultBytes: number;

  beforeAll(async () => {
    ({ names: fullNames, bytes: fullBytes } = await listTools("full"));
    ({ names: defaultNames, bytes: defaultBytes } = await listTools(undefined));
  });

  it("full loads every registered tool (159)", () => {
    expect(fullNames.length).toBe(159);
    expect(new Set(fullNames).size).toBe(159); // no dupes
  });

  it("every name in every TOOLSET is a real registered tool (no typos)", () => {
    const real = new Set(fullNames);
    const orphans: string[] = [];
    for (const [set, names] of Object.entries(TOOLSETS)) {
      for (const n of names) if (!real.has(n)) orphans.push(`${set}:${n}`);
    }
    expect(orphans, `TOOLSET names not registered: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the union of all named sets equals the full surface (nothing full-only)", () => {
    const union = new Set<string>();
    for (const names of Object.values(TOOLSETS)) for (const n of names) union.add(n);
    const missing = fullNames.filter((n) => !union.has(n));
    expect(missing, `tools reachable only under full: ${missing.join(", ")}`).toEqual([]);
    expect(union.size).toBe(159);
  });

  it("default profile is a strict, slim subset", () => {
    expect(defaultNames.length).toBeLessThan(fullNames.length);
    expect(defaultNames.length).toBeGreaterThan(50);
    // core present
    expect(defaultNames).toContain("dexe_context");
    expect(defaultNames).toContain("dexe_dao_create");
    expect(defaultNames).toContain("dexe_proposal_create");
    // proposals present
    expect(defaultNames).toContain("dexe_proposal_build_token_sale");
    // gated out of default
    expect(defaultNames).not.toContain("dexe_compile"); // dev
    expect(defaultNames).not.toContain("dexe_gov_build_propose"); // governor
    expect(defaultNames).not.toContain("dexe_vote_build_delegate"); // vote
  });

  it("default profile is a big tools/list cut; core-only clears 60%", async () => {
    const { bytes: coreBytes, names: coreNames } = await listTools("core");
    const defReduction = 1 - defaultBytes / fullBytes;
    const coreReduction = 1 - coreBytes / fullBytes;
    // eslint-disable-next-line no-console
    console.log(
      `tools/list bytes — full: ${fullBytes} (${fullNames.length}t), ` +
        `default core,proposals: ${defaultBytes} (${defaultNames.length}t, −${(defReduction * 100).toFixed(1)}%), ` +
        `core-only: ${coreBytes} (${coreNames.length}t, −${(coreReduction * 100).toFixed(1)}%)`,
    );
    // Default (core,proposals) keeps every proposal builder discoverable — a
    // meaningful cut, not the deepest. core-only is the max-slim path.
    expect(defReduction).toBeGreaterThan(0.4);
    expect(defaultBytes).toBeLessThan(130_000);
    // The documented "maximum slim" default alternative clears the 60% target.
    expect(coreReduction).toBeGreaterThan(0.6);
  });

  it("dev profile exposes dev tools, hides the composites", async () => {
    const { names } = await listTools("dev");
    expect(names).toContain("dexe_compile");
    expect(names).toContain("dexe_dao_build_deploy");
    expect(names).not.toContain("dexe_dao_create");
  });
});
