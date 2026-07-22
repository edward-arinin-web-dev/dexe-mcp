/**
 * gen-knowledge — renders the knowledge corpus (src/knowledge/) into the
 * GENERATED regions of docs/PLAYBOOK.md. Run via:
 *
 *   npm run gen:knowledge          # rewrite the regions in place
 *   npm run gen:knowledge:check    # exit 1 if the file is out of date (CI)
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
import { renderFlowsSection, renderGotchasSection, renderErrorTable } from "../src/knowledge/render.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playbookPath = resolve(root, "docs", "PLAYBOOK.md");

const REGIONS: Record<string, () => string> = {
  flows: renderFlowsSection,
  gotchas: renderGotchasSection,
  "error-slugs": renderErrorTable,
};

function replaceRegion(source: string, name: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const bi = source.indexOf(begin);
  const ei = source.indexOf(end);
  if (bi === -1 || ei === -1 || ei < bi) {
    throw new Error(`docs/PLAYBOOK.md is missing the '${name}' generated region markers (${begin} … ${end}).`);
  }
  return source.slice(0, bi + begin.length) + "\n" + body + "\n" + source.slice(ei);
}

const check = process.argv.includes("--check");
const original = readFileSync(playbookPath, "utf8");
let next = original;
for (const [name, render] of Object.entries(REGIONS)) {
  next = replaceRegion(next, name, render());
}

if (next === original) {
  process.stdout.write("docs/PLAYBOOK.md generated regions are up to date.\n");
  process.exit(0);
}
if (check) {
  process.stderr.write(
    "docs/PLAYBOOK.md generated regions are OUT OF DATE with src/knowledge/. Run `npm run gen:knowledge` and commit.\n",
  );
  process.exit(1);
}
writeFileSync(playbookPath, next, "utf8");
process.stdout.write("docs/PLAYBOOK.md generated regions rewritten from src/knowledge/.\n");
