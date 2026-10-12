import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The built bin: `dexe-mcp serve-http`. Proves the things only a real process
 * can — that NO .env file is loaded (cwd, DEXE_ENV_FILE), that a signing key
 * placed in one never reaches the server or its log, and that the profile is
 * forced to read-only whatever DEXE_TOOLSETS says. Needs `npm run build`
 * first, like tests/cli/usage.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "..", "..", "dist", "index.js");

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// Its address (Hardhat account #1). Must never appear in the server's output.
const TEST_ADDR_PREFIX = "0x70997970";

/** Parent env minus anything DeXe-specific, so a developer's own config cannot leak in. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DEXE_|AGENT_|SWARM_)/.test(k) || k === "PORT") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function runToExit(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [DIST, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => child.kill(), 15_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      done({ code, out, err });
    });
  });
}

describe.skipIf(!existsSync(DIST))("dexe-mcp serve-http (built bin)", () => {
  let work: string;
  let stateDir: string;
  let child: ChildProcess;
  let stderr = "";
  let stdout = "";
  let listening: Record<string, unknown>;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "dexe-serve-http-"));
    stateDir = mkdtempSync(join(tmpdir(), "dexe-serve-http-state-"));
    // A .env that WOULD switch on signing and the full tool surface if loaded.
    const envFile = join(work, ".env");
    writeFileSync(envFile, `DEXE_PRIVATE_KEY=${TEST_KEY}\nDEXE_TOOLSETS=full\nDEXE_HTTP_ALLOWED_ORIGINS=*\n`);
    child = spawn(process.execPath, [DIST, "serve-http", "--port", "0"], {
      cwd: work,
      env: cleanEnv({ DEXE_ENV_FILE: envFile, DEXE_STATE_PATH: join(stateDir, "state.json"), DEXE_TOOLSETS: "full" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (stdout += d));
    listening = await new Promise<Record<string, unknown>>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`no listening line within 20s:\n${stderr}`)), 20_000);
      child.stderr!.on("data", (d) => {
        stderr += d;
        for (const line of stderr.split("\n")) {
          if (!line.startsWith("{")) continue;
          try {
            const j = JSON.parse(line) as Record<string, unknown>;
            if (j.event === "listening") {
              clearTimeout(timer);
              ok(j);
            }
          } catch {
            // partial line
          }
        }
      });
      child.on("exit", (code) => fail(new Error(`exited ${code} before listening:\n${stderr}`)));
    });
  }, 30_000);

  afterAll(async () => {
    // Windows will not delete a directory that is a live process's cwd: wait
    // for the exit, not just the kill signal.
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("starts on the requested ephemeral port, read profile only, marked experimental", () => {
    expect(listening).toMatchObject({ mode: "serve-http", experimental: true, endpoint: "/mcp", host: "127.0.0.1" });
    expect(listening.port).toEqual(expect.any(Number));
    expect(listening.tools as number).toBeLessThan(60);
    // The .env was not loaded, so there was nothing write-side to remove…
    expect(listening.ignoredWriteSideEnv).toEqual([]);
    // …and its `DEXE_HTTP_ALLOWED_ORIGINS=*` did not apply either.
    expect(listening.allowedOrigins).toBe(0);
  });

  it("serves MCP and health over HTTP", async () => {
    const base = `http://127.0.0.1:${listening.port as number}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cli-test", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);
    const body = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("dexe-mcp-read");
  });

  it("never prints the signer, writes an access log line to stdout, and leaves DEXE_STATE_PATH empty", async () => {
    await new Promise((r) => setTimeout(r, 100));
    expect(stderr.toLowerCase()).not.toContain(TEST_ADDR_PREFIX.toLowerCase());
    expect(stdout.toLowerCase()).not.toContain(TEST_ADDR_PREFIX.toLowerCase());
    expect(stdout).toMatch(/"event":"http"/);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("--help exits 0 and says EXPERIMENTAL; a typo exits 2; a public bind without a Host allowlist refuses to start", async () => {
    const env = cleanEnv({});
    const help = await runToExit(["serve-http", "--help"], env, work);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/EXPERIMENTAL/);
    const typo = await runToExit(["serve-http", "--prot", "1"], env, work);
    expect(typo.code).toBe(2);
    expect(typo.err).toMatch(/unknown option '--prot'/);
    const open = await runToExit(["serve-http", "--host", "0.0.0.0", "--port", "0"], env, work);
    expect(open.code).toBe(2);
    expect(open.err).toMatch(/DEXE_HTTP_ALLOWED_HOSTS is required/);
  }, 45_000);
});
