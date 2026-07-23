import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOOLSETS } from "../../src/tools/gate.js";

/**
 * Guard against the 0.29.0-era doc drift where the README header claimed "165
 * tools" while the group-catalog table summed to 163. The authoritative count
 * is the union of every non-`full` toolset profile in gate.ts; README.md and
 * docs/TOOLS.md must agree with it, three ways each.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function authoritativeToolCount(): number {
  const union = new Set<string>();
  for (const set of Object.values(TOOLSETS)) for (const name of set) union.add(name);
  return union.size;
}

describe("doc/tool-count consistency", () => {
  const TOTAL = authoritativeToolCount();

  it("gate.ts profile union is a sane non-empty count", () => {
    expect(TOTAL).toBeGreaterThan(100);
  });

  it("docs/TOOLS.md lists exactly one row per registered tool", () => {
    const tools = read("docs/TOOLS.md");
    const rows = tools.split("\n").filter((l) => /^\|\s*`dexe_/.test(l));
    expect(rows.length).toBe(TOTAL);
  });

  it("every README 'N tools in M groups' claim matches the authoritative count", () => {
    const readme = read("README.md");
    const claims = [...readme.matchAll(/(\d+)\s+(?:typed\s+)?tools\s+in\s+(\d+)\s+groups/g)];
    expect(claims.length).toBeGreaterThan(0);
    for (const [, n] of claims) expect(Number(n)).toBe(TOTAL);
  });

  it("the README group-catalog table sums to the authoritative count", () => {
    const readme = read("README.md");
    // Rows of the tool-catalog table: | Group | <count> | Summary |
    const rows = [...readme.matchAll(/^\|\s*([A-Za-z][^|]*?)\s*\|\s*(\d+)\s*\|/gm)]
      // Exclude the header separator and any non-catalog numeric tables.
      .filter((m) => !/^-+$/.test(m[1]!.trim()));
    const sum = rows.reduce((a, m) => a + Number(m[2]), 0);
    expect(sum).toBe(TOTAL);
    // The intro line advertises the same group count as the table has rows.
    const groupClaim = readme.match(/tools\s+in\s+(\d+)\s+groups/);
    expect(rows.length).toBe(Number(groupClaim![1]));
  });
});
