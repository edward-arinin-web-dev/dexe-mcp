import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Skill-parity guard. `dexe-plugin/skills/` is the shipped source of truth;
 * any repo-local mirror at `.claude/skills/<name>/SKILL.md` must stay
 * byte-identical, or a session in this repo teaches different recipes than
 * the plugin ships. Fix a failure by copying the dexe-plugin version over
 * the `.claude` one — never the other way around.
 */
const root = resolve(__dirname, "..", "..");
const pluginSkillsDir = resolve(root, "dexe-plugin", "skills");

describe("skill parity (dexe-plugin/skills is the source of truth)", () => {
  const names = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds the shipped plugin skills", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    const source = resolve(pluginSkillsDir, name, "SKILL.md");
    const mirror = resolve(root, ".claude", "skills", name, "SKILL.md");
    if (!existsSync(source) || !existsSync(mirror)) continue;

    it(`.claude/skills/${name}/SKILL.md is byte-identical to dexe-plugin/skills/${name}/SKILL.md`, () => {
      const identical = readFileSync(mirror).equals(readFileSync(source));
      expect(
        identical,
        `.claude/skills/${name}/SKILL.md has drifted — copy dexe-plugin/skills/${name}/SKILL.md over it`,
      ).toBe(true);
    });
  }
});
