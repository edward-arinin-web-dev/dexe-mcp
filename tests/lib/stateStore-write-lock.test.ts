import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 0.30.4 P2, second half. Fixing the rename retry stopped writes from FAILING,
 * but they were still being LOST: atomic publish makes each write indivisible,
 * it does not make read-modify-write safe. Two windows both read state N, each
 * appends its own DAO, and the second rename publishes N+its-own — the first
 * window's DAO is gone, no error anywhere. Measured on Windows with 4 real
 * writer processes, that window ate 2-15 of every 40 records even with the
 * rename fixed.
 *
 * Two mechanisms close it, and both are tested here:
 *   1. a cross-process lock file, so the read and the publish are one section;
 *   2. a compare-and-swap publish, so a writer that could NOT take the lock
 *      still refuses to overwrite bytes it did not read.
 *
 * Neither may ever cost a write: if the lock cannot be taken, the write still
 * happens (see "runs the write anyway").
 */

const ctl = vi.hoisted(() => ({
  /** Leading `open` calls against the .lock path that throw before the real one runs. */
  openFailures: 0,
  openCode: "EPERM" as string,
  openCalls: 0,
  /** JSON published to the target by a "rival process" during the next temp write. */
  injectDuringTempWrite: null as string | null,
  target: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((p: string, ...rest: unknown[]) => {
      if (String(p).endsWith(".lock")) {
        ctl.openCalls += 1;
        if (ctl.openCalls <= ctl.openFailures) {
          const err = new Error(`${ctl.openCode}: simulated lock contention on ${String(p)}`);
          (err as NodeJS.ErrnoException).code = ctl.openCode;
          throw err;
        }
      }
      return (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof actual.openSync,
    writeFileSync: ((p: string, data: string, ...rest: unknown[]) => {
      const out = (actual.writeFileSync as (...a: unknown[]) => void)(p, data, ...rest);
      // Simulate another process publishing in the instant between our read and
      // our rename — the exact interleaving that loses an update.
      if (ctl.injectDuringTempWrite && ctl.target && String(p).endsWith(".tmp")) {
        const payload = ctl.injectDuringTempWrite;
        ctl.injectDuringTempWrite = null;
        actual.writeFileSync(ctl.target, payload, "utf8");
      }
      return out;
    }) as typeof actual.writeFileSync,
  };
});

const { LOCK_BUDGET_MS, LOCK_STALE_MS, StateStore, lockBackoffMs, lockPath, withWriteLock } =
  await import("../../src/lib/stateStore.js");

const dirs: string[] = [];
function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "dexe-state-lock-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

beforeEach(() => {
  ctl.openFailures = 0;
  ctl.openCode = "EPERM";
  ctl.openCalls = 0;
  ctl.injectDuringTempWrite = null;
  ctl.target = "";
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

const dao = (name: string, n: number) => ({
  name,
  govPool: `0x${String(n).padStart(40, "0")}`,
  chainId: 97,
  deployedAt: "2026-08-06T00:00:00.000Z",
});

const stateWith = (...names: string[]) =>
  JSON.stringify(
    {
      version: 1,
      knownDaos: names.map((n, i) => dao(n, 900 + i)),
      recentProposals: [],
      walletLabels: {},
    },
    null,
    2,
  );

/* ───────────────────────────── budget coherence ──────────────────────────── */

describe("lock timing constants", () => {
  it("collects a corpse-lock INSIDE the wait budget", () => {
    // If staleness were the larger of the two, a process that died holding the
    // lock would push every future writer through its whole budget and onto the
    // unlocked path — permanently, until someone deleted the file by hand.
    expect(LOCK_STALE_MS).toBeLessThan(LOCK_BUDGET_MS);
  });

  it("polls often enough to keep a waiter from starving out of the budget", () => {
    const polls = Array.from({ length: 50 }, (_, i) => lockBackoffMs(i));
    for (const p of polls) expect(p).toBeLessThanOrEqual(8);
    expect(new Set(polls.slice(10)).size).toBeGreaterThan(1); // jittered, not a fixed tick
  });
});

/* ──────────────────────────── acquire / release ──────────────────────────── */

describe("withWriteLock", () => {
  it("holds the lock for the duration of fn and removes it after", () => {
    const p = tmpState();
    let heldDuring = false;
    withWriteLock(p, () => {
      heldDuring = existsSync(lockPath(p));
    });
    expect(heldDuring).toBe(true);
    expect(existsSync(lockPath(p))).toBe(false);
  });

  it("releases the lock when fn throws, so one failure cannot wedge every later write", () => {
    const p = tmpState();
    expect(() => withWriteLock(p, () => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(existsSync(lockPath(p))).toBe(false);
  });

  it("creates the state directory on the very first write", () => {
    const p = join(mkdtempSync(join(tmpdir(), "dexe-state-lock-")), "nested", "deep", "state.json");
    dirs.push(dirname(dirname(p)));
    let held = false;
    withWriteLock(p, () => {
      held = existsSync(lockPath(p));
    });
    expect(held).toBe(true);
  });

  it("retries an EPERM from open — Windows reports a mid-delete lock file that way", () => {
    // Regression: treating anything-but-EEXIST as "unwritable directory" made
    // the writer abandon the lock after ~8ms and publish unlocked, which is how
    // records were still disappearing after the lock landed.
    const p = tmpState();
    ctl.openFailures = 3;
    ctl.openCode = "EPERM";
    let held = false;
    withWriteLock(p, () => {
      held = existsSync(lockPath(p));
    });
    expect(held).toBe(true);
    expect(ctl.openCalls).toBe(4);
  });

  it("retries EACCES and EBUSY from open too", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const p = tmpState();
      ctl.openCalls = 0;
      ctl.openFailures = 2;
      ctl.openCode = code;
      let held = false;
      withWriteLock(p, () => {
        held = existsSync(lockPath(p));
      });
      expect(held, code).toBe(true);
    }
  });

  it("runs the write anyway when the lock genuinely cannot be created", () => {
    // A read-only or nonexistent directory must never mean "skip the write" —
    // losing a DAO the user paid gas for is worse than racing for it.
    const p = tmpState();
    ctl.openFailures = Number.MAX_SAFE_INTEGER;
    ctl.openCode = "EROFS";
    let ran = false;
    const t0 = Date.now();
    withWriteLock(p, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(ctl.openCalls).toBe(1); // fatal code: no pointless waiting
    expect(Date.now() - t0).toBeLessThan(LOCK_BUDGET_MS);
  });

  it("breaks a lock left behind by a process that died holding it", () => {
    const p = tmpState();
    const lock = lockPath(p);
    writeFileSync(lock, "4242 crashed-holder\n", "utf8");
    const old = new Date(Date.now() - 10 * LOCK_STALE_MS);
    utimesSync(lock, old, old);

    let held = false;
    const t0 = Date.now();
    withWriteLock(p, () => {
      held = existsSync(lock);
    });
    expect(held).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500); // collected immediately, not waited out
    expect(existsSync(lock)).toBe(false);
  });

  it("waits for a lock that looks alive, then collects it once it goes stale", () => {
    const p = tmpState();
    const lock = lockPath(p);
    writeFileSync(lock, "4242 holder-that-never-returns\n", "utf8"); // fresh mtime

    let held = false;
    const t0 = Date.now();
    withWriteLock(p, () => {
      held = existsSync(lock);
    });
    const waited = Date.now() - t0;
    expect(held).toBe(true);
    // It waited (did not barge in on a live holder) but still got in via the
    // staleness breaker, inside the budget rather than at the end of it.
    expect(waited).toBeGreaterThanOrEqual(LOCK_STALE_MS - 100);
    expect(waited).toBeLessThan(LOCK_BUDGET_MS);
  }, 15_000);
});

/* ─────────────────────── compare-and-swap on publish ─────────────────────── */

describe("compare-and-swap publish", () => {
  it("does not overwrite a record that landed while it was computing", () => {
    const p = tmpState();
    writeFileSync(p, stateWith("Original"), "utf8");
    const store = new StateStore(p);
    store.getState();

    // A rival publishes {Rival, Original} in the window between our read and
    // our rename. Pre-CAS this write clobbered it and Rival vanished.
    ctl.target = p;
    ctl.injectDuringTempWrite = stateWith("Rival", "Original");

    store.recordDao(dao("Ours", 1));

    const names = (JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> })
      .knownDaos.map((d) => d.name);
    expect(names).toContain("Ours");
    expect(names).toContain("Rival"); // the whole point
    expect(names).toContain("Original");
  });

  it("recomputes from the winner's state, not from its own stale read", () => {
    const p = tmpState();
    writeFileSync(p, stateWith("Original"), "utf8");
    const store = new StateStore(p);
    ctl.target = p;
    ctl.injectDuringTempWrite = stateWith("Rival");

    store.recordDao(dao("Ours", 2));

    const names = (JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> })
      .knownDaos.map((d) => d.name);
    // "Original" is gone because the RIVAL dropped it — we rebuilt on top of
    // whatever the file actually held, which is exactly the contract.
    expect(names).toEqual(["Ours", "Rival"]);
  });

  it("still writes on the uncontended path (no CAS churn)", () => {
    const p = tmpState();
    const store = new StateStore(p);
    store.recordDao(dao("Solo", 3));
    expect(
      (JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> }).knownDaos,
    ).toHaveLength(1);
  });

  it("leaves no lock or temp file behind after a normal write", () => {
    const p = tmpState();
    new StateStore(p).recordDao(dao("Tidy", 4));
    expect(readdirSync(dirname(p))).toEqual(["state.json"]);
  });

  it("cleans up the abandoned temp file when the CAS check fails", () => {
    const p = tmpState();
    writeFileSync(p, stateWith("Original"), "utf8");
    ctl.target = p;
    ctl.injectDuringTempWrite = stateWith("Rival");
    new StateStore(p).recordDao(dao("Ours", 5));
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
