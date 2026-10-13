import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defaultToolNames, INSTRUCTIONS_MAX_CHARS, READ_SKILLS, readInstructions } from "@dexe-network/dexe-mcp/core";
import { serverInstructions, SHIPPED_SKILLS, WRITE_SKILLS, writeInstructions } from "../src/instructionsWrite.js";
import {
  DEFAULT_TOOLSETS,
  TOOLSETS,
  WRITE_EDITION_TOOLSETS,
  defaultProfileToolNames,
} from "../src/tools/gate.js";
import { READ_TOOLS, WRITE_TOOLS } from "../src/editions.js";
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
      "SHIPPED_SKILLS in src/instructionsWrite.ts is out of sync with dexe-plugin/skills — " +
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
  const SURFACES = ["src/instructionsWrite.ts", "src/env/schema.ts", ".env.example", "docs/USAGE.md"];

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

  // The read edition's handshake is the package's (@dexe-network/dexe-mcp/core):
  // checked as the text it serves rather than as a source file of this repo.
  it("the read edition's handshake does not claim the default is core,proposals", () => {
    const hit = readInstructions().split("\n").findIndex((l) => STALE.test(l));
    expect(hit, hit === -1 ? "" : `readInstructions() line ${hit + 1} says the default profile is core,proposals`).toBe(-1);
  });
});

/**
 * A7 — each edition carries its own handshake. The read text may name read
 * tools only; the write text may name write tools only (it points at the read
 * server without naming its tools). A glob counts as the other edition's when
 * ANY tool it matches is — `dexe_gov_*` spans both, so neither text may use it.
 */
describe("per-edition instructions", () => {
  const READ = new Set(READ_TOOLS);
  const WRITE = new Set(WRITE_TOOLS);
  const otherEdition = (text: string, other: readonly string[], otherSet: ReadonlySet<string>) =>
    toolRefs(text)
      .filter(({ ref, glob }) => (glob ? other.some((n) => n.startsWith(ref)) : otherSet.has(ref)))
      .map(({ raw }) => raw);
  const unknownTools = (text: string, own: readonly string[], ownSet: ReadonlySet<string>) =>
    toolRefs(text)
      .filter(({ ref, glob }) => (glob ? !own.some((n) => n.startsWith(ref)) : !ownSet.has(ref)))
      .map(({ raw }) => raw);

  const read = readInstructions();
  const write = writeInstructions();

  it("both fit the 2,048-character handshake budget", () => {
    expect(read.length, `readInstructions() is ${read.length} characters`).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(write.length, `writeInstructions() is ${write.length} characters`).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it("the read handshake names no write tool, and only real read tools", () => {
    expect(otherEdition(read, WRITE_TOOLS, WRITE), "write tools in readInstructions()").toEqual([]);
    expect(unknownTools(read, READ_TOOLS, READ), "names that are not read tools").toEqual([]);
  });

  it("the write handshake names no read tool, and only real write tools", () => {
    expect(otherEdition(write, READ_TOOLS, READ), "read tools in writeInstructions()").toEqual([]);
    expect(unknownTools(write, WRITE_TOOLS, WRITE), "names that are not write tools").toEqual([]);
  });

  it("the read handshake carries none of the write rules", () => {
    // No composites, no resume contract, no amount/image/approve rules, no write skills.
    for (const banned of [/composite/i, /re-run/i, /raw wei/i, /LOCAL FILE PATH/, /ERC20\.approve/, /DEXE_TOOLSETS/]) {
      expect(read, `readInstructions() mentions ${banned}`).not.toMatch(banned);
    }
    for (const skill of WRITE_SKILLS) expect(read, `write skill ${skill}`).not.toContain(skill);
    for (const skill of READ_SKILLS) expect(read).toContain(skill);
  });

  it("the read handshake leads with the report and the graph schema", () => {
    expect(read).toContain("dexe_dao_report");
    expect(read).toContain("dexe_graph_schema");
    expect(read.indexOf("dexe_dao_report")).toBeLessThan(read.indexOf("dexe_graph_query"));
  });

  it("the write handshake keeps the resume contract and states its own default profile", () => {
    expect(write).toContain("dexe_tx_status");
    const n = defaultToolNames(WRITE_EDITION_TOOLSETS).size;
    expect(write).toContain(`default '${WRITE_EDITION_TOOLSETS.defaults.join(",")}' — ${n} tools`);
    for (const skill of WRITE_SKILLS) expect(write).toContain(skill);
    for (const skill of READ_SKILLS) expect(write).not.toContain(skill);
  });

  it("every write-handshake tool outside the write default profile says how to get it", () => {
    const defaults = defaultToolNames(WRITE_EDITION_TOOLSETS);
    const dangling: string[] = [];
    for (const { raw, ref, glob, end } of toolRefs(write)) {
      const satisfied = glob ? [...defaults].some((n) => n.startsWith(ref)) : defaults.has(ref);
      if (satisfied) continue;
      const sets = annotationAfter(write, end);
      const unlocked = new Set<string>();
      for (const s of sets ?? []) for (const name of WRITE_EDITION_TOOLSETS.sets[s] ?? []) unlocked.add(name);
      const ok = glob ? [...unlocked].some((n) => n.startsWith(ref)) : unlocked.has(ref);
      if (!ok) dangling.push(raw);
    }
    expect(dangling).toEqual([]);
  });

  it("the read and write skill rosters partition the shipped skills", () => {
    expect([...READ_SKILLS, ...WRITE_SKILLS].sort()).toEqual([...SHIPPED_SKILLS].sort());
  });

  it("the single server's handshake is not one of the edition texts", () => {
    // It stays byte-for-byte what 0.35.0 shipped while the single server ships.
    expect(serverInstructions()).not.toBe(read);
    expect(serverInstructions()).not.toBe(write);
  });
});
