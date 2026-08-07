import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FLOW_PROPOSAL_TYPES } from "../../src/lib/proposalBuilders.js";
import { KNOWN_FAILURES } from "../../src/lib/errors.js";
import { TOOLSETS } from "../../src/tools/gate.js";

/**
 * Drift guard for docs/PLAYBOOK.md — the AI-efficiency guide must keep pace
 * with the tool surface. If this fails you added/renamed a proposal type,
 * toolset, or known-failure remedy without updating the playbook.
 */
const playbook = readFileSync(resolve(__dirname, "..", "..", "docs", "PLAYBOOK.md"), "utf8");

describe("PLAYBOOK.md coverage", () => {
  it("documents every wired proposalType", () => {
    const missing = FLOW_PROPOSAL_TYPES.filter((t) => !playbook.includes(`\`${t}\``));
    expect(missing, `proposalTypes missing from PLAYBOOK: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * "Documents a toolset" used to mean `\b<name>\b` anywhere in the file, which
   * is wrong in both directions.
   *
   * Too lax: most profile names are ordinary English. "read the revert reason"
   * documented `read`, "vote on proposal N" documented `vote`, and `core`/`dev`
   * occur in prose — four of the seven profiles could not have failed whatever
   * the doc said. Too strict where it did fire: `agents` appeared only as
   * `dexe_agents_list`, and the underscores suppress the word boundary. Right
   * verdict, wrong reason — naming a tool is not documenting the profile that
   * ships it, and that rule should be stated, not left to a regex quirk.
   *
   * So the guard is split into the two things a reader actually needs: an entry
   * in the catalog saying what the profile unlocks, and a paste-able line that
   * turns it on.
   */
  it("documents every toolset", () => {
    const start = playbook.indexOf("## Toolsets");
    expect(start, "PLAYBOOK has no '## Toolsets' section").toBeGreaterThan(-1);
    const rest = playbook.slice(start);
    const end = rest.indexOf("\n## ", 1);
    const catalog = end === -1 ? rest : rest.slice(0, end);

    // | agents | dexe_agents_list (roster) … | → "agents" ➜ "dexe_agents_list …"
    const unlocks = new Map(
      catalog
        .split("\n")
        .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l))
        .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
        .filter((cells) => cells.length >= 2 && cells[0] !== "Set")
        .map((cells) => [cells[0]!.replace(/`/g, "").replace(/\s*\(default\)$/, ""), cells[1]!] as const),
    );

    const missing = Object.keys(TOOLSETS).filter((s) => !unlocks.has(s));
    expect(missing, `toolsets with no row in the PLAYBOOK toolset catalog: ${missing.join(", ")}`).toEqual([]);

    const thin = Object.keys(TOOLSETS).filter((s) => (unlocks.get(s) ?? "").length < 40);
    expect(thin, `catalog rows that name a profile without saying what it unlocks: ${thin.join(", ")}`).toEqual([]);
  });

  it("gives a paste-able DEXE_TOOLSETS line for every toolset", () => {
    // A profile the reader cannot turn on is not documented. This wants the
    // literal assignment — `DEXE_TOOLSETS=core,agents` — not a prose mention and
    // not an elided `DEXE_TOOLSETS=…,agents`, which is not paste-able.
    const enableLine = (set: string) => new RegExp(String.raw`DEXE_TOOLSETS=[a-z,]*\b${set}\b`);

    const missing = Object.keys(TOOLSETS).filter((s) => !enableLine(s).test(playbook));
    expect(missing, `no paste-able DEXE_TOOLSETS=… line enabling: ${missing.join(", ")}`).toEqual([]);

    // The rule cannot be satisfied by naming a tool or using the word in prose —
    // which is exactly how the old `\bagents\b` check could have been silenced.
    expect(enableLine("agents").test("call dexe_agents_list; set DEXE_TOOLSETS and restart")).toBe(false);
  });

  it("covers the core failure remedies", () => {
    // One representative marker per KNOWN_FAILURES entry the playbook must explain.
    const markers: Record<string, string> = {
      "pinata-missing": "DEXE_PINATA_JWT",
      "no-gas": "faucet",
      "onchain-revert": "REVERTED",
      "rpc-flaky": "429",
    };
    for (const f of KNOWN_FAILURES) {
      const marker = markers[f.slug];
      if (!marker) continue;
      expect(playbook, `PLAYBOOK must cover failure '${f.slug}' (marker '${marker}')`).toContain(marker);
    }
  });

  it("teaches the composite-first + resume rules", () => {
    expect(playbook).toContain("dexe_dao_create");
    expect(playbook).toContain("dexe_proposal_create");
    expect(playbook).toContain("dexe_proposal_vote_and_execute");
    expect(playbook).toContain("landedSteps");
    expect(playbook).toMatch(/re-run the SAME call/i);
  });
});
