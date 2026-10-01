import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { serverInstructions } from "../../src/instructions.js";
import { alwaysLoadedToolNames, classifiedToolNames, titledToolNames } from "../../src/tools/annotations.js";

/**
 * ── MCP annotations and titles, asserted on the WIRE ───────────────────────
 *
 * Everything here reads `client.listTools()` from a real server over a real
 * transport, not the registry, because the registry is not what a host sees.
 * The central wrapper (src/tools/annotations.ts) has to survive BOTH
 * registration shapes (`registerTool` config objects and the deprecated
 * positional `tool()`), the toolset gate dropping names, and the `full`
 * profile where the gate returns the bare server — only the wire proves that.
 *
 * Without annotations the MCP spec makes a client assume every tool is
 * non-read-only, destructive and open-world, so `dexe_read_treasury` reads as
 * exactly as dangerous as `dexe_tx_send`.
 */
async function listTools(toolsetsEnv: string | undefined): Promise<Tool[]> {
  if (toolsetsEnv === undefined) delete process.env.DEXE_TOOLSETS;
  else process.env.DEXE_TOOLSETS = toolsetsEnv;
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = await client.listTools();
  await client.close();
  await server.close();
  return res.tools as Tool[];
}

/**
 * Tools that sign and send, or queue a transaction other people execute. A new
 * entry here is a human decision, never a rename artefact: the list is spelled
 * out so a tool that silently starts broadcasting fails this file.
 */
const BROADCAST_TOOLS = [
  "dexe_agents_fund",
  "dexe_dao_create",
  "dexe_otc_buyer_buy",
  "dexe_otc_buyer_claim_all",
  "dexe_otc_dao_open_sale",
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_safe_propose_tx",
  "dexe_tx_send",
];

/** Mutates something remote but destroys nothing: IPFS pins, sessions, login. */
const REMOTE_WRITE_TOOLS = [
  "dexe_auth_login",
  "dexe_dao_generate_avatar",
  "dexe_ipfs_update_dao_metadata",
  "dexe_ipfs_upload_avatar",
  "dexe_ipfs_upload_dao_metadata",
  "dexe_ipfs_upload_file",
  "dexe_ipfs_upload_proposal_metadata",
  "dexe_wc_connect",
  "dexe_wc_disconnect",
];

/** Shells out to hardhat in DEXE_PROTOCOL_PATH; touches no network. */
const LOCAL_WRITE_TOOLS = ["dexe_compile", "dexe_coverage", "dexe_lint", "dexe_test"];

/**
 * Name shapes that are reads by construction — every `dexe_read_*`, every
 * `*_build_*` calldata builder (they return an unsigned payload, they never
 * send it), every decoder and every simulator. Kept as a rule rather than a
 * list so a NEW read tool is covered the day it is added.
 */
const READ_SHAPE =
  /^dexe_read_|^dexe_get_|^dexe_list_|^dexe_sim_|^dexe_gov_get_|^dexe_gov_simulate_|_build_|_decode_|_catalog$/;

/**
 * Read-shaped names that are genuinely NOT reads. Deliberately empty: an
 * addition here must be visible in the diff and argued for in review.
 */
const READ_SHAPE_EXCEPTIONS = new Set<string>([]);

describe("MCP tool annotations (wire shape)", () => {
  let full: Tool[];
  let byName: Map<string, Tool>;

  beforeAll(async () => {
    full = await listTools("full");
    byName = new Map(full.map((t) => [t.name, t]));
  });

  it("every registered tool is explicitly classified", () => {
    const unclassified = full.filter((t) => !t.annotations).map((t) => t.name);
    expect(
      unclassified,
      `add ${unclassified.join(", ")} to TOOL_CLASSES in src/tools/annotations.ts — ` +
        `an unlisted tool ships unannotated, which the MCP spec reads as destructive and open-world`,
    ).toEqual([]);
  });

  it("the classification map has no entry for a tool that no longer exists", () => {
    const registered = new Set(full.map((t) => t.name));
    const orphans = [...classifiedToolNames()].filter((n) => !registered.has(n));
    expect(orphans, `classified but not registered: ${orphans.join(", ")}`).toEqual([]);
  });

  it("declares readOnlyHint as a boolean on every tool", () => {
    const bad = full.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("marks the broadcast set destructive", () => {
    for (const name of BROADCAST_TOOLS) {
      const t = byName.get(name);
      expect(t, `${name} is not registered`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, name).toBe(false);
      expect(t!.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it("marks remote writes non-read-only but NOT destructive", () => {
    // An IPFS pin is content-addressed: re-running it converges instead of
    // clobbering, so a destructive prompt here is the same overstatement as
    // calling a read dangerous.
    for (const name of REMOTE_WRITE_TOOLS) {
      const t = byName.get(name);
      expect(t, `${name} is not registered`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, name).toBe(false);
      expect(t!.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("marks local hardhat runs closed-world", () => {
    for (const name of LOCAL_WRITE_TOOLS) {
      const t = byName.get(name);
      expect(t, `${name} is not registered`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, name).toBe(false);
      expect(t!.annotations?.openWorldHint, name).toBe(false);
    }
  });

  it("the non-read-only set is exactly broadcast + remote write + local exec", () => {
    const writers = full
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    const expected = [...BROADCAST_TOOLS, ...REMOTE_WRITE_TOOLS, ...LOCAL_WRITE_TOOLS].sort();
    expect(writers).toEqual(expected);
  });

  it("read-shaped names are read-only", () => {
    const liars = full
      .filter((t) => READ_SHAPE.test(t.name) && !READ_SHAPE_EXCEPTIONS.has(t.name))
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    expect(liars).toEqual([]);
  });

  it("no tool claims to be both read-only and destructive", () => {
    const contradictory = full
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it("emits only spec-meaningful fields — reads carry readOnlyHint alone", () => {
    // destructiveHint / idempotentHint are defined as meaningful only when
    // readOnlyHint is false, and tools/list bytes are budgeted
    // (tests/tools/gate.test.ts). A read that ships four keys is ~67 wasted
    // bytes per tool for nothing a client can act on.
    for (const t of full) {
      if (t.annotations?.readOnlyHint !== true) continue;
      expect(t.annotations.destructiveHint, t.name).toBeUndefined();
      expect(t.annotations.idempotentHint, t.name).toBeUndefined();
    }
  });

  it("annotations survive the toolset gate on the default profile", async () => {
    // The wrapper sits OUTSIDE applyToolGate, which returns the bare server on
    // `full` and `undefined` for a dropped name. Both paths must annotate.
    const def = await listTools(undefined);
    expect(def.length).toBeGreaterThan(0);
    const unannotated = def.filter((t) => !t.annotations).map((t) => t.name);
    expect(unannotated).toEqual([]);
  });
});

describe("tool titles (wire shape)", () => {
  let full: Tool[];

  beforeAll(async () => {
    full = await listTools("full");
  });

  it("every tool has a human-readable title", () => {
    // The 21 tools registered through the deprecated positional `tool()`
    // overload have no title slot; without the central map a host's approval
    // dialog shows "dexe_otc_buyer_buy" instead of "Buy from an OTC tier".
    const untitled = full.filter((t) => typeof t.title !== "string" || t.title.length === 0);
    expect(untitled.map((t) => t.name)).toEqual([]);
  });

  it("no title is just the tool name", () => {
    const lazy = full
      .filter((t) => (t.title ?? "").replace(/\s+/g, "_").toLowerCase() === t.name)
      .map((t) => t.name);
    expect(lazy).toEqual([]);
  });

  it("the fallback titles stay short enough for an approval dialog", () => {
    // Scoped to the titles this module supplies. The 147 titles that come from
    // `registerTool` configs are a different surface with a different house
    // style (several are a full sentence) and are not this file's to police.
    const supplied = titledToolNames();
    const tooLong = full
      .filter((t) => supplied.has(t.name) && (t.title ?? "").length > 40)
      .map((t) => `${t.name} (${t.title!.length})`);
    expect(tooLong).toEqual([]);
  });

  it("the fallback title map only covers tools that need one", () => {
    // A registration that grows its own `title:` must not be shadowed here —
    // and a stale entry for a deleted tool must not linger.
    const registered = new Set(full.map((t) => t.name));
    const orphans = [...titledToolNames()].filter((n) => !registered.has(n));
    expect(orphans, `fallback title for an unregistered tool: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the broadcast composites name their action", () => {
    for (const name of BROADCAST_TOOLS) {
      const t = full.find((x) => x.name === name)!;
      expect(t.title, name).toBeTruthy();
      expect(t.title!.length, name).toBeGreaterThan(5);
    }
  });
});

describe("always-loaded tools (wire shape)", () => {
  /**
   * Claude Code defers every MCP tool behind tool search unless the tool's
   * `_meta` carries `"anthropic/alwaysLoad": true`. The handshake sends every
   * session to dexe_guide / dexe_context first, so those two must not cost a
   * search round-trip — and nothing else may be loaded upfront by accident,
   * because each always-loaded schema is paid on every turn.
   */
  const flagged = (tools: Tool[]) =>
    tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] !== undefined).map((t) => t.name).sort();

  it("exactly the two entry-point tools carry anthropic/alwaysLoad, as the boolean true", async () => {
    const full = await listTools("full");
    expect(flagged(full)).toEqual([...alwaysLoadedToolNames()].sort());
    expect(flagged(full)).toEqual(["dexe_context", "dexe_guide"]);
    for (const t of full.filter((x) => alwaysLoadedToolNames().has(x.name))) {
      expect(t._meta?.["anthropic/alwaysLoad"], t.name).toBe(true);
    }
  });

  it("the flag survives the toolset gate on the default profile", async () => {
    // Both are registered through the positional `tool()` overload, which has
    // no `_meta` slot — the wrapper assigns it after registration.
    const def = await listTools(undefined);
    expect(flagged(def)).toEqual(["dexe_context", "dexe_guide"]);
  });

  it("every always-loaded name is a tool the handshake tells the agent to call first", () => {
    const text = serverInstructions();
    for (const name of alwaysLoadedToolNames()) expect(text, name).toContain(name);
  });
});
