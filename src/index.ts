#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./tools/index.js";
import { serverInstructions } from "./instructionsWrite.js";
import { registerDocResources } from "./resources.js";
import { homedir } from "node:os";
import { loadEnvFile, writeStartupBanner, resolveEnvCandidates, type EnvLoadReport } from "./env/loader.js";
import { envKeys, FULL_ENV_SURFACE } from "./env/schema.js";
import { debugHint, debugLog, formatDiagnostic } from "./runtime.js";
import {
  MIN_NODE_VERSION,
  installProcessGuards,
  installTransportGuards,
  isMainModule,
  nodeVersionWarning,
} from "./stdioRuntime.js";
import { safeErrorMessage } from "./lib/redact.js";
import { writeDoctorChecks } from "./diag/writeChecks.js";
import { spawn } from "node:child_process";
import { isReadServerEnvKey } from "./http/remoteEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Real package version — the MCP handshake previously hardcoded "0.1.5". */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* ──────────────────────────── CLI argv handling ──────────────────────────── */

/**
 * Subcommands `bootstrap()` dispatches. The dispatch, the usage text and the
 * unknown-argument message all read THIS list — never a second hand-written
 * one, so a fourth subcommand cannot land half-documented.
 */
export const SUBCOMMANDS = ["doctor", "init", "key", "skills", "serve-http"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP_ARGS = new Set(["--help", "-h", "help"]);
const VERSION_ARGS = new Set(["--version", "-v", "-V"]);

/**
 * argv[2] values that an MCP host may append and that must still start the
 * server. Users copy transport flags from other MCP servers' configs; those
 * launch shapes work today, and turning them into "server disconnected, no
 * reason" is exactly the failure 0.30.4 spent a release removing.
 */
const TRANSPORT_PASSTHROUGH = new Set(["--stdio", "--transport=stdio", "--mcp"]);

export type CliIntent =
  | { kind: "server" }
  | { kind: "subcommand"; name: Subcommand }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; arg: string };

/**
 * Pure classification of `process.argv`. An empty/whitespace argv[2] counts as
 * absent: a host config can expand a template to `""` and must still serve.
 */
export function classifyArgv(argv: readonly string[]): CliIntent {
  const raw = argv[2]?.trim();
  if (!raw || TRANSPORT_PASSTHROUGH.has(raw)) return { kind: "server" };
  if ((SUBCOMMANDS as readonly string[]).includes(raw)) return { kind: "subcommand", name: raw as Subcommand };
  if (HELP_ARGS.has(raw)) return { kind: "help" };
  if (VERSION_ARGS.has(raw)) return { kind: "version" };
  return { kind: "unknown", arg: raw };
}

/**
 * Exported for tests — what `dexe-mcp --help` prints. Every SUBCOMMANDS entry
 * MUST appear here; tests/cli/usage.test.ts fails the build otherwise. Never
 * advertise a flag that does not exist: a documented no-op is the same class of
 * bug as a missing help screen.
 */
export function usageText(version: string): string {
  return [
    `dexe-mcp ${version} — MCP server for DeXe Protocol DAO governance`,
    "",
    "USAGE",
    "  dexe-mcp                        start the MCP server on stdio (what your MCP host runs)",
    "  dexe-mcp doctor [--strict]      diagnose env + connectivity; --strict exits 1 on warnings (CI)",
    "        [--probe-pin]             also verify Pinata pin capability (WRITES one tiny pin)",
    "  dexe-mcp init [--skills-only]   interactive onboarding wizard (writes ~/.dexe-mcp/.env)",
    "        [--unattended]            offer the plaintext hot-key option (unattended signing)",
    "  dexe-mcp key <command>          encrypted keystore: create | import [--from-env | --json <file>] |",
    "                                  list | export-address | change-password | remove (`dexe-mcp key --help`)",
    "  dexe-mcp skills [--global]      copy the shipped Claude skills into ./.claude/skills (or ~ with --global)",
    "  dexe-mcp serve-http [--port <n>] [--host <addr>]",
    "                                  the read edition over MCP Streamable HTTP for remote clients (runs",
    "                                  `dexe-mcp-read serve-http`); process env only, no .env (`--help`)",
    "  dexe-mcp --help | --version",
    "",
    "ENV",
    "  .env is read once at startup, from the first of: $DEXE_ENV_FILE, ./.env, ~/.dexe-mcp/.env, <pkgdir>/.env",
    "  Reads work with zero config. Signing and IPFS uploads need keys — run `dexe-mcp init`.",
    "",
    "DOCS  https://github.com/dexe-network/dexe-mcp#readme",
    "",
  ].join("\n");
}

/**
 * Exported for tests. Names the bad token, the valid set, and the remedy —
 * including the host-config remedy, because argv[2] usually got there from a
 * hand-edited "args" array rather than from a shell.
 */
export function unknownArgText(arg: string, version: string): string {
  return (
    `[dexe-mcp] unknown command '${arg}'. ` +
    `dexe-mcp takes no flags when it serves on stdio. Valid subcommands: ${SUBCOMMANDS.join(", ")}.\n` +
    `If an MCP host config passed this, delete it from that server's "args" array and restart the host.\n` +
    `Run \`dexe-mcp --help\` for usage.\n\n` +
    usageText(version)
  );
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
    const report = loadEnvFile(candidate, prevSnapshot, FULL_ENV_SURFACE);
    if (!envReport) envReport = report; // first existing file drives the banner
  }
  // Nothing on disk anywhere — still emit a banner naming the recommended home
  // location so the user knows exactly where to create their config.
  writeStartupBanner(envReport ?? loadEnvFile(homeEnvPath, prevSnapshot, FULL_ENV_SURFACE));
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
async function runSubcommand(name: Exclude<Subcommand, "serve-http">, envFiles: readonly string[] = []): Promise<void> {
  if (name === "doctor") {
    const mod = await import("./cli/doctor.js");
    // Forward argv[3..] the same way the skills branch does. `run()` calls
    // process.exit() itself with the graded code — do NOT "clean that up" into
    // a returned value, or every doctor run exits 0 and CI goes green forever.
    // The read checks plus the write ones (signer, Pinata incl. --probe-pin,
    // WalletConnect), over the full config and env surface: this binary
    // carries both editions.
    await mod.run(process.argv.slice(3), writeDoctorChecks, loadConfig);
    process.exit(0);
  }
  if (name === "init") {
    const mod = await import("./cli/init.js");
    const next = await mod.run();
    // The wizard stays free of key handling (it is shared with the read
    // edition); when the user picked the encrypted key it hands over here.
    if (next === "key-create" || next === "key-import") {
      const key = await import("./cli/key.js");
      process.exit(await key.run([next === "key-create" ? "create" : "import"], { envFiles }));
    }
    process.exit(0);
  }
  if (name === "key") {
    const mod = await import("./cli/key.js");
    process.exit(await mod.run(process.argv.slice(3), { envFiles }));
  }
  const mod = await import("./cli/skills.js");
  await mod.run(process.argv.slice(3));
  process.exit(0);
}

/* ─────────────────────── runtime crash safety (0.30.4) ───────────────────── */

// The Node floor, the process guards and the transport guards live in
// ./stdioRuntime.ts, shared with the read edition's binary (src/read/bin.ts).
export {
  MIN_NODE_VERSION,
  formatCrashReport,
  installProcessGuards,
  installTransportGuards,
  isTransportGoneError,
  nodeVersionWarning,
} from "./stdioRuntime.js";

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
    const transport = new StdioServerTransport();
    installTransportGuards(transport);
    await server.connect(transport);
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
      instructions: serverInstructions(),
    },
  );

  registerAll(server, config);

  // Shipped docs as on-demand resources (playbook, graph schema, tool catalog).
  // Kept out of `instructions` so they don't cost tokens every session.
  registerDocResources(server, resolve(__dirname, ".."));

  const transport = new StdioServerTransport();
  installTransportGuards(transport);
  await server.connect(transport);

  // Log-only, not protocol. stdout is the MCP channel.
  process.stderr.write(
    `[dexe-mcp] connected on stdio. DEXE_PROTOCOL_PATH=${config.protocolPath}${
      config.rpcUrl ? " (rpc enabled)" : ""
    }\n`,
  );

  // The startup facts a field report needs, behind DEXE_DEBUG so a normal
  // session pays nothing. debugLog redacts, so the RPC URL is safe to name.
  debugLog(
    "startup",
    `pid=${process.pid} node=${process.versions.node} version=${packageVersion()} ` +
      `defaultChain=${config.defaultChainId} chains=[${[...config.chains.keys()].join(",")}] ` +
      `rpc=${config.rpcUrl ?? "(none)"} statePath=${config.statePath}`,
  );
}

/**
 * `dexe-mcp serve-http` runs the read edition's HTTP server in a CHILD process
 * (`dexe-mcp-read serve-http`, src/read/bin.ts). Not in this one: this process
 * has already loaded every write module through its static imports, and a
 * public endpoint must carry no code that signs, broadcasts or pins — nor the
 * write wording of error remedies, which those modules register when they
 * load. stdio is inherited (the JSON logs pass through untouched), signals are
 * forwarded, and the child's exit code becomes this one's.
 */
async function delegateServeHttp(args: readonly string[]): Promise<void> {
  // dist/index.js → dist/read/bin.js; under tsx, src/index.ts → src/read/bin.ts.
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const bin = fileURLToPath(new URL(`./read/bin${ext}`, import.meta.url));
  if (!existsSync(bin)) {
    process.stderr.write(
      `[dexe-mcp] serve-http is served by the read edition, which this install does not carry (${bin} is missing). ` +
        "Run `npx -p dexe-mcp dexe-mcp-read serve-http` instead.\n",
    );
    process.exitCode = 2;
    return;
  }
  // Process flags are not inherited: an `--inspect` port would clash with the
  // parent's. Under tsx (development) the loader flags must come along.
  const execArgv = ext === ".ts" ? process.execArgv.filter((a) => !/^--(inspect|debug)/.test(a)) : [];
  // The child gets the read allowlist only — never this process's signing
  // keys or unrelated secrets (it would drop them itself, but they would sit
  // in its environment until then). The IPC channel is how the child notices
  // this process is gone, even after a SIGKILL that runs no handler here.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => isReadServerEnvKey(k)));
  const child = spawn(process.execPath, [...execArgv, bin, "serve-http", ...args], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env,
  });
  const forward = (signal: NodeJS.Signals) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  process.exitCode = await new Promise<number>((done) => {
    child.once("error", (err) => {
      process.stderr.write(`[dexe-mcp] serve-http: could not start the read edition: ${safeErrorMessage(err)}\n`);
      done(1);
    });
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

/** Runtime check → .env → CLI subcommands → MCP server (degraded if it throws). */
async function bootstrap(): Promise<void> {
  const intent = classifyArgv(process.argv);

  // Help / version / a typo are answered from argv ALONE — before
  // nodeVersionWarning and before loadEnvironment(). Two reasons: a help screen
  // must work on a machine whose .env is broken, and writeStartupBanner() names
  // the signer address + keyring, which has no business on a `--version`.
  //
  // `process.exitCode` + return, never process.exit(): stdout to a PIPE is
  // asynchronous on Windows and exit() does not flush it, which would truncate
  // `dexe-mcp --help | more` and make the regression test flaky. Nothing is
  // scheduled at this point (no transport, no process guards, no env load), so
  // the loop drains immediately and the stream flushes.
  if (intent.kind === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    process.exitCode = 0;
    return;
  }
  if (intent.kind === "help") {
    process.stdout.write(usageText(packageVersion()));
    process.exitCode = 0;
    return;
  }
  if (intent.kind === "unknown") {
    process.stderr.write(unknownArgText(intent.arg, packageVersion()));
    process.exitCode = 2;
    return;
  }

  // The remote HTTP server is the read edition's (`dexe-mcp-read serve-http`),
  // configured by process env ONLY — dispatched before loadEnvironment() so no
  // .env file (cwd, home, package dir) can configure a public endpoint or put a
  // signing key into its process.
  if (intent.kind === "subcommand" && intent.name === "serve-http") {
    await delegateServeHttp(process.argv.slice(3));
    return;
  }

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
    process.stderr.write(
      `[dexe-mcp] warn: .env loading failed (${safeErrorMessage(err)}) — using process env only\n`,
    );
  }

  if (intent.kind === "subcommand" && intent.name !== "serve-http") {
    // A human/CI ran this in a terminal: report and exit, never open a
    // transport. Deliberately AFTER loadEnvironment() — `doctor`/`init` need
    // the same env the MCP startup path sees (see the note above it).
    await runSubcommand(intent.name, envCandidates);
    return;
  }

  // From here on the process is long-lived, so a stray rejection anywhere in
  // the tool surface must not take the session with it. Installed AFTER the
  // subcommand dispatch on purpose — `doctor`/`init` keep Node's default
  // die-loudly behaviour, otherwise a failing CLI run would hang.
  installProcessGuards();

  try {
    await main();
  } catch (err: unknown) {
    process.stderr.write(`[dexe-mcp] startup failed:\n${formatDiagnostic(err)}\n${debugHint()}`);
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
//
// Compared through real paths (isMainModule): npm installs the bin as a symlink
// on Linux/macOS, and a string compare against argv[1] never matched there.
if (isMainModule(import.meta.url)) {
  await bootstrap();
}
