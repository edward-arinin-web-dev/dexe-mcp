import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 0.30.4 P2. The publish rename retried three times with ZERO delay, on a
 * comment that claimed "retrying immediately is enough; a sleep would only make
 * the two writers collide again". Measured on Windows with real concurrent
 * processes, that is empirically false:
 *
 *   2 writers → 12 of 60 persists dropped (20%)
 *   4 writers → 53 of 120 dropped (44%)
 *
 * The EPERM survives all three immediate attempts, because two writers retrying
 * at full speed simply collide again. The atomic publish itself was fine (507
 * polls: zero torn reads, zero zero-byte reads, no orphaned temps) — only the
 * retry policy was wrong. These tests pin the new policy: more attempts,
 * exponential, and jittered so two writers desynchronize.
 */

/** Controls the mocked `renameSync` below. Hoisted so `vi.mock` can close over it. */
const ctl = vi.hoisted(() => ({
  calls: 0,
  /** How many leading calls throw before the real rename runs. */
  failures: 0,
  code: "EPERM" as string,
  /** Wall-clock of every rename attempt, for measuring the gaps between them. */
  stamps: [] as number[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      ctl.calls += 1;
      ctl.stamps.push(Date.now());
      if (ctl.calls <= ctl.failures) {
        const err = new Error(`${ctl.code}: simulated contention, rename '${String(from)}' -> '${String(to)}'`);
        (err as NodeJS.ErrnoException).code = ctl.code;
        throw err;
      }
      return actual.renameSync(from, to);
    },
  };
});

const { RENAME_ATTEMPTS, StateStore, renameBackoffMs, renameWithRetry } = await import(
  "../../src/lib/stateStore.js"
);

const dirs: string[] = [];
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "dexe-state-backoff-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

beforeEach(() => {
  ctl.calls = 0;
  ctl.failures = 0;
  ctl.code = "EPERM";
  ctl.stamps = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* the OS will get it */
    }
  }
});

/** Stage the temp file a rename probe publishes. Only `renameSync` is mocked, so this writes for real. */
function probe(target: string): string {
  const tmp = `${target}.probe.tmp`;
  writeFileSync(tmp, "payload", "utf8");
  return tmp;
}

let daoSeq = 0;
const dao = (name: string) => ({
  name,
  govPool: `0x${String(++daoSeq).padStart(40, "0")}`,
  chainId: 97,
  deployedAt: "2026-08-06T00:00:00.000Z",
});

/* ─────────────────────────── the backoff curve itself ────────────────────── */

describe("renameBackoffMs", () => {
  const pinned = (v: number) => () => v;

  it("grows exponentially: each attempt's ceiling doubles", () => {
    // rand()=0 yields the floor of each window: 5, 10, 20, 40, 80 ms.
    expect([0, 1, 2, 3, 4].map((a) => renameBackoffMs(a, pinned(0)))).toEqual([5, 10, 20, 40, 80]);
  });

  it("never returns a constant — the delay is drawn inside the window", () => {
    // Same attempt, two different draws → two different delays. A constant
    // delay is exactly what re-collides two writers.
    expect(renameBackoffMs(2, pinned(0))).not.toBe(renameBackoffMs(2, pinned(0.9)));
  });

  it("is jittered across a real Math.random population", () => {
    const samples = Array.from({ length: 200 }, () => renameBackoffMs(2));
    expect(new Set(samples).size).toBeGreaterThan(50);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(20);
      expect(s).toBeLessThan(40);
    }
  });

  it("is monotonic: the slowest draw of attempt N is no slower than the fastest of N+1", () => {
    for (let a = 0; a < 5; a++) {
      const maxThis = renameBackoffMs(a, pinned(0.999999));
      const minNext = renameBackoffMs(a + 1, pinned(0));
      expect(minNext).toBeGreaterThanOrEqual(maxThis);
    }
  });

  it("draws from Math.random by default, per call", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    renameBackoffMs(0);
    renameBackoffMs(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not consume randomness at module load — importing twice must be deterministic", async () => {
    // The jitter has to live inside the retry function; a module-level draw
    // would make every retry in the process use the same fixed delay (and make
    // these tests non-deterministic).
    vi.resetModules();
    const spy = vi.spyOn(Math, "random");
    await import("../../src/lib/stateStore.js");
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ──────────────────────────── the retry loop ─────────────────────────────── */

describe("renameWithRetry under simulated contention", () => {
  it("survives more consecutive EPERMs than the old 3-attempt budget allowed", () => {
    const p = tmpState();
    const tmp = probe(p);
    ctl.failures = RENAME_ATTEMPTS - 1; // fails on every attempt but the last

    expect(() => renameWithRetry(tmp, p)).not.toThrow();
    expect(ctl.calls).toBe(RENAME_ATTEMPTS);
    expect(readFileSync(p, "utf8")).toBe("payload");
  });

  it("actually sleeps between attempts (the old policy retried with zero delay)", () => {
    const p = tmpState();
    const tmp = probe(p);
    ctl.failures = 3; // three sleeps: >=5ms, >=10ms, >=20ms
    const t0 = Date.now();
    renameWithRetry(tmp, p);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it("the gaps grow — the last retry waits far longer than the first", () => {
    const p = tmpState();
    const tmp = probe(p);
    ctl.failures = 5;
    renameWithRetry(tmp, p);

    const gaps = ctl.stamps.slice(1).map((t, i) => t - ctl.stamps[i]!);
    expect(gaps).toHaveLength(5);
    // Windows timers are coarse (~15ms), so assert the shape with slack rather
    // than exact per-step values: first gap is drawn from [5,10), last from
    // [80,160).
    expect(gaps[0]!).toBeLessThan(45);
    expect(gaps.at(-1)!).toBeGreaterThanOrEqual(60);
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]!);
  });

  it("jitters every retry — one Math.random draw per sleep, none reused", () => {
    const p = tmpState();
    const tmp = probe(p);
    const spy = vi.spyOn(Math, "random");
    ctl.failures = 4;
    renameWithRetry(tmp, p);
    expect(spy).toHaveBeenCalledTimes(4); // one fresh draw per backoff
  });

  it("gives up after the full budget and rethrows the real error", () => {
    const p = tmpState();
    const tmp = probe(p);
    ctl.failures = Number.MAX_SAFE_INTEGER;
    expect(() => renameWithRetry(tmp, p)).toThrow(/EPERM/);
    expect(ctl.calls).toBe(RENAME_ATTEMPTS);
  });

  it("retries EACCES and EBUSY too — Windows reports the same collision three ways", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      ctl.calls = 0;
      ctl.code = code;
      ctl.failures = 2;
      const p = tmpState();
      const tmp = probe(p);
      expect(() => renameWithRetry(tmp, p)).not.toThrow();
      expect(ctl.calls).toBe(3);
    }
  });

  it("does not burn the budget (or the wall clock) on a non-transient error", () => {
    const p = tmpState();
    const tmp = probe(p);
    ctl.code = "ENOSPC";
    ctl.failures = Number.MAX_SAFE_INTEGER;
    const t0 = Date.now();
    expect(() => renameWithRetry(tmp, p)).toThrow(/ENOSPC/);
    expect(ctl.calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(30);
  });
});

/* ───────────────────── the bug as the user experiences it ────────────────── */

describe("StateStore.persist under contention", () => {
  it("a write contended through 5 attempts still lands (pre-0.30.4 it was silently dropped)", () => {
    const p = tmpState();
    const store = new StateStore(p);
    ctl.failures = RENAME_ATTEMPTS - 1;

    store.recordDao(dao("Aurora"));

    const onDisk = JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> };
    expect(onDisk.knownDaos.map((d) => d.name)).toEqual(["Aurora"]);
    // The atomic publish must stay clean: nothing left in the directory.
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("still degrades quietly (no throw, no orphan temp) when contention outlasts the budget", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const p = tmpState();
    const store = new StateStore(p);
    ctl.failures = Number.MAX_SAFE_INTEGER;

    expect(() => store.recordDao(dao("Boreal"))).not.toThrow();
    // The tool call that just landed a tx still returns its result.
    expect(store.getState().knownDaos).toHaveLength(1);
    expect(String(stderr.mock.calls.map((c) => c[0]).join(""))).toContain("could not persist state");
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("consecutive contended writes accumulate rather than overwrite", () => {
    const p = tmpState();
    const store = new StateStore(p);
    for (const name of ["Aurora", "Boreal", "Cinder"]) {
      ctl.calls = 0;
      ctl.failures = 2;
      store.recordDao(dao(name));
    }
    const onDisk = JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> };
    expect(onDisk.knownDaos.map((d) => d.name)).toEqual(["Cinder", "Boreal", "Aurora"]);
  });
});

