import { describe, it, expect } from "vitest";
import { pageMeta, truncationNote } from "../../src/lib/page.js";

/**
 * 0.34.0 — a full page used to be indistinguishable from a complete list.
 *
 * `dexe_read_dao_members` defaults to limit 20 and BOXY DAO has 104 voters, so
 * "this DAO has 20 members" was what an agent reported. The two live shapes
 * these cases encode are named in each test: BOXY's 104 members (a usable
 * total) and its 0 experts against the same 104 `votersCount` (a total that
 * counts a DIFFERENT set and must never drive `truncated`).
 */
describe("pageMeta", () => {
  it("a full page with no total is truncated and advances", () => {
    const m = pageMeta({ offset: 0, limit: 20, returned: 20 });
    expect(m.truncated).toBe(true);
    expect(m.nextOffset).toBe(20);
    // Absent, not undefined-valued: an unknown total must not serialize as one.
    expect("total" in m).toBe(false);
  });

  it("a short page is the end of the list", () => {
    const m = pageMeta({ offset: 0, limit: 20, returned: 12 });
    expect(m.truncated).toBe(false);
    expect(m.nextOffset).toBeUndefined();
  });

  it("a known total ends the walk instead of paging past the last row", () => {
    const m = pageMeta({ offset: 100, limit: 20, returned: 4, total: 104 });
    expect(m.truncated).toBe(false);
    expect(m.nextOffset).toBeUndefined();
    expect(m.total).toBe(104);
  });

  it("a full page with a known total reports both", () => {
    const m = pageMeta({ offset: 0, limit: 20, returned: 20, total: 104 });
    expect(m).toMatchObject({ truncated: true, nextOffset: 20, total: 104 });
  });

  it("ZERO rows is never truncated, even with a total that disagrees", () => {
    // The live BOXY case: 0 experts, votersCount 104. A total-driven rule emits
    // `truncated: true, nextOffset: 0` — an instruction to re-issue the
    // identical call forever.
    const m = pageMeta({ offset: 0, limit: 50, returned: 0, total: 104 });
    expect(m.truncated).toBe(false);
    expect(m.nextOffset).toBeUndefined();
  });

  it("an under-counting total is dropped, not believed", () => {
    // A stale index that says 5 must not talk a full page of 20 into claiming
    // completeness — that is the very defect being fixed.
    const m = pageMeta({ offset: 0, limit: 20, returned: 20, total: 5 });
    expect(m.truncated).toBe(true);
    expect(m.nextOffset).toBe(20);
    expect("total" in m).toBe(false);
  });
});

describe("truncationNote", () => {
  it("is empty when nothing is truncated", () => {
    expect(truncationNote(pageMeta({ offset: 0, limit: 20, returned: 3 }), "t", "row")).toBe("");
  });

  it("names the tool, the next offset and the do-not-report rule", () => {
    const note = truncationNote(pageMeta({ offset: 0, limit: 20, returned: 20 }), "dexe_x", "member");
    expect(note).toContain("dexe_x");
    expect(note).toContain("offset: 20");
    expect(note).toContain("total unknown");
    expect(note).toContain("Do NOT report");
  });

  it("uses the tool's OWN cursor names, never offset/limit", () => {
    // dexe_proposal_voters pages by first/skip and its published input schema is
    // additionalProperties:false — an "offset:" remediation is unexecutable.
    const note = truncationNote(
      pageMeta({ offset: 50, limit: 50, returned: 50 }),
      "dexe_proposal_voters",
      "voter",
      { offsetKey: "skip", limitKey: "first" },
    );
    expect(note).toContain("skip: 100");
    expect(note).toContain("first");
    expect(note).not.toContain("offset:");
  });
});
