import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { serverInstructions, SHIPPED_SKILLS, INSTRUCTIONS_MAX_CHARS } from "../src/instructions.js";
import { DEFAULT_TOOLSETS, TOOLSETS, defaultProfileToolNames } from "../src/tools/gate.js";
import { ENV_SPEC } from "../src/env/schema.js";
import { toolRefs, annotationAfter } from "./helpers/toolTokens.js";

/**
 * D2-3 / D7-2 / D9-3 / D10-3 / D2-5 — the MCP handshake `instructions` are the
 * one block of text EVERY session reads before it acts, and nothing asserted
 * anything about them. v0.31.0 narrowed DEFAULT_TOOLSETS to ["core"]; the
 * string kept claiming 'core,proposals' for three releases, and the shipped
 * skill roster kept saying 6 while 8 directories shipped.
 *
 * These tests fail on main.
 */
const root = resolve(__dirname, "..");
const pluginSkillsDir = resolve(root, "dexe-plugin", "skills");
const text = serverInstructions();

describe("server instructions — the budget", () => {
  it("fits the 2,048 characters Claude Code keeps of a handshake", () => {
    // Measured 2026-10-01: the 0.34.x handshake was 3,129 characters and reached
    // the model cut at exactly 2,048 — the default profile, the resources and
    // the skill roster were all in the part that was dropped.
    expect(INSTRUCTIONS_MAX_CHARS).toBe(2048);
    expect(
      text.length,
      `the handshake is ${text.length} characters; everything past ${INSTRUCTIONS_MAX_CHARS} is cut by the client — ` +
        "shorten it, or move the detail to dexe_context / dexe://playbook",
    ).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it("keeps the last thing it says inside the budget too", () => {
    // The roster is the tail: if it survives the cut, so did everything before it.
    expect(text.slice(0, INSTRUCTIONS_MAX_CHARS)).toContain(SHIPPED_SKILLS[SHIPPED_SKILLS.length - 1]);
  });
});

describe("server instructions — the default profile", () => {
  it("names the profile DEFAULT_TOOLSETS actually resolves to", () => {
    expect(
      text,
      "the handshake must state the real default profile — derive it from DEFAULT_TOOLSETS, never a literal",
    ).toContain(`default '${DEFAULT_TOOLSETS.join(",")}'`);
  });

  it("makes no other 'default' profile claim", () => {
    const claims = [...text.matchAll(/default '([a-z,]+)'/g)].map((m) => m[1]);
    expect(claims).toEqual([DEFAULT_TOOLSETS.join(",")]);
  });

  it("states the tool count the default profile really has", () => {
    expect(text).toContain(`${defaultProfileToolNames().size} tools`);
  });
});

describe("server instructions — tool references", () => {
  it("names no tool a default session cannot call without saying how to get it", () => {
    const defaultNames = defaultProfileToolNames();
    const dangling: string[] = [];

    for (const { raw, ref, glob, end } of toolRefs(text)) {
      const satisfied = glob ? [...defaultNames].some((n) => n.startsWith(ref)) : defaultNames.has(ref);
      if (satisfied) continue;

      const sets = annotationAfter(text, end);
      const home = Object.entries(TOOLSETS)
        .filter(([, names]) => (glob ? [...names].some((n) => n.startsWith(ref)) : names.has(ref)))
        .map(([s]) => s);

      if (!sets) {
        dangling.push(
          `${raw}: not in the default profile (lives in: ${home.join(", ") || "no toolset at all"}) — ` +
            `write "${raw} (needs DEXE_TOOLSETS=core,${home[0] ?? "read"})"`,
        );
        continue;
      }
      const unlocked = new Set<string>();
      for (const s of sets) for (const n of TOOLSETS[s] ?? []) unlocked.add(n);
      const ok = glob ? [...unlocked].some((n) => n.startsWith(ref)) : unlocked.has(ref);
      if (!ok) {
        dangling.push(
          `${raw}: annotated DEXE_TOOLSETS=${sets.join(",")}, which does not contain it — ` +
            `use "(needs DEXE_TOOLSETS=core,${home[0] ?? "read"})"`,
        );
      }
    }

    expect(dangling, `dangling tool references in the handshake:\n  ${dangling.join("\n  ")}`).toEqual([]);
  });
});

describe("server instructions — shipped skills", () => {
  const shipped = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(pluginSkillsDir, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();

  it("SHIPPED_SKILLS matches the directories that actually ship", () => {
    expect(
      [...SHIPPED_SKILLS].sort(),
      "SHIPPED_SKILLS in src/instructions.ts is out of sync with dexe-plugin/skills — " +
        "add the new skill name to the const and a row to docs/SKILLS.md",
    ).toEqual(shipped);
  });

  it("the handshake names every shipped skill", () => {
    for (const name of shipped) expect(text, `the handshake never mentions ${name}`).toContain(name);
  });

  it("flags that dexe-agent-team needs a non-default toolset", () => {
    // dexe_agents_* live in AGENTS/VOTE, never CORE — advertising the skill
    // unqualified manufactures a "tool not registered" failure on week one.
    expect(text).toMatch(/dexe-agent-team[^.]*DEXE_TOOLSETS=core,agents/);
  });
});

describe("the env schema agrees with the gate", () => {
  const spec = ENV_SPEC.DEXE_TOOLSETS;

  it("the DEXE_TOOLSETS doc states the real default", () => {
    expect(spec.doc).toContain(`Default '${DEFAULT_TOOLSETS.join(",")}'`);
  });

  it("the DEXE_TOOLSETS doc names every profile plus 'full'", () => {
    for (const set of Object.keys(TOOLSETS)) {
      expect(spec.doc, `src/env/schema.ts omits the '${set}' profile from the DEXE_TOOLSETS doc`).toContain(set);
    }
    expect(spec.doc).toContain("full");
  });

  it("the example value is the default profile, and .env.example matches", () => {
    const want = DEFAULT_TOOLSETS.join(",");
    expect(spec.example).toBe(want);
    expect(
      readFileSync(resolve(root, ".env.example"), "utf8"),
      "`.env.example` still shows a commented DEXE_TOOLSETS that is not the default",
    ).toContain(`# DEXE_TOOLSETS=${want}`);
  });
});

describe("no shipped surface restates the pre-0.31 default", () => {
  /** Bans the CLAIM ("default core,proposals"), not the string — `(needs DEXE_TOOLSETS=core,proposals)` is correct. */
  const STALE = /default[^\n.]{0,30}['"`]?core,proposals/i;
  const SURFACES = ["src/instructions.ts", "src/env/schema.ts", ".env.example", "docs/USAGE.md"];

  for (const rel of SURFACES) {
    it(`${rel} does not claim the default is core,proposals`, () => {
      const body = readFileSync(resolve(root, rel), "utf8");
      const hit = body.split("\n").findIndex((l) => STALE.test(l));
      expect(
        hit,
        hit === -1 ? "" : `${rel}:${hit + 1} still says the default profile is core,proposals`,
      ).toBe(-1);
    });
  }
});
