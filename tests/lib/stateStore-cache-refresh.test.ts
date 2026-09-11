import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * D12-1, the other half: the re-read must be CHEAP.
 *
 * Replacing a load-once cache with "always read from disk" would trade a
 * correctness bug for a performance one — `load()` is called from `lastDao()`,
 * `dexe_context`, `dexe_guide` and every composite's state write. The stat
 * fast-path is what keeps it a stat instead of a parse, so it is worth an
 * explicit read counter rather than a claim in a comment.
 */

const ctl = vi.hoisted(() => ({ reads: 0, target: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((p: string, ...rest: unknown[]) => {
      if (ctl.target && String(p) === ctl.target) ctl.reads += 1;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { StateStore } = await import("../../src/lib/stateStore.js");

const dirs: string[] = [];
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "dexe-state-refresh-"));
  dirs.push(dir);
  return join(dir, "state.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* the OS will get it */
    }
  }
});

const dao = (name: string, n: number) => ({
  name,
  govPool: `0x${String(n).padStart(40, "0")}`,
  chainId: 97,
  deployedAt: new Date().toISOString(),
});

describe("the refresh is a stat, not a re-parse", () => {
  it("repeated reads with nothing happening parse the file exactly once", () => {
    const p = tmpState();
    const writer = new StateStore(p);
    writer.recordDao(dao("Seed", 1));

    const reader = new StateStore(p);
    ctl.target = p;
    ctl.reads = 0;
    reader.getState();
    reader.getState();
    reader.getState();
    reader.lastDao();
    expect(ctl.reads).toBe(1);
    ctl.target = "";
  });

  it("a peer's write costs exactly one more parse", () => {
    const p = tmpState();
    const writer = new StateStore(p);
    writer.recordDao(dao("Seed", 1));
    const reader = new StateStore(p);
    reader.getState();

    ctl.target = p;
    ctl.reads = 0;
    reader.getState();
    expect(ctl.reads).toBe(0); // still fresh

    writer.recordDao(dao("Peer", 2));
    // The writer's own read-modify-write also parses the file; count only what
    // the READER does from here on.
    ctl.reads = 0;
    expect(reader.getState().knownDaos[0]!.name).toBe("Peer");
    expect(ctl.reads).toBe(1);
    reader.getState();
    expect(ctl.reads).toBe(1); // and it settles again
    ctl.target = "";
  });

  it("a file that never existed is not re-parsed on every call", () => {
    const p = tmpState();
    const reader = new StateStore(p);
    ctl.target = p;
    ctl.reads = 0;
    expect(reader.getState().knownDaos).toEqual([]);
    expect(reader.getState().knownDaos).toEqual([]);
    // Nothing to stat and nothing to read — the empty state is served from the
    // cache rather than re-derived.
    expect(ctl.reads).toBe(0);
    ctl.target = "";
  });
});
