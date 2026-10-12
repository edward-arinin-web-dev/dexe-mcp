import { formatDiagnostic } from "../runtime.js";
import { parseHttpOptions, serveHttpUsage } from "./options.js";
import { createRpcReadinessProbe, createInterimReadServerFactory, loadRemoteReadConfig } from "./readServer.js";
import { createHttpApp } from "./server.js";

/**
 * `dexe-mcp serve-http` — EXPERIMENTAL. Composition root for the remote read
 * server: parse options, build the read-only config from process env, wire the
 * interim factory into the HTTP app, listen, shut down cleanly on SIGTERM.
 *
 * Runs BEFORE the stdio path's .env loading (see src/index.ts bootstrap), so a
 * .env file in the working directory or home never configures a public server.
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
    for (const e of parsed.errors) process.stderr.write(`[dexe-mcp] serve-http: ${e}\n`);
    process.stderr.write("[dexe-mcp] run `dexe-mcp serve-http --help` for the options.\n");
    process.exitCode = 2;
    return;
  }
  const opts = parsed.options;

  const { config, scrubbedEnv, configNotes } = await loadRemoteReadConfig();
  for (const msg of configNotes) logLine("info", "config", { msg });
  const read = createInterimReadServerFactory(config, version);
  try {
    // Build once up front: a registration failure is a startup error, not a
    // 500 on every request.
    await read.factory();
  } catch (err) {
    logLine("error", "startup_failed", { detail: formatDiagnostic(err) });
    process.exitCode = 1;
    return;
  }

  const app = createHttpApp(opts, {
    serverFactory: read.factory,
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
    experimental: true,
    version,
    host: opts.host,
    port: bound && typeof bound === "object" ? bound.port : opts.port,
    endpoint: "/mcp",
    tools: read.toolNames().length,
    defaultChainId: config.defaultChainId,
    chains: [...config.chains.keys()],
    allowedHosts: opts.allowedHosts ?? "*",
    allowedOrigins: opts.allowedOrigins === null ? "*" : opts.allowedOrigins.length,
    trustProxyHops: opts.trustProxyHops,
    rateLimit: opts.rateLimit,
    maxInflight: opts.maxInflight,
    requestTimeoutMs: opts.requestTimeoutMs,
    // Names only — these keys were present and have been removed from the env.
    ignoredWriteSideEnv: scrubbedEnv,
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
