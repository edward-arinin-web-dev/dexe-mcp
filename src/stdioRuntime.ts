import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Is the module at `moduleUrl` the process entrypoint (`process.argv[1]`)?
 *
 * npm installs a package's bins on Linux and macOS as SYMLINKS
 * (`node_modules/.bin/dexe-mcp`, `/usr/local/bin/dexe-mcp`), so `argv[1]` is
 * the link while `import.meta.url` is the resolved file. From 0.30.1 to 0.36.0
 * the entrypoint check compared the two as strings and never matched there:
 * every `npx dexe-mcp` and global install off Windows exited 0 without serving
 * (and without printing `--version` / `--help`). Windows bins are `.cmd` shims
 * that pass the real path, and the plugin runs `node <file>`, so neither saw it.
 *
 * Compare real paths instead; fall back to the plain URL compare first so the
 * common case needs no filesystem call.
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
