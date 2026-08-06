import { describe, expect, it } from "vitest";
import { ENV_REGISTRY, type EnvEntry, type EnvKey } from "../../src/env/schema.js";
import { parseEnv } from "../../src/env/parse.js";

/**
 * Since 0.30.1 a bad env value degrades instead of exiting, so the validator's
 * message is the ONLY thing the user is ever told about the rejection. These
 * tests walk ENV_REGISTRY itself — not a checked-in list of var names — so a
 * newly added entry is held to the same bar the day it lands.
 */

/** Probes, not fixtures: no validator in the spec should accept any of these. */
const BAD_VALUES = ["not-a-valid-value", "??", "-1", "12.5", "0x"] as const;

/** zod's stock texts — the exact thing this suite exists to keep off the surface. */
const STOCK_ZOD_MESSAGE =
  /^(Invalid|Invalid input|Invalid url|Invalid email|Invalid uuid|Invalid date|Invalid enum value\b.*|Required|Expected .*, received .*|String must contain .*)$/;

interface Probe {
  key: EnvKey;
  entry: EnvEntry;
  /** First BAD_VALUES member this entry rejects. */
  bad: string;
  messages: string[];
}

const probes: Probe[] = [];
/** Entries that accept any string — no rejection path, so nothing to explain. */
const freeForm: EnvKey[] = [];

for (const [key, entry] of Object.entries(ENV_REGISTRY) as [EnvKey, EnvEntry][]) {
  const bad = BAD_VALUES.find((v) => !entry.schema.safeParse(v).success);
  if (bad === undefined) {
    freeForm.push(key);
    continue;
  }
  const r = entry.schema.safeParse(bad);
  probes.push({ key, entry, bad, messages: r.success ? [] : r.error.issues.map((i) => i.message) });
}

/** Every message the given entries produce that fails `ok`, labelled by key. */
const offenders = (ok: (m: string) => boolean): string[] =>
  probes
    .filter((p) => !p.messages.every(ok))
    .map((p) => `${p.key} <- ${JSON.stringify(p.bad)} => ${p.messages.join(" | ")}`);

describe("ENV_SPEC rejection messages", () => {
  it("has validators left to check", () => {
    // Floor, not a count: it only trips if validators were dropped or the probe
    // values stopped biting — either way the rest of this suite went vacuous.
    expect(probes.length, `only ${probes.length} validating entries; free-form: ${freeForm.join(", ")}`).toBeGreaterThan(20);
  });

  it("every rejection produces at least one message", () => {
    const silent = probes.filter((p) => p.messages.length === 0).map((p) => p.key);
    expect(silent, `entries rejected a value without saying why: ${silent.join(", ")}`).toEqual([]);
  });

  it("no entry falls back to a stock zod message", () => {
    const bad = offenders((m) => !STOCK_ZOD_MESSAGE.test(m.trim()));
    expect(bad, `stock zod text tells the user nothing:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every entry states the expected shape", () => {
    const bad = offenders((m) => /^must \S/.test(m));
    expect(bad, `message must start with "must <shape>":\n${bad.join("\n")}`).toEqual([]);
  });

  it("every entry shows a concrete example", () => {
    const bad = offenders((m) => /\be\.g\.\s+\S/.test(m));
    expect(bad, `message must carry an "e.g. <value>" example:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every entry records its expected shape as the schema description", () => {
    const bad = probes
      .filter((p) => !p.entry.schema.description?.trim())
      .map((p) => p.key);
    expect(bad, `missing .describe() on: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("parseEnv surfaces the guidance", () => {
  it("carries the shape and example into the user-facing issue", () => {
    const bad: string[] = [];
    for (const p of probes) {
      const [issue] = parseEnv({ [p.key]: p.bad }).issues;
      if (!issue || issue.key !== p.key) {
        bad.push(`${p.key}: no issue raised`);
        continue;
      }
      if (!/\bmust \S/.test(issue.message) || !/\be\.g\.\s+\S/.test(issue.message)) {
        bad.push(`${p.key}: ${issue.message}`);
      }
    }
    expect(bad, `issue message loses the guidance:\n${bad.join("\n")}`).toEqual([]);
  });

  it("never echoes a rejected secret", () => {
    const leaked: string[] = [];
    for (const p of probes.filter((x) => x.entry.secret)) {
      const [issue] = parseEnv({ [p.key]: p.bad }).issues;
      if (issue?.message.includes(p.bad) || !issue?.message.includes("<redacted>")) {
        leaked.push(`${p.key}: ${issue?.message}`);
      }
    }
    expect(leaked, `secret leaked into the message:\n${leaked.join("\n")}`).toEqual([]);
  });
});
