import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENV_REGISTRY,
  DYNAMIC_PER_CHAIN_RPC_RE,
  envKeys,
  isKnownEnvKey,
} from "../../src/env/schema.js";

/**
 * Drift guards between the schema, the example file, and the docs surface.
 *
 * These tests run offline. They do NOT verify zod schema semantics (that's
 * parse.test.ts) — they verify that the SET of recognized env keys is
 * coherent across every place we document it.
 */

describe("ENV_REGISTRY shape", () => {
  it("every entry has a category, doc, schema, and example", () => {
    for (const [key, e] of Object.entries(ENV_REGISTRY)) {
      expect(e.category, `${key}.category`).toBeTruthy();
      expect(e.doc, `${key}.doc`).toBeTruthy();
      expect(e.schema, `${key}.schema`).toBeTruthy();
      // example may be "" but the field must exist
      expect(typeof e.example, `${key}.example type`).toBe("string");
    }
  });

  it("nothing is marked required (current product invariant)", () => {
    // If you make something required, also update the startup banner and the
    // wizard so users learn about it before tools start failing.
    for (const [key, e] of Object.entries(ENV_REGISTRY)) {
      expect(e.required, `${key} should not be required`).toBe(false);
    }
  });

  it("envKeys() returns the full key set", () => {
    expect(envKeys().sort()).toEqual(Object.keys(ENV_REGISTRY).sort());
  });

  it("isKnownEnvKey() recognizes every registered key and rejects others", () => {
    for (const k of envKeys()) expect(isKnownEnvKey(k)).toBe(true);
    expect(isKnownEnvKey("DEXE_NOT_REAL")).toBe(false);
    expect(isKnownEnvKey("HOME")).toBe(false);
  });

  it("DYNAMIC_PER_CHAIN_RPC_RE matches DEXE_RPC_URL_<digits> only", () => {
    expect(DYNAMIC_PER_CHAIN_RPC_RE.test("DEXE_RPC_URL_1")).toBe(true);
    expect(DYNAMIC_PER_CHAIN_RPC_RE.test("DEXE_RPC_URL_10")).toBe(true);
    expect(DYNAMIC_PER_CHAIN_RPC_RE.test("DEXE_RPC_URL_TESTNET")).toBe(false);
    expect(DYNAMIC_PER_CHAIN_RPC_RE.test("DEXE_PRIVATE_KEY")).toBe(false);
  });
});

describe(".env.example drift guard", () => {
  const envExamplePath = resolve(import.meta.dirname, "..", "..", ".env.example");
  const raw = readFileSync(envExamplePath, "utf8");
  // Extract every DEXE_* key on the LHS of `=` (commented or not).
  const exampleKeys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*#?\s*(DEXE_[A-Z0-9_]+)\s*=/.exec(line);
    if (m) exampleKeys.add(m[1]!);
  }

  it(".env.example references at least one DEXE_* var (sanity)", () => {
    expect(exampleKeys.size).toBeGreaterThan(0);
  });

  it("every DEXE_* key in .env.example is in the schema", () => {
    const unknown: string[] = [];
    for (const k of exampleKeys) {
      if (DYNAMIC_PER_CHAIN_RPC_RE.test(k)) continue;
      if (!isKnownEnvKey(k)) unknown.push(k);
    }
    expect(unknown, `.env.example has unknown DEXE_* keys: ${unknown.join(", ")}`).toEqual([]);
  });
});
