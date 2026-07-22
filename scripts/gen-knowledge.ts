/**
 * gen-knowledge — renders the knowledge corpus (src/knowledge/) into the
 * GENERATED regions of docs/PLAYBOOK.md and the shipped skills. Run via:
 *
 *   npm run gen:knowledge          # rewrite the regions in place
 *   npm run gen:knowledge:check    # exit 1 if any file is out of date (CI)
 *
 * Regions are delimited by exact marker lines:
 *   <!-- BEGIN GENERATED: <name> -->
 *   …
 *   <!-- END GENERATED: <name> -->
 * Hand-written prose outside the markers is never touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderFlowsSection,
  renderGotchasSection,
  renderErrorTable,
  renderSkillRecipe,
} from "../src/knowledge/render.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** file → region name → renderer. Every listed region must exist in the file. */
const TARGETS: Array<{ file: string; regions: Record<string, () => string> }> = [
  {
    file: "docs/PLAYBOOK.md",
    regions: {
      flows: renderFlowsSection,
      gotchas: renderGotchasSection,
      "error-slugs": renderErrorTable,
    },
  },
  { file: "dexe-plugin/skills/dexe-create-dao/SKILL.md", regions: { "flow-recipe": () => renderSkillRecipe("create_dao") } },
  { file: "dexe-plugin/skills/dexe-create-proposal/SKILL.md", regions: { "flow-recipe": () => renderSkillRecipe("create_proposal") } },
  { file: "dexe-plugin/skills/dexe-vote-execute/SKILL.md", regions: { "flow-recipe": () => renderSkillRecipe("vote_execute") } },
  { file: "dexe-plugin/skills/dexe-otc/SKILL.md", regions: { "flow-recipe": () => renderSkillRecipe("otc_sale") } },
  { file: "dexe-plugin/skills/dexe-staking/SKILL.md", regions: { "flow-recipe": () => renderSkillRecipe("staking_setup") } },
];

function replaceRegion(source: string, file: string, name: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const bi = source.indexOf(begin);
  const ei = source.indexOf(end);
  if (bi === -1 || ei === -1 || ei < bi) {
    throw new Error(`${file} is missing the '${name}' generated region markers (${begin} … ${end}).`);
  }
  return source.slice(0, bi + begin.length) + "\n" + body + "\n" + source.slice(ei);
}

const check = process.argv.includes("--check");
let stale = 0;
for (const target of TARGETS) {
  const path = resolve(root, target.file);
  const original = readFileSync(path, "utf8");
  let next = original;
  for (const [name, render] of Object.entries(target.regions)) {
    next = replaceRegion(next, target.file, name, render());
  }
  if (next === original) continue;
  if (check) {
    process.stderr.write(`${target.file} generated regions are OUT OF DATE with src/knowledge/.\n`);
    stale++;
    continue;
  }
  writeFileSync(path, next, "utf8");
  process.stdout.write(`${target.file}: generated regions rewritten.\n`);
}

if (check && stale > 0) {
  process.stderr.write(`Run \`npm run gen:knowledge\` and commit (${stale} file(s) stale).\n`);
  process.exit(1);
}
process.stdout.write(
  check ? "All generated regions are up to date.\n" : "gen:knowledge done.\n",
);
