#!/usr/bin/env node
import { isMainModule } from "@dexe-network/dexe-mcp/core";
import { runReadBin } from "@dexe-network/dexe-mcp/bin";

/**
 * `dexe-mcp-read` — the read edition's binary, as this package ships it.
 *
 * The read edition is @dexe-network/dexe-mcp: its stdio server, `serve-http`,
 * the usage text and the version it reports are that package's, unchanged.
 * This file only gives it a bin entry here (package.json "bin"), and is what
 * `dexe-mcp serve-http` spawns (src/index.ts). It imports nothing from src/,
 * so it carries no write code (tests/read/module-graph.test.ts).
 */
if (isMainModule(import.meta.url)) {
  await runReadBin();
}
