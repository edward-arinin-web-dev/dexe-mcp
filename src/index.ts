#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./tools/index.js";

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer(
    { name: "dexe-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools for the DeXe Protocol governance-DAO codebase. Before calling any dexe_get_* / dexe_list_contracts / dexe_find_selector tool, ensure artifacts exist by calling dexe_compile once per session. dexe_decode_proposal and dexe_read_gov_state require DEXE_RPC_URL to be set.",
    },
  );

  registerAll(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log-only, not protocol. stdout is the MCP channel.
  process.stderr.write(
    `[dexe-mcp] connected on stdio. DEXE_PROTOCOL_PATH=${config.protocolPath}${
      config.rpcUrl ? " (rpc enabled)" : ""
    }\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`[dexe-mcp] unhandled error:\n${msg}\n`);
  process.exit(1);
});
