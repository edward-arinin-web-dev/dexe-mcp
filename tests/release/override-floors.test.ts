import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The `overrides` block in package.json pins transitive dependencies above
 * their advisory lines. A floor only takes effect once `npm install` re-resolves
 * the tree — `npm ci` installs whatever the lockfile already says — so a raised
 * floor with a stale lockfile ships the vulnerable version anyway. This asserts
 * every installed copy of an overridden package is at or above its floor.
 *
 * Scope, honestly: this guards lock-BELOW-floor desync only. It does NOT catch a
 * floor pinned below a widened advisory line — that is what the
 * `npm audit --omit=dev` gate in ci.yml / release.yml / audit.yml is for; this
 * file would have passed on the 0.33.0 tree that shipped three live advisories.
 */
const ROOT = process.cwd();

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  overrides?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
};

/** Exact-floor overrides only (`>=1.2.3`); ranges like `^1.2.3` or `*` are skipped. */
const EXACT_FLOOR = /^>=(\d+\.\d+\.\d+)$/;

/** Hand-rolled 3-part compare — deliberately no `semver` dependency in the test tree. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Strip a prerelease/build suffix so `1.2.3-rc.1` compares as `1.2.3`. */
function core(version: string): string {
  return version.split(/[-+]/)[0] ?? version;
}

function installedCopies(name: string): Array<{ path: string; version: string }> {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .filter(([, entry]) => typeof entry.version === "string")
    .map(([path, entry]) => ({ path, version: entry.version as string }));
}

const floors = Object.entries(pkg.overrides ?? {})
  .map(([name, range]) => [name, EXACT_FLOOR.exec(range)?.[1]] as const)
  .filter((pair): pair is readonly [string, string] => typeof pair[1] === "string");

describe("package.json overrides vs package-lock.json", () => {
  it("declares at least one exact-floor override", () => {
    expect(floors.length).toBeGreaterThan(0);
  });

  it.each(floors.map(([name, floor]) => ({ name, floor })))(
    "$name is installed at >= $floor everywhere",
    ({ name, floor }) => {
      for (const { path, version } of installedCopies(name)) {
        expect(
          compareVersions(core(version), floor) >= 0,
          `package-lock.json has ${name}@${version} but package.json overrides demand >=${floor} — run \`npm install\` (NOT \`npm ci\`) and commit the refreshed lockfile. (lock path: ${path})`,
        ).toBe(true);
      }
    },
  );
});
