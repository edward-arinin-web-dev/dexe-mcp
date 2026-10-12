import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyReadArgv, readUsageText } from "../../src/read/bin.js";

/**
 * `dexe-mcp-read` argv handling: stdio by default (transport flags a host may
 * append still serve), `serve-http`, help/version answered from argv alone,
 * anything else exits 2 with the usage.
 */

const ROOT = resolve(__dirname, "..", "..");
const BIN = resolve(ROOT, "dist", "read", "bin.js");
const version = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }).version;
const argv = (...rest: string[]) => ["node", "/x/dist/read/bin.js", ...rest];

describe("classifyReadArgv", () => {
  it.each([[], [""], ["--stdio"], ["--transport=stdio"], ["--mcp"]])("%j serves on stdio", (...rest) => {
    expect(classifyReadArgv(argv(...(rest as string[])))).toEqual({ kind: "server" });
  });
  it("serve-http, help, version, unknown", () => {
    expect(classifyReadArgv(argv("serve-http", "--port", "1"))).toEqual({ kind: "serve-http" });
    for (const h of ["--help", "-h", "help"]) expect(classifyReadArgv(argv(h))).toEqual({ kind: "help" });
    for (const v of ["--version", "-v", "-V"]) expect(classifyReadArgv(argv(v))).toEqual({ kind: "version" });
    // the full server's subcommands are not this binary's
    for (const a of ["doctor", "init", "skills", "--strict"]) {
      expect(classifyReadArgv(argv(a))).toEqual({ kind: "unknown", arg: a });
    }
  });
  it("the usage names both modes and no write capability", () => {
    const text = readUsageText("1.2.3");
    expect(text).toContain("dexe-mcp-read serve-http");
    expect(text).not.toMatch(/\binit\b|sign (and|or) send|Pinata|WalletConnect|dexe_[a-z_]+/);
  });
});

describe.skipIf(!existsSync(BIN))("the built dexe-mcp-read binary", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 15_000, input: "" });

  it("--version and --help exit 0 on stdout", () => {
    const v = run("--version");
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(version);
    const h = run("--help");
    expect(h.status).toBe(0);
    expect(h.stdout).toContain(`dexe-mcp-read ${version}`);
  });

  it("an unknown argument exits 2 and says why", () => {
    const r = run("doctor");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'doctor'/);
  });
});
