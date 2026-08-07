import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeErrorMessage } from "../lib/redact.js";
import {
  ENV_REGISTRY,
  DYNAMIC_PER_CHAIN_RPC_RE,
  envKeys,
  isKnownEnvKey,
  type EnvKey,
  type EnvEntry,
} from "./schema.js";

/**
 * A raw-byte trap in the `.env` file. `process.loadEnvFile` reports none of
 * these — it misreads the file and returns normally — so they are detected
 * here and surfaced by the startup banner and `dexe_doctor`.
 */
export interface EnvParseIssue {
  /** Stable slug; doctor renders it as the check id `env.parse.<trap>`. */
  trap:
    | "bom"
    | "no-trailing-newline"
    | "spaces-around-equals"
    | "keys-not-applied"
    | "unreadable"
    | "load-failed";
  /** `fail` only when the key loss is *proven* on the running Node version. */
  severity: "warn" | "fail";
  message: string;
  remediation: string;
}

/**
 * Diagnostic report produced by `loadEnvFile`. Written to stderr by
 * `writeStartupBanner` and surfaced via `dexe_doctor`.
 */
export interface EnvLoadReport {
  envFilePath: string;
  envFileExists: boolean;
  envFileLoaded: boolean;
  loadedNodeVersion: string;
  /** Raw-byte parse traps (BOM, missing trailing newline, spaces around =). */
  parseIssues: EnvParseIssue[];
  /** Every key assigned in the file, in file order, deduped. */
  fileKeys: string[];
  /** File keys whose value actually took effect — nothing had set them yet. */
  keysApplied: string[];
  /**
   * File keys ALREADY present in `process.env` when this file was read.
   * `process.loadEnvFile` does not override, so the file's value is dead text.
   * For the winning file this means the MCP host `env` block shadows `.env`.
   */
  keysShadowed: string[];
  /**
   * File keys that were neither pre-set nor present after loading: the parser
   * did not apply the line at all (BOM on the first key, dropped last line,
   * malformed syntax). Proof of a silent trap rather than a suspicion.
   */
  keysDropped: string[];
  /** DEXE_* vars in process.env that ENV_SPEC does not know about. */
  unknownDexeVars: string[];
  /** Vars that are NOT set but would unlock a common flow if they were. */
  missingButEnablesFlows: Array<{ key: EnvKey; flows: readonly string[] }>;
  /**
   * Schema keys that were already in process.env BEFORE .env was loaded —
   * meaning they were injected by the MCP host (.claude.json env block) and
   * SHADOW the .env file. Subtle precedence trap.
   */
  preExistingVars: EnvKey[];
}

/** Everything the server learned while resolving `.env`, for `dexe_doctor`. */
export interface EnvSourceState {
  /** Paths tried, in precedence order (from `resolveEnvCandidates`). */
  candidates: string[];
  /** One report per path passed to `loadEnvFile`, in load order. */
  reports: EnvLoadReport[];
}

/**
 * Recorded as a side effect of the two functions below, because `src/index.ts`
 * resolves and loads `.env` at module scope — before any tool exists — and
 * doctor runs much later, when the inputs that produced it (the pre-load
 * `process.env`, the launcher's cwd, the package dir) are gone or changed.
 * Re-deriving it there would answer a different question than "what did this
 * server actually load at startup".
 */
let envSourceState: EnvSourceState = { candidates: [], reports: [] };

/** What this process resolved and loaded at startup. */
export function getEnvLoadState(): EnvSourceState {
  return envSourceState;
}

/** Test seam — drop the recorded resolution. */
export function resetEnvLoadState(): void {
  envSourceState = { candidates: [], reports: [] };
}

/**
 * The ordered list of `.env` locations the server tries, deliberately
 * cwd-INDEPENDENT so a plugin launched by an MCP host from an arbitrary working
 * directory — on macOS, Linux, or Windows — still finds the user's config.
 * Callers load each returned path that exists, in order; because
 * `process.loadEnvFile()` never overrides an already-set key, the FIRST file
 * wins per key (and any host-injected OS env beats all files).
 *
 * Order:
 *   1. `explicit` (`$DEXE_ENV_FILE`) — absolute path, for CI/containers/hosts
 *      that can inject one var but not a working directory.
 *   2. `<cwd>/.env`               — dev convenience when run from the repo.
 *   3. `<home>/.dexe-mcp/.env`    — the universal home config (same dir as
 *      `state.json`); works from any folder on any OS. `dexe-mcp init` /
 *      `/dexe-setup` write here for installed (npx/plugin) usage.
 *   4. `<pkgDir>/../.env`         — the npm package dir (npx cache; ~never present).
 *
 * Duplicates are removed so running from the repo (where cwd and pkgDir may
 * resolve to the same file) loads it once.
 */
export function resolveEnvCandidates(opts: {
  cwd: string;
  home: string;
  pkgDir: string;
  explicit?: string;
}): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  const explicit = opts.explicit?.trim();
  if (explicit) push(resolve(explicit));
  push(resolve(opts.cwd, ".env"));
  push(resolve(opts.home, ".dexe-mcp", ".env"));
  push(resolve(opts.pkgDir, "..", ".env"));
  // A fresh resolution supersedes anything recorded before it.
  envSourceState = { candidates: out, reports: [] };
  return out;
}

interface Assignment {
  key: string;
  /** 1-based line number, for paste-ready "fix line N" messages. */
  line: number;
}

/**
 * Line-scan the file for `KEY=` assignments. Values spanning multiple lines
 * (an unclosed quote) are skipped wholesale — treating their inner lines as
 * assignments would invent keys that were never dropped.
 */
function scanAssignments(lines: string[]): { assignments: Assignment[]; spaceLines: number[] } {
  const assignments: Assignment[] = [];
  const spaceLines: number[] = [];
  let openQuote: string | undefined;
  lines.forEach((line, i) => {
    if (openQuote) {
      if (line.includes(openQuote)) openQuote = undefined;
      return;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    // Spaces around `=` survive into the value on some parsers — a JWT with a
    // leading space fails auth in a way nothing else explains.
    if (
      /^\s*[A-Za-z_][A-Za-z0-9_]*\s+=/.test(line) ||
      /^\s*[A-Za-z_][A-Za-z0-9_]*=\s/.test(line)
    ) {
      spaceLines.push(i + 1);
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!m) return;
    assignments.push({ key: m[1]!, line: i + 1 });
    const value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !(value.length > 1 && value.endsWith(quote))) {
      openQuote = quote;
    }
  });
  return { assignments, spaceLines };
}

/**
 * Read .env from disk, scan its raw bytes for common parse-traps, then call
 * `process.loadEnvFile()`. Never throws; surfaces problems via the returned
 * report so the startup banner and doctor can show them.
 *
 * @param envFilePath  absolute path to the .env file
 * @param prevEnvSnapshot  set of DEXE_* keys that were already in
 *   `process.env` before this function runs. Pass an empty set to skip the
 *   precedence-collision check.
 */
export function loadEnvFile(
  envFilePath: string,
  prevEnvSnapshot: ReadonlySet<string>,
): EnvLoadReport {
  const parseIssues: EnvParseIssue[] = [];
  const envFileExists = existsSync(envFilePath);
  let envFileLoaded = false;
  let fileKeys: string[] = [];
  const keysApplied: string[] = [];
  const keysShadowed: string[] = [];
  const keysDropped: string[] = [];

  if (envFileExists) {
    let hasBom = false;
    let missingTrailingNewline = false;
    let firstKey: string | undefined;
    let lastLineKey: string | undefined;
    let spaceLines: number[] = [];

    try {
      const raw = readFileSync(envFilePath);
      hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      // Node's parser stops at the last newline; a final line without one is
      // never seen.
      missingTrailingNewline = raw.length > 0 && raw[raw.length - 1] !== 0x0a; /* \n */
      // Drop the BOM bytes before line-scanning; keep the flag so the trap is
      // still reported.
      const lines = (hasBom ? raw.subarray(3) : raw).toString("utf8").split(/\r?\n/);
      const scan = scanAssignments(lines);
      spaceLines = scan.spaceLines;
      fileKeys = [...new Set(scan.assignments.map(a => a.key))];
      firstKey = scan.assignments[0]?.key;
      if (missingTrailingNewline) {
        lastLineKey = scan.assignments.find(a => a.line === lines.length)?.key;
      }
    } catch (err) {
      parseIssues.push({
        trap: "unreadable",
        severity: "fail",
        message: `${envFilePath} could not be read: ${safeErrorMessage(err)}`,
        remediation: `Check the file's permissions and that it is a regular file, then restart Claude Code.`,
      });
    }

    // Which of the file's keys are already claimed. Captured BEFORE the load:
    // `process.loadEnvFile` does not override, so these values never apply.
    const preSet = new Set(fileKeys.filter(k => process.env[k] !== undefined));

    try {
      process.loadEnvFile(envFilePath);
      envFileLoaded = true;
    } catch (err) {
      parseIssues.push({
        trap: "load-failed",
        severity: "fail",
        message: `${envFilePath} was NOT loaded — process.loadEnvFile threw (Node < 21.7, or a syntax error): ${
          safeErrorMessage(err)
        }`,
        remediation:
          "Upgrade to Node 22 LTS, then check the file for lines that are not `KEY=value`. Restart Claude Code after fixing.",
      });
    }

    // Post-load truth: what the parser actually did with each key.
    for (const k of fileKeys) {
      if (preSet.has(k)) keysShadowed.push(k);
      else if (process.env[k] !== undefined) keysApplied.push(k);
      else keysDropped.push(k);
    }

    if (hasBom) {
      const proven = !!firstKey && keysDropped.includes(firstKey);
      parseIssues.push({
        trap: "bom",
        severity: proven ? "fail" : "warn",
        message: proven
          ? `${envFilePath} starts with a UTF-8 BOM and its first key (${firstKey}) did NOT load — the BOM is glued to the key name.`
          : `${envFilePath} starts with a UTF-8 BOM — process.loadEnvFile can glue it to the first key name.`,
        remediation: `Re-save ${envFilePath} as UTF-8 WITHOUT BOM (VS Code: "Save with Encoding" → "UTF-8"; PowerShell: Set-Content -Encoding utf8NoBOM), then restart Claude Code.`,
      });
    }

    if (missingTrailingNewline) {
      const proven = !!lastLineKey && keysDropped.includes(lastLineKey);
      parseIssues.push({
        trap: "no-trailing-newline",
        severity: proven ? "fail" : "warn",
        message: proven
          ? `${envFilePath} does not end with a newline and its last line (${lastLineKey}=…) was DROPPED by process.loadEnvFile on Node ${process.version}.`
          : `${envFilePath} does not end with a newline${
              lastLineKey ? ` — the last line (${lastLineKey}=…) is at risk` : ""
            }; process.loadEnvFile silently drops the final line on some Node versions.`,
        remediation: `Add a trailing newline to ${envFilePath} (the last line must end with \\n), then restart Claude Code.`,
      });
    }

    if (spaceLines.length) {
      parseIssues.push({
        trap: "spaces-around-equals",
        severity: "warn",
        message: `${envFilePath} has spaces around \`=\` on line(s) ${spaceLines.join(
          ", ",
        )} — Node trims them, but other readers of the same file (shell \`source\`, docker --env-file, older parsers) do not, and a stray space inside a pasted secret is invisible.`,
        remediation: `Write \`KEY=value\` with no spaces around \`=\` on those lines in ${envFilePath}, then restart Claude Code.`,
      });
    }

    // Keys the parser skipped for a reason the two traps above don't explain.
    const explained = new Set(
      [hasBom ? firstKey : undefined, missingTrailingNewline ? lastLineKey : undefined].filter(
        (k): k is string => !!k,
      ),
    );
    const unexplained = keysDropped.filter(k => !explained.has(k));
    if (unexplained.length && envFileLoaded) {
      parseIssues.push({
        trap: "keys-not-applied",
        severity: "fail",
        message: `${envFilePath} assigns ${unexplained.join(
          ", ",
        )} but process.loadEnvFile did not apply ${unexplained.length === 1 ? "it" : "them"} — the line(s) are malformed.`,
        remediation: `Rewrite those lines in ${envFilePath} as plain \`KEY=value\` (no \`export\`, no quotes needed, nothing after the value), then restart Claude Code.`,
      });
    }
  }

  // DEXE_* vars present that we don't recognize (typos, deprecated keys).
  const unknownDexeVars: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("DEXE_")) continue;
    if (DYNAMIC_PER_CHAIN_RPC_RE.test(key)) continue;
    if (!isKnownEnvKey(key)) unknownDexeVars.push(key);
  }

  // Vars NOT set but which would enable a common flow.
  const missingButEnablesFlows: Array<{ key: EnvKey; flows: readonly string[] }> = [];
  for (const [k, v] of Object.entries(ENV_REGISTRY) as [EnvKey, EnvEntry][]) {
    if (!v.enablesFlows?.length) continue;
    if (process.env[k]?.trim()) continue;
    missingButEnablesFlows.push({ key: k, flows: v.enablesFlows });
  }

  // Schema keys present in process.env BEFORE we loaded .env — they came
  // from the MCP host (.claude.json env block) and will shadow .env.
  const preExistingVars: EnvKey[] = envKeys().filter(k => prevEnvSnapshot.has(k));

  const report: EnvLoadReport = {
    envFilePath,
    envFileExists,
    envFileLoaded,
    loadedNodeVersion: process.version,
    parseIssues,
    fileKeys,
    keysApplied,
    keysShadowed,
    keysDropped,
    unknownDexeVars,
    missingButEnablesFlows,
    preExistingVars,
  };

  const seen = envSourceState.reports.findIndex(r => r.envFilePath === envFilePath);
  if (seen >= 0) envSourceState.reports[seen] = report;
  else envSourceState.reports.push(report);

  return report;
}

/**
 * Print a one-banner summary of `loadEnvFile`'s findings to stderr. stdout
 * is the MCP protocol channel — never write to it.
 */
export function writeStartupBanner(report: EnvLoadReport): void {
  const w = (s: string): void => {
    process.stderr.write(`[dexe-mcp] ${s}\n`);
  };
  if (!report.envFileExists) {
    w(`no .env at ${report.envFilePath} — using process env only`);
  } else if (report.envFileLoaded) {
    w(
      `loaded .env from ${report.envFilePath} — ${report.keysApplied.length} key(s) applied (Node ${report.loadedNodeVersion})`,
    );
  } else {
    w(`.env present but not loaded — see warnings below`);
  }
  for (const issue of report.parseIssues) {
    w(`${issue.severity}: ${issue.message} ${issue.remediation}`);
  }
  if (report.unknownDexeVars.length) {
    w(
      `warn: unrecognized DEXE_* vars (typo or deprecated): ${report.unknownDexeVars.join(
        ", ",
      )}. Run dexe_doctor for details.`,
    );
  }
  if (report.keysShadowed.length) {
    w(
      `warn: [${report.keysShadowed.join(", ")}] are set in ${report.envFilePath} but were ` +
        `ALREADY set in the environment, so the file's values were ignored — ` +
        `process.loadEnvFile does not override pre-set values. Remove them from the MCP host ` +
        `env block (.claude.json) to use the .env values, or update them there. ` +
        `Run dexe_doctor for details.`,
    );
  }
}
