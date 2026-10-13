// Refuse to publish while a runtime dependency points at a local file.
//
// npm publishes a dependency spec as written: `file:vendor/x.tgz` would ship to
// the registry and every install of this package would fail on it. Until
// @dexe-network/dexe-mcp is on npm, dexe-mcp depends on a vendored tarball
// (vendor/); switch it to a registry range before a release. Runs in
// `prepublishOnly`, so `npm publish` (and the Release workflow) stop here.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const local = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) =>
  /^(file:|link:|git\+file:|\.{0,2}[\\/])/.test(String(spec)),
);
if (local.length > 0) {
  for (const [name, spec] of local) {
    process.stderr.write(`[assert-registry-deps] ${name} is "${spec}" — a local path cannot be published.\n`);
  }
  process.stderr.write("Point it at the registry (e.g. \"^1.0.0-rc.1\") and re-run `npm install` before publishing.\n");
  process.exit(1);
}
