#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadReadConfig } from "../configRead.js";
import { loadEnvFile, resolveEnvCandidates, writeStartupBanner, type EnvLoadReport } from "../env/loader.js";
import { dropWriteEnv, READ_ENV_SURFACE } from "../env/schemaRead.js";
import { READ_TOOLS } from "../editions.js";
import { runServeHttp } from "../http/cli.js";
import { safeErrorMessage } from "../lib/redact.js";
import { debugHint, debugLog, formatDiagnostic } from "../runtime.js";
import { installProcessGuards, installTransportGuards, isMainModule, nodeVersionWarning } from "../stdioRuntime.js";
import { createReadServer, READ_SERVER_NAME } from "./server.js";

/**
 * `dexe-mcp-read` — the read edition's binary.
 *
 *   dexe-mcp-read               MCP server on stdio (what an MCP host runs)
 *   dexe-mcp-read serve-http    the same tools over Streamable HTTP, for remote clients
 *
 * Read-only by construction: it imports read modules only (the import walk in
 * tests/read/module-graph.test.ts fails on any path to write code), it never
 * constructs a wallet, and it keeps nothing between calls.
 *
 * stdio loads `.env` the way `dexe-mcp` does (the same candidate files), then
 * deletes every write-edition var — a `.env` shared with the write edition
 * holds signing keys, and a read-only process has no use for them. `serve-http`
 * loads no `.env` at all.
 */

const LABEL = READ_SERVER_NAME;
const __dirname = dirname(fileURLToPath(import.meta.url));

/** package.json is two levels up from src/read/ (tsx) and dist/read/ (built). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* ──────────────────────────── CLI argv handling ──────────────────────────── */

export const READ_SUBCOMMANDS = ["serve-http"] as const;

/** argv[2] values an MCP host may append that must still start the stdio server. */
const TRANSPORT_PASSTHROUGH = new Set(["--stdio", "--transport=stdio", "--mcp"]);

export type ReadCliIntent =
  | { kind: "server" }
  | { kind: "serve-http" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; arg: string };

export function classifyReadArgv(argv: readonly string[]): ReadCliIntent {
  const raw = argv[2]?.trim();
  if (!raw || TRANSPORT_PASSTHROUGH.has(raw)) return { kind: "server" };
  if (raw === "serve-http") return { kind: "serve-http" };
  if (raw === "--help" || raw === "-h" || raw === "help") return { kind: "help" };
  if (raw === "--version" || raw === "-v" || raw === "-V") return { kind: "version" };
  return { kind: "unknown", arg: raw };
}

export function readUsageText(version: string): string {
  return [
    `dexe-mcp-read ${version} — read-only MCP server for DeXe Protocol DAO data`,
    "",
    "USAGE",
    "  dexe-mcp-read                     start the MCP server on stdio (what your MCP host runs)",
    "  dexe-mcp-read serve-http [--port <n>] [--host <addr>]",
    "                                    serve the same tools over MCP Streamable HTTP for remote",
    "                                    clients; process env only, no .env (`dexe-mcp-read serve-http --help`)",
    "  dexe-mcp-read --help | --version",
    "",
    `TOOLS  ${READ_TOOLS.length} read-only tools: DAOs, proposals, votes, treasury, members, delegation,`,
    "       validators, token sales, staking, external Governors. Nothing signs, sends or stores.",
    "",
    "ENV",
    "  Works with zero config. stdio reads .env once at startup, from the first of: $DEXE_ENV_FILE,",
    "  ./.env, ~/.dexe-mcp/.env; signing and upload keys in it are ignored and dropped.",
    "  Variables: docs/ENVIRONMENT.md.",
    "",
    "DOCS  https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/REMOTE.md",
    "",
  ].join("\n");
}

function unknownArgText(arg: string, version: string): string {
  return (
    `[${LABEL}] unknown command '${arg}'. dexe-mcp-read takes no flags when it serves on stdio; ` +
    `its one subcommand is serve-http.\n` +
    `If an MCP host config passed this, delete it from that server's "args" array and restart the host.\n\n` +
    readUsageText(version)
  );
}

/* ──────────────────────────────── stdio ─────────────────────────────────── */

/**
 * Load every `.env` candidate that exists (first file wins per key; a value the
 * MCP host already set wins over every file), print the banner, then drop the
 * write-edition vars from the process. Returns the candidates for the degraded
 * report.
 */
function loadLocalEnvironment(): string[] {
  const prevSnapshot = new Set<string>(Object.keys(READ_ENV_SURFACE.spec).filter((k) => !!process.env[k]?.trim()));
  const candidates = resolveEnvCandidates({
    cwd: process.cwd(),
    home: homedir(),
    pkgDir: resolve(__dirname, ".."),
    explicit: process.env.DEXE_ENV_FILE,
  });
  let first: EnvLoadReport | undefined;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const report = loadEnvFile(candidate, prevSnapshot, READ_ENV_SURFACE);
    first ??= report;
  }
  writeStartupBanner(first ?? loadEnvFile(resolve(homedir(), ".dexe-mcp", ".env"), prevSnapshot, READ_ENV_SURFACE));
  const dropped = dropWriteEnv();
  if (dropped > 0) debugLog("startup", `dropped ${dropped} write-edition env var(s); this server never reads them`);
  return candidates;
}

/** A one-tool server that says why startup failed — an MCP host shows a dead server as "disconnected", with no reason. */
function createDegradedReadServer(err: unknown, version: string): McpServer {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  const report =
    "dexe-mcp-read failed to start, so its tools are NOT registered in this session.\n\n" +
    `WHAT HAPPENED\n${detail}\n\n` +
    "Fix the cause (the startup log on stderr has the details), then restart the MCP host.";
  const server = new McpServer(
    { name: READ_SERVER_NAME, version },
    {
      instructions:
        "dexe-mcp-read failed to start, so none of its tools exist in this session. Call dexe_doctor for the " +
        "startup error, then relay it to the user — do not retry the missing tools.",
    },
  );
  server.registerTool(
    "dexe_doctor",
    {
      title: "Startup diagnostic",
      description: "Returns why dexe-mcp-read failed to start.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => ({ content: [{ type: "text" as const, text: report }] }),
  );
  return server;
}

async function serveStdio(version: string): Promise<void> {
  const warning = nodeVersionWarning(process.versions.node);
  if (warning) process.stderr.write(`[${LABEL}] warn: ${warning}\n`);
  try {
    loadLocalEnvironment();
  } catch (err) {
    // Best-effort by contract: process env alone may still be a working config.
    process.stderr.write(`[${LABEL}] warn: .env loading failed (${safeErrorMessage(err)}) — using process env only\n`);
  }
  installProcessGuards({ label: LABEL });

  let server: McpServer;
  try {
    const config = await loadReadConfig();
    if (config.toolsets.length > 0) {
      process.stderr.write(`[${LABEL}] DEXE_TOOLSETS is not used by this server — all ${READ_TOOLS.length} read tools are served.\n`);
    }
    server = createReadServer(config, { remote: false, version });
    debugLog(
      "startup",
      `pid=${process.pid} node=${process.versions.node} version=${version} defaultChain=${config.defaultChainId} ` +
        `chains=[${[...config.chains.keys()].join(",")}]`,
    );
  } catch (err) {
    process.stderr.write(`[${LABEL}] startup failed:\n${formatDiagnostic(err)}\n${debugHint()}`);
    server = createDegradedReadServer(err, version);
  }

  const transport = new StdioServerTransport();
  installTransportGuards(transport, { label: LABEL });
  await server.connect(transport);
  process.stderr.write(`[${LABEL}] connected on stdio — read-only, ${READ_TOOLS.length} tools.\n`);
}

/* ─────────────────────────────── bootstrap ──────────────────────────────── */

export async function runReadBin(argv: readonly string[] = process.argv): Promise<void> {
  const version = packageVersion();
  const intent = classifyReadArgv(argv);
  // Answered from argv alone, before any env is read. `exitCode` + return, not
  // process.exit(): a piped stdout must flush (see src/index.ts).
  if (intent.kind === "version") {
    process.stdout.write(`${version}\n`);
    process.exitCode = 0;
    return;
  }
  if (intent.kind === "help") {
    process.stdout.write(readUsageText(version));
    process.exitCode = 0;
    return;
  }
  if (intent.kind === "unknown") {
    process.stderr.write(unknownArgText(intent.arg, version));
    process.exitCode = 2;
    return;
  }
  if (intent.kind === "serve-http") {
    // Process env only: dispatched before any .env is loaded.
    await runServeHttp(argv.slice(3), version);
    return;
  }
  await serveStdio(version);
}

// Boot only when this module IS the entrypoint (tests import it). Through
// realpath: an npm bin on Linux/macOS is a symlink (see isMainModule).
if (isMainModule(import.meta.url)) {
  await runReadBin();
}
