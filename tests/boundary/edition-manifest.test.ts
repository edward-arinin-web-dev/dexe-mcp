import { beforeAll, describe, expect, it } from "vitest";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { listTools, type ListedTools } from "../helpers/listTools.js";

/**
 * The edition manifest (src/editions.ts) against the surface the server
 * actually registers. Until the two editions ship as separate servers, this is
 * what keeps the line drawn: a tool added without a side fails here by name.
 */

function dupes(list: readonly string[]): string[] {
  const seen = new Set<string>();
  return list.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
}

describe("edition manifest", () => {
  let full: ListedTools;

  beforeAll(async () => {
    full = await listTools("full");
  });

  it("has 54 read and 115 write tools, no duplicates", () => {
    expect(dupes(READ_TOOLS), "listed twice in READ_TOOLS").toEqual([]);
    expect(dupes(WRITE_TOOLS), "listed twice in WRITE_TOOLS").toEqual([]);
    expect(READ_TOOLS.length).toBe(54);
    expect(WRITE_TOOLS.length).toBe(115);
  });

  it("the two editions are disjoint", () => {
    const write = new Set(WRITE_TOOLS);
    expect(READ_TOOLS.filter((n) => write.has(n)), "in both editions").toEqual([]);
  });

  it("read ∪ write is exactly the registered surface", () => {
    const registered = new Set(full.names);
    const manifest = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
    const unclassified = full.names.filter((n) => !manifest.has(n));
    const phantom = [...manifest].filter((n) => !registered.has(n)).sort();
    expect(
      unclassified,
      "registered but in neither edition — add each to READ_TOOLS or WRITE_TOOLS in src/editions.ts",
    ).toEqual([]);
    expect(phantom, "in src/editions.ts but not registered — renamed or removed?").toEqual([]);
  });

  it("every read tool is annotated readOnlyHint: true", () => {
    // dexe_dao_report passes this while still persisting reports.json beside
    // state.json — the annotation is set, the behaviour is not yet read-only.
    // An annotation check cannot see that, so the disk-write ratchet in
    // import-boundary.test.ts pins src/tools/report.ts until the read edition
    // makes snapshot persistence pluggable (off by default).
    const byName = new Map(full.tools.map((t) => [t.name, t]));
    const notReadOnly = READ_TOOLS.filter((n) => byName.get(n)?.annotations?.readOnlyHint !== true);
    expect(notReadOnly, "read-edition tools without readOnlyHint: true").toEqual([]);
  });
});
