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
  renderErrorTable,
  renderFlowsSection,
  renderGotchasSection,
  renderSkillRecipe,
  renderTopicsSection,
} from "@dexe-network/dexe-mcp/core";
import { SINGLE_SERVER_CORPUS } from "../src/knowledge/index.js";
import { WRITE_CORPUS } from "../src/knowledge/write/index.js";
import { WRITE_ONLY_KNOWN_FAILURES } from "../src/lib/writeErrors.js";
import { WRITE_GUIDE_TOOL } from "../src/tools/guideWrite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A write skill's recipe region: one write flow, rendered from the write
 * corpus, closing with a pointer at dexe_write_guide — the tool that serves the
 * flows on every setup (the read server's dexe_guide has none).
 */
const recipe = (flowId: string) => () => renderSkillRecipe(WRITE_CORPUS, flowId, WRITE_GUIDE_TOOL);

/** file → region name → renderer. Every listed region must exist in the file. */
const TARGETS: Array<{ file: string; regions: Record<string, () => string> }> = [
  {
    // PLAYBOOK documents both editions: write flows next to read topics, and
    // the read error table with the write table on top — worded for the
    // default setup (write-only server, read server beside it).
    file: "docs/PLAYBOOK.md",
    regions: {
      flows: () => renderFlowsSection(SINGLE_SERVER_CORPUS),
      topics: () => renderTopicsSection(SINGLE_SERVER_CORPUS),
      gotchas: () => renderGotchasSection(SINGLE_SERVER_CORPUS),
      "error-slugs": () => renderErrorTable(WRITE_ONLY_KNOWN_FAILURES),
    },
  },
  { file: "dexe-plugin/skills/dexe-create-dao/SKILL.md", regions: { "flow-recipe": recipe("create_dao") } },
  { file: "dexe-plugin/skills/dexe-create-proposal/SKILL.md", regions: { "flow-recipe": recipe("create_proposal") } },
  { file: "dexe-plugin/skills/dexe-vote-execute/SKILL.md", regions: { "flow-recipe": recipe("vote_execute") } },
  { file: "dexe-plugin/skills/dexe-otc/SKILL.md", regions: { "flow-recipe": recipe("otc_sale") } },
  { file: "dexe-plugin/skills/dexe-staking/SKILL.md", regions: { "flow-recipe": recipe("staking_setup") } },
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
  // Compare with normalized line endings: a Windows checkout with
  // core.autocrlf=true reads CRLF files while the renderer emits LF, which
  // made --check report every generated file as stale. Preserve the file's
  // original EOL style when rewriting so a CRLF checkout stays CRLF.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const toLf = (text: string) => text.replace(/\r\n/g, "\n");
  let next = original;
  for (const [name, render] of Object.entries(target.regions)) {
    next = replaceRegion(next, target.file, name, render());
  }
  if (toLf(next) === toLf(original)) continue;
  if (check) {
    process.stderr.write(`${target.file} generated regions are OUT OF DATE with src/knowledge/.\n`);
    stale++;
    continue;
  }
  writeFileSync(path, eol === "\r\n" ? toLf(next).replace(/\n/g, "\r\n") : toLf(next), "utf8");
  process.stdout.write(`${target.file}: generated regions rewritten.\n`);
}

if (check && stale > 0) {
  process.stderr.write(`Run \`npm run gen:knowledge\` and commit (${stale} file(s) stale).\n`);
  process.exit(1);
}
process.stdout.write(
  check ? "All generated regions are up to date.\n" : "gen:knowledge done.\n",
);
