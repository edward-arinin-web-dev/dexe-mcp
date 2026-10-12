import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { TOOLSETS } from "../../src/tools/gate.js";
import { applyToolAliases, DEPRECATED_ALIASES } from "../../src/tools/aliases.js";
import { listTools } from "../helpers/listTools.js";

/**
 * D4 (0.36.0) renamed two read tools; the single server keeps answering to
 * the old names as deprecated aliases (src/tools/aliases.ts). An alias is
 * listed and callable exactly when its target is, behaves identically, and is
 * never counted as a tool.
 */

const ALIASES = Object.entries(DEPRECATED_ALIASES);

describe("deprecated aliases", () => {
  let full: Tool[];
  let byName: Map<string, Tool>;

  beforeAll(async () => {
    full = (await listTools("full")).tools;
    byName = new Map(full.map((t) => [t.name, t]));
  });

  it("are exactly the two D4 renames", () => {
    expect(DEPRECATED_ALIASES).toEqual({
      dexe_otc_buyer_status: "dexe_read_token_sale_position",
      dexe_otc_list_sales_for_dao: "dexe_read_token_sales",
    });
  });

  it("point at read-edition tools, and are tools of no edition and no toolset", () => {
    for (const [oldName, target] of ALIASES) {
      expect(READ_TOOLS, target).toContain(target);
      expect([...READ_TOOLS, ...WRITE_TOOLS], oldName).not.toContain(oldName);
      for (const [set, names] of Object.entries(TOOLSETS)) expect(names.has(oldName), `${set}:${oldName}`).toBe(false);
    }
  });

  it("are listed with the target's schemas and hints, and a deprecation description", () => {
    for (const [oldName, target] of ALIASES) {
      const a = byName.get(oldName);
      const t = byName.get(target);
      expect(a, `${oldName} is not listed`).toBeDefined();
      expect(t, `${target} is not listed`).toBeDefined();
      expect(a!.inputSchema).toEqual(t!.inputSchema);
      expect(a!.outputSchema).toEqual(t!.outputSchema);
      expect(a!.annotations).toEqual(t!.annotations);
      expect(a!.title).toBe(`${t!.title} (old name)`);
      expect(a!.description).toBe(`Read-only. Deprecated alias of ${target} (renamed in 0.36.0); same input and output.`);
    }
  });

  it("follow their target through the toolset gate", async () => {
    // core carries both targets; dev carries neither.
    const core = new Set((await listTools("core")).names);
    const dev = new Set((await listTools("dev")).names);
    for (const [oldName, target] of ALIASES) {
      expect(core.has(oldName), oldName).toBe(core.has(target));
      expect(dev.has(oldName), oldName).toBe(false);
    }
  });

  it("answer exactly like their target", async () => {
    process.env.DEXE_TOOLSETS = "full";
    const config = await loadConfig();
    delete process.env.DEXE_TOOLSETS;
    const server = new McpServer({ name: "aliases", version: "0.0.0" }, {});
    registerAll(server, config);
    const client = new Client({ name: "c", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // Input validation runs before any network call, so the answers compare offline.
      const args: Record<string, Record<string, unknown>> = {
        dexe_read_token_sale_position: { tokenSaleProposal: "0x1", tierIds: ["1"], user: "0x2" },
        dexe_read_token_sales: { govPool: "0x1", tokenSaleProposal: "0x2" },
      };
      for (const [oldName, target] of ALIASES) {
        const viaTarget = await client.callTool({ name: target, arguments: args[target]! });
        const viaAlias = await client.callTool({ name: oldName, arguments: args[target]! });
        expect(viaAlias).toEqual(viaTarget);
        expect(viaAlias.isError).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuse a target registered without a config object", () => {
    const bare = new McpServer({ name: "x", version: "0.0.0" }, {});
    const wrapped = applyToolAliases(bare, bare, { old_name: "new_name" });
    expect(() => wrapped.tool("new_name", "Read-only. x", {}, async () => ({ content: [] }))).toThrow(/registerTool/);
    // A tool with no alias registers untouched either way.
    expect(() => wrapped.tool("other", "Read-only. y", { a: z.string() }, async () => ({ content: [] }))).not.toThrow();
  });

  it("are not counted as tools in the docs", () => {
    const root = resolve(__dirname, "..", "..");
    const tools = readFileSync(resolve(root, "docs/TOOLS.md"), "utf8");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    const count = READ_TOOLS.length + WRITE_TOOLS.length;
    expect(tools).toContain(`${count} tools`);
    expect(readme).toContain(`${count} tools`);
    for (const [oldName] of ALIASES) {
      // Mentioned (so a reader can find what an old name became), never as a catalog row.
      expect(tools, oldName).toContain(oldName);
      expect(tools, `${oldName} has its own row in docs/TOOLS.md`).not.toMatch(new RegExp(`^\\| \`${oldName}\` \\|`, "m"));
    }
  });
});
