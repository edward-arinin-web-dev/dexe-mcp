import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

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
  // Linux / others — respect XDG_CACHE_HOME
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, CACHE_DIR_NAME);
}

function log(msg: string): void {
  process.stderr.write(`[dexe-mcp] ${msg}\n`);
}

function runSync(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Ensures a DeXe-Protocol checkout is available, returning its absolute path.
 *
 * Priority:
 *  1. `DEXE_PROTOCOL_PATH` env var (power-user override)
 *  2. Auto-managed clone in the platform cache directory
 *
 * On first run the clone + npm install may take a few minutes.
 * Progress is logged to stderr (stdout is the MCP protocol channel).
 */
export async function ensureProtocolCheckout(): Promise<string> {
  // ---- explicit override ----
  const explicit = process.env.DEXE_PROTOCOL_PATH?.trim();
  if (explicit) return explicit;

  // ---- auto-managed clone ----
  const cacheDir = getCacheDir();
  const protocolPath = join(cacheDir, CHECKOUT_DIR);

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const gitDir = join(protocolPath, ".git");

  if (!existsSync(gitDir)) {
    log(`Cloning DeXe-Protocol (shallow, ~200 MB) into ${protocolPath} …`);
    log("This only happens once. Subsequent launches will be instant.");
    try {
      runSync(
        `git clone --depth 1 ${REPO_URL} "${CHECKOUT_DIR}"`,
        cacheDir,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to clone DeXe-Protocol. Make sure git is installed and you have internet access.\n${msg}`,
      );
    }
    log("Clone complete.");
  }

  // Ensure npm dependencies are installed
  const nodeModules = join(protocolPath, "node_modules");
  if (!existsSync(nodeModules)) {
    log("Installing DeXe-Protocol npm dependencies (first run only) …");
    try {
      runSync("npm install", protocolPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `npm install failed in DeXe-Protocol checkout.\n${msg}`,
      );
    }
    log("Dependencies installed.");
  }

  return protocolPath;
}
