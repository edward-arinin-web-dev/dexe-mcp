import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeJsonSchema } from "../../src/tools/schemaNormalize.js";

const dist = resolve(__dirname, "..", "..", "dist/index.js");

describe("normalizeJsonSchema", () => {
  it("rewrites oneOf to anyOf at any depth", () => {
    const out = normalizeJsonSchema({
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "number" }] },
    }) as { items: Record<string, unknown> };
    expect(out.items.oneOf).toBeUndefined();
    expect(out.items.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("closes objects that list properties, but not open maps or explicit choices", () => {
    const out = normalizeJsonSchema({
      type: "object",
      properties: {
        type: { type: "string" },
        m: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
        p: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
      },
    }) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.m.additionalProperties).toEqual({});
    expect(out.properties.p.additionalProperties).toBe(true);
  });
});

describe.skipIf(!existsSync(dist))("advertised tool schemas (DEXE_TOOLSETS=full)", () => {
  it("have no oneOf and no open property-bearing object", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      env: { DEXE_TOOLSETS: "full" },
      stderr: "ignore",
    });
    const client = new Client({ name: "schema-check", version: "0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    await client.close();
    expect(tools.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    const walk = (n: unknown, path: string): void => {
      if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (n === null || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if ("oneOf" in o) offenders.push(`${path}: oneOf`);
      if (
        o.type === "object" &&
        o.properties &&
        typeof o.properties === "object" &&
        !("additionalProperties" in o) &&
        !("propertyNames" in o)
      ) {
        offenders.push(`${path}: object without additionalProperties`);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const t of tools) {
      walk(t.inputSchema, `${t.name}.inputSchema`);
      if (t.outputSchema) walk(t.outputSchema, `${t.name}.outputSchema`);
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
