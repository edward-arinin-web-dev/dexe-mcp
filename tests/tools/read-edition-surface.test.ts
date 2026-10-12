import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { readInstructions } from "../../src/instructions.js";
import { listReadEdition, type ReadEditionListing } from "../helpers/readEdition.js";
import { listTools } from "../helpers/listTools.js";

/**
 * 2e — the READ edition's surface as connector directories review it.
 *
 * Anthropic's directory wants a `title` and `readOnlyHint: true` on every
 * tool, names of at most 64 characters, and descriptions that do not tell the
 * model to call other tools; OpenAI's wants explicit boolean `readOnlyHint`,
 * `destructiveHint` and `openWorldHint`. Checked twice: on the read edition
 * wired from read modules only (tests/helpers/readEdition.ts), and on the
 * single server, which serves the same 54 tools today.
 */

/** The read tools that compute locally — the only ones with `openWorldHint: false`. */
const LOCAL = new Set([
  "dexe_decode_calldata",
  "dexe_get_config",
  "dexe_guide",
  "dexe_ipfs_cid_info",
  "dexe_list_gov_contract_types",
]);

const READ = new Set(READ_TOOLS);

function checkAnnotations(tools: Tool[]): string[] {
  const bad: string[] = [];
  for (const t of tools) {
    const a = t.annotations ?? {};
    if (a.readOnlyHint !== true) bad.push(`${t.name}: readOnlyHint ${a.readOnlyHint}`);
    if (a.destructiveHint !== false) bad.push(`${t.name}: destructiveHint ${a.destructiveHint}`);
    if (a.idempotentHint !== true) bad.push(`${t.name}: idempotentHint ${a.idempotentHint}`);
    if (a.openWorldHint !== !LOCAL.has(t.name)) bad.push(`${t.name}: openWorldHint ${a.openWorldHint}`);
  }
  return bad;
}

function checkTitles(tools: Tool[]): string[] {
  const bad: string[] = [];
  for (const t of tools) {
    const title = t.title ?? "";
    if (!title.trim()) bad.push(`${t.name}: no title`);
    else if (title.length > 60) bad.push(`${t.name}: title is ${title.length} chars`);
    else if (title.replace(/\s+/g, "_").toLowerCase() === t.name) bad.push(`${t.name}: title is the name`);
    else if (/\bOTC\b/.test(title)) bad.push(`${t.name}: title says OTC (read titles say "token sale")`);
  }
  return bad;
}

describe("read edition surface (wired from read modules only)", () => {
  let edition: ReadEditionListing;
  const saved = process.env.DEXE_TOOLSETS;

  beforeAll(async () => {
    // The read edition ignores DEXE_TOOLSETS: a narrow value must not shrink it.
    process.env.DEXE_TOOLSETS = "core";
    edition = await listReadEdition();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DEXE_TOOLSETS;
    else process.env.DEXE_TOOLSETS = saved;
  });

  it("registers exactly READ_TOOLS, whatever DEXE_TOOLSETS says", () => {
    expect(edition.names).toEqual([...READ_TOOLS].sort());
  });

  it("serves the read handshake", () => {
    expect(edition.instructions).toBe(readInstructions());
  });

  it("every tool spells readOnlyHint / destructiveHint / idempotentHint / openWorldHint", () => {
    expect(checkAnnotations(edition.tools)).toEqual([]);
  });

  it("every tool has a short human-readable title", () => {
    expect(checkTitles(edition.tools)).toEqual([]);
  });

  it("no tool name is longer than 64 characters", () => {
    expect(edition.tools.filter((t) => t.name.length > 64).map((t) => t.name)).toEqual([]);
  });

  it("dexe_dao_report keeps nothing between calls", () => {
    const report = edition.tools.find((t) => t.name === "dexe_dao_report")!;
    const props = (report.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("persist");
  });

  it("dexe_doctor publishes no pin probe", () => {
    const doctor = edition.tools.find((t) => t.name === "dexe_doctor")!;
    const props = (doctor.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("probePin");
    expect(doctor.description).not.toMatch(/Pinata|probePin/);
  });
});

describe("read tools on the single server", () => {
  let full: Tool[];

  beforeAll(async () => {
    full = (await listTools("full")).tools;
  });

  it("carry the same explicit annotations", () => {
    expect(checkAnnotations(full.filter((t) => READ.has(t.name)))).toEqual([]);
  });

  it("carry short human-readable titles", () => {
    expect(checkTitles(full.filter((t) => READ.has(t.name)))).toEqual([]);
  });

  it("no registered tool name is longer than 64 characters", () => {
    // Anthropic's directory limit; applies to the whole surface, write tools included.
    expect(full.filter((t) => t.name.length > 64).map((t) => t.name)).toEqual([]);
    expect([...READ_TOOLS, ...WRITE_TOOLS].filter((n) => n.length > 64)).toEqual([]);
  });
});
