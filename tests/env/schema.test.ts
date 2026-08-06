import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENV_REGISTRY,
  DYNAMIC_PER_CHAIN_RPC_RE,
  PER_CHAIN_SUBGRAPH_URL_RE,
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

/**
 * Env families whose members differ only by a numeric suffix. Two of them are
 * open-ended (the chain set a user points at is theirs, not ours) so they
 * cannot live in ENV_SPEC at all; the third is 16 near-identical spec entries.
 * One worked example documents the whole family — sixteen agent-key lines, or
 * one subgraph line per conceivable chain, would bury the file.
 *
 * The reverse guard below skips family members ONLY because this table makes
 * each family prove itself: every family must be represented in `.env.example`
 * by a CONCRETE member key. `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` shipped
 * undocumented precisely because a family with no fixed name is invisible to a
 * name-by-name check — so the family is what gets checked.
 */
const ENV_FAMILIES = [
  {
    label: "per-chain RPC — DEXE_RPC_URL_<chainId>",
    member: DYNAMIC_PER_CHAIN_RPC_RE,
  },
  {
    label: "per-chain subgraph — DEXE_SUBGRAPH_<KIND>_URL_<chainId>",
    member: PER_CHAIN_SUBGRAPH_URL_RE,
  },
  {
    label: "agent keyring — DEXE_AGENT_PK_<n> (slots 1–16)",
    member: /^DEXE_AGENT_PK_\d+$/,
  },
] as const;

describe(".env.example drift guard", () => {
  const envExamplePath = resolve(import.meta.dirname, "..", "..", ".env.example");
  const raw = readFileSync(envExamplePath, "utf8");
  // Extract every DEXE_* key on the LHS of `=` (commented or not).
  const exampleKeys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*#?\s*(DEXE_[A-Z0-9_]+)\s*=/.exec(line);
    if (m) exampleKeys.add(m[1]!);
  }
  const inFamily = (k: string) => ENV_FAMILIES.some((f) => f.member.test(k));

  it(".env.example references at least one DEXE_* var (sanity)", () => {
    expect(exampleKeys.size).toBeGreaterThan(0);
  });

  it("every DEXE_* key in .env.example is in the schema", () => {
    const unknown: string[] = [];
    for (const k of exampleKeys) {
      if (!isKnownEnvKey(k)) unknown.push(k);
    }
    expect(unknown, `.env.example has unknown DEXE_* keys: ${unknown.join(", ")}`).toEqual([]);
  });

  // The direction that was missing. The check above only sees vars that exist
  // in the example and not in the schema; a var added to the schema and never
  // written down stayed invisible — which is how two public subgraph families
  // reached review undocumented.
  it("every schema key appears in .env.example", () => {
    const missing = envKeys().filter((k) => !exampleKeys.has(k) && !inFamily(k));
    expect(
      missing,
      `ENV_SPEC keys with no line in .env.example: ${missing.join(", ")}. ` +
        "Add a commented example (documented families need only one member).",
    ).toEqual([]);
  });

  it("every dynamic env family has a concrete example member", () => {
    for (const family of ENV_FAMILIES) {
      const shown = [...exampleKeys].filter((k) => family.member.test(k));
      expect(
        shown.length,
        `.env.example documents no member of the ${family.label} family — ` +
          "add one concrete line (e.g. DEXE_SUBGRAPH_POOLS_URL_97=…) so the family is discoverable.",
      ).toBeGreaterThan(0);
    }
  });

  it("family members named in .env.example are recognized by the loader", () => {
    // A representative that the loader would report as a typo documents a var
    // nobody can actually use.
    for (const k of exampleKeys) {
      if (!inFamily(k)) continue;
      expect(isKnownEnvKey(k), `${k} is in .env.example but unknown to isKnownEnvKey()`).toBe(true);
    }
  });
});
