import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { execFile } from "node:child_process";

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
} {
  const cli = resolveNpmCli();
  if (cli) return { command: process.execPath, prefixArgs: [cli], needsShell: false };
  return {
    command: platform() === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
    needsShell: platform() === "win32",
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
