import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Shipped-doc MCP resources. Served on demand so they cost zero tokens until a
 * host actually reads them (unlike `instructions`, which every session pays
 * for). The backing files ship in the npm tarball (`files` includes docs/) and
 * in the plugin bundle (scripts/bundle-plugin.mjs copies them next to the
 * bundled server) — the same `<baseDir>/docs/<file>` layout in all three
 * install shapes (repo, npm, plugin).
 */
export const DOC_RESOURCES = [
  {
    name: "playbook",
    uri: "dexe://playbook",
    file: "PLAYBOOK.md",
    description:
      "AI playbook for dexe-mcp: intent → exact tool call recipes for every flow, per-proposal-type params, and the error → remedy table.",
  },
  {
    name: "graph-schema",
    uri: "dexe://graph-schema",
    file: "GRAPH.md",
    description:
      "Subgraph entity/field reference for dexe_graph_query (pools / interactions / validators): id conventions, filters, enums, worked queries. BSC mainnet data only.",
  },
  {
    name: "tools",
    uri: "dexe://tools",
    file: "TOOLS.md",
    description:
      "Full dexe-mcp tool catalog: every tool by group with a one-line description, plus the DEXE_TOOLSETS profiles that gate them.",
  },
] as const;

/**
 * Register one resource per doc that exists under `<baseDir>/docs/`. Missing
 * files are skipped silently — a partial install must not crash the server,
 * and the pack-contents test guards against the docs going missing from the
 * tarball in the first place.
 */
export function registerDocResources(server: McpServer, baseDir: string): void {
  for (const r of DOC_RESOURCES) {
    const path = resolve(baseDir, "docs", r.file);
    if (!existsSync(path)) continue;
    server.resource(r.name, r.uri, { description: r.description, mimeType: "text/markdown" }, async () => ({
      contents: [
        {
          uri: r.uri,
          mimeType: "text/markdown",
          text: readFileSync(path, "utf8"),
        },
      ],
    }));
  }
}
