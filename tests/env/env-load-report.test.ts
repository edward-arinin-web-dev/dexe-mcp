import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnvFile,
  resolveEnvCandidates,
  getEnvLoadState,
  resetEnvLoadState,
} from "../../src/env/loader.js";

/**
 * 0.30.1 — doctor has to answer "which .env did this server load, and what is
 * overriding it". `process.loadEnvFile` answers neither: it never reports which
 * assignments it applied, and it silently ignores keys that are already set.
 * These tests pin the evidence the loader collects for that answer.
 *
 * Keys are non-DEXE_ on purpose — they exercise the loader without tripping the
 * schema-validation surface.
 */

let dir: string;
const TOUCHED = [
  "LOADER_TEST_A",
  "LOADER_TEST_B",
  "LOADER_TEST_SHADOWED",
  "LOADER_TEST_LAST",
  "LOADER_TEST_FIRST",
  "LOADER_TEST_SPACED",
  "NOT_A_KEY",
];

function write(name: string, body: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexe-loader-"));
  resetEnvLoadState();
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  // A BOM'd file leaves a glued key behind; clear it so it cannot leak.
  for (const k of Object.keys(process.env)) {
    if (k.includes("LOADER_TEST_")) delete process.env[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnvFile — provenance", () => {
  it("reports which keys the file actually supplied", () => {
    const p = write("clean.env", "LOADER_TEST_A=1\nLOADER_TEST_B=2\n");
    const r = loadEnvFile(p, new Set());
    expect(r.envFileExists).toBe(true);
    expect(r.envFileLoaded).toBe(true);
    expect(r.fileKeys).toEqual(["LOADER_TEST_A", "LOADER_TEST_B"]);
    expect(r.keysApplied).toEqual(["LOADER_TEST_A", "LOADER_TEST_B"]);
    expect(r.keysShadowed).toEqual([]);
    expect(r.keysDropped).toEqual([]);
    expect(r.parseIssues).toEqual([]);
  });

  it("a key already set in process.env is reported shadowed, not applied", () => {
    process.env.LOADER_TEST_SHADOWED = "from-host";
    const p = write("shadow.env", "LOADER_TEST_SHADOWED=from-file\nLOADER_TEST_A=1\n");
    const r = loadEnvFile(p, new Set());
    expect(r.keysShadowed).toEqual(["LOADER_TEST_SHADOWED"]);
    expect(r.keysApplied).toEqual(["LOADER_TEST_A"]);
    // The whole point: the file's value never took effect.
    expect(process.env.LOADER_TEST_SHADOWED).toBe("from-host");
  });

  it("ignores comments, blank lines, and lines inside a multi-line quoted value", () => {
    const p = write(
      "multiline.env",
      ['# comment', '', 'LOADER_TEST_A="line one', 'NOT_A_KEY=still inside the quotes"', 'LOADER_TEST_B=2', ''].join(
        "\n",
      ),
    );
    const r = loadEnvFile(p, new Set());
    expect(r.fileKeys).toEqual(["LOADER_TEST_A", "LOADER_TEST_B"]);
    expect(r.keysDropped).toEqual([]);
  });

  it("records candidates and every report so doctor can report the resolution", () => {
    const candidates = resolveEnvCandidates({ cwd: dir, home: dir, pkgDir: join(dir, "dist") });
    const p = write(".env", "LOADER_TEST_A=1\n");
    loadEnvFile(p, new Set());
    const state = getEnvLoadState();
    expect(state.candidates).toEqual(candidates);
    expect(state.reports.map(r => r.envFilePath)).toEqual([p]);
  });

  it("re-loading the same path replaces its report instead of duplicating it", () => {
    const p = write("dup.env", "LOADER_TEST_A=1\n");
    loadEnvFile(p, new Set());
    loadEnvFile(p, new Set());
    expect(getEnvLoadState().reports.filter(r => r.envFilePath === p)).toHaveLength(1);
  });

  it("a missing file is recorded as not-existing rather than throwing", () => {
    const r = loadEnvFile(join(dir, "nope.env"), new Set());
    expect(r.envFileExists).toBe(false);
    expect(r.envFileLoaded).toBe(false);
    expect(r.parseIssues).toEqual([]);
  });
});

describe("loadEnvFile — parse traps", () => {
  it("flags a UTF-8 BOM and proves the first key was dropped", () => {
    const p = write(
      "bom.env",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("LOADER_TEST_FIRST=1\nLOADER_TEST_B=2\n"),
      ]),
    );
    const r = loadEnvFile(p, new Set());
    const issue = r.parseIssues.find(i => i.trap === "bom")!;
    expect(issue).toBeDefined();
    expect(issue.remediation).toContain(p);
    // Severity is evidence-based: `fail` only when the key really did not land.
    expect(issue.severity).toBe(r.keysDropped.includes("LOADER_TEST_FIRST") ? "fail" : "warn");
    expect(r.keysApplied).toContain("LOADER_TEST_B");
  });

  it("flags a missing trailing newline and names the at-risk key", () => {
    const p = write("nonewline.env", "LOADER_TEST_A=1\nLOADER_TEST_LAST=2");
    const r = loadEnvFile(p, new Set());
    const issue = r.parseIssues.find(i => i.trap === "no-trailing-newline")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain("LOADER_TEST_LAST");
    expect(issue.remediation).toContain(p);
    expect(issue.severity).toBe(r.keysDropped.includes("LOADER_TEST_LAST") ? "fail" : "warn");
  });

  it("flags spaces around `=` with the offending line numbers", () => {
    const p = write("spaces.env", "LOADER_TEST_A=1\nLOADER_TEST_SPACED = 2\n");
    const r = loadEnvFile(p, new Set());
    const issue = r.parseIssues.find(i => i.trap === "spaces-around-equals")!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBe("warn");
    expect(issue.message).toContain("line(s) 2");
  });

  it("a well-formed file produces no traps", () => {
    const p = write("ok.env", "# header\nLOADER_TEST_A=1\n\nLOADER_TEST_B=2\n");
    expect(loadEnvFile(p, new Set()).parseIssues).toEqual([]);
  });
});
