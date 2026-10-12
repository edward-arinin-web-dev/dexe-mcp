// Bundle the read edition's binary (dist/read/bin.js, after `npm run build`)
// into ONE self-contained ES module: its five runtime packages inlined, no
// node_modules needed beside it. The Docker image runs this file; nothing from
// the write edition can be in it, because dist/read/bin.js never imports any
// (tests/read/module-graph.test.ts).
//
//   node scripts/bundle-read.mjs [outfile]      default: bundle/read/bin.js
//
// Keep the output at <root>/dist/read/bin.js-depth (two directories below the
// package root): the binary finds package.json and docs/GRAPH.md at ../../.
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, process.argv[2] ?? "bundle/read/bin.js");

await build({
  entryPoints: [resolve(root, "dist/read/bin.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  // CommonJS dependencies (the MCP SDK's ajv, ethers' ws) call require().
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

console.log(`bundled ${outfile} (${(statSync(outfile).size / 1e6).toFixed(1)} MB)`);
