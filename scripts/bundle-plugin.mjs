// Bundle the compiled MCP server into a single self-contained file the Claude
// Code plugin can launch with plain `node` — no `npx`, no network fetch, no
// node_modules on the end-user machine.
//
// Why this exists: `dist/index.js` is tsc output that `import`s ~12 runtime
// deps (@modelcontextprotocol/sdk, ethers, execa, @walletconnect/*, …), so it
// only runs where node_modules is present. `npx dexe-mcp@x` fetched them at
// launch, but that path throws -32000 on Windows. esbuild inlines every dep
// into one ESM file so the plugin ships a runnable server.
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

await build({
  entryPoints: [resolve(root, "dist/index.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(outDir, "index.mjs"),
  // Some bundled CJS deps call require() internally; in an ESM bundle that
  // throws "Dynamic require … is not supported" unless we hand them a real one.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

// The server reads these files at runtime via fs, relative to its own dir
// (__dirname/..). After bundling __dirname is dexe-plugin/server, so they must
// live at the plugin root:
//   - package.json → the version reported in the MCP handshake
//   - docs/*.md    → back the dexe://playbook / dexe://graph-schema /
//                    dexe://tools resources (src/resources.ts DOC_RESOURCES)
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

console.log(`bundled dexe-plugin/server/index.mjs (v${pkg.version})`);
