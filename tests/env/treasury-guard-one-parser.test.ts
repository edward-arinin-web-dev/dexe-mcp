import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseEnv } from "../../src/env/parse.js";
import { ENV_REGISTRY } from "../../src/env/schema.js";
import {
  TREASURY_GUARD_MODES,
  resolveTreasuryGuardMode,
  treasuryGuardMode,
} from "../../src/lib/quorumRisk.js";

/**
 * 0.33.0 finding — two resolution paths disagreed about DEXE_TREASURY_GUARD.
 *
 * `DexeConfig.treasuryGuard` was typed `"off" | "warn"` and rejected `block` as
 * MALFORMED (startup degrade → fall back to `warn`), while `treasuryGuardMode()`
 * read the same variable straight off `process.env` and returned `block`. An
 * operator who set the STRICTEST posture was told their value was invalid, and
 * two halves of the server then behaved differently on the same input.
 *
 * There was a third disagreeing path nobody had counted: the ENV_SPEC validator
 * (`src/env/schema.ts`) hardcoded the same `off|warn` enum, and a schema
 * rejection DELETES the variable from `process.env` before any other reader sees
 * it — so `block` could never have taken effect at all, however the config was
 * typed. All three now resolve through `resolveTreasuryGuardMode`.
 *
 * The 0.30.1 rule is unchanged and re-asserted below: a genuinely malformed
 * value falls back to the SAFE posture and is RECORDED as a startup issue. Never
 * `off` (a typo must not silence the guard), and never an exit.
 */

const KEY = "DEXE_TREASURY_GUARD";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

/** Everything an operator can observe about one raw value, in one shot. */
async function resolveEverywhere(raw: string | undefined) {
  const schemaIssues = parseEnv(raw === undefined ? {} : { [KEY]: raw }).issues.filter(
    (i) => i.key === KEY,
  );
  if (raw === undefined) delete process.env[KEY];
  else process.env[KEY] = raw;
  const config = await loadConfig();
  return {
    schemaIssues,
    /** What the config carries — read by daoDeploy / proposalBuild* directly. */
    configured: config.treasuryGuard,
    /** What every gated call site resolves at tool time. */
    runtime: treasuryGuardMode({ configured: config.treasuryGuard }),
    startupIssues: config.startupIssues.filter((i) => i.key === KEY),
  };
}

describe("DEXE_TREASURY_GUARD resolves the same way everywhere", () => {
  it.each(TREASURY_GUARD_MODES)("%s is first-class in all three paths", async (mode) => {
    const r = await resolveEverywhere(mode);
    expect(r.schemaIssues, `ENV_SPEC rejected the documented posture '${mode}'`).toEqual([]);
    expect(r.configured).toBe(mode);
    expect(r.runtime).toBe(mode);
    expect(r.startupIssues, `'${mode}' was reported as a config problem`).toEqual([]);
  });

  it("block — the strictest posture — arrives with no complaint about it", async () => {
    // The regression verbatim: config said MALFORMED and degraded to warn while
    // the runtime honoured block.
    const r = await resolveEverywhere("block");
    expect(r.configured).toBe("block");
    expect(r.runtime).toBe("block");
    expect(r.startupIssues).toEqual([]);
    expect(r.schemaIssues).toEqual([]);
  });

  it("unset falls to the documented default in both paths, silently", async () => {
    const r = await resolveEverywhere(undefined);
    expect(r.configured).toBe("warn");
    expect(r.runtime).toBe("warn");
    expect(r.startupIssues).toEqual([]);
  });

  it.each(["Blocked!", "blok", "1", "on", "warn warn"])(
    "a malformed value (%s) falls back SAFE and is recorded — never an exit",
    async (bad) => {
      const r = await resolveEverywhere(bad);
      expect(r.configured).toBe("warn"); // safe, and never 'off'
      expect(r.runtime).toBe("warn");
      expect(r.startupIssues.length, "the rejection was swallowed silently").toBe(1);
      expect(r.startupIssues[0]!.message).toContain(KEY);
      expect(r.startupIssues[0]!.fallback.length).toBeGreaterThan(0);
    },
  );

  it("records a malformed value exactly ONCE, not once per validating layer", async () => {
    // Two layers each writing their own issue for the same typo is the same
    // duplication bug wearing a different hat.
    const r = await resolveEverywhere("Blocked!");
    expect(r.startupIssues).toHaveLength(1);
  });

  it("the config and the call-time lookup never disagree, on any input", async () => {
    for (const raw of ["off", "warn", "block", "BLOCK", "  warn  ", "nonsense", ""]) {
      const r = await resolveEverywhere(raw);
      expect(r.runtime, `config=${r.configured} but runtime=${r.runtime} for ${JSON.stringify(raw)}`).toBe(
        r.configured,
      );
    }
  });
});

describe("the ENV_SPEC validator delegates to the shared parser", () => {
  it("accepts exactly the values resolveTreasuryGuardMode accepts", () => {
    const schema = ENV_REGISTRY[KEY]!.schema;
    for (const raw of ["off", "warn", "block", "BLOCK", " block ", "nonsense", "1", ""]) {
      expect(
        schema.safeParse(raw).success,
        `schema and resolver disagree about ${JSON.stringify(raw)}`,
      ).toBe(resolveTreasuryGuardMode(raw).issue === undefined);
    }
  });

  it("names every posture in the message it shows the user", () => {
    const issue = parseEnv({ [KEY]: "nonsense" }).issues.find((i) => i.key === KEY);
    expect(issue).toBeDefined();
    for (const mode of TREASURY_GUARD_MODES) expect(issue!.message).toContain(mode);
  });

  it("documents block, so doctor and .env.example stop advertising two postures", () => {
    expect(ENV_REGISTRY[KEY]!.doc).toContain("block");
  });
});
