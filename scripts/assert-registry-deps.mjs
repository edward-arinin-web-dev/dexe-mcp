// Refuse to publish while a dependency points at a local file.
//
// npm publishes a dependency spec as written: `file:vendor/x.tgz` would ship to
// the registry and every install of this package would fail on it. Until
// @dexe-network/dexe-mcp is on npm, dexe-mcp depends on a vendored tarball
// (vendor/); switch it to the exact published version before a release. Runs in
// `prepublishOnly`, so `npm publish` (and the Release workflow) stop here.
//
//   node scripts/assert-registry-deps.mjs [package.json]
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** A spec npm resolves from the local disk rather than a registry or a remote git host. */
export function isLocalSpec(spec) {
  const s = String(spec).trim();
  // remote: fetched over the network, whatever the file name says
  if (/^(https?|ssh|git(\+(ssh|https?))?):/i.test(s)) return false;
  return (
    /^(file|link|portal):/i.test(s) || // file:vendor/x.tgz, link:../x
    /^git\+file:/i.test(s) ||
    /^\.{1,2}([\\/]|$)/.test(s) || // ./x, ../x, .., .
    /^~[\\/]/.test(s) || // ~/x
    /^[\\/]/.test(s) || // /abs, \\server\share
    /^[a-z]:[\\/]/i.test(s) || // C:\x, C:/x
    /\.(tgz|tar|tar\.gz)$/i.test(s) // vendor/x.tgz — npm reads a bare tarball path from disk
  );
}

/** The local-path dependencies of `pkg`, in every dependency field. */
export function localDependencies(pkg) {
  return FIELDS.flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(([, spec]) => isLocalSpec(spec))
      .map(([name, spec]) => ({ field, name, spec })),
  );
}

function main() {
  const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../package.json", import.meta.url));
  const local = localDependencies(JSON.parse(readFileSync(path, "utf8")));
  if (local.length === 0) return;
  for (const { field, name, spec } of local) {
    process.stderr.write(`[assert-registry-deps] ${field}.${name} is "${spec}" — a local path cannot be published.\n`);
  }
  process.stderr.write(
    'Point it at the exact published version (e.g. "1.0.0-rc.1", no range) and re-run `npm install` before publishing.\n',
  );
  process.exitCode = 1;
}

// Run only as a script (tests import isLocalSpec / localDependencies).
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(self)) main();
