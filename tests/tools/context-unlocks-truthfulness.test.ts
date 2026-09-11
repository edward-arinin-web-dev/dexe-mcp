import { describe, it, expect } from "vitest";
import { TOOLSET_UNLOCKS, describeToolsets } from "../../src/tools/operationalContext.js";
import { TOOLSETS, DEFAULT_TOOLSETS, defaultProfileToolNames } from "../../src/tools/gate.js";
import { toolRefs } from "../helpers/toolTokens.js";

/**
 * D2-4 — `dexe_context` advertised `dexe_proposal_create` and
 * `dexe_proposal_vote_and_execute` as things the hidden `proposals` set would
 * unlock, and named two reads (`dao members`, `delegation map`) under `read`.
 * All four have been in CORE since v0.31.0, so a default session was told to
 * edit DEXE_TOOLSETS and restart Claude Code to obtain tools it already had.
 *
 * `unlocks` is the asserted field; `note` is cross-reference prose and is never
 * scanned, so a useful "you already have X" pointer cannot trip the guard.
 */
describe("TOOLSET_UNLOCKS is true about its own set", () => {
  it("covers exactly the gateable sets", () => {
    expect(new Set(Object.keys(TOOLSET_UNLOCKS))).toEqual(new Set(Object.keys(TOOLSETS)));
  });

  for (const [set, names] of Object.entries(TOOLSETS)) {
    it(`every tool named under '${set}' is actually in that set`, () => {
      const entry = TOOLSET_UNLOCKS[set];
      expect(entry, `TOOLSET_UNLOCKS has no entry for '${set}'`).toBeDefined();
      const wrong = toolRefs(entry!.unlocks)
        .filter(({ ref, glob }) => (glob ? ![...names].some((n) => n.startsWith(ref)) : !names.has(ref)))
        .map(({ raw }) => raw);
      expect(
        wrong,
        `TOOLSET_UNLOCKS.${set}.unlocks names ${wrong.join(", ")}, which DEXE_TOOLSETS=${set} does not register`,
      ).toEqual([]);
    });
  }

  for (const set of Object.keys(TOOLSETS).filter((s) => !DEFAULT_TOOLSETS.includes(s as "core"))) {
    it(`'${set}' does not advertise a tool the default profile already has`, () => {
      const defaults = defaultProfileToolNames();
      const already = toolRefs(TOOLSET_UNLOCKS[set]!.unlocks)
        .filter(({ ref, glob }) => (glob ? false : defaults.has(ref)))
        .map(({ raw }) => raw);
      expect(
        already,
        `TOOLSET_UNLOCKS.${set}.unlocks promises ${already.join(", ")}, which a default session already has — ` +
          `a user who follows this edits .env and restarts for nothing`,
      ).toEqual([]);
    });
  }
});

describe("describeToolsets", () => {
  it("only lists a hidden set that would actually add tools", () => {
    const d = describeToolsets([...DEFAULT_TOOLSETS]);
    expect(d.hidden.length).toBeGreaterThan(0);
    for (const row of d.hidden) expect(row.newToolCount).toBeGreaterThan(0);
  });

  it("leads the hint with 'check what you already have', not with a set to enable", () => {
    const d = describeToolsets([...DEFAULT_TOOLSETS]);
    expect(d.enableHint).toBeDefined();
    expect(d.enableHint!).toContain("Check the `enabled` list first");
    // The bug this replaces: the hint's worked example named `proposals`, the
    // set whose unlocks line claimed the composites.
    expect(d.enableHint!).not.toMatch(/DEXE_TOOLSETS=core,proposals\b/);
  });

  it("has nothing hidden under full", () => {
    const d = describeToolsets(["full"]);
    expect(d.hidden).toEqual([]);
    expect(d.enableHint).toBeUndefined();
  });
});
