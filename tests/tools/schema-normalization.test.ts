import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dist = resolve(__dirname, "..", "..", "dist/index.js");

// The normalizer itself (normalizeJsonSchema, installed by
// installListToolsNormalizer from @dexe-network/dexe-mcp/core) is unit-tested in
// the read edition's copy of this file. Here: every schema this server
// advertises, write tools included, comes out normalized.

describe.skipIf(!existsSync(dist))("advertised tool schemas (DEXE_TOOLSETS=full)", () => {
  it("have no oneOf and no open property-bearing object", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      // Standalone: every schema this binary can advertise, the read tools' included.
      env: { DEXE_TOOLSETS: "full", DEXE_WRITE_STANDALONE: "1" },
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
