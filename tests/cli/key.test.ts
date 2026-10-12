import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Wallet } from "ethers";
import { keyUsage, stripEnvKey, upsertEnvKey } from "../../src/cli/key.js";
import { SUBCOMMANDS, usageText } from "../../src/index.js";
import { encryptPrivateKey, writeKeystoreFile } from "../../src/lib/keystore.js";

/**
 * `dexe-mcp key` — the secret-handling commands refuse without a TTY (an AI
 * agent's shell is a pipe, so it cannot type the password), the read-only ones
 * work anywhere, and `import --from-env` edits .env text precisely.
 */
const ROOT = resolve(__dirname, "..", "..");
const DIST = join(ROOT, "dist", "index.js");
let dir: string;
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dexe-keycli-"));
  writeKeystoreFile(dir, await encryptPrivateKey(PK, "password123", { N: 1024, r: 8, p: 1 }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[]) {
  return spawnSync(process.execPath, [DIST, ...args], {
    cwd: dir, // no .env here
    env: { ...process.env, DEXE_KEYSTORE_PATH: dir, DEXE_ENV_FILE: join(dir, "none.env") },
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe.skipIf(!existsSync(DIST))("dexe-mcp key (built CLI)", () => {
  for (const cmd of ["create", "import", "change-password", "remove"]) {
    it(`'${cmd}' refuses without a TTY`, () => {
      const r = cli(["key", cmd]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/needs an interactive terminal/);
    });
  }

  it("'list' and 'export-address' work without a TTY", () => {
    const addr = new Wallet(PK).address;
    const list = cli(["key", "list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(addr);
    const exp = cli(["key", "export-address"]);
    expect(exp.status).toBe(0);
    expect(exp.stdout.trim()).toBe(addr);
    expect(exp.stdout).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("'--help' prints the usage", () => {
    const r = cli(["key", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("change-password");
  });
});

describe("key CLI helpers", () => {
  it("is a documented subcommand", () => {
    expect(SUBCOMMANDS).toContain("key");
    expect(usageText("x")).toMatch(/dexe-mcp key <command>/);
    expect(keyUsage()).not.toMatch(/export-private/);
  });

  it("stripEnvKey removes only the key's lines, keeping CRLF", () => {
    const src = "A=1\r\nDEXE_PRIVATE_KEY=0xabc\r\n# DEXE_PRIVATE_KEY=commented stays\r\nexport DEXE_PRIVATE_KEY=0xdef\r\nB=2\r\n";
    const r = stripEnvKey(src, "DEXE_PRIVATE_KEY");
    expect(r.removed).toBe(2);
    expect(r.content).toBe("A=1\r\n# DEXE_PRIVATE_KEY=commented stays\r\nB=2\r\n");
  });

  it("upsertEnvKey replaces or appends, always ending in a newline (loadEnvFile drops a last line without one)", () => {
    expect(upsertEnvKey("A=1\nDEXE_SIGNER_MODE=walletconnect\n", "DEXE_SIGNER_MODE", "keystore")).toBe(
      "A=1\nDEXE_SIGNER_MODE=keystore\n",
    );
    expect(upsertEnvKey("A=1", "DEXE_SIGNER_MODE", "keystore")).toBe("A=1\nDEXE_SIGNER_MODE=keystore\n");
    expect(upsertEnvKey("A=1\n\n", "DEXE_SIGNER_MODE", "keystore")).toBe("A=1\nDEXE_SIGNER_MODE=keystore\n");
  });

  it("the built CLI is the one tested above", () => {
    if (!existsSync(DIST)) return;
    expect(execFileSync(process.execPath, [DIST, "--version"], { encoding: "utf8" }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
