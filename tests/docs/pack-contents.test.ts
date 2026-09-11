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

/**
 * npm `files` semantics: a bare entry that is a directory includes everything
 * under it, and — like .gitignore — an entry with no slash matches at ANY
 * depth. That last rule is why `SECURITY.md` is spelled `/SECURITY.md`: once
 * the plugin bundle started carrying the whole docs tree, the unanchored form
 * also swept in `dexe-plugin/docs/SECURITY.md`. A leading `/` anchors at the
 * package root and is stripped here before matching.
 */
function shipped(path: string): boolean {
  return pkg.files.some((raw) => {
    const entry = raw.replace(/^\//, "").replace(/\/$/, "");
    return path === entry || path.startsWith(entry + "/");
  });
}

const CRITICAL = [
  "docs/PLAYBOOK.md",
  "docs/TOOLS.md",
  "docs/GRAPH.md",
  "docs/USE_CASES.md",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  ".mcp.example.json",
  ".env.example",
  "dist/index.js",
];

/**
 * `files` ships `docs` as a bare directory entry, so EVERY file under docs/
 * reaches every npm consumer. Three maintainer records (a test backlog, a
 * frontend parity audit, and a 0.5.8-era client dossier) sat there unnoticed
 * for sixteen releases; they now live in `internal/`, which is not on the
 * allowlist.
 *
 * This is an allowlist, not a denylist of the three: the next internal
 * artifact dropped into docs/ has to be justified here or moved, instead of
 * shipping quietly.
 */
const PUBLIC_DOCS = [
  "AGENTS.md",
  "DAO_CREATE_PARITY.md",
  "DOCTOR.md",
  "ENVIRONMENT.md",
  "GOVERNOR.md",
  "GOVERNOR_LAUNCH.md",
  "GRAPH.md",
  "INBOX.md",
  "INSTALL.md",
  "MIGRATION.md",
  "OTC.md",
  "PLAYBOOK.md",
  "PROFILE.md",
  "PROFILES.md",
  "REPORTING.md",
  "SAFE.md",
  "SECURITY.md",
  "SETUP.md",
  "SIMULATOR.md",
  "SKILLS.md",
  "TOOLS.md",
  "UPSTREAM-ISSUES.md",
  "USAGE.md",
  "USE_CASES.md",
  "WALLETCONNECT.md",
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

  it("docs/ contains only files intended for every consumer", () => {
    const actual = readdirSync(resolve(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(
      actual,
      'A file in docs/ ships in the npm tarball to every user. If that is intended, add it to PUBLIC_DOCS; if it is a maintainer record, move it to internal/ (not covered by package.json "files").',
    ).toEqual([...PUBLIC_DOCS].sort());
  });

  it("internal/ is a maintainer area and never ships", () => {
    expect(existsSync(resolve(ROOT, "internal")), "internal/ missing").toBe(true);
    for (const f of readdirSync(resolve(ROOT, "internal"))) {
      expect(shipped(`internal/${f}`), `internal/${f} would ship`).toBe(false);
    }
  });

  it("every doc path quoted in runtime text is published", () => {
    for (const p of [
      "docs/UPSTREAM-ISSUES.md",
      "docs/PLAYBOOK.md",
      "docs/ENVIRONMENT.md",
      "docs/GRAPH.md",
      "docs/REPORTING.md",
      "docs/SETUP.md",
      "docs/PROFILES.md",
    ]) {
      expect(shipped(p), `${p} is quoted to users but not covered by package.json "files"`).toBe(
        true,
      );
      expect(existsSync(resolve(ROOT, p)), `${p} is quoted to users but missing on disk`).toBe(true);
    }
  });

  it("the bin entry and main point at a shipped dist file", () => {
    for (const target of [pkg.main, ...Object.values(pkg.bin)]) {
      expect(shipped(target), `${target} not covered by files`).toBe(true);
      expect(existsSync(resolve(ROOT, target)), `${target} missing on disk`).toBe(true);
    }
  });
});
