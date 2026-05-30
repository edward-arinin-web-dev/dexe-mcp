import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hintFor, requireEnv } from "../../src/lib/requireEnv.js";

/**
 * Unit coverage for the env guard helper used by hot tool paths
 * (read.ts, txSend.ts). Snapshots process.env so the suite stays
 * parallel-safe.
 */

describe("requireEnv", () => {
  const original: Record<string, string | undefined> = {};
  const touched = ["DEXE_PINATA_JWT", "DEXE_BACKEND_API_URL"] as const;

  beforeEach(() => {
    for (const k of touched) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of touched) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("returns ok when every listed key is set", () => {
    process.env.DEXE_PINATA_JWT = "abc";
    const r = requireEnv(["DEXE_PINATA_JWT"]);
    expect("ok" in r).toBe(true);
    if ("ok" in r) expect(r.ok.DEXE_PINATA_JWT).toBe("abc");
  });

  it("returns error with paste-ready remediation when a key is missing", () => {
    delete process.env.DEXE_PINATA_JWT;
    const r = requireEnv(["DEXE_PINATA_JWT"]);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toMatch(/Missing required env: DEXE_PINATA_JWT/);
      expect(r.remediation).toContain("DEXE_PINATA_JWT");
      expect(r.remediation).toContain("restart");
    }
  });

  it("treats blank/whitespace as unset", () => {
    process.env.DEXE_PINATA_JWT = "   ";
    const r = requireEnv(["DEXE_PINATA_JWT"]);
    expect("error" in r).toBe(true);
  });

  it("hintFor includes enablesFlows when present", () => {
    const h = hintFor(["DEXE_PINATA_JWT"]);
    expect(h).toContain("ipfs-upload");
    expect(h).toContain("DEXE_PINATA_JWT");
  });
});
