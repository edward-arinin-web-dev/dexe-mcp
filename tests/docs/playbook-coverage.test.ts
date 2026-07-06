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

  it("documents every toolset", () => {
    const missing = Object.keys(TOOLSETS).filter((s) => !new RegExp(`\\b${s}\\b`).test(playbook));
    expect(missing, `toolsets missing from PLAYBOOK: ${missing.join(", ")}`).toEqual([]);
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
