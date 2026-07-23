import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Codifies the pre-0.24.2 regression where docs/PLAYBOOK.md (and the recipe
 * skills) were missing from the published tarball because the package.json
 * `files` allowlist didn't cover them. This asserts, statically and fast (no
 * `npm pack`), that every artifact a fresh install depends on is BOTH present
 * on disk AND matched by a `files` entry, so it will actually ship.
 */
const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  files: string[];
  bin: Record<string, string>;
  main: string;
};

/** npm `files` semantics: a bare entry that is a directory includes everything under it. */
function shipped(path: string): boolean {
  return pkg.files.some((entry) => path === entry || path.startsWith(entry.replace(/\/$/, "") + "/"));
}

const CRITICAL = [
  "docs/PLAYBOOK.md",
  "docs/TOOLS.md",
  "docs/USE_CASES.md",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  ".mcp.example.json",
  "dist/index.js",
];

describe("published-package contents", () => {
  it.each(CRITICAL)("%s exists on disk and is covered by package.json files", (p) => {
    expect(existsSync(resolve(ROOT, p)), `${p} missing on disk`).toBe(true);
    expect(shipped(p), `${p} not covered by package.json "files" — it would NOT ship`).toBe(true);
  });

  it("every shipped recipe skill has a SKILL.md that will ship", () => {
    const skillsDir = resolve(ROOT, "dexe-plugin", "skills");
    const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(skills.length).toBeGreaterThanOrEqual(6);
    for (const s of skills) {
      const rel = `dexe-plugin/skills/${s.name}/SKILL.md`;
      expect(existsSync(resolve(ROOT, rel)), `${rel} missing`).toBe(true);
      expect(shipped(rel), `${rel} not covered by package.json "files"`).toBe(true);
    }
  });

  it("the bin entry and main point at a shipped dist file", () => {
    for (const target of [pkg.main, ...Object.values(pkg.bin)]) {
      expect(shipped(target), `${target} not covered by files`).toBe(true);
      expect(existsSync(resolve(ROOT, target)), `${target} missing on disk`).toBe(true);
    }
  });
});
