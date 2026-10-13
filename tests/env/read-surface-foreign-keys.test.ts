import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, READ_ENV_SURFACE } from "@dexe-network/dexe-mcp/core";
import { FULL_ENV_SURFACE } from "../../src/env/schema.js";

/**
 * A9 — the read edition shares a `.env` with the write edition. Its loader
 * report (banner, doctor `env.file`) must neither list nor name the write
 * edition's variables; the binary then drops them from the process. The full
 * server's report is unchanged.
 *
 * `dropWriteEnv` (what the read binary does with them) is pinned with the read
 * edition, in @dexe-network/dexe-mcp's copy of this file; that its foreign list
 * is exactly this repo's write and dev vars is tests/env/edition-spec.test.ts.
 */

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOUCHED = ["DEXE_RPC_URL_MAINNET", "DEXE_PRIVATE_KEY", "DEXE_PINATA_JWT", "AGENT_PK_2", "DEXE_AGENT_LEDGER_PATH"];
const dir = mkdtempSync(join(tmpdir(), "dexe-read-foreign-"));

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

function writeEnv(body: string): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(p, body);
  return p;
}

describe("the read surface's .env report", () => {
  it("lists and names only read variables; write ones are neither applied-listed nor shadow-warned", () => {
    process.env.DEXE_PINATA_JWT = "from-host"; // would be "shadowed" by the file
    const path = writeEnv(
      `DEXE_RPC_URL_MAINNET=https://bsc.example\nDEXE_PRIVATE_KEY=${KEY}\nDEXE_PINATA_JWT=from-file\nAGENT_PK_2=${KEY}\nDEXE_AGENT_LEDGER_PATH=/x\n`,
    );
    const r = loadEnvFile(path, new Set(), READ_ENV_SURFACE);
    expect(r.keysApplied).toEqual(["DEXE_RPC_URL_MAINNET"]);
    expect(r.keysShadowed).toEqual([]);
    expect(r.fileKeys).toEqual(["DEXE_RPC_URL_MAINNET"]);
    expect(r.unknownDexeVars).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE_KEY|PINATA_JWT|AGENT_PK|LEDGER/);
  });

  it("the full server's report still lists every key it read", () => {
    process.env.DEXE_PINATA_JWT = "from-host";
    const path = writeEnv(`DEXE_RPC_URL_MAINNET=https://bsc.example\nDEXE_PRIVATE_KEY=${KEY}\nDEXE_PINATA_JWT=from-file\n`);
    const r = loadEnvFile(path, new Set(), FULL_ENV_SURFACE);
    expect(r.keysApplied.sort()).toEqual(["DEXE_PRIVATE_KEY", "DEXE_RPC_URL_MAINNET"]);
    expect(r.keysShadowed).toEqual(["DEXE_PINATA_JWT"]);
  });

  it("a write key on the last line without a newline is not named", () => {
    const path = writeEnv(`DEXE_RPC_URL_MAINNET=https://bsc.example\nDEXE_PRIVATE_KEY=${KEY}`);
    const r = loadEnvFile(path, new Set(), READ_ENV_SURFACE);
    const trap = r.parseIssues.find((i) => i.trap === "no-trailing-newline");
    expect(trap).toBeDefined();
    expect(trap!.message).not.toContain("DEXE_PRIVATE_KEY");
  });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
