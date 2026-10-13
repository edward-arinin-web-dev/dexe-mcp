#!/usr/bin/env node
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
 * the plugin bundles into dexe-plugin/server/read/bin.mjs. It imports no src/
 * module, so it carries no write code (tests/read/module-graph.test.ts).
 *
 * What it tells the binary about this install:
 *   - the version to report: the READ PACKAGE's (not dexe-mcp's) — the read server is
 *     that package at the exact version this release pins, whoever starts it.
 *     Installed, `runReadBin` reads it from the package itself; in the plugin
 *     bundle there is no package directory, so scripts/bundle-plugin.mjs bakes
 *     it in as `__DEXE_READ_VERSION__`;
 *   - where the install's `.env` candidate is (`<dist>/../.env`, as for
 *     `dexe-mcp`).
 */

declare const __DEXE_READ_VERSION__: string | undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The read package version esbuild baked into the plugin bundle, or undefined. */
const bundledReadVersion = typeof __DEXE_READ_VERSION__ === "string" ? __DEXE_READ_VERSION__ : undefined;

if (isMainModule(import.meta.url)) {
  await runReadBin(process.argv, {
    ...(bundledReadVersion ? { version: bundledReadVersion } : {}),
    pkgDir: resolve(__dirname, ".."),
  });
}
