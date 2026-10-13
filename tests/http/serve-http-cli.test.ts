import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { READ_TOOLS } from "../../src/editions.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The built bins: `dexe-mcp-read serve-http`, and `dexe-mcp serve-http`, which
 * starts the same entry in a child process. Proves the things only a real
 * process can — that NO .env file is loaded (cwd, DEXE_ENV_FILE), that a
 * signing key placed in one never reaches the server or its log, that the read
 * edition's 54 tools are served whatever DEXE_TOOLSETS says, that nothing is
 * written under HOME, and that the server refuses to start on the shared
 * built-in endpoints. Needs `npm run build` first, like tests/cli/usage.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const READ_BIN = resolve(here, "..", "..", "dist", "read", "bin.js");
const FULL_BIN = resolve(here, "..", "..", "dist", "index.js");
const DIST = READ_BIN;

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

function runToExit(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  bin: string = DIST,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

interface Running {
  child: ChildProcess;
  listening: Record<string, unknown>;
  stdout: () => string;
  stderr: () => string;
}

/** Spawn `serve-http --port 0` and resolve with its `listening` log line. */
function startBin(env: NodeJS.ProcessEnv, cwd: string, bin: string = DIST): Promise<Running> {
  const child = spawn(process.execPath, [bin, "serve-http", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no listening line within 20s:\n${err}`)), 20_000);
    child.stderr!.on("data", (d) => {
      err += d;
      for (const line of err.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const j = JSON.parse(line) as Record<string, unknown>;
          if (j.event === "listening") {
            clearTimeout(timer);
            ok({ child, listening: j, stdout: () => out, stderr: () => err });
          }
        } catch {
          // partial line
        }
      }
    });
    child.on("exit", (code) => fail(new Error(`exited ${code} before listening:\n${err}`)));
  });
}

/** Windows will not delete a live process's cwd: wait for the exit, not just the signal. */
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}

/** Every file under `dir`, relative — a server that writes nothing leaves this empty. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? (e as { path?: string }).path ?? "", e.name));
}

describe.skipIf(!existsSync(DIST))("dexe-mcp-read serve-http (built bin)", () => {
  let work: string;
  let stateDir: string;
  let home: string;
  let run: Running;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "dexe-serve-http-"));
    stateDir = mkdtempSync(join(tmpdir(), "dexe-serve-http-state-"));
    // An empty HOME: whatever lands under it was written by the server.
    home = mkdtempSync(join(tmpdir(), "dexe-serve-http-home-"));
    // A .env that WOULD switch on signing, the full tool surface and any
    // browser origin if it were loaded.
    const envFile = join(work, ".env");
    writeFileSync(
      envFile,
      `DEXE_SIGNER_MODE=unattended\nDEXE_PRIVATE_KEY=${TEST_KEY}\nDEXE_TOOLSETS=full\nDEXE_HTTP_ALLOWED_ORIGINS=*\n`,
    );
    run = await startBin(
      cleanEnv({
        DEXE_ENV_FILE: envFile,
        DEXE_STATE_PATH: join(stateDir, "state.json"),
        DEXE_TOOLSETS: "full",
        DEXE_HTTP_ALLOW_SHARED_DEFAULTS: "1",
        // planted in the process env, not a file: still never read or echoed
        DEXE_PINATA_JWT: "planted-jwt-value",
        DEXE_AGENT_PK_1: TEST_KEY,
        HOME: home,
        USERPROFILE: home,
      }),
      work,
    );
  }, 30_000);

  afterAll(async () => {
    await stop(run?.child);
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("starts on the requested ephemeral port with the read edition's 54 tools, marked pre-release", () => {
    const l = run.listening;
    expect(l).toMatchObject({ mode: "serve-http", server: "dexe-mcp-read", preRelease: true, endpoint: "/mcp", host: "127.0.0.1" });
    expect(l.port).toEqual(expect.any(Number));
    expect(l.tools).toBe(READ_TOOLS.length);
    // The env was reduced to the allowlist; only a count is logged.
    expect(l.removedEnvVars).toEqual(expect.any(Number));
    // The .env's `DEXE_HTTP_ALLOWED_ORIGINS=*` did not apply: it was never loaded.
    expect(l.allowedOrigins).toBe(0);
    // The opt-in is loud.
    expect(run.stderr()).toMatch(/"event":"shared_defaults"/);
  });

  it("serves MCP and health over HTTP", async () => {
    const base = `http://127.0.0.1:${run.listening.port as number}`;
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

  it("never prints a signer or a planted secret, logs access to stdout, and writes nothing to disk", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const out = `${run.stderr()}\n${run.stdout()}`.toLowerCase();
    expect(out).not.toContain(TEST_ADDR_PREFIX.toLowerCase());
    expect(out).not.toContain("planted-jwt-value");
    expect(out).not.toContain(TEST_KEY.slice(2, 20));
    expect(run.stdout()).toMatch(/"event":"http"/);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(filesUnder(home), "remote mode writes nothing under HOME").toEqual([]);
  });

  it("refuses to start on the shared built-in endpoints and names the vars to set", async () => {
    const r = await runToExit(["serve-http", "--port", "0"], cleanEnv({}), work);
    expect(r.code).toBe(2);
    for (const v of ["DEXE_RPC_URL_MAINNET", "DEXE_SUBGRAPH_POOLS_URL", "DEXE_BACKEND_API_URL", "DEXE_HTTP_ALLOW_SHARED_DEFAULTS"]) {
      expect(r.err).toContain(v);
    }
    expect(r.err).toMatch(/LOCAL TESTING ONLY/);
  }, 30_000);

  it("starts without the opt-in once the operator names their own endpoints", async () => {
    const own = "https://gateway.thegraph.com/api/0123456789abcdef0123456789abcdef/subgraphs/id/X";
    const ok = await startBin(
      cleanEnv({
        DEXE_RPC_URL_MAINNET: "http://127.0.0.1:9",
        DEXE_SUBGRAPH_POOLS_URL: own,
        DEXE_SUBGRAPH_VALIDATORS_URL: own,
        DEXE_SUBGRAPH_INTERACTIONS_URL: own,
        DEXE_BACKEND_API_URL: "http://127.0.0.1:9",
      }),
      work,
    );
    try {
      expect(ok.listening.chains).toEqual([56]);
      expect(ok.stderr()).not.toMatch(/shared_defaults/);
    } finally {
      await stop(ok.child);
    }
  }, 30_000);

  it("--help exits 0 and says PRE-RELEASE; a typo exits 2; a public bind without a Host allowlist refuses to start", async () => {
    const env = cleanEnv({});
    const help = await runToExit(["serve-http", "--help"], env, work);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/PRE-RELEASE/);
    const typo = await runToExit(["serve-http", "--prot", "1"], env, work);
    expect(typo.code).toBe(2);
    expect(typo.err).toMatch(/unknown option '--prot'/);
    const open = await runToExit(["serve-http", "--host", "0.0.0.0", "--port", "0"], env, work);
    expect(open.code).toBe(2);
    expect(open.err).toMatch(/DEXE_HTTP_ALLOWED_HOSTS is required/);
  }, 45_000);
});

describe.skipIf(!existsSync(FULL_BIN) || !existsSync(READ_BIN))("dexe-mcp serve-http delegates to the read edition", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "dexe-serve-http-full-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("answers with the read edition's usage, refusals and exit codes", async () => {
    const env = cleanEnv({});
    const help = await runToExit(["serve-http", "--help"], env, work, FULL_BIN);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^dexe-mcp-read .*PRE-RELEASE/);
    const typo = await runToExit(["serve-http", "--prot", "1"], env, work, FULL_BIN);
    expect(typo.code).toBe(2);
    expect(typo.err).toMatch(/unknown option '--prot'/);
    const shared = await runToExit(["serve-http", "--port", "0"], env, work, FULL_BIN);
    expect(shared.code).toBe(2);
    expect(shared.err).toMatch(/refusing to start on shared built-in defaults/);
  }, 45_000);

  it("hands the child only the read allowlist, and the child exits when the parent is SIGKILLed", async () => {
    const run = await startBin(
      cleanEnv({
        DEXE_HTTP_ALLOW_SHARED_DEFAULTS: "1",
        DEXE_PRIVATE_KEY: TEST_KEY,
        DEXE_PINATA_JWT: "planted-jwt-value",
        FOO_SECRET: "planted-foo",
      }),
      work,
      FULL_BIN,
    );
    const port = run.listening.port as number;
    try {
      expect(run.listening).toMatchObject({ server: "dexe-mcp-read", tools: READ_TOOLS.length });
      // The parent filtered its env: nothing outside the allowlist reached the child to remove.
      expect(run.listening.removedEnvVars).toBe(0);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      run.child.kill("SIGKILL"); // no handler runs in the parent
    }
    // The child sees its IPC channel close and shuts down, freeing the port.
    const deadline = Date.now() + 15_000;
    let up = true;
    while (up && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then(
        () => true,
        () => false,
      );
    }
    expect(up, "orphaned serve-http child still holds the port").toBe(false);
  }, 45_000);
});

describe.skipIf(!existsSync(READ_BIN) || process.platform === "win32")("serve-http signals (POSIX)", () => {
  it("a second SIGINT during the drain does not kill the process: it still exits 0", async () => {
    const work = mkdtempSync(join(tmpdir(), "dexe-serve-http-sig-"));
    try {
      const run = await startBin(cleanEnv({ DEXE_HTTP_ALLOW_SHARED_DEFAULTS: "1" }), work);
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
        run.child.once("exit", (code, signal) => r({ code, signal })),
      );
      run.child.kill("SIGINT");
      run.child.kill("SIGINT");
      const r = await exited;
      expect(r).toEqual({ code: 0, signal: null });
      expect(run.stderr().match(/"event":"shutdown"/g)).toHaveLength(1);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
