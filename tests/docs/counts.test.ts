import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Drift guard for the tool count quoted in user-facing docs. The registered
 * surface is 161 tools (asserted structurally in tests/tools/gate.test.ts);
 * every three-digit "<N> tools" mention in the docs must quote that number,
 * and known stale literals from past releases must not reappear.
 */
const REAL_COUNT = "161";
const STALE_LITERALS = ["153 tools", "155 tools", "156 tools", "156-tool", "159 tools", "all 155", "all-155"];
const FILES = [
  "README.md",
  "docs/TOOLS.md",
  "docs/USAGE.md",
  "docs/WALLETCONNECT.md",
  "docs/ENVIRONMENT.md",
  "docs/MIGRATION.md",
];

const root = resolve(__dirname, "..", "..");

describe("docs quote the real tool count", () => {
  for (const rel of FILES) {
    describe(rel, () => {
      const text = readFileSync(resolve(root, rel), "utf8");

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
