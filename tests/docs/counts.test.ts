import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Drift guard for the tool count quoted in user-facing docs. The registered
 * surface is 168 tools (asserted structurally in tests/tools/gate.test.ts);
 * every three-digit "<N> tools" mention in the docs must quote that number,
 * and known stale literals from past releases must not reappear.
 */
const REAL_COUNT = "168";
const STALE_LITERALS = [
  "153 tools",
  "155 tools",
  "156 tools",
  "156-tool",
  "159 tools",
  "165 tools",
  "165-tool",
  "167 tools",
  "all 155",
  "all-155",
];
/**
 * Docs that state the size of the tool surface as a fact about the CURRENT
 * release. docs/WALLETCONNECT.md is deliberately absent: it is a feature doc
 * whose one count mention was incidental to a build note, so requiring it to
 * track every release only produced churn and a number nobody read.
 */
const FILES = [
  "README.md",
  "docs/TOOLS.md",
  "docs/USAGE.md",
  "docs/USE_CASES.md",
  "docs/ENVIRONMENT.md",
  "docs/MIGRATION.md",
];

const root = resolve(__dirname, "..", "..");

/**
 * Archival docs record one section per release, and each section's tool count
 * was TRUE when it shipped. Rewriting those numbers to match today's surface
 * would make the migration guide lie about what a user actually upgraded from.
 *
 * So for these files the guard checks only the NEWEST section — everything from
 * the top down to the second `## ` heading. That is the current claim; the rest
 * is history and is left alone.
 */
const ARCHIVAL = new Set(["docs/MIGRATION.md"]);

function currentClaim(rel: string, text: string): string {
  if (!ARCHIVAL.has(rel)) return text;
  const headings = [...text.matchAll(/^## /gm)];
  return headings.length >= 2 ? text.slice(0, headings[1]!.index) : text;
}

describe("docs quote the real tool count", () => {
  for (const rel of FILES) {
    describe(rel, () => {
      const text = currentClaim(rel, readFileSync(resolve(root, rel), "utf8"));

      it(`every three-digit '<N> tools' mention equals ${REAL_COUNT}`, () => {
        const mentions = [...text.matchAll(/\b(1\d\d)(?=[ -]tools?\b)/g)].map((m) => m[1]);
        const wrong = mentions.filter((n) => n !== REAL_COUNT);
        expect(wrong, `${rel} quotes stale tool counts: ${wrong.join(", ")}`).toEqual([]);
      });

      it(`mentions the real count (${REAL_COUNT})`, () => {
        expect(text, `${rel} should mention the ${REAL_COUNT}-tool surface`).toContain(REAL_COUNT);
      });

      it("contains no stale count literals", () => {
        const found = STALE_LITERALS.filter((s) => text.includes(s));
        expect(found, `${rel} contains stale literals: ${found.join(", ")}`).toEqual([]);
      });
    });
  }
});

/**
 * ROADMAP.md is deliberately NOT in FILES. Membership there mandates quoting
 * the live count, and the roadmap's "Current state" line had gone four releases
 * stale precisely because it restated facts that live elsewhere. The fix was to
 * stop restating them; this pins that shape instead of pinning a number.
 */
describe("ROADMAP.md does not restate current state", () => {
  const text = readFileSync(resolve(root, "ROADMAP.md"), "utf8");
  const claim = text.match(/^\*\*Current state:.*$/m);

  it("has a Current state line", () => {
    expect(claim, "ROADMAP.md lost its **Current state:** line").not.toBeNull();
  });

  it("the Current state line names no release version", () => {
    expect(claim![0], "point at package.json instead of restating the version").not.toMatch(
      /\bv?\d+\.\d+\.\d+\b/,
    );
  });

  it("the Current state line quotes no tool count", () => {
    expect(claim![0], "point at docs/TOOLS.md instead of restating the count").not.toMatch(
      /\b\d{2,3}[ -]tools?\b/,
    );
  });

  it("contains no stale count literals anywhere", () => {
    const found = STALE_LITERALS.filter((s) => text.includes(s));
    expect(found, `ROADMAP.md contains stale literals: ${found.join(", ")}`).toEqual([]);
  });
});
