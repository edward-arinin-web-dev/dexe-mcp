import { beforeAll, describe, expect, it } from "vitest";
import { READ_TOOLS } from "../../src/editions.js";
import { listTools, type ListedTools } from "../helpers/listTools.js";

/**
 * Every array a read-edition tool accepts is a fan-out knob. Before the
 * hardening, one `tools/call` to dexe_read_protocol_stats with 3,000
 * `chainIds` became 3,001 backend requests. Each array input now publishes a
 * `maxItems` (src/lib/inputLimits.ts), so the SDK rejects an over-long array
 * before the handler runs and a client can see the limit up front.
 *
 * This walks the PUBLISHED input schema of every read tool — nested objects,
 * array items, anyOf/allOf branches and record values included — so a new
 * read tool, or a new array on an old one, fails here by path.
 */

interface ArrayNode {
  tool: string;
  path: string;
  maxItems: unknown;
}

function collectArrays(tool: string, schema: unknown): ArrayNode[] {
  const out: ArrayNode[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as Record<string, unknown>;
    const isArray = n.type === "array" || (Array.isArray(n.type) && n.type.includes("array"));
    if (isArray) out.push({ tool, path: path || "$", maxItems: n.maxItems });
    if (n.properties && typeof n.properties === "object") {
      for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
    }
    if (n.items) walk(n.items, `${path}[]`);
    if (n.additionalProperties && typeof n.additionalProperties === "object") walk(n.additionalProperties, `${path}{}`);
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const arms = n[key];
      if (Array.isArray(arms)) for (const a of arms) walk(a, path);
    }
  };
  walk(schema, "");
  return out;
}

describe("read-edition tools bound every array input", () => {
  let listed: ListedTools;
  let arrays: ArrayNode[];

  beforeAll(async () => {
    listed = await listTools("full");
    const read = new Set(READ_TOOLS);
    arrays = listed.tools.filter((t) => read.has(t.name)).flatMap((t) => collectArrays(t.name, t.inputSchema));
  });

  it("finds the read tools and their arrays (the walk is not vacuous)", () => {
    const read = new Set(READ_TOOLS);
    expect(listed.tools.filter((t) => read.has(t.name)).length).toBe(READ_TOOLS.length);
    // chainIds, calls, calls[].args, tokens ×2, tierIds ×2, proposalIds, sections,
    // actionsOnFor, actions, daos, addresses, whitelists, whitelists[].users
    expect(arrays.length).toBeGreaterThanOrEqual(15);
  });

  it("every array input of every read tool declares maxItems", () => {
    const unbounded = arrays.filter((a) => typeof a.maxItems !== "number").map((a) => `${a.tool} ${a.path}`);
    expect(unbounded, "add .max(N) (src/lib/inputLimits.ts) to each of these").toEqual([]);
  });

  it("no ceiling is so high it stops being one", () => {
    const tooHigh = arrays
      .filter((a) => typeof a.maxItems === "number" && (a.maxItems as number) > 10_000)
      .map((a) => `${a.tool} ${a.path} maxItems=${String(a.maxItems)}`);
    expect(tooHigh).toEqual([]);
  });

  it("the reviewer's fan-out vector is closed: protocol_stats takes at most 8 chainIds", () => {
    const chainIds = arrays.find((a) => a.tool === "dexe_read_protocol_stats" && a.path === "chainIds");
    expect(chainIds?.maxItems).toBe(8);
  });
});
