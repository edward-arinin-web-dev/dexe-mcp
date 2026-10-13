// Bundle the compiled MCP server into a single self-contained file the Claude
// Code plugin can launch with plain `node` — no `npx`, no network fetch, no
// node_modules on the end-user machine.
//
// Why this exists: `dist/index.js` is tsc output that `import`s ~12 runtime
// deps (@modelcontextprotocol/sdk, ethers, execa, @walletconnect/*, the read
// edition @dexe-network/dexe-mcp, …), so it
// only runs where node_modules is present. `npx dexe-mcp@x` fetched them at
// launch, but that path throws -32000 on Windows. esbuild inlines every dep
// into one ESM file so the plugin ships a runnable server.
//
// The plugin ships TWO servers (1.0.0): `dexe` (this package — write tools only
// by default) and `dexe-read` (the DeXe read server, @dexe-network/dexe-mcp,
// which serves the reads). Both are bundled here from what this install
// carries — dist/index.js and dist/read/bin.js (the read package's binary
// behind this package's shim) — so the plugin launches the read server with
// plain `node` too, offline, at exactly the read version this release pins.
//
// Output goes to dexe-plugin/server/ (NOT dexe-plugin/dist/) on purpose:
// `.gitignore` has a bare `dist/` rule that matches dist dirs at any depth, so
// a bundle under dist/ would be silently un-committable.
//
// esbuild is resolved from the override-pinned transitive install (see
// package.json `overrides.esbuild`); it is intentionally not a direct devDep
// because that override rejects the direct add (EOVERRIDE).
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rehostUpTreeLinks, repoBlobRoot } from "./lib/doc-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(root, "dexe-plugin");
const outDir = resolve(pluginDir, "server");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

mkdirSync(outDir, { recursive: true });

// Nothing that reaches @dexe-network/dexe-mcp/core (the doctor, `dexe-mcp key`)
// may be a DYNAMIC import of dist/index.js. In a single-file bundle esbuild
// answers a dynamic import by wrapping the target AND everything it reaches in
// a lazy `init_*()` closure. Core pulls in zod (the env schema), so when the
// doctor was `await import("./cli/doctor.js")` zod 4 got wrapped and the MCP
// SDK's top-level `custom(...)` calls ran before `ZodCustom` was assigned: the
// bundle died on load with "Class2 is not a constructor". A plugin here used to
// rewrite that one import; src/index.ts now imports both statically, so there
// is nothing left to rewrite (tests/plugin/bundle-smoke.test.ts boots the
// bundle).
const bundle = (entry, outfile) =>
  build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    // Some bundled CJS deps call require() internally; in an ESM bundle that
    // throws "Dynamic require … is not supported" unless we hand them a real one.
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    },
    logLevel: "info",
  });

await bundle("dist/index.js", resolve(outDir, "index.mjs"));
// The read server: two directories below the plugin root, like dist/read/bin.js
// below the package root — the binary finds package.json (its version) and
// docs/GRAPH.md (the dexe://graph-schema resource) at ../../, and its .env
// candidate at ../.env, the same file as the write server's. Nothing of the
// write edition can be in it: dist/read/bin.js imports no write module
// (tests/read/module-graph.test.ts).
await bundle("dist/read/bin.js", resolve(outDir, "read", "bin.mjs"));

// The server reads these files at runtime via fs, relative to its own dir
// (__dirname/..). After bundling __dirname is dexe-plugin/server, so they must
// live at the plugin root:
//   - package.json → the version reported in the MCP handshake
//   - docs/*.md    → back the dexe://playbook / dexe://graph-schema /
//                    dexe://tools resources (DOC_RESOURCES, @dexe-network/dexe-mcp/core)
//
// The WHOLE docs/ tree ships, not just those three: PLAYBOOK/TOOLS/GRAPH link
// their siblings (AGENTS, REPORTING, OTC, SAFE, …) and dexe_doctor's
// remediations name docs/ENVIRONMENT.md, so a three-file copy left eleven dead
// links inside the resources an agent actually reads. Links that leave docs/
// are rehosted to GitHub, since the plugin has no repo above it. `rmSync`
// first, so a doc deleted upstream cannot linger in the bundle.
writeFileSync(
  resolve(pluginDir, "package.json"),
  JSON.stringify({ name: "dexe-mcp-plugin", version: pkg.version, private: true }, null, 2) + "\n",
);
rmSync(resolve(pluginDir, "docs"), { recursive: true, force: true });
mkdirSync(resolve(pluginDir, "docs"), { recursive: true });
const blob = repoBlobRoot(pkg);
for (const doc of readdirSync(resolve(root, "docs")).filter((f) => f.endsWith(".md"))) {
  writeFileSync(
    resolve(pluginDir, "docs", doc),
    rehostUpTreeLinks(readFileSync(resolve(root, "docs", doc), "utf8"), blob),
  );
}

// server.json is the MCP Registry manifest. It carries the version twice (the
// server and the npm package it points at) and the registry rejects a manifest
// whose version is not the published one, so it is stamped here with the other
// generated version files rather than left as a fifth thing to bump by hand.
const serverJsonPath = resolve(root, "server.json");
const serverJson = JSON.parse(readFileSync(serverJsonPath, "utf8"));
serverJson.version = pkg.version;
for (const p of serverJson.packages ?? []) p.version = pkg.version;
writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + "\n");

console.log(`bundled dexe-plugin/server/index.mjs + dexe-plugin/server/read/bin.mjs (v${pkg.version})`);
