#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@dexe-network/dexe-mcp/core";
import { runReadBin } from "@dexe-network/dexe-mcp/bin";

/**
 * `dexe-mcp-read` — the read edition's binary, as this package ships it.
 *
 * The read edition is @dexe-network/dexe-mcp: its stdio server, `serve-http`
 * and the usage text are that package's (`runReadBin`, which starts nothing
 * until called). This file gives it a bin entry here (package.json "bin"), is
 * what `dexe-mcp serve-http` spawns (src/index.ts), and tells it two things
 * about this install: the version to report (this package's, as before the
 * read code moved out) and where the install's `.env` candidate is
 * (`<dist>/../.env`, as for `dexe-mcp`). It imports no src/ module, so it
 * carries no write code (tests/read/module-graph.test.ts).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** package.json is two levels up from src/read/ (tsx) and dist/read/ (built). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (isMainModule(import.meta.url)) {
  await runReadBin(process.argv, { version: packageVersion(), pkgDir: resolve(__dirname, "..") });
}
