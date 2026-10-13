#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@dexe-network/dexe-mcp/core";
import { runReadBin } from "@dexe-network/dexe-mcp/bin";

/**
 * The read server (`dexe-mcp-read`) as this install starts it.
 *
 * The read edition is @dexe-network/dexe-mcp: its stdio server, `serve-http`
 * and the usage text are that package's (`runReadBin`, which starts nothing
 * until called). Since 1.0.0 this file is NOT a package.json "bin" — that name
 * belongs to @dexe-network/dexe-mcp, and two packages declaring one bin collide
 * on a global install (EEXIST). It is what `dexe-mcp serve-http` spawns
 * (src/index.ts), the `dexe-read` server `dexe-mcp init` prints, and the entry
 * the plugin bundles into dexe-plugin/server/read/bin.mjs. It tells the binary
 * two things about this install: the version to report (this package's, as
 * before the read code moved out) and where the install's `.env` candidate is
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
