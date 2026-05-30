import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard for the soft-fail migration (PR-3, v0.8.1).
 *
 * Asserts that no `.requireProvider(` or `.requireSigner(` call exists in
 * any tool file outside their definition modules. The throwing variants
 * are kept available in `src/rpc.ts` and `src/lib/signer.ts` for external
 * callers, but every in-tree consumer must use the soft `tryProvider` /
 * `trySigner` variants so missing env surfaces as a structured MCP error
 * with remediation hints — never a thrown stack reaching the MCP
 * transport.
 *
 * This test catches a regression as soon as a new tool is added that
 * forgets the migration; the .requireProvider() / .requireSigner() lines
 * are visually similar to their soft siblings and easy to copy by mistake.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const TARGET_DIRS = [
  resolve(REPO_ROOT, "src", "tools"),
  resolve(REPO_ROOT, "src", "governor"),
];

// Definition files where the throwing variants are intentionally still
// in use; the public sibling-method pattern requires them.
const EXEMPT = new Set<string>([
  resolve(REPO_ROOT, "src", "rpc.ts"),
  resolve(REPO_ROOT, "src", "lib", "signer.ts"),
]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      yield* walkTs(full);
    } else if (s.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      yield full;
    }
  }
}

describe("soft-fail migration (PR-3)", () => {
  it("no direct .requireProvider() calls outside their definition module", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const dir of TARGET_DIRS) {
      for (const file of walkTs(dir)) {
        if (EXEMPT.has(file)) continue;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (/\.requireProvider\(/.test(line)) {
            offenders.push({ file, line: i + 1, text: line.trim() });
          }
        });
      }
    }
    expect(
      offenders,
      `Replace direct .requireProvider() calls with the soft sibling rpc.tryProvider() — ` +
        `missing env should return a structured MCP error, not a thrown stack. ` +
        `Offending sites:\n` +
        offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
    ).toEqual([]);
  });

  it("no direct .requireSigner() calls outside their definition module", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const dir of TARGET_DIRS) {
      for (const file of walkTs(dir)) {
        if (EXEMPT.has(file)) continue;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (/\.requireSigner\(/.test(line)) {
            offenders.push({ file, line: i + 1, text: line.trim() });
          }
        });
      }
    }
    expect(
      offenders,
      `Replace direct .requireSigner() calls with the soft sibling signer.trySigner(). ` +
        `Offending sites:\n` +
        offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
    ).toEqual([]);
  });
});
