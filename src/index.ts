#!/usr/bin/env node
import { existsSync } from "node:fs";
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
const prevSnapshot = new Set<string>(envKeys().filter(k => !!process.env[k]?.trim()));
// Two possible .env locations: the user's PROJECT (cwd — Claude Code spawns
// the MCP server with the project dir as cwd) and the PACKAGE dir
// (`dist/../.env`). Load the project .env FIRST so it wins —
// `process.loadEnvFile()` never overrides already-set keys, so whichever file
// loads first is authoritative. This is what makes `/dexe-setup` (which edits
// the project .env) reach a server launched via `npx dexe-mcp` from the plugin,
// whose package dir sits in the npx cache and holds no .env. When both paths
// resolve to the same file (running from the repo) we load it once.
const cwdEnvPath = resolve(process.cwd(), ".env");
const pkgEnvPath = resolve(__dirname, "..", ".env");
const primaryEnvPath = existsSync(cwdEnvPath) ? cwdEnvPath : pkgEnvPath;
const envReport = loadEnvFile(primaryEnvPath, prevSnapshot);
if (primaryEnvPath !== pkgEnvPath && existsSync(pkgEnvPath)) {
  loadEnvFile(pkgEnvPath, prevSnapshot); // fill keys the project .env didn't set
}
writeStartupBanner(envReport);

// CLI subcommand dispatch. `npx dexe-mcp` (no args) → MCP server.
// `npx dexe-mcp doctor` → run diagnostics and exit.
// `npx dexe-mcp init`   → run the onboarding wizard and exit.
// Keeps a single bin entry instead of shipping parallel scripts.
// Subcommands must be handled BEFORE the stdio transport opens — the MCP
// host passes no args, so any argv[2] means a human/CI invoked directly.
const subcommand = process.argv[2];
if (subcommand === "doctor") {
  const mod = await import("./cli/doctor.js");
  await mod.run();
  process.exit(0);
}
if (subcommand === "init") {
  const mod = await import("./cli/init.js");
  await mod.run();
  process.exit(0);
}
if (subcommand === "skills") {
  // `npx dexe-mcp skills [--global]` → copy the shipped skills only, no env
  // interview. The lightweight path for users who just want the Claude recipes.
  const mod = await import("./cli/skills.js");
  await mod.run(process.argv.slice(3));
  process.exit(0);
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer(
    { name: "dexe-mcp", version: "0.1.5" },
    {
      instructions:
        "Tools for DeXe Protocol governance DAOs (plus a generic dexe_gov_* surface for external OpenZeppelin/Compound Governor DAOs). " +
        "Call dexe_context first WHEN you need orientation (signer, active chain, env readiness, DAOs/proposals from prior sessions) — skip it when the user already gave you the target DAO and chain. " +
        "Prefer the composite flow tools over hand-sequencing calldata: dexe_dao_create (deploy a DAO), dexe_proposal_create (any proposal — pass proposalType + params), dexe_proposal_vote_and_execute. " +
        "For images (DAO avatars): pass a LOCAL FILE PATH (avatarPath / newAvatarPath / filePath) and the server reads, validates, and pins it — never read image files or pass base64 through the conversation. " +
        "They handle the approve→deposit→create sequence, correct IPFS metadata, and the known deploy/proposal reverts. When depositing, ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
        "Before any dexe_get_* / dexe_list_contracts / dexe_find_selector, run dexe_compile once per session. dexe_decode_proposal and dexe_read_gov_state need an RPC. " +
        "The tool surface is gated by DEXE_TOOLSETS (default 'core,proposals'). Set DEXE_TOOLSETS=full for every tool, or add sets: read, vote, governor, dev. " +
        "Recipe skills ship with the package (dexe-create-dao, dexe-create-proposal, dexe-vote-execute, dexe-otc). Installed automatically with the Claude Code plugin (`/plugin install dexe@dexe-mcp`), or copy them standalone with `npx dexe-mcp skills`.",
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
