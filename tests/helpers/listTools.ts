import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * Boot a REAL server at a given `DEXE_TOOLSETS` profile and return what a host
 * would see from `tools/list`.
 *
 * Four test files grew their own copy of this (gate, default-profile-references,
 * default-profile-capability, and now description-lint). They drifted in what
 * they returned — names only, tools only, tools+bytes — so a rule written
 * against one shape could not be reused by the next. One helper, one shape.
 *
 * Not itself a test file: vitest's default include glob is
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)`, and there is no vitest config widening
 * it, so nothing here is collected as a suite.
 */
export interface ListedTools {
  /** Tool names, sorted — the shape membership assertions want. */
  names: string[];
  /** The full Tool objects exactly as serialized to the client. */
  tools: Tool[];
  /** Serialized size of the whole `tools` array, the budgeted number. */
  bytes: number;
}

export async function listTools(toolsetsEnv: string | undefined): Promise<ListedTools> {
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

/** One input parameter, flattened out of a tool's JSON Schema. */
export interface ParamEntry {
  /** Dotted path from the tool's inputSchema root, e.g. `tiers[].totalTokenProvided`. */
  path: string;
  /** The property's own JSON Schema node. */
  node: Record<string, unknown>;
  /** Trimmed description, "" when absent. */
  description: string;
  /** JSON Schema `type`, when the node declares one. */
  type: string | undefined;
  /** True when the property sits below the top level of the schema. */
  nested: boolean;
}

/**
 * Every input parameter of `tool`, INCLUDING the ones inside object properties,
 * array items and anyOf/oneOf branches.
 *
 * Walking only `inputSchema.properties` is blind exactly where the worst
 * schemas are: `dexe_otc_dao_open_sale.tiers` is one property hiding a dozen
 * unit-bearing fields, and `dexe_dao_build_deploy` nests everything two levels
 * down.
 */
export function collectParams(tool: Tool): ParamEntry[] {
  const out: ParamEntry[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, path: string, nested: boolean): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as Record<string, unknown>;

    const props = n.properties;
    if (props && typeof props === "object") {
      for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
        const child = (raw ?? {}) as Record<string, unknown>;
        const childPath = path ? `${path}.${key}` : key;
        out.push({
          path: childPath,
          node: child,
          description: typeof child.description === "string" ? child.description.trim() : "",
          type: typeof child.type === "string" ? child.type : undefined,
          nested,
        });
        walk(child, childPath, true);
      }
    }
    if (n.items) walk(n.items, `${path}[]`, true);
    for (const branchKey of ["anyOf", "oneOf", "allOf"]) {
      const branches = n[branchKey];
      if (Array.isArray(branches)) for (const b of branches) walk(b, path, nested);
    }
  };

  walk(tool.inputSchema as unknown, "", false);
  return out;
}
