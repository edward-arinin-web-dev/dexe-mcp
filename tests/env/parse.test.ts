import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/env/parse.js";

/**
 * Unit coverage for the zod-driven env parser. Each test isolates one key
 * and feeds it via an explicit env object — never touches the real
 * process.env so the suite stays parallel-safe.
 */

describe("parseEnv", () => {
  it("returns empty result for an empty env", () => {
    const r = parseEnv({});
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({});
  });

  it("accepts a valid URL for an RPC var", () => {
    const r = parseEnv({ DEXE_RPC_URL_MAINNET: "https://bsc-dataseed.binance.org" });
    expect(r.issues).toEqual([]);
    expect(r.values.DEXE_RPC_URL_MAINNET).toBe("https://bsc-dataseed.binance.org");
  });

  it("rejects a non-URL for an RPC var", () => {
    const r = parseEnv({ DEXE_RPC_URL_MAINNET: "not-a-url" });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.key).toBe("DEXE_RPC_URL_MAINNET");
    expect(r.issues[0]!.severity).toBe("error");
    expect(r.issues[0]!.message).toMatch(/Invalid DEXE_RPC_URL_MAINNET/);
  });

  it("rejects DEXE_CHAIN_ID that is not a positive integer", () => {
    const r = parseEnv({ DEXE_CHAIN_ID: "abc" });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.key).toBe("DEXE_CHAIN_ID");
  });

  it("accepts a valid 64-hex private key", () => {
    const r = parseEnv({ DEXE_PRIVATE_KEY: "0x" + "a".repeat(64) });
    expect(r.issues).toEqual([]);
    expect(r.values.DEXE_PRIVATE_KEY).toBeTruthy();
  });

  it("rejects a malformed private key and redacts the value in the message", () => {
    const r = parseEnv({ DEXE_PRIVATE_KEY: "0xshort" });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toContain("<redacted>");
    expect(r.issues[0]!.message).not.toContain("0xshort");
  });

  it("trims whitespace before validating", () => {
    const r = parseEnv({ DEXE_RPC_URL_MAINNET: "  https://example.com  " });
    expect(r.issues).toEqual([]);
    expect(r.values.DEXE_RPC_URL_MAINNET).toBe("https://example.com");
  });

  it("ignores unset (blank) optional vars without complaint", () => {
    const r = parseEnv({ DEXE_PINATA_JWT: "", DEXE_BACKEND_API_URL: "   " });
    expect(r.issues).toEqual([]);
    expect(r.values.DEXE_PINATA_JWT).toBeUndefined();
  });

  it("validates DEXE_CONTRACTS_REGISTRY as a 40-hex address", () => {
    const good = parseEnv({ DEXE_CONTRACTS_REGISTRY: "0x" + "a".repeat(40) });
    expect(good.issues).toEqual([]);
    const bad = parseEnv({ DEXE_CONTRACTS_REGISTRY: "0xnotanaddress" });
    expect(bad.issues).toHaveLength(1);
  });
});
