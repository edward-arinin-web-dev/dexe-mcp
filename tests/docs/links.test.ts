import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/**
 * Twelve relative links were dead at 0.33.1 — eleven of them inside
 * `dexe-plugin/docs/`, the files that back `dexe://tools`, `dexe://playbook`
 * and `dexe://graph-schema`, i.e. exactly where an agent follows a link and
 * gets nothing. One more pointed at `CLAUDE.md`, which is git-ignored.
 *
 * Path existence only. Anchor checking needs a heading slugger that agrees with
 * GitHub's on every heading in every doc, and a flaky docs test is worse than
 * no docs test — that half is deliberately left for later.
 *
 * `research/` is excluded (exploratory, unshipped); `.claude/` is a git-ignored
 * local workspace.
 */
const ROOT = process.cwd();

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((f) => !f.startsWith("research/") && !f.startsWith(".claude/"));

/** `[text](target)` outside fenced code blocks, excluding absolute/anchor-only targets. */
function relativeLinks(rel: string): string[] {
  const text = readFileSync(resolve(ROOT, rel), "utf8").replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((url) => !/^(https?:|mailto:|data:|#)/.test(url));
}

describe("relative markdown links resolve", () => {
  it("finds markdown files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s", (rel) => {
    const broken = relativeLinks(rel).filter((url) => {
      const [path] = url.split("#");
      if (!path) return false;
      return !existsSync(join(dirname(resolve(ROOT, rel)), decodeURIComponent(path)));
    });
    expect(broken, `${rel} links to files that do not exist: ${broken.join(", ")}`).toEqual([]);
  });
});
