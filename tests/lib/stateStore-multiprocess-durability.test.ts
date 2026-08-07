import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * 0.30.4 P2, the finding itself: concurrent state writes were SILENTLY DROPPED.
 * Measured before the fix, on Windows, with real concurrent processes:
 *
 *   2 writers → 12 of 60 persists dropped (20%)
 *   4 writers → 53 of 120 dropped (44%)
 *
 * Three separate defects fed that number, and this test is the end-to-end guard
 * for all of them at once:
 *
 *   1. the publish rename retried 3x with ZERO delay, so two writers colliding
 *      just collided again at full speed and the write failed outright;
 *   2. read-modify-write was unserialized, so a writer could publish a whole
 *      state file computed from a stale read and erase everything added since;
 *   3. lock acquisition treated Windows' EPERM (a lock file in pending-delete)
 *      as "unwritable directory" and fell straight through to the unlocked path.
 *
 * After the fix this run loses nothing. The same harness at 2 / 4 / 8 writers
 * measured 0 lost records out of 408 and 0 persist failures.
 *
 * The assertion is strict on purpose: "most writes survive" is the bug.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "..", "fixtures", "state-writer-child.ts");
const REPO = resolve(here, "..", "..");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* the OS will get it */
    }
  }
});

function runWriter(statePath: string, label: string, count: number, startAt: number) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CHILD, statePath, label, String(count), String(startAt)],
      { cwd: REPO, windowsHide: true, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        done({ code: typeof code === "number" ? code : error ? 1 : 0, out: stdout, err: stderr });
      },
    );
  });
}

describe("four concurrent OS processes writing one state.json", () => {
  it("loses nothing: every record from every writer survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-state-durability-"));
    dirs.push(dir);
    const p = join(dir, "state.json");
    const labels = ["a", "b", "c", "d"];
    const PER_WRITER = 10; // 40 records total, under the 50-entry cap

    // Every child spins to this instant before its first write, so the loops
    // genuinely overlap instead of running back to back.
    const startAt = Date.now() + 5_000;
    const results = await Promise.all(
      labels.map((l) => runWriter(p, l, PER_WRITER, startAt)),
    );

    const stderr = results.map((r) => r.err).join("");
    for (const [i, r] of results.entries()) {
      expect(r.code, `writer ${labels[i]} stderr: ${r.err}`).toBe(0);
      expect(r.out).toContain(`DONE ${labels[i]}`);
    }

    // Nobody had to give up on the write.
    expect(stderr).not.toContain("could not persist state");
    // The pre-0.30.4 shared-temp signature.
    expect(stderr).not.toContain("ENOENT");

    const parsed = JSON.parse(readFileSync(p, "utf8")) as {
      version: number;
      knownDaos: Array<{ name: string }>;
    };
    expect(parsed.version).toBe(1);

    const survived = new Set(parsed.knownDaos.map((d) => d.name));
    const expected = labels.flatMap((l) =>
      Array.from({ length: PER_WRITER }, (_, i) => `${l}-${i}`),
    );
    const missing = expected.filter((n) => !survived.has(n));
    expect(missing, `dropped ${missing.length}/${expected.length} records`).toEqual([]);

    // Every entry is a whole record from one writer or another — no field-level
    // interleaving of two processes' JSON.
    for (const d of parsed.knownDaos) expect(d.name).toMatch(/^[abcd]-\d+$/);

    // Nothing left in the directory but the state file: no orphaned temps, no
    // leaked lock.
    expect(readdirSync(dir)).toEqual(["state.json"]);
  }, 180_000);
});
