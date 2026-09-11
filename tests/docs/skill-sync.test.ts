import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderSkillRecipe } from "../../src/knowledge/render.js";

/**
 * Skill-parity guard. `dexe-plugin/skills/` is the shipped source of truth;
 * any repo-local mirror at `.claude/skills/<name>/SKILL.md` must stay
 * byte-identical, or a session in this repo teaches different recipes than
 * the plugin ships. Fix a failure by copying the dexe-plugin version over
 * the `.claude` one — never the other way around.
 *
 * D2-7: the mirror loop `continue`s when a mirror is absent, and coverage had
 * decayed to 1 of 8 shipped skills with no signal. The mirror count is now
 * reported explicitly, and three guards that need NO mirror run for every
 * shipped skill: front-matter identity, docs/SKILLS.md coverage, and — for the
 * five skills gen-knowledge owns — the generated region matching a fresh render.
 */
const root = resolve(__dirname, "..", "..");
const pluginSkillsDir = resolve(root, "dexe-plugin", "skills");

/** `npm run gen:knowledge` targets: skill directory → the flow it renders. */
const GEN_OWNED: Record<string, string> = {
  "dexe-create-dao": "create_dao",
  "dexe-create-proposal": "create_proposal",
  "dexe-vote-execute": "vote_execute",
  "dexe-otc": "otc_sale",
  "dexe-staking": "staking_setup",
};

/** CRLF on a Windows checkout is not drift (see CLAUDE.md gen:knowledge gotcha). */
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("skill parity (dexe-plugin/skills is the source of truth)", () => {
  const names = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds the shipped plugin skills", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  const mirrored = names.filter((n) => existsSync(resolve(root, ".claude", "skills", n, "SKILL.md")));

  it("reports how many shipped skills have a repo-local mirror", () => {
    // Not a drift guard by itself — it makes the number visible so a decay from
    // 8/8 to 1/8 cannot happen silently again. The real per-skill guards below
    // need no mirror.
    // eslint-disable-next-line no-console
    console.log(`skill mirrors: ${mirrored.length}/${names.length}${mirrored.length ? ` (${mirrored.join(", ")})` : ""}`);
    expect(names.length).toBeGreaterThanOrEqual(mirrored.length);
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

describe("every shipped skill is guarded, mirror or not", () => {
  const names = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(pluginSkillsDir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
  const skillsDoc = lf(readFileSync(resolve(root, "docs", "SKILLS.md"), "utf8"));

  for (const name of names) {
    const body = lf(readFileSync(resolve(pluginSkillsDir, name, "SKILL.md"), "utf8"));

    it(`${name}/SKILL.md front-matter name matches its directory`, () => {
      const fm = /^---\n([\s\S]*?)\n---/.exec(body);
      expect(fm, `${name}/SKILL.md has no YAML front matter`).not.toBeNull();
      expect(/^name:\s*(\S+)/m.exec(fm![1]!)?.[1]).toBe(name);
    });

    it(`docs/SKILLS.md lists ${name}`, () => {
      expect(
        skillsDoc,
        `docs/SKILLS.md does not mention shipped skill ${name} — add a row to ## The skills`,
      ).toContain("`" + name + "`");
    });

    const flow = GEN_OWNED[name];
    if (!flow) continue;
    it(`${name}/SKILL.md generated flow-recipe region is in sync`, () => {
      const begin = "<!-- BEGIN GENERATED: flow-recipe -->";
      const end = "<!-- END GENERATED: flow-recipe -->";
      const bi = body.indexOf(begin);
      const ei = body.indexOf(end);
      expect(bi, `${name}/SKILL.md is missing ${begin}`).toBeGreaterThan(-1);
      expect(ei).toBeGreaterThan(bi);
      const onDisk = body.slice(bi + begin.length, ei).trim();
      expect(
        onDisk,
        `${name}/SKILL.md's generated region is stale — run \`npm run gen:knowledge\` and commit the result`,
      ).toBe(lf(renderSkillRecipe(flow)).trim());
    });
  }

  it("docs/SKILLS.md states the real skill count", () => {
    const WORD: Record<number, string> = { 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    expect(skillsDoc, `docs/SKILLS.md should say "all ${WORD[names.length]} skills"`).toContain(
      `all ${WORD[names.length]} skills`,
    );
    for (const [n, w] of Object.entries(WORD)) {
      if (Number(n) === names.length) continue;
      expect(skillsDoc, `docs/SKILLS.md still says "all ${w} skills"; there are ${names.length}`).not.toContain(
        `all ${w} skills`,
      );
    }
  });
});
