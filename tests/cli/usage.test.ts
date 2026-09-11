import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUBCOMMANDS, classifyArgv, unknownArgText, usageText } from "../../src/index.js";

/**
 * D8-1 / D10-2 — `dexe-mcp --help`, `--version` and any typo used to fall
 * through the three-string subcommand allowlist into `main()`, open a
 * StdioServerTransport and hang the user's terminal forever, printing zero
 * bytes on stdout and the full env banner (signer address + keyring) on stderr.
 *
 * The unit half pins the classification and the text. The child-process half is
 * the anti-hang guard, and it MUST keep stdin open: with stdin closed the stdio
 * transport gets immediate EOF and even the UNFIXED build exits 0 in
 * milliseconds, so a "did not time out" assertion would pass on the bug.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const DIST = resolve(root, "dist", "index.js");
const pkgVersion = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;

describe("classifyArgv", () => {
  const argv = (...rest: string[]) => ["node", "/x/dist/index.js", ...rest];

  it("no argument means: serve on stdio", () => {
    expect(classifyArgv(argv())).toEqual({ kind: "server" });
  });

  // A host config can expand a template to "" — that must still serve, not
  // turn into "server disconnected" with no reason.
  it.each(["", "   ", "\t"])("a blank argv[2] (%j) still serves", (blank) => {
    expect(classifyArgv(argv(blank))).toEqual({ kind: "server" });
  });

  // Users copy transport flags from other MCP servers' configs; those launch
  // shapes work today and must keep working.
  it.each(["--stdio", "--transport=stdio", "--mcp"])("transport passthrough %s still serves", (flag) => {
    expect(classifyArgv(argv(flag))).toEqual({ kind: "server" });
  });

  it.each([...SUBCOMMANDS])("dispatches the %s subcommand", (name) => {
    expect(classifyArgv(argv(name))).toEqual({ kind: "subcommand", name });
  });

  it.each(["--help", "-h", "help"])("%s is a help request", (flag) => {
    expect(classifyArgv(argv(flag))).toEqual({ kind: "help" });
  });

  it.each(["--version", "-v", "-V"])("%s is a version request", (flag) => {
    expect(classifyArgv(argv(flag))).toEqual({ kind: "version" });
  });

  it.each(["docter", "skils", "bogus", "--strict"])("%s is an unknown argument", (arg) => {
    expect(classifyArgv(argv(arg))).toEqual({ kind: "unknown", arg });
  });
});

describe("usageText", () => {
  const text = usageText("9.9.9");

  it("names the version and the USAGE heading", () => {
    expect(text).toContain("9.9.9");
    expect(text).toContain("USAGE");
  });

  // Looped over SUBCOMMANDS, not a hard-coded list: a fourth subcommand cannot
  // land half-documented.
  it.each([...SUBCOMMANDS])("documents the %s subcommand", (name) => {
    expect(text).toContain(`dexe-mcp ${name}`);
  });

  it("documents --help and --version", () => {
    expect(text).toContain("--help");
    expect(text).toContain("--version");
  });

  // Every flag in the usage text must actually exist; a documented no-op is the
  // same class of bug as a missing help screen. These two are real as of 0.34.0
  // (src/cli/doctor.ts parseDoctorArgs).
  it("only advertises doctor flags that exist", () => {
    expect(text).toContain("--strict");
    expect(text).toContain("--probe-pin");
  });
});

describe("unknownArgText", () => {
  const text = unknownArgText("docter", "1.2.3");

  it("names the bad token, the valid set and the host-config remedy", () => {
    expect(text).toContain("unknown command 'docter'");
    for (const name of SUBCOMMANDS) expect(text).toContain(name);
    expect(text).toContain("args");
    expect(text).toContain("USAGE");
  });
});

/* ───────────────────────── live child process ───────────────────────────── */

interface ChildRun {
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
}

/**
 * Spawn the built bin with stdin PIPED AND NEVER ENDED — i.e. a real terminal.
 * cwd is an empty temp dir and DEXE_ENV_FILE points at a nonexistent path so no
 * developer `.env` (or hot key) leaks into the child.
 */
function spawnCli(args: string[], timeoutMs = 5000): Promise<ChildRun> {
  return new Promise((done) => {
    const cwd = mkdtempSync(resolve(tmpdir(), "dexe-cli-"));
    const child = spawn(process.execPath, [DIST, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, DEXE_ENV_FILE: resolve(cwd, "nonexistent.env") },
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, err, timedOut });
    });
  });
}

// `npm run build` before `npm test` is the project contract (a pack-contents
// test already asserts dist/index.js ships), but skip loudly on a fresh clone
// rather than failing for the wrong reason.
const describeDist = existsSync(DIST) ? describe : describe.skip;

describeDist("the built bin answers argv instead of opening a transport", () => {
  it("--help prints usage, exits 0, and leaks no env banner", async () => {
    const r = await spawnCli(["--help"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/USAGE/);
    expect(r.out).toContain(pkgVersion);
    // The whole point of answering before loadEnvironment(): no transport, and
    // no signer address on a help screen.
    expect(r.err).not.toMatch(/connected on stdio/);
    expect(r.err).not.toMatch(/0x[0-9a-fA-F]{8}/);
  }, 20_000);

  it("-h behaves like --help", async () => {
    const r = await spawnCli(["-h"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/USAGE/);
  }, 20_000);

  it("--version prints exactly the package version", async () => {
    const r = await spawnCli(["--version"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pkgVersion);
    expect(r.err).not.toMatch(/connected on stdio/);
  }, 20_000);

  it("an unknown subcommand names the typo and exits 2 instead of hanging", async () => {
    const r = await spawnCli(["docter"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command 'docter'/);
    expect(r.err).not.toMatch(/connected on stdio/);
  }, 20_000);
});
