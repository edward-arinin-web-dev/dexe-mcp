import { redactUrlCredentials, safeErrorMessage } from "./lib/redact.js";

/* ──────────────────────── diagnostics (DEXE_DEBUG) ───────────────────────── */

/**
 * Opt-in verbose diagnostics, enabled with `DEXE_DEBUG=1`.
 *
 * Why here: this is the one process-level helper module that depends on
 * nothing but node builtins and `lib/redact`, so the startup path
 * (`src/index.ts`) can import it before `loadConfig()` has run, without a cycle.
 *
 * Two invariants, both load-bearing:
 *
 *  1. **stderr only.** stdout is the MCP JSON-RPC channel — one stray line
 *     there corrupts the stream and the host drops the connection.
 *  2. **Always redacted.** ethers v6 appends the full RPC URL, API key and
 *     all, to `err.message` on any non-2xx provider response (401/429/5xx are
 *     routine under load). A debug log is precisely the text a user pastes
 *     into a bug report, so it is the last place that key may appear.
 */

/** Accepted truthy spellings. Anything else (including "0"/"false") is off. */
const DEBUG_TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Read `DEXE_DEBUG` live rather than caching it at import time: `.env` is
 * loaded after this module may already have been imported, and tests flip the
 * var between cases.
 */
export function isDebugEnabled(): boolean {
  const raw = process.env.DEXE_DEBUG?.trim().toLowerCase();
  return raw !== undefined && DEBUG_TRUTHY.has(raw);
}

/**
 * Ceiling on any single diagnostic line. A 200-frame stack helps nobody and
 * floods the host's log pane, which is often the only place the user can read.
 */
const MAX_DIAGNOSTIC_CHARS = 4000;

function clampDiagnostic(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}… [truncated, ${text.length - MAX_DIAGNOSTIC_CHARS} more chars]`;
}

/**
 * Render a caught value as a redacted, bounded diagnostic block.
 *
 * Walks `.cause` (bounded depth): undici and ethers hide the real reason
 * there, so a top-level "fetch failed" on its own explains nothing — the
 * `ECONNREFUSED`/`UND_ERR_CONNECT_TIMEOUT` underneath is the whole answer.
 *
 * Unlike `safeErrorMessage()` (tool results, where brevity matters) this keeps
 * the stack: the audience is stderr and a maintainer, not the model context.
 */
export function formatDiagnostic(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.stack || `${err.name}: ${err.message}`);
    let cause: unknown = (err as { cause?: unknown }).cause;
    for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
      parts.push(
        `  caused by: ${
          cause instanceof Error ? cause.stack || `${cause.name}: ${cause.message}` : safeErrorMessage(cause)
        }`,
      );
      cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
    }
  } else {
    parts.push(describeUnknown(err));
  }
  return clampDiagnostic(redactUrlCredentials(parts.join("\n")));
}

/**
 * Render a value that is not an Error. Never throws.
 *
 * `Promise.reject({ code: -32603, … })` and `throw someObject` are both real —
 * a JSON-RPC error body is the common case — and `String(value)` renders them
 * as "[object Object]", which is worse than saying nothing. Only fall back to
 * JSON when the value carries no message-like field of its own; when it does,
 * safeErrorMessage's redaction path is the better rendering.
 */
function describeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const e = value as { shortMessage?: unknown; message?: unknown };
    const hasMessage =
      (typeof e.shortMessage === "string" && e.shortMessage.length > 0) ||
      (typeof e.message === "string" && e.message.length > 0);
    if (!hasMessage) {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value); // circular, or a BigInt field
      }
    }
  }
  return safeErrorMessage(value);
}

/** Best-effort one-line rendering of a debug payload. Never throws (circular refs). */
function describeDetail(detail: unknown): string {
  if (detail instanceof Error) return formatDiagnostic(detail);
  return describeUnknown(detail);
}

/**
 * Write one verbose diagnostic to stderr — a no-op unless `DEXE_DEBUG` is set.
 *
 * `scope` names the subsystem ("startup", "state", "transport") so a user can
 * grep the host log; `detail` may be an Error, a string, or any JSON-able value.
 */
export function debugLog(scope: string, message: string, detail?: unknown): void {
  if (!isDebugEnabled()) return;
  const suffix = detail === undefined ? "" : ` ${describeDetail(detail)}`;
  process.stderr.write(`${clampDiagnostic(redactUrlCredentials(`[dexe-mcp:debug] ${scope}: ${message}${suffix}`))}\n`);
}

/** One-line nudge appended to failure reports when the user has no verbose output yet. */
export function debugHint(): string {
  return isDebugEnabled()
    ? ""
    : "[dexe-mcp] set DEXE_DEBUG=1 in your .env and restart for verbose diagnostics.\n";
}
