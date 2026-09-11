import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runSkills } from "../../src/cli/skills.js";

/**
 * D10-2, objection 1 — `dexe-mcp skills --help` did not hang like the other
 * argv shapes. It silently COPIED the shipped skills into `./.claude/skills` of
 * whatever directory the user happened to be in, then printed "Done". A help
 * request that writes to disk is worse than one that hangs.
 */
describe("dexe-mcp skills --help", () => {
  let cwd: string;
  let previousCwd: string;
  let written: string[];

  beforeEach(() => {
    previousCwd = process.cwd();
    cwd = mkdtempSync(resolve(tmpdir(), "dexe-skills-"));
    process.chdir(cwd);
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
  });

  it.each(["--help", "-h"])("%s prints usage and installs nothing", async (flag) => {
    await runSkills([flag]);

    expect(written.join("")).toContain("dexe-mcp skills");
    expect(written.join("")).toContain("--global");
    // The regression assertion: no files were created anywhere under cwd.
    expect(existsSync(resolve(cwd, ".claude"))).toBe(false);
  });

  it("--help wins over --global, so neither target is written", async () => {
    await runSkills(["--global", "--help"]);
    expect(existsSync(resolve(cwd, ".claude"))).toBe(false);
  });
});
