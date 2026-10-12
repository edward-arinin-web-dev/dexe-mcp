import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { debugHint, debugLog, formatDiagnostic } from "./runtime.js";

/**
 * ── What a long-lived stdio MCP server needs to stay up and say why ─────────
 *
 * Shared by both binaries: `dexe-mcp` (src/index.ts, which re-exports these
 * for its tests and callers) and `dexe-mcp-read` (src/read/bin.ts). Every
 * message is prefixed with the binary's own label.
 */

/**
 * `process.loadEnvFile()` — the ONLY way this server reads a .env file —
 * landed in Node 20.12.0. On 20.0–20.11 it does not exist, the .env is skipped
 * without a word, and the user ends up with a fully unconfigured server and no
 * idea why. Keep in sync with `engines.node` in package.json.
 */
export const MIN_NODE_VERSION = "20.12.0";

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

/**
 * Is the module at `moduleUrl` the process entrypoint?
 *
 * Compared through realpath, not as strings. npm installs a bin on Linux and
 * macOS as a SYMLINK (`node_modules/.bin/dexe-mcp`, `/usr/local/bin/dexe-mcp`)
 * to the package's file: `process.argv[1]` keeps the link's path while
 * `import.meta.url` is the resolved file, so a string compare said "not the
 * entrypoint" and the binary exited 0 having done nothing — no server, no
 * `--version`, no `--help` — for every npx and global install off Windows
 * (0.30.1 – 0.36.0; Windows bins are `.cmd` shims that pass the real path).
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/* ─────────────────────── runtime crash safety (0.30.4) ───────────────────── */

/**
 * Is this failure one we cannot serve through?
 *
 * The stdio pipe being gone is the whole list. Once stdout is closed there is
 * no channel left to explain anything over, and every subsequent write throws
 * the same error — staying up would just spin. Everything else keeps the
 * server alive: the request that triggered it has already failed on its own,
 * and the next call is far more likely to succeed than a dead server is.
 */
export function isTransportGoneError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/**
 * The stderr block emitted for a process-level failure.
 *
 * An MCP host renders a dead server as "server disconnected" with no reason
 * attached — the user loses the tools AND the explanation. So we say what
 * happened, whether we survived it, and where to get more detail. The
 * diagnostic is redacted: `formatDiagnostic()` strips credentialed RPC URLs,
 * which ethers appends verbatim to error messages on any non-2xx response.
 */
export function formatCrashReport(kind: string, err: unknown, fatal: boolean, label = "dexe-mcp"): string {
  const verdict = fatal
    ? "the stdio channel is gone, so the server is shutting down"
    : "the server is STILL RUNNING — the call that triggered this already failed, so retry it";
  return (
    `[${label}] ${kind} — ${verdict}.\n` +
    `${formatDiagnostic(err)}\n` +
    debugHint()
  );
}

/** Minimal shape of the emitter the guards attach to — `process`, or a fake in tests. */
type GuardEmitter = { on(event: string, listener: (...args: never[]) => void): unknown };

/** Guards are process-global; installing twice would double every report. */
let processGuardsInstalled = false;

/**
 * Keep the server alive through the failures that used to kill it silently.
 *
 * Node exits on an unhandled rejection (>= 15) and on an uncaught exception,
 * and neither prints anything the MCP host relays — the user just sees the
 * server vanish. This is the same silent-death class 0.30.1 removed from the
 * startup path; these handlers remove it from the *running* path.
 *
 * Deliberately install-once and only on the long-lived server path: the
 * `doctor`/`init` subcommands must keep Node's default "print and exit
 * non-zero" behaviour, or a broken CLI run would hang instead of failing.
 *
 * Every dependency is injectable so tests can drive the handlers without
 * touching the real process.
 */
export function installProcessGuards(
  opts: {
    emitter?: GuardEmitter;
    write?: (line: string) => void;
    exit?: (code: number) => void;
    label?: string;
  } = {},
): void {
  const usingRealProcess = !opts.emitter;
  if (usingRealProcess) {
    if (processGuardsInstalled) return;
    processGuardsInstalled = true;
  }
  const emitter = opts.emitter ?? (process as unknown as GuardEmitter);
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const label = opts.label ?? "dexe-mcp";

  emitter.on("unhandledRejection", ((reason: unknown) => {
    // Always survivable: a rejected promise cannot have corrupted the
    // interpreter, and whatever awaited it has already surfaced its own error.
    write(formatCrashReport("unhandled promise rejection", reason, false, label));
  }) as (...args: never[]) => void);

  emitter.on("uncaughtException", ((err: unknown) => {
    const fatal = isTransportGoneError(err);
    write(formatCrashReport("uncaught exception", err, fatal, label));
    // Exit 0, not 1: a closed pipe means the host went away, which is a normal
    // end of session, not a server failure worth flagging in the host's UI.
    if (fatal) exit(0);
  }) as (...args: never[]) => void);

  // Node's own warnings (deprecations, MaxListenersExceeded, unsettled
  // promises) are invisible in most hosts. Surface them only under DEXE_DEBUG,
  // where the user has already asked for noise.
  emitter.on("warning", ((warning: unknown) => {
    debugLog("node-warning", "node emitted a process warning", warning);
  }) as (...args: never[]) => void);
}

/**
 * Wire the transport's out-of-band callbacks.
 *
 * The SDK reports transport-level trouble through `onerror`/`onclose` and does
 * nothing with them when they are unset: a malformed frame was swallowed, and
 * a host that closed stdin left this process running with nobody on the other
 * end — a stray socket or pending timer is enough to keep the event loop alive
 * forever, which is how orphaned `node` processes pile up.
 *
 * Safe to call before `server.connect()`: `Protocol.connect()` captures the
 * handlers already on the transport and chains its own behind them, so ours
 * run first and the SDK's still run.
 */
export function installTransportGuards(
  transport: { onerror?: (error: Error) => void; onclose?: () => void },
  opts: { write?: (line: string) => void; exit?: (code: number) => void; label?: string } = {},
): void {
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const label = opts.label ?? "dexe-mcp";

  transport.onerror = (err: Error) => {
    // Non-fatal by the SDK's own contract ("errors are not necessarily
    // fatal") — one bad frame must not cost the user their session.
    write(`[${label}] transport error (session continues):\n${formatDiagnostic(err)}\n${debugHint()}`);
  };

  transport.onclose = () => {
    write(`[${label}] stdio transport closed by the host — shutting down.\n`);
    // Deferred one loop turn: the SDK's own onclose is chained behind this one
    // and is what rejects the in-flight requests. Exiting inline would skip
    // that cleanup and truncate the line above on a piped stderr.
    setImmediate(() => exit(0));
  };
}
