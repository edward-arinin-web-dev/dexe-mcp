// Shared by scripts/bundle-plugin.mjs and tests/docs/plugin-doc-bundle.test.ts.
//
// The plugin ships the whole `docs/` tree next to the bundled server, because
// PLAYBOOK/TOOLS/GRAPH cross-reference their siblings and because dexe_doctor's
// remediations name docs/ENVIRONMENT.md. Sibling `./X.md` links therefore
// resolve inside the plugin and are left alone.
//
// Links that leave docs/ (`../README.md`, `../src/…`, `../tests/…`) cannot
// resolve there — the plugin has no repo above it — so they are rehosted to the
// canonical GitHub copy.

/** Rewrite every `](../path)` link to `<repoBlobRoot>path`. */
export function rehostUpTreeLinks(md, repoBlobRoot) {
  return md.replace(/\]\(\.\.\/([^)\s]+)\)/g, (_m, p) => `](${repoBlobRoot}${p})`);
}

/** `https://github.com/<owner>/<repo>/blob/main/`, derived from package.json. */
export function repoBlobRoot(pkg) {
  const url = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  if (!url) throw new Error("package.json repository.url is required to rehost doc links");
  return `${url}/blob/main/`;
}
