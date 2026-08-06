#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./tools/index.js";
import { registerDocResources } from "./resources.js";
import { homedir } from "node:os";
import { loadEnvFile, writeStartupBanner, resolveEnvCandidates, type EnvLoadReport } from "./env/loader.js";
import { envKeys } from "./env/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `process.loadEnvFile()` — the ONLY way this server reads a .env file —
 * landed in Node 20.12.0. On 20.0–20.11 it does not exist, the .env is skipped
 * without a word, and the user ends up with a fully unconfigured server and no
 * idea why. Keep in sync with `engines.node` in package.json.
 */
const MIN_NODE_VERSION = "20.12.0";

/**
 * Warning line for a runtime older than `min`, or null when it is new enough.
 * Compared component-by-component as numbers: as strings "20.9.0" sorts AFTER
 * "20.12.0", which is precisely the bug this guard exists to catch. A version
 * we cannot parse is treated as new enough — never nag on a runtime we can't read.
 */
export function nodeVersionWarning(running: string, min: string = MIN_NODE_VERSION): string | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(running);
  const want = parse(min);
  if (!have || !want) return null;
  for (let i = 0; i < 3; i++) {
    const delta = (have[i] ?? 0) - (want[i] ?? 0);
    if (delta > 0) return null;
    if (delta < 0) {
      return (
        `Node ${running} is older than the required ${min} — process.loadEnvFile() ` +
        `does not exist before ${min}, so .env files are ignored on this runtime — ` +
        `upgrade Node or set the vars in your MCP host env block.`
      );
    }
  }
  return null;
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

/**
 * Load every .env candidate that exists and print the startup banner.
 * Returns the candidate list so a later failure can name the files it searched.
 *
 * Snapshots DEXE_* schema keys already in process.env BEFORE we load .env.
 * Anything found there was injected by the MCP host (Claude Code's
 * .claude.json `env` block) and will SHADOW the .env file —
 * `process.loadEnvFile()` does NOT override pre-set keys. The startup banner
 * (and dexe_doctor) surface the collision so users don't chase a phantom
 * "I edited .env and nothing changed" bug.
 *
 * This must run BEFORE the CLI subcommand dispatch: `npx dexe-mcp doctor`
 * invoked directly from a shell needs the same env as the MCP startup path,
 * otherwise the diagnostic sees an empty config.
 */
function loadEnvironment(): string[] {
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
  return envCandidates;
}

/**
 * CLI subcommand dispatch. `npx dexe-mcp` (no args) → MCP server.
 * `npx dexe-mcp doctor` → run diagnostics and exit.
 * `npx dexe-mcp init`   → run the onboarding wizard and exit.
 * `npx dexe-mcp skills` → copy the shipped skills only, no env interview.
 * Keeps a single bin entry instead of shipping parallel scripts.
 * Subcommands must be handled BEFORE the stdio transport opens — the MCP
 * host passes no args, so any argv[2] means a human/CI invoked directly.
 */
async function runSubcommand(name: "doctor" | "init" | "skills"): Promise<void> {
  if (name === "doctor") {
    const mod = await import("./cli/doctor.js");
    await mod.run();
    process.exit(0);
  }
  if (name === "init") {
    const mod = await import("./cli/init.js");
    await mod.run();
    process.exit(0);
  }
  const mod = await import("./cli/skills.js");
  await mod.run(process.argv.slice(3));
  process.exit(0);
}

/**
 * Diagnostic-only server, served when startup failed.
 *
 * A dead process is rendered by an MCP host as "server disconnected" with no
 * reason attached — the one thing the user needs (why) is the one thing they
 * cannot get, and `npx dexe-mcp doctor` may be just as dead. So we stay up with
 * a single hand-rolled tool that hands the failure and its fix back in-band.
 * No config, no toolset gate, no dependencies beyond the SDK: this path has to
 * work when everything else did not.
 */
export function createDegradedServer(err: unknown, envFiles: readonly string[] = []): McpServer {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  const searched = envFiles.length ? ` (searched, in order: ${envFiles.join(", ")})` : "";
  const report =
    "dexe-mcp failed to start. Its DAO tools are NOT registered in this session.\n\n" +
    `WHAT HAPPENED\n${detail}\n\n` +
    "HOW TO FIX\n" +
    "1. Run `npx dexe-mcp doctor` in a terminal — it walks every DEXE_* var and " +
    "prints paste-ready remediation for the offending one.\n" +
    `2. Fix that value in your .env${searched}.\n` +
    "   Vars set in the MCP host config (Claude Code's .claude.json `env` block) " +
    "SHADOW .env — if the value looks right on disk, check there.\n" +
    "3. Restart the MCP host. .env is read once at startup; mid-session edits do nothing.\n\n" +
    `Runtime: Node ${process.versions.node} (dexe-mcp requires >=${MIN_NODE_VERSION}).`;

  const server = new McpServer(
    { name: "dexe-mcp", version: packageVersion() },
    {
      instructions:
        "dexe-mcp failed to start, so none of its DAO tools exist in this session. " +
        "Call dexe_doctor for the startup error and the fix, then relay both to the user — " +
        "do not retry the missing tools.",
    },
  );

  server.registerTool(
    "dexe_doctor",
    {
      title: "dexe-mcp startup diagnostic",
      description:
        "Returns why dexe-mcp failed to start and how to fix it. The server is running in " +
        "degraded mode — this is the only tool available until the cause is fixed and the host restarted.",
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: "text" as const, text: report }] }),
  );

  return server;
}

/** Open the stdio transport for the degraded server. Last line of defence. */
async function startDegraded(err: unknown, envFiles: readonly string[]): Promise<void> {
  try {
    const server = createDegradedServer(err, envFiles);
    await server.connect(new StdioServerTransport());
    process.stderr.write(
      "[dexe-mcp] DEGRADED mode: startup failed, serving dexe_doctor only. " +
        "Call it (or run `npx dexe-mcp doctor`) for the cause and the fix.\n",
    );
  } catch (fatal: unknown) {
    // Even stdio is gone — nothing left to serve the explanation over.
    const msg = fatal instanceof Error ? fatal.stack || fatal.message : String(fatal);
    process.stderr.write(`[dexe-mcp] could not open the degraded transport:\n${msg}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer(
    { name: "dexe-mcp", version: packageVersion() },
    {
      instructions:
        "Tools for DeXe Protocol governance DAOs (plus a generic dexe_gov_* surface for external OpenZeppelin/Compound Governor DAOs). " +
        "For any MULTI-STEP request (create a DAO, launch a token economy, OTC sale, staking, distribution, pass a proposal) call dexe_guide FIRST — it returns the exact plan, the questions to ask the user with risk notes, and the known pitfalls. " +
        "Call dexe_context first WHEN you need orientation (signer, active chain, env readiness, DAOs/proposals from prior sessions) — skip it when the user already gave you the target DAO and chain. " +
        "Prefer the composite flow tools over hand-sequencing calldata: dexe_dao_create (deploy a DAO), dexe_proposal_create (ANY of the 33 catalog proposal types — pass proposalType + params), dexe_proposal_vote_and_execute (auto-deposits when power is short). " +
        "Amounts accept raw wei (digits-only) or human units with a decimal point ('12.5'); durations are seconds. " +
        "For images (DAO avatars): pass a LOCAL FILE PATH (avatarPath / newAvatarPath / filePath) and the server reads, validates, and pins it — never read image files or pass base64 through the conversation. " +
        "The composites handle approve→deposit→create sequencing, correct IPFS metadata, and the known deploy/proposal reverts; on partial failure they return the landed-steps ledger — fix the cause and re-run the same call (completed steps are skipped). " +
        "When depositing, ERC20.approve the UserKeeper, never GovPool. Validate DAO deploys on BSC testnet (chain 97). " +
        "Before any dexe_get_* / dexe_list_contracts / dexe_find_selector, run dexe_compile once per session. " +
        "The tool surface is gated by DEXE_TOOLSETS (default 'core,proposals'); dexe_context reports which sets are off and what they unlock. " +
        "Full intent→call recipes + error→remedy table: docs/PLAYBOOK.md (shipped in the package). " +
        "MCP resources: dexe://playbook (recipes + error remedies), dexe://graph-schema (subgraph entity reference for dexe_graph_query), dexe://tools (full tool catalog). " +
        "Recipe skills ship with the package (dexe-create-dao, dexe-create-proposal, dexe-vote-execute, dexe-otc, dexe-staking, dexe-setup). Installed automatically with the Claude Code plugin (`/plugin install dexe@dexe-mcp`), or copy them standalone with `npx dexe-mcp skills`.",
    },
  );

  registerAll(server, config);

  // Shipped docs as on-demand resources (playbook, graph schema, tool catalog).
  // Kept out of `instructions` so they don't cost tokens every session.
  registerDocResources(server, resolve(__dirname, ".."));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log-only, not protocol. stdout is the MCP channel.
  process.stderr.write(
    `[dexe-mcp] connected on stdio. DEXE_PROTOCOL_PATH=${config.protocolPath}${
      config.rpcUrl ? " (rpc enabled)" : ""
    }\n`,
  );
}

/** Runtime check → .env → CLI subcommands → MCP server (degraded if it throws). */
async function bootstrap(): Promise<void> {
  // Before anything reads .env: on an old runtime the file is ignored outright,
  // so every later "missing var" complaint would point at the wrong cause.
  const versionWarning = nodeVersionWarning(process.versions.node);
  if (versionWarning) process.stderr.write(`[dexe-mcp] warn: ${versionWarning}\n`);

  let envCandidates: readonly string[] = [];
  try {
    envCandidates = loadEnvironment();
  } catch (err: unknown) {
    // Env loading is best-effort by contract; a broken file must never cost the
    // user their tools — process env alone may still be a working config.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dexe-mcp] warn: .env loading failed (${msg}) — using process env only\n`);
  }

  const subcommand = process.argv[2];
  if (subcommand === "doctor" || subcommand === "init" || subcommand === "skills") {
    // A human/CI ran this in a terminal: report and exit, never open a transport.
    await runSubcommand(subcommand);
    return;
  }

  try {
    await main();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`[dexe-mcp] startup failed:\n${msg}\n`);
    await startDegraded(err, envCandidates);
  }
}

// Boot only when this module IS the entrypoint. Tests import it to exercise
// createDegradedServer() directly, and booting on import would attach a
// StdioServerTransport to the test worker's own stdio and pull the repo .env
// into its process.env.
//
// This deliberately keys on the entrypoint rather than on an env var: gating
// the boot on something like VITEST ships that switch inside dist/index.js —
// the published `bin` — so any runtime that happens to set it would exit 0 with
// no output at all, which is the exact silent-death failure mode this release
// exists to remove.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bootstrap();
}
