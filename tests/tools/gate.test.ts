import { describe, it, expect, beforeAll } from "vitest";
import { TOOLSETS, resolveToolsets, DEFAULT_TOOLSETS } from "../../src/tools/gate.js";
import { listTools } from "../helpers/listTools.js";

describe("resolveToolsets", () => {
  it("defaults to core alone when empty", () => {
    const r = resolveToolsets([]);
    expect(r.full).toBe(false);
    expect(r.requested).toEqual([...DEFAULT_TOOLSETS]);
    expect(r.names!.size).toBeGreaterThan(0);
  });
  it("explicit full bypasses filtering", () => {
    const r = resolveToolsets(["full"]);
    expect(r.full).toBe(true);
    expect(r.names).toBeNull();
  });
  it("drops an unknown set name but keeps the recognized ones", () => {
    const r = resolveToolsets(["core", "typo"]);
    expect(r.full).toBe(false);
    expect(r.unknown).toContain("typo");
    expect(r.requested).toEqual(["core"]);
    expect(r.names!.has("dexe_dao_create")).toBe(true); // core survived
    expect(r.names!.has("dexe_compile")).toBe(false); // did NOT escalate to full
  });
  it("falls back to the defaults when every requested set is unknown", () => {
    const r = resolveToolsets(["devtools"]);
    expect(r.full).toBe(false);
    expect(r.unknown).toEqual(["devtools"]);
    expect(r.requested).toEqual([...DEFAULT_TOOLSETS]);
    expect(r.names!.has("dexe_compile")).toBe(false);
  });
  it("unions the requested sets", () => {
    const r = resolveToolsets(["core", "vote"]);
    expect(r.full).toBe(false);
    expect(r.names!.has("dexe_dao_create")).toBe(true); // core
    expect(r.names!.has("dexe_vote_build_delegate")).toBe(true); // vote
    expect(r.names!.has("dexe_compile")).toBe(false); // dev
  });
});

describe("tool gating (real server)", () => {
  let fullNames: string[];
  let fullBytes: number;
  let defaultNames: string[];
  let defaultBytes: number;

  beforeAll(async () => {
    ({ names: fullNames, bytes: fullBytes } = await listTools("full"));
    ({ names: defaultNames, bytes: defaultBytes } = await listTools(undefined));
  });

  it("full registers each tool exactly once", () => {
    // No hardcoded surface count here. The count is pinned by a chain of
    // derived equalities instead — registered surface == TOOLSETS union (below)
    // == docs/TOOLS.md rows (tests/docs/doc-count-consistency.test.ts) — which
    // cannot go stale the way a literal repeated in three files does. The floor
    // still catches a catastrophic registration failure.
    expect(new Set(fullNames).size).toBe(fullNames.length);
    expect(fullNames.length).toBeGreaterThan(150);
  });

  it("every name in every TOOLSET is a real registered tool (no typos)", () => {
    const real = new Set(fullNames);
    const orphans: string[] = [];
    for (const [set, names] of Object.entries(TOOLSETS)) {
      for (const n of names) if (!real.has(n)) orphans.push(`${set}:${n}`);
    }
    expect(orphans, `TOOLSET names not registered: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the union of all named sets equals the full surface (nothing full-only)", () => {
    const union = new Set<string>();
    for (const names of Object.values(TOOLSETS)) for (const n of names) union.add(n);
    const missing = fullNames.filter((n) => !union.has(n));
    expect(missing, `tools reachable only under full: ${missing.join(", ")}`).toEqual([]);
    expect(union.size).toBe(fullNames.length);
  });

  it("default profile is core alone — composites in, single-purpose builders out", () => {
    expect(defaultNames.length).toBeLessThan(fullNames.length);
    expect(defaultNames.length).toBeGreaterThan(30);
    // composites + orientation
    expect(defaultNames).toContain("dexe_context");
    expect(defaultNames).toContain("dexe_dao_create");
    expect(defaultNames).toContain("dexe_proposal_create");
    // discovery for dexe_proposal_create stays in, so demoting the builders
    // does not hide which proposal types exist
    expect(defaultNames).toContain("dexe_proposal_catalog");
    expect(defaultNames).toContain("dexe_guide");
    // 0.31.0: the zero-config reporting surface is now default-visible. These
    // are what README and dexe://graph-schema have always advertised; before
    // this release they needed DEXE_TOOLSETS=read to exist at all.
    for (const t of [
      "dexe_graph_query",
      "dexe_read_dao_list",
      "dexe_read_dao_stats",
      "dexe_read_dao_members",
      "dexe_read_token_holders",
      "dexe_read_delegation_map",
      "dexe_ipfs_fetch",
    ]) {
      expect(defaultNames, `${t} must be default-visible`).toContain(t);
    }
    // 0.31.0: paid for by demoting the builders dexe_proposal_create subsumes.
    expect(defaultNames).not.toContain("dexe_proposal_build_token_sale");
    expect(defaultNames).not.toContain("dexe_proposal_build_token_transfer");
    // gated out of default (unchanged)
    expect(defaultNames).not.toContain("dexe_compile"); // dev
    expect(defaultNames).not.toContain("dexe_gov_build_propose"); // governor
    expect(defaultNames).not.toContain("dexe_vote_build_delegate"); // vote
  });

  it("the pre-0.31.0 default is one env var away", async () => {
    // The demotion must be reversible in place: DEXE_TOOLSETS=core,proposals
    // reproduces exactly what a 0.30.x session loaded, so an upgrade that
    // depended on a builder tool has a one-line fix, not a rollback.
    const { names } = await listTools("core,proposals");
    for (const t of defaultNames) expect(names).toContain(t);
    expect(names).toContain("dexe_proposal_build_token_sale");
    expect(names).toContain("dexe_proposal_build_offchain_single_option");
    expect(names).toContain("dexe_auth_login");
  });

  it("default profile clears 60% off tools/list and stays under budget", async () => {
    const { bytes: withProposalsBytes, names: withProposalsNames } = await listTools("core,proposals");
    const defReduction = 1 - defaultBytes / fullBytes;
    // eslint-disable-next-line no-console
    console.log(
      `tools/list bytes — full: ${fullBytes} (${fullNames.length}t), ` +
        `default core: ${defaultBytes} (${defaultNames.length}t, −${(defReduction * 100).toFixed(1)}%), ` +
        `core,proposals: ${withProposalsBytes} (${withProposalsNames.length}t)`,
    );

    // History of this ceiling:
    //   0.13.0  default became core,proposals  — the first slim default
    //   0.30.3  raised 130_000 → 138_000       — recorded as DEBT: paying for
    //           the `chainId` param across ~30 builders the default carried
    //   0.31.0  measured 134_263 → ~87_000 B  — the debt is PAID, not rolled
    //   0.34.0  92_807 B → 95_317 B (44 tools) — MCP annotations plus the 21
    //           missing titles cost ~2.5 KB, which the 2.2 KB of headroom could
    //           not absorb. The line moved once, 95_000 → 96_000 (see below);
    //           no tool left the default profile. The description lint later
    //           brought the default to ~86.7 KB.
    //
    // Keeping `proposals` in the default would have forced a THIRD raise: the
    // old core,proposals profile measures ~154 KB on this tree, past the 138_000
    // it was already straining. The console.log above prints it every run.
    //
    // 0.31.0 stopped loading the single-purpose proposal builders by default:
    // `dexe_proposal_create` already covers every on-chain catalog type from
    // proposalType + params, so those ~45 KB bought a second way to do what core
    // could already do — while the analytics reads a DAO report needs were gated
    // off entirely. Swapping the builders out for the reporting surface (incl.
    // dexe_dao_report, ~10 KB on its own) cut the default 35% AND made it
    // strictly more capable: a fresh install can now query the subgraph.
    //
    // This is a budget, not debt. Anything that pushes past it should demote
    // something, not raise the line.
    //
    // 0.34.0 raised the line once, 95_000 → 96_000, for MCP tool annotations
    // (readOnlyHint etc.) and the 21 missing titles: ~2.5 KB the spec asks
    // for, not description bloat. The alternative — demoting
    // dexe_ipfs_upload_file out of the default — was rejected as a user-facing
    // surprise to save 300 bytes. Description trimming (WP-I) should win the
    // headroom back; do not raise again without a reason of the same kind.
    //
    // 0.34.0, description lint: the headroom WAS won back. The default profile
    // peaked at 96,555 B mid-integration (annotations + titles, then warnings[]
    // on ~40 builders, then the read pagination/formatting fields) and the
    // style pass brought it to well under the line again — chiefly by
    // publishing `dexe_dao_create.params` opaquely (the fully-expanded ADVANCED
    // deploy struct was 5 KB, 5% of everything a zero-config session reads,
    // for the mode the tool's own first sentence says not to use) and by
    // leading every description with one effect marker instead of a paragraph.
    // The rules that keep it there are tests/tools/description-lint.test.ts.
    expect(defaultBytes).toBeLessThan(96_000);
    // Well below the 0.30.x default it replaces — the whole point of the swap.
    expect(defaultBytes).toBeLessThan(134_263);
    // The default is now the "maximum slim" profile that used to require opting
    // out of `proposals`, so it inherits that profile's 60% target.
    expect(defReduction).toBeGreaterThan(0.6);
    // Opting the builders back in is still a real, larger surface.
    expect(withProposalsBytes).toBeGreaterThan(defaultBytes);
  });

  it("dev profile exposes dev tools, hides the composites", async () => {
    const { names } = await listTools("dev");
    expect(names).toContain("dexe_compile");
    expect(names).toContain("dexe_dao_build_deploy");
    expect(names).not.toContain("dexe_dao_create");
  });
});
