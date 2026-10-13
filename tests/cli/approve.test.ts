import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `dexe-mcp approve` from the built bin, run the way an AI agent's shell runs
 * it: stdin and stdout are pipes, not a terminal. Deciding must be refused
 * (exit 2) before any server is contacted; `--list` and `--help` still work.
 */
const ROOT = resolve(__dirname, "..", "..");
const DIST = join(ROOT, "dist", "index.js");
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dexe-approve-cli-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function cli(args: string[], input = "") {
  return spawnSync(process.execPath, [DIST, "approve", ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, DEXE_ENV_FILE: join(home, "none.env") },
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe.skipIf(!existsSync(DIST))("dexe-mcp approve (built CLI, no TTY)", () => {
  it("refuses to decide without an interactive terminal — even with a password piped in", () => {
    const r = cli([], "a\nmy-keystore-password\n");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/needs an interactive terminal/);
    expect(r.stdout).not.toMatch(/password/i);
    // and it did not even create the rendezvous directory
    expect(existsSync(join(home, ".dexe-mcp", "run"))).toBe(false);
  });

  it("refuses for a named approval too", () => {
    expect(cli(["apr_abcdefgh"]).status).toBe(2);
  });

  it("--list works without a terminal and decides nothing", () => {
    const r = cli(["--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No running dexe-mcp server has terminal approvals open/);
  });

  it("--help documents the command; unknown arguments are rejected", () => {
    const h = cli(["--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(/dexe-mcp approve \[<approvalId>\]/);
    const bad = cli(["--password", "x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/unexpected argument '--password'/);
  });
});
