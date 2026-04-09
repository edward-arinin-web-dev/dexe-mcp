import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
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
 * Locate the `npm-cli.js` that ships with the currently-running Node.
 *
 * Layouts we handle:
 *  - Windows (official installer / nvm-windows):
 *      <execDir>\node_modules\npm\bin\npm-cli.js
 *  - Unix (nvm, homebrew, official installer):
 *      <execDir>/../lib/node_modules/npm/bin/npm-cli.js
 *
 * Returns `null` if nothing is found — caller should fall back to `npm` on PATH.
 */
export function resolveNpmCli(): string | null {
  const execDir = dirname(process.execPath);
  const candidates =
    platform() === "win32"
      ? [join(execDir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          join(execDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
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
 * Describe the PATH-independent command we'd use to run `npm` / `npx`.
 * Returns the `[command, prefixArgs]` tuple so callers can append script args.
 *
 * If `npm-cli.js` is found, we return `(process.execPath, [cliPath])`.
 * Otherwise we fall back to `("npm", [])` which requires PATH — and may fail
 * on machines where npm isn't on the spawn PATH, but that's strictly better
 * than crashing at startup.
 */
export function npmCommand(): { command: string; prefixArgs: string[] } {
  const cli = resolveNpmCli();
  if (cli) return { command: process.execPath, prefixArgs: [cli] };
  return { command: platform() === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
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
