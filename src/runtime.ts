import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { redactUrlCredentials, safeErrorMessage } from "./lib/redact.js";

/**
 * Portable runtime helpers for spawning `npm`, `npx`, `hardhat`, and `git`
 * without depending on the MCP process's PATH.
 *
 * Claude Code (and other MCP clients) spawn servers with a minimal PATH.
 * On Windows in particular, `npm`/`npx` are `.cmd` shims that `CreateProcess`
 * won't find unless they're on that PATH. We side-step the whole problem by
 * invoking JS entry points (`npm-cli.js`, `hardhat/internal/cli/cli.js`)
 * directly through `process.execPath`.
 */

/**
 * Locate a usable `npm-cli.js` on the system.
 *
 * Since `npm-cli.js` is plain JavaScript, any modern `node` binary can run
 * it — we don't need to find the npm that "ships with" the current Node.
 * That matters on stripped Windows installs where `C:\Program Files\nodejs\`
 * contains only `node.exe` (no bundled npm), but another Node (e.g. nvm)
 * has a complete npm install elsewhere.
 *
 * Search order:
 *  1. Next to `process.execPath` (covers sane installs)
 *  2. Platform-specific alternate locations (nvm / nvm-windows / npm prefix)
 *
 * Returns `null` if nothing is found — caller should fall back to shell
 * resolution of `npm` / `npm.cmd`.
 */
export function resolveNpmCli(): string | null {
  const candidates = [...primaryNpmCandidates(), ...alternateNpmCandidates()];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function primaryNpmCandidates(): string[] {
  const execDir = dirname(process.execPath);
  if (platform() === "win32") {
    return [join(execDir, "node_modules", "npm", "bin", "npm-cli.js")];
  }
  return [
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

function alternateNpmCandidates(): string[] {
  const out: string[] = [];
  const home = homedir();
  const os = platform();

  if (os === "win32") {
    // nvm-windows: scan %APPDATA%\nvm\v* for the newest version that ships npm
    const nvmRoots = [
      process.env.NVM_HOME,
      join(process.env.APPDATA || join(home, "AppData", "Roaming"), "nvm"),
    ].filter((p): p is string => !!p && existsSync(p));
    for (const nvmRoot of nvmRoots) {
      try {
        const versions = readdirSync(nvmRoot)
          .filter((d) => d.startsWith("v"))
          .sort()
          .reverse();
        for (const v of versions) {
          out.push(join(nvmRoot, v, "node_modules", "npm", "bin", "npm-cli.js"));
        }
      } catch {
        // ignore — unreadable nvm dir
      }
    }
    // Per-user global prefix
    out.push(
      join(
        process.env.APPDATA || join(home, "AppData", "Roaming"),
        "npm",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    );
    // System-wide stock install (if user later reinstalls without nvm)
    out.push(join("C:\\", "Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"));
  } else {
    // nvm (Unix): scan ~/.nvm/versions/node/v*/lib/node_modules/npm/bin/npm-cli.js
    const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
    const versionsDir = join(nvmDir, "versions", "node");
    if (existsSync(versionsDir)) {
      try {
        const versions = readdirSync(versionsDir)
          .filter((d) => d.startsWith("v"))
          .sort()
          .reverse();
        for (const v of versions) {
          out.push(join(versionsDir, v, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
        }
      } catch {
        // ignore
      }
    }
    // Homebrew
    out.push("/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js");
    out.push("/usr/local/lib/node_modules/npm/bin/npm-cli.js");
  }

  return out;
}

/**
 * Locate Hardhat's CLI entry point inside a protocol checkout.
 * Returns `null` if `node_modules` isn't installed yet.
 */
export function resolveHardhatCli(protocolPath: string): string | null {
  const p = join(protocolPath, "node_modules", "hardhat", "internal", "cli", "cli.js");
  return existsSync(p) ? p : null;
}

/**
 * Given the absolute path to `npm-cli.js`, derive the directory that holds
 * the matching `npm.cmd`/`npx.cmd` (Windows) or `bin/npm`/`bin/npx` (Unix)
 * shims. Returned directory should be **prepended** to the `PATH` of any
 * child process that might invoke `npx` / `npm` internally — most notably
 * `npm run <script>` children whose scripts reference `npx hardhat …`,
 * which is the case for DeXe-Protocol's own `compile` / `coverage` scripts.
 *
 * Returns `null` if `npmCliPath` is `null` or the derived layout is
 * unfamiliar (caller should leave `PATH` untouched).
 */
export function deriveNodeBinDir(npmCliPath: string | null): string | null {
  if (!npmCliPath) return null;
  if (platform() === "win32") {
    // Windows layout:  <nodeRoot>\node_modules\npm\bin\npm-cli.js
    // `.cmd` shims live at `<nodeRoot>\npm.cmd`, `<nodeRoot>\npx.cmd`.
    // dirname x4 peels bin → npm → node_modules → nodeRoot.
    const nodeRoot = dirname(dirname(dirname(dirname(npmCliPath))));
    return existsSync(join(nodeRoot, "npm.cmd")) || existsSync(join(nodeRoot, "npx.cmd"))
      ? nodeRoot
      : null;
  }
  // Unix layouts (official installer / nvm / Homebrew):
  //   <prefix>/lib/node_modules/npm/bin/npm-cli.js
  // Binaries live at `<prefix>/bin/npm` and `<prefix>/bin/npx`.
  // dirname x5 peels bin → npm → node_modules → lib → prefix.
  const prefix = dirname(dirname(dirname(dirname(dirname(npmCliPath)))));
  const binDir = join(prefix, "bin");
  return existsSync(join(binDir, "npx")) || existsSync(join(binDir, "npm")) ? binDir : null;
}

/**
 * Build an `env` object that extends `process.env` with the Node shim
 * directory prepended to `PATH`, so that child processes spawned by
 * `npm run <script>` can resolve `npx` / `npm` even when the MCP server
 * itself was launched by a stripped Node install whose PATH lacks them.
 *
 * Pass the returned env to `execa` / `execFile`. Idempotent — passing
 * a `null` binDir returns the unchanged `process.env`.
 */
export function envWithNodeBinDir(binDir: string | null): NodeJS.ProcessEnv {
  if (!binDir) return { ...process.env };
  const sep = platform() === "win32" ? ";" : ":";
  const existing = process.env.PATH || process.env.Path || "";
  return { ...process.env, PATH: `${binDir}${sep}${existing}` };
}

/** Detect whether `git` is available on PATH. Cached per-process. */
let gitAvailable: boolean | null = null;
export function hasGit(): Promise<boolean> {
  if (gitAvailable !== null) return Promise.resolve(gitAvailable);
  return new Promise((resolvePromise) => {
    execFile("git", ["--version"], { windowsHide: true }, (err) => {
      gitAvailable = !err;
      resolvePromise(gitAvailable);
    });
  });
}

/**
 * Describe the command we'd use to run `npm`.
 *
 * Preferred form: `(process.execPath, [<absolute npm-cli.js>])` — invokes
 * npm through the currently-running Node with zero PATH dependency, and
 * works with `execFile` directly (no `shell: true` required).
 *
 * Fallback: plain `npm` / `npm.cmd` on PATH. The `needsShell` flag tells
 * the caller to set `{ shell: true }` on the spawn options — without it,
 * Node refuses to `execFile` a `.cmd` or `.bat` (CVE-2024-27980 fix), and
 * callers get `spawn EINVAL`.
 */
export function npmCommand(): {
  command: string;
  prefixArgs: string[];
  needsShell: boolean;
  /**
   * Directory containing `npm.cmd`/`npx.cmd` (Windows) or `bin/npm`/`bin/npx`
   * (Unix), paired with the `npm-cli.js` we resolved. Should be prepended
   * to child PATH via `envWithNodeBinDir()` so npm scripts that invoke
   * `npx foo` internally can find it.
   */
  binDir: string | null;
} {
  const cli = resolveNpmCli();
  if (cli) {
    return {
      command: process.execPath,
      prefixArgs: [cli],
      needsShell: false,
      binDir: deriveNodeBinDir(cli),
    };
  }
  return {
    command: platform() === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
    needsShell: platform() === "win32",
    binDir: null,
  };
}

/**
 * Describe the command we'd use to run Hardhat against a given protocol path.
 *
 * Prefers `node <protocolPath>/node_modules/hardhat/internal/cli/cli.js` which
 * has zero PATH dependency. Falls back to `npx hardhat` (requires PATH).
 *
 * Returns `null` if the protocol's `node_modules` isn't installed — caller
 * should trigger `ensureBuildReady` first.
 */
export function hardhatCommand(
  protocolPath: string,
): { command: string; prefixArgs: string[] } | null {
  const cli = resolveHardhatCli(protocolPath);
  if (cli) return { command: process.execPath, prefixArgs: [cli] };
  return null;
}

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
