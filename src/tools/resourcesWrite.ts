import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocResources } from "@dexe-network/dexe-mcp/core";
import { markReadTools } from "./readServerMarks.js";

/**
 * The shipped docs this server serves as MCP resources, per mode.
 *
 *   standalone   the read edition's three (`registerDocResources`):
 *                dexe://playbook, dexe://graph-schema, dexe://tools — as
 *                before 1.0.
 *   write-only   dexe://playbook and dexe://tools, each served with every read
 *                tool it names marked `(read server)` (the docs describe both
 *                servers; this one registers only the write half).
 *                dexe://graph-schema is the read server's — it documents
 *                `dexe_graph_query`, which this server does not have.
 *
 * Same `<baseDir>/docs/<file>` layout in the repo, the npm package and the
 * plugin bundle; a missing file is skipped, never fatal.
 */
const WRITE_ONLY_DOC_RESOURCES = [
  {
    name: "playbook",
    uri: "dexe://playbook",
    file: "PLAYBOOK.md",
    description:
      "AI playbook for dexe-mcp: intent → exact tool call recipes for every flow, per-proposal-type params, and the " +
      "error → remedy table. Read tools it names are the DeXe read server's.",
  },
  {
    name: "tools",
    uri: "dexe://tools",
    file: "TOOLS.md",
    description:
      "Full dexe-mcp tool catalog: every tool by group with a one-line description, plus the DEXE_TOOLSETS profiles " +
      "that gate them. Read tools it names are the DeXe read server's.",
  },
] as const;

export function registerWriteDocResources(
  server: McpServer,
  baseDir: string,
  config: { writeStandalone?: boolean },
): void {
  if (config.writeStandalone) {
    registerDocResources(server, baseDir);
    return;
  }
  for (const r of WRITE_ONLY_DOC_RESOURCES) {
    const path = resolve(baseDir, "docs", r.file);
    if (!existsSync(path)) continue;
    server.registerResource(r.name, r.uri, { description: r.description, mimeType: "text/markdown" }, async () => ({
      contents: [{ uri: r.uri, mimeType: "text/markdown", text: markReadTools(readFileSync(path, "utf8")) }],
    }));
  }
}
