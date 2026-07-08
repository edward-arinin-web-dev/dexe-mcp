#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./tools/index.js";
import { homedir } from "node:os";
import { loadEnvFile, writeStartupBanner, resolveEnvCandidates, type EnvLoadReport } from "./env/loader.js";
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
// .env resolution MUST be cwd-independent: an MCP host (e.g. the Claude Code
// plugin) launches `npx dexe-mcp` with an arbitrary working directory, so a
// cwd-relative .env is silently missed and every DEXE_* var looks unset — on
// every OS. We load each candidate that exists, in order (see
// resolveEnvCandidates): $DEXE_ENV_FILE → <cwd>/.env → ~/.dexe-mcp/.env →
// <pkgdir>/.env. `process.loadEnvFile()` never overrides an already-set key, so
// the FIRST existing file wins per key and host-injected OS env beats them all.
const homeEnvPath = resolve(homedir(), ".dexe-mcp", ".env");
const envCandidates = resolveEnvCandidates({
  cwd: process.cwd(),
  home: homedir(),
  pkgDir: __dirname,
  explicit: process.env.DEXE_ENV_FILE,
});
let envReport: EnvLoadReport | undefined;
for (const candidate of envCandidates) {
  if (!existsSync(candidate)) continue;
  const report = loadEnvFile(candidate, prevSnapshot);
  if (!envReport) envReport = report; // first existing file drives the banner
}
// Nothing on disk anywhere — still emit a banner naming the recommended home
// location so the user knows exactly where to create their config.
writeStartupBanner(envReport ?? loadEnvFile(homeEnvPath, prevSnapshot));

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

/** Real package version — the MCP handshake previously hardcoded "0.1.5". */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer(
    { name: "dexe-mcp", version: packageVersion() },
    {
      instructions:
        "Tools for DeXe Protocol governance DAOs (plus a generic dexe_gov_* surface for external OpenZeppelin/Compound Governor DAOs). " +
        "Call dexe_context first WHEN you need orientation (signer, active chain, env readiness, DAOs/proposals from prior sessions) — skip it when the user already gave you the target DAO and chain. " +
        "Prefer the composite flow tools over hand-sequencing calldata: dexe_dao_create (deploy a DAO), dexe_proposal_create (ANY of the 33 catalog proposal types — pass proposalType + params), dexe_proposal_vote_and_execute (auto-deposits when power is short). " +
        "Amounts accept raw wei (digits-only) or human units with a decimal point ('12.5'); durations are seconds. " +
        "For images (DAO avatars): pass a LOCAL FILE PATH (avatarPath / newAvatarPath / filePath) and the server reads, validates, and pins it — never read image files or pass base64 through the conversation. " +
        "The composites handle approve→deposit→create sequencing, correct IPFS metadata, and the known deploy/proposal reverts; on partial failure they return the landed-steps ledger — fix the cause and re-run the same call (completed steps are skipped). " +
        "When depositing, ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
        "Before any dexe_get_* / dexe_list_contracts / dexe_find_selector, run dexe_compile once per session. " +
        "The tool surface is gated by DEXE_TOOLSETS (default 'core,proposals'); dexe_context reports which sets are off and what they unlock. " +
        "Full intent→call recipes + error→remedy table: docs/PLAYBOOK.md (shipped in the package). " +
        "Recipe skills ship with the package (dexe-create-dao, dexe-create-proposal, dexe-vote-execute, dexe-otc). Installed automatically with the Claude Code plugin (`/plugin install dexe@dexe-mcp`), or copy them standalone with `npx dexe-mcp skills`.",
    },
  );

  registerAll(server, config);

  // The AI-efficiency guide, on demand (docs/PLAYBOOK.md ships in the package).
  // Kept out of `instructions` so it doesn't cost tokens every session.
  const playbookPath = resolve(__dirname, "..", "docs", "PLAYBOOK.md");
  if (existsSync(playbookPath)) {
    server.resource("playbook", "dexe://playbook", async () => ({
      contents: [
        {
          uri: "dexe://playbook",
          mimeType: "text/markdown",
          text: readFileSync(playbookPath, "utf8"),
        },
      ],
    }));
  }

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
