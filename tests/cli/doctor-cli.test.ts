import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `dexe-mcp doctor` (the CLI) keeps covering BOTH editions after 1.0.0 split
 * the tools: the read checks (the read package's doctor engine — RPC, IPFS
 * gateway, subgraph, backend) and the write ones (surface mode, signer,
 * Pinata, WalletConnect, state), over the full env surface. In the MCP host
 * the two halves are `dexe_doctor` (read server) and `dexe_write_doctor`.
 *
 * Hermetic: no RPC (public fallback off), every endpoint a closed local port,
 * HOME and cwd pointed at an empty directory so no real .env is read.
 */
const ROOT = resolve(__dirname, "..", "..");
const DIST = resolve(ROOT, "dist", "index.js");
const work = mkdtempSync(join(tmpdir(), "dexe-doctor-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function doctor(extra: Record<string, string> = {}) {
  const dead = "http://127.0.0.1:9";
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    HOME: work,
    USERPROFILE: work,
    DEXE_DISABLE_PUBLIC_RPC: "1",
    DEXE_SUBGRAPH_POOLS_URL: `${dead}/pools`,
    DEXE_SUBGRAPH_VALIDATORS_URL: `${dead}/validators`,
    DEXE_SUBGRAPH_INTERACTIONS_URL: `${dead}/interactions`,
    DEXE_BACKEND_API_URL: dead,
    DEXE_IPFS_GATEWAY: dead,
    DEXE_IPFS_DISABLE_PUBLIC_FALLBACK: "1",
    DEXE_STATE_PATH: join(work, "state.json"),
    ...extra,
  };
  return spawnSync(process.execPath, [DIST, "doctor"], { cwd: work, env, encoding: "utf8", timeout: 60_000, input: "" });
}

describe.skipIf(!existsSync(DIST))("dexe-mcp doctor (CLI)", () => {
  it("runs the read checks and the write checks in one report", () => {
    const r = doctor();
    const out = `${r.stdout}\n${r.stderr}`;
    // read half (the read package's engine)
    expect(out).toMatch(/subgraph\./);
    expect(out).toMatch(/backend\.reachable/);
    // write half
    expect(out).toContain("surface.mode");
    expect(out).toContain("signer.mode");
    expect(out).toContain("write-only");
  }, 60_000);

  it("reports the standalone surface when DEXE_WRITE_STANDALONE=1", () => {
    const r = doctor({ DEXE_WRITE_STANDALONE: "1" });
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/surface\.mode\s+standalone/);
  }, 60_000);
});
