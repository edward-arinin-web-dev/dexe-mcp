import { formatDiagnostic } from "../runtime.js";
import { parseHttpOptions, serveHttpUsage } from "./options.js";
import { createRpcReadinessProbe, findSharedDefaults, loadRemoteReadConfig } from "./remoteEnv.js";
import { createHttpApp } from "./server.js";
import { createReadServerFactory, useRemoteFailureWording } from "../read/server.js";
import { setRemoteAudience } from "../lib/audience.js";

/**
 * `dexe-mcp-read serve-http` — the read edition over MCP Streamable HTTP
 * (pre-release). Composition root: parse options, reduce the process env to
 * the read allowlist and build the read config from it, wire the read server
 * factory (src/read/server.ts) into the HTTP app, listen, shut down cleanly on
 * SIGTERM. `dexe-mcp serve-http` starts this same entry in a child process
 * (src/index.ts), so the HTTP process never loads write code.
 *
 * Runs BEFORE any .env loading (src/read/bin.ts dispatches it first), so a .env
 * file in the working directory or home never configures a public server.
 *
 * Logs are JSON lines: startup/diagnostics on stderr, the access log on stdout.
 */

function logLine(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

/**
 * A stray rejection or exception in one request must not take every other
 * caller's request down with it. Unlike the stdio guards there is no channel
 * whose loss is fatal here: sockets fail one at a time and Node reports those
 * on the socket, not as uncaught exceptions.
 */
function installHttpProcessGuards(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logLine("error", "unhandled_rejection", { detail: formatDiagnostic(reason) });
  });
  process.on("uncaughtException", (err: unknown) => {
    logLine("error", "uncaught_exception", { detail: formatDiagnostic(err) });
  });
}

export async function runServeHttp(argv: readonly string[], version: string): Promise<void> {
  const parsed = parseHttpOptions(argv, process.env);
  if (parsed.kind === "help") {
    process.stdout.write(serveHttpUsage(version));
    process.exitCode = 0;
    return;
  }
  if (parsed.kind === "error") {
    for (const e of parsed.errors) process.stderr.write(`[dexe-mcp-read] serve-http: ${e}\n`);
    process.stderr.write("[dexe-mcp-read] run `dexe-mcp-read serve-http --help` for the options.\n");
    process.exitCode = 2;
    return;
  }
  const opts = parsed.options;

  const { config, removedEnvCount, configNotes } = await loadRemoteReadConfig();
  for (const msg of configNotes) logLine("info", "config", { msg });

  if (config.chains.size === 0) {
    process.stderr.write(
      "[dexe-mcp-read] serve-http: no RPC endpoint is configured, so every read would fail. " +
        "Set DEXE_RPC_URL_MAINNET (and DEXE_RPC_URL_TESTNET for chain 97).\n",
    );
    process.exitCode = 2;
    return;
  }
  // A public server must not run on what ships in the package and is shared
  // by every install (public RPCs, the baked Graph key, the default backend):
  // its traffic would exhaust quotas and a billable key that are not the
  // operator's. Refuse unless the operator explicitly opts in for local use.
  const shared = findSharedDefaults(config);
  if (shared.length > 0 && !opts.allowSharedDefaults) {
    process.stderr.write("[dexe-mcp-read] serve-http: refusing to start on shared built-in defaults:\n");
    for (const s of shared) process.stderr.write(`  - ${s.what} → set ${s.setVars.join(", ")}\n`);
    process.stderr.write(
      "Set your own endpoints/keys (docs/REMOTE.md), or DEXE_HTTP_ALLOW_SHARED_DEFAULTS=1 for LOCAL TESTING ONLY.\n",
    );
    process.exitCode = 2;
    return;
  }
  if (shared.length > 0) {
    logLine("warn", "shared_defaults", {
      msg: "DEXE_HTTP_ALLOW_SHARED_DEFAULTS=1: running on shared built-in endpoints — local testing only",
      using: shared.map((s) => s.what),
    });
  }

  // Messages a caller of a hosted server can act on: no "set DEXE_… / edit
  // .env / restart" (src/lib/audience.ts), and the remote remedy table.
  setRemoteAudience();
  useRemoteFailureWording();
  let factory: ReturnType<typeof createReadServerFactory>;
  try {
    // Builds the first server: a registration failure is a startup error, not
    // a 500 on every request.
    factory = createReadServerFactory(config, { remote: true, version, maxIdle: opts.maxInflight });
  } catch (err) {
    logLine("error", "startup_failed", { detail: formatDiagnostic(err) });
    process.exitCode = 1;
    return;
  }

  const app = createHttpApp(opts, {
    serverFactory: factory.acquire,
    releaseServer: factory.release,
    readiness: createRpcReadinessProbe(config, opts.readyTimeoutMs),
    version,
    accessLog: opts.accessLog ? undefined : () => undefined,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(opts.port, opts.host, () => {
        app.server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    logLine("error", "listen_failed", { host: opts.host, port: opts.port, detail: formatDiagnostic(err) });
    process.exitCode = 1;
    return;
  }

  installHttpProcessGuards();

  const bound = app.server.address();
  logLine("info", "listening", {
    mode: "serve-http",
    server: "dexe-mcp-read",
    preRelease: true,
    version,
    host: opts.host,
    port: bound && typeof bound === "object" ? bound.port : opts.port,
    endpoint: "/mcp",
    tools: factory.toolNames().length,
    defaultChainId: config.defaultChainId,
    chains: [...config.chains.keys()],
    allowedHosts: opts.allowedHosts ?? "*",
    allowedOrigins: opts.allowedOrigins === null ? "*" : opts.allowedOrigins.length,
    trustProxyHops: opts.trustProxyHops,
    rateLimit: opts.rateLimit,
    maxInflight: opts.maxInflight,
    bodyTimeoutMs: opts.bodyTimeoutMs,
    requestTimeoutMs: opts.requestTimeoutMs,
    // A count, not names: env var names alone can say what else runs on the box.
    removedEnvVars: removedEnvCount,
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logLine("info", "shutdown", { signal, inflight: app.inflight() });
    void app.close(10_000).then(() => process.exit(0));
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
