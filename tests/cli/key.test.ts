import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Wallet } from "ethers";
import {
  keyUsage,
  parseEnvAssignment,
  removeEnvKeyValue,
  setEnvValue,
  writeFileAtomic,
} from "../../src/cli/key.js";
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

});

describe("import --from-env: .env editing (security review fix 7)", () => {
  const K = "0x" + "ab".repeat(32);
  const OTHER = "0x" + "cd".repeat(32);
  const KEY = "DEXE_PRIVATE_KEY";

  it("removes `KEY=0x… # comment`, `export KEY=…`, and quoted values", () => {
    for (const line of [
      `${KEY}=${K} # my hot key`,
      `export ${KEY}=${K}`,
      `${KEY}="${K}"`,
      `${KEY}='${K}'`,
      `  ${KEY} = ${K}  `,
      `${KEY}=${K.slice(2)}`, // without 0x
    ]) {
      const r = removeEnvKeyValue(`A=1\n${line}\nB=2\n`, KEY, K);
      expect(r.removed, line).toBe(1);
      expect(r.content, line).toBe("A=1\nB=2\n");
    }
    expect(parseEnvAssignment(`${KEY}=${K} # c`, KEY)).toBe(K);
    expect(parseEnvAssignment(`${KEY}="${K}" # c`, KEY)).toBe(K);
    expect(parseEnvAssignment(`# ${KEY}=${K}`, KEY)).toBeNull();
  });

  it("never touches a commented-out key line, but reports it", () => {
    const src = `# ${KEY}=${K}\n#${KEY}=${OTHER}\n${KEY}=${K}\n`;
    const r = removeEnvKeyValue(src, KEY, K);
    expect(r.removed).toBe(1);
    expect(r.commented).toBe(2);
    expect(r.content).toBe(`# ${KEY}=${K}\n#${KEY}=${OTHER}\n`);
  });

  it("leaves a line holding a DIFFERENT key alone", () => {
    const r = removeEnvKeyValue(`${KEY}=${OTHER}\n`, KEY, K);
    expect(r.removed).toBe(0);
    expect(r.content).toBe(`${KEY}=${OTHER}\n`);
  });

  it("preserves every other line byte-for-byte: CRLF, mixed endings, BOM, spacing, no trailing newline", () => {
    const src = `﻿A = 1 \r\n  # note\t\r\n${KEY}=${K}\r\nB='x y'\nC=3`;
    const r = removeEnvKeyValue(src, KEY, K);
    expect(r.content).toBe(`﻿A = 1 \r\n  # note\t\r\nB='x y'\nC=3`);
    // Then switching the mode appends with the file's own CRLF, terminating the last line first.
    expect(setEnvValue(r.content, "DEXE_SIGNER_MODE", "keystore")).toBe(
      `﻿A = 1 \r\n  # note\t\r\nB='x y'\nC=3\r\nDEXE_SIGNER_MODE=keystore\r\n`,
    );
    // The key as the very first (BOM) line.
    expect(removeEnvKeyValue(`﻿${KEY}=${K}\nA=1\n`, KEY, K).content).toBe("﻿A=1\n");
  });

  it("setEnvValue rewrites an existing assignment in place (keeping its line ending) or appends one", () => {
    expect(setEnvValue("A=1\nDEXE_SIGNER_MODE=walletconnect\nB=2\n", "DEXE_SIGNER_MODE", "keystore")).toBe(
      "A=1\nDEXE_SIGNER_MODE=keystore\nB=2\n",
    );
    expect(setEnvValue("A=1\r\nexport DEXE_SIGNER_MODE=readonly # x\r\n", "DEXE_SIGNER_MODE", "keystore")).toBe(
      "A=1\r\nDEXE_SIGNER_MODE=keystore\r\n",
    );
    expect(setEnvValue("A=1", "DEXE_SIGNER_MODE", "keystore")).toBe("A=1\nDEXE_SIGNER_MODE=keystore\n");
    expect(setEnvValue("", "DEXE_SIGNER_MODE", "keystore")).toBe("DEXE_SIGNER_MODE=keystore\n");
  });

  it("writes atomically (temp + rename in the same directory), leaving no temp file", () => {
    const f = join(dir, "atomic.env");
    writeFileSync(f, "OLD=1\n");
    writeFileAtomic(f, "NEW=2\n");
    expect(readFileSync(f, "utf8")).toBe("NEW=2\n");
    expect(readdirSync(dir).filter((n) => n.startsWith("atomic.env.") && n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("key CLI build", () => {
  it("the built CLI is the one tested above", () => {
    if (!existsSync(DIST)) return;
    expect(execFileSync(process.execPath, [DIST, "--version"], { encoding: "utf8" }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
