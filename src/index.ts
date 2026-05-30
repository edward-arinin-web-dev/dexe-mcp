#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./tools/index.js";
import { loadEnvFile, writeStartupBanner } from "./env/loader.js";
import { envKeys } from "./env/schema.js";

// Snapshot DEXE_* schema keys already in process.env BEFORE we load .env.
// Anything found here was injected by the MCP host (Claude Code's
// .claude.json `env` block) and will SHADOW the .env file —
// `process.loadEnvFile()` does NOT override pre-set keys. The startup banner
// (and dexe_doctor) surface the collision so users don't chase a phantom
// "I edited .env and nothing changed" bug.
//
// This must run BEFORE the CLI subcommand dispatch below: `npx dexe-mcp
// doctor` invoked directly from a shell needs the same env as the MCP
// startup path, otherwise the diagnostic sees an empty config.
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenvPath = resolve(__dirname, "..", ".env");
const prevSnapshot = new Set<string>(envKeys().filter(k => !!process.env[k]?.trim()));
const envReport = loadEnvFile(dotenvPath, prevSnapshot);
writeStartupBanner(envReport);

// CLI subcommand dispatch. `npx dexe-mcp` (no args) → MCP server.
// `npx dexe-mcp doctor` → run diagnostics and exit. Keeps a single bin entry
// instead of shipping a parallel `dexe-mcp-doctor` script. Subcommands must
// be handled BEFORE the stdio transport opens — the MCP host passes no args,
// so any argv[2] means a human/CI invoked the binary directly.
const subcommand = process.argv[2];
if (subcommand === "doctor") {
  const mod = await import("./cli/doctor.js");
  await mod.run();
  process.exit(0);
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer(
    { name: "dexe-mcp", version: "0.1.5" },
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
