import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { READ_PACKAGE, READ_PACKAGE_VERSION, READ_SERVER_NPX } from "../../src/readPackage.js";
import { usageText } from "../../src/index.js";
import { surfaceModeCheck } from "../../src/diag/writeChecks.js";

/**
 * Every "start the read server" snippet names the EXACT read package version
 * this release depends on — the read code runs on the signing path, so the
 * read server a user adds next to this one must be the tested one.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("the pinned read package", () => {
  it("READ_PACKAGE_VERSION is the dependency this package installs", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const spec = pkg.dependencies[READ_PACKAGE]!;
    if (spec.startsWith("file:")) {
      // The vendored tarball (until the package is on npm): its file name carries the version.
      expect(spec, "vendored tarball name").toMatch(new RegExp(`-${READ_PACKAGE_VERSION.replace(/\./g, "\\.")}\\.tgz$`));
    } else {
      expect(spec, "pin the read package exactly — no range").toBe(READ_PACKAGE_VERSION);
    }
    const installed = JSON.parse(read(`node_modules/${READ_PACKAGE}/package.json`)) as { version: string };
    expect(installed.version).toBe(READ_PACKAGE_VERSION);
  });

  const docs = [
    "README.md",
    "CHANGELOG.md",
    ".mcp.example.json",
    "Dockerfile",
    ...readdirSync(resolve(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => join("docs", f)),
    ...readdirSync(resolve(ROOT, "dexe-plugin", "skills")).map((d) => join("dexe-plugin", "skills", d, "SKILL.md")),
  ];

  // `-p @dexe-network/dexe-mcp…` (shell) and `"-p", "@dexe-network/dexe-mcp…"` (JSON / TOML args).
  const SNIPPET = /-p["',\s]+@dexe-network\/dexe-mcp(@[\w.+-]+)?/g;

  for (const rel of docs) {
    it(`${rel}: every npx snippet pins ${READ_PACKAGE}@${READ_PACKAGE_VERSION}`, () => {
      const text = read(rel);
      const unpinned = [...text.matchAll(SNIPPET)].filter((m) => m[1] !== `@${READ_PACKAGE_VERSION}`).map((m) => m[0]);
      expect(unpinned).toEqual([]);
    });
  }

  it("--help and the write doctor's surface.mode remediation name the pinned command", () => {
    expect(usageText("0.0.0")).toContain(READ_SERVER_NPX);
    const row = surfaceModeCheck({ writeStandalone: false } as never, {})[0]!;
    expect(row.remediation).toContain(READ_SERVER_NPX);
  });
});
