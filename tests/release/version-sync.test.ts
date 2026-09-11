import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Four files carry the release version and two of them are generated, so it is
 * easy to bump package.json and ship a plugin that still announces the previous
 * release. This pins all of them to package.json.
 *
 * It also refuses a `packageManager: pnpm@...` field: the repo builds and
 * publishes with npm + package-lock.json, and that field makes GitHub
 * Dependabot's npm security-update jobs install pnpm and fail before they can
 * open a PR.
 */
const ROOT = process.cwd();

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as T;
}

const pkg = readJson<{ version: string; packageManager?: string }>("package.json");

const REMEDY =
  "run `npm install` (lockfile) and `npm run bundle:plugin` (plugin files) after bumping the version";

describe("release version sync", () => {
  it("package.json carries a plain semver version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("package-lock.json agrees on both version fields", () => {
    const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>(
      "package-lock.json",
    );
    expect(
      lock.version,
      `package-lock.json "version" is ${lock.version}, package.json is ${pkg.version} — ${REMEDY}`,
    ).toBe(pkg.version);
    const rootEntry = lock.packages[""];
    expect(
      rootEntry?.version,
      `package-lock.json packages[""].version is ${rootEntry?.version}, package.json is ${pkg.version} — ${REMEDY}`,
    ).toBe(pkg.version);
  });

  it("dexe-plugin/package.json agrees", () => {
    const plugin = readJson<{ version: string }>("dexe-plugin/package.json");
    expect(
      plugin.version,
      `dexe-plugin/package.json is ${plugin.version}, package.json is ${pkg.version} — ${REMEDY}`,
    ).toBe(pkg.version);
  });

  it("dexe-plugin/.claude-plugin/plugin.json agrees", () => {
    const manifest = readJson<{ version: string }>("dexe-plugin/.claude-plugin/plugin.json");
    expect(
      manifest.version,
      `dexe-plugin/.claude-plugin/plugin.json is ${manifest.version}, package.json is ${pkg.version} — ${REMEDY}`,
    ).toBe(pkg.version);
  });

  it(".claude-plugin/marketplace.json plugins[0] agrees", () => {
    const marketplace = readJson<{ plugins: Array<{ name: string; version: string }> }>(
      ".claude-plugin/marketplace.json",
    );
    const entry = marketplace.plugins[0];
    expect(entry, ".claude-plugin/marketplace.json has no plugins[0] entry").toBeDefined();
    expect(
      entry?.version,
      `.claude-plugin/marketplace.json plugins[0].version is ${entry?.version}, package.json is ${pkg.version} — ${REMEDY}`,
    ).toBe(pkg.version);
  });

  it("package.json declares no pnpm packageManager", () => {
    expect(
      pkg.packageManager?.startsWith("pnpm") ?? false,
      "packageManager: pnpm breaks Dependabot's npm security updates — this repo uses npm + package-lock.json",
    ).toBe(false);
  });
});
