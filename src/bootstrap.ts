import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasGit, npmCommand } from "./runtime.js";

const execFileAsync = promisify(execFile);

const REPO_URL = "https://github.com/dexe-network/DeXe-Protocol.git";
const CACHE_DIR_NAME = "dexe-mcp";
const CHECKOUT_DIR = "DeXe-Protocol";

/**
 * Returns the platform-appropriate cache directory for dexe-mcp.
 *
 * - Windows: %LOCALAPPDATA%/dexe-mcp
 * - macOS:   ~/Library/Caches/dexe-mcp
 * - Linux:   ~/.cache/dexe-mcp (XDG_CACHE_HOME if set)
 */
function getCacheDir(): string {
  const os = platform();
  if (os === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, CACHE_DIR_NAME);
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Caches", CACHE_DIR_NAME);
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, CACHE_DIR_NAME);
}

function log(msg: string): void {
  process.stderr.write(`[dexe-mcp] ${msg}\n`);
}

/**
 * Cheap, synchronous resolution of where the DeXe-Protocol checkout *should*
 * live. **Does not** clone or install anything — safe to call at MCP startup.
 *
 * Priority:
 *  1. `DEXE_PROTOCOL_PATH` env var (power-user override)
 *  2. Auto-managed path inside the platform cache directory
 *
 * The returned path may not exist yet on disk. Call `ensureBuildReady()`
 * before invoking tools that require hardhat.
 */
export function resolveProtocolPath(): string {
  const explicit = process.env.DEXE_PROTOCOL_PATH?.trim();
  if (explicit) return explicit;
  return join(getCacheDir(), CHECKOUT_DIR);
}

/**
 * True if `protocolPath` looks like a hardhat project with installed deps.
 * Used by build/test tools to short-circuit the lazy bootstrap.
 */
export function isBuildReady(protocolPath: string): boolean {
  if (!existsSync(protocolPath)) return false;
  const hasConfig =
    existsSync(join(protocolPath, "hardhat.config.js")) ||
    existsSync(join(protocolPath, "hardhat.config.ts"));
  const hasNodeModules = existsSync(join(protocolPath, "node_modules"));
  return hasConfig && hasNodeModules;
}

// Promise-coalescing: if two tools call ensureBuildReady() concurrently,
// they should share a single clone+install, not race.
let inflightEnsure: Promise<void> | null = null;

/**
 * Lazy, expensive bootstrap: ensures a DeXe-Protocol checkout exists at
 * `protocolPath` and that its npm dependencies are installed. Idempotent.
 *
 * Only called from build/test tools. MCP startup must **not** await this.
 *
 * Skipped entirely when `DEXE_PROTOCOL_PATH` points at a user-managed
 * checkout — we trust the user to keep it in shape.
 *
 * Throws with an actionable message if `git` or `npm` are unavailable.
 */
export async function ensureBuildReady(protocolPath: string): Promise<void> {
  if (isBuildReady(protocolPath)) return;
  if (inflightEnsure) return inflightEnsure;

  inflightEnsure = (async () => {
    try {
      const explicit = process.env.DEXE_PROTOCOL_PATH?.trim();

      if (explicit) {
        // User-managed checkout: don't touch it. Give a clear diagnosis.
        if (!existsSync(protocolPath)) {
          throw new Error(
            `DEXE_PROTOCOL_PATH points at ${protocolPath}, but that directory does not exist.`,
          );
        }
        if (
          !existsSync(join(protocolPath, "hardhat.config.js")) &&
          !existsSync(join(protocolPath, "hardhat.config.ts"))
        ) {
          throw new Error(
            `DEXE_PROTOCOL_PATH=${protocolPath} is not a Hardhat project (no hardhat.config.{js,ts}).`,
          );
        }
        if (!existsSync(join(protocolPath, "node_modules"))) {
          throw new Error(
            `DEXE_PROTOCOL_PATH=${protocolPath} is missing node_modules. Run \`npm install\` there once and retry.`,
          );
        }
        return;
      }

      // Auto-managed cache path: we own it, we can clone + install into it.
      const cacheDir = getCacheDir();
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

      if (!existsSync(join(protocolPath, ".git"))) {
        if (!(await hasGit())) {
          throw new Error(
            "`git` is not on PATH. Install git (https://git-scm.com/downloads) and retry — dexe-mcp needs it to fetch the DeXe-Protocol sources on first run.",
          );
        }
        log(`Cloning DeXe-Protocol (shallow, ~200 MB) into ${protocolPath} …`);
        log("This only happens once. Subsequent calls will be instant.");
        try {
          await execFileAsync(
            "git",
            ["clone", "--depth", "1", REPO_URL, CHECKOUT_DIR],
            { cwd: cacheDir, windowsHide: true },
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to clone DeXe-Protocol. Check internet access and git credentials.\n${msg}`,
          );
        }
        log("Clone complete.");
      }

      if (!existsSync(join(protocolPath, "node_modules"))) {
        log("Installing DeXe-Protocol npm dependencies (first run only) — this takes a few minutes …");
        const npm = npmCommand();
        try {
          await execFileAsync(
            npm.command,
            [...npm.prefixArgs, "install", "--no-audit", "--no-fund"],
            {
              cwd: protocolPath,
              windowsHide: true,
              maxBuffer: 64 * 1024 * 1024,
            },
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `\`npm install\` failed inside ${protocolPath}.\n` +
              `If your Node install lacks a bundled npm (e.g. a stripped node.exe), ` +
              `install Node from https://nodejs.org or via nvm and retry.\n${msg}`,
          );
        }
        log("Dependencies installed.");
      }
    } finally {
      inflightEnsure = null;
    }
  })();

  return inflightEnsure;
}
