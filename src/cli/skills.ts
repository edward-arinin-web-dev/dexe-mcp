import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { installSkills, findRepoRoot } from "./init.js";

/**
 * `npx dexe-mcp skills [--global]` — copy the shipped recipe skills into a
 * Claude Code skills directory. No env interview, no secrets, no prompts: the
 * lightweight path for someone who only wants the tool-sequence recipes.
 *
 * The Claude Code plugin installs these automatically; this is the standalone
 * equivalent for other MCP clients (Cursor, Claude Desktop) or a manual top-up.
 *
 * Target: ./.claude/skills (project, default) or ~/.claude/skills (--global).
 */
export async function run(argv: string[]): Promise<void> {
  // BEFORE findRepoRoot()/installSkills(): without this branch
  // `dexe-mcp skills --help` silently COPIES files into whatever cwd the user
  // happens to be in. A help request that writes to disk is worse than one
  // that hangs.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "dexe-mcp skills [--global]\n\n" +
        "  copies the DeXe recipe skills into ./.claude/skills (default)\n" +
        "  --global, -g   install into ~/.claude/skills instead (every project)\n\n" +
        "Restart Claude Code afterwards so it picks them up.\n",
    );
    return;
  }
  const global = argv.includes("--global") || argv.includes("-g");
  const repoRoot = findRepoRoot();
  const skillsSrc = resolve(repoRoot, "dexe-plugin", "skills");
  if (!existsSync(skillsSrc)) {
    process.stderr.write(
      "[dexe-mcp skills] bundled skills not found (dev checkout without build?). " +
        `Looked in ${skillsSrc}.\n`,
    );
    process.exit(2);
  }
  const targetRoot = global
    ? resolve(homedir(), ".claude", "skills")
    : resolve(process.cwd(), ".claude", "skills");

  const summary = installSkills(skillsSrc, targetRoot);
  process.stdout.write(`Skills → ${targetRoot}\n`);
  for (const s of summary) process.stdout.write(`  ${s}\n`);
  process.stdout.write(
    `\nDone (${global ? "available in every project" : "available in this project"}). ` +
      "Restart Claude Code if it was already running.\n",
  );
}
