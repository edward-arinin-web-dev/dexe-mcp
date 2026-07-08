import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENV_REGISTRY,
  DYNAMIC_PER_CHAIN_RPC_RE,
  envKeys,
  isKnownEnvKey,
  type EnvKey,
  type EnvEntry,
} from "./schema.js";

/**
 * Diagnostic report produced by `loadEnvFile`. Written to stderr by
 * `writeStartupBanner` and surfaced via `dexe_doctor`.
 */
export interface EnvLoadReport {
  envFilePath: string;
  envFileExists: boolean;
  envFileLoaded: boolean;
  loadedNodeVersion: string;
  /** Raw-byte parse warnings (BOM, missing trailing newline, spaces around =). */
  parseWarnings: string[];
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
  return out;
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
  const parseWarnings: string[] = [];
  const envFileExists = existsSync(envFilePath);
  let envFileLoaded = false;

  if (envFileExists) {
    try {
      const raw = readFileSync(envFilePath);
      // UTF-8 BOM — process.loadEnvFile may misparse the first key.
      if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        parseWarnings.push(
          ".env begins with a UTF-8 BOM — process.loadEnvFile may misparse the first line. " +
            "Re-save the file without BOM.",
        );
      }
      // Missing trailing newline — Node silently drops the last line.
      if (raw.length > 0 && raw[raw.length - 1] !== 0x0a /* \n */) {
        parseWarnings.push(
          ".env does not end with a newline — process.loadEnvFile silently drops the last line. " +
            "Add a trailing newline to fix.",
        );
      }
      // Spaces around `=` produce surprising values.
      const spaceLines: number[] = [];
      raw
        .toString("utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!line || line.trimStart().startsWith("#")) return;
          if (
            /^\s*[A-Za-z_][A-Za-z0-9_]*\s+=/.test(line) ||
            /^\s*[A-Za-z_][A-Za-z0-9_]*=\s/.test(line)
          ) {
            spaceLines.push(i + 1);
          }
        });
      if (spaceLines.length) {
        parseWarnings.push(
          `.env has spaces around \`=\` on line(s) ${spaceLines.join(
            ", ",
          )} — values may include leading/trailing whitespace. Remove the spaces.`,
        );
      }
    } catch (err) {
      parseWarnings.push(
        `.env is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      process.loadEnvFile(envFilePath);
      envFileLoaded = true;
    } catch (err) {
      parseWarnings.push(
        `process.loadEnvFile failed (Node < 21.7 or syntax error): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

  return {
    envFilePath,
    envFileExists,
    envFileLoaded,
    loadedNodeVersion: process.version,
    parseWarnings,
    unknownDexeVars,
    missingButEnablesFlows,
    preExistingVars,
  };
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
    w(`loaded .env from ${report.envFilePath} (Node ${report.loadedNodeVersion})`);
  } else {
    w(`.env present but not loaded — see warnings below`);
  }
  for (const wmsg of report.parseWarnings) {
    w(`warn: ${wmsg}`);
  }
  if (report.unknownDexeVars.length) {
    w(
      `warn: unrecognized DEXE_* vars (typo or deprecated): ${report.unknownDexeVars.join(
        ", ",
      )}. Run dexe_doctor for details.`,
    );
  }
  if (report.preExistingVars.length) {
    w(
      `warn: [${report.preExistingVars.join(", ")}] were set by the MCP host env block ` +
        `and will SHADOW .env. process.loadEnvFile does not override pre-set values. ` +
        `Remove them from .claude.json to use .env values, or update them there. ` +
        `Run dexe_doctor for details.`,
    );
  }
}
