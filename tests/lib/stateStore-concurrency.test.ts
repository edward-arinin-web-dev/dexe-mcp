import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { StateStore, tempStatePath } from "../../src/lib/stateStore.js";

/**
 * 0.30.4. `~/.dexe-mcp/state.json` is shared by every Claude Code window on
 * the machine, and the store treated it as single-process:
 *
 *   1. All writers used the SAME `<path>.tmp`. Window A wrote the temp, window
 *      B overwrote it, A's rename published B's bytes and B's rename failed
 *      ENOENT — one window's known-DAO list gone, with no error the user ever
 *      saw.
 *   2. The in-memory cache was loaded once per process, so the second window
 *      computed its update from a snapshot taken at ITS startup and dropped
 *      everything the first window had recorded since.
 *
 * Neither may ever cost the user a DAO they just paid gas to deploy, and no
 * failure here — read-only disk, no HOME, a path that cannot be created — may
 * throw into a tool or into startup.
 */

const tmpDirs: string[] = [];
function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), "dexe-state-conc-"));
  tmpDirs.push(dir);
  return join(dir, "state.json");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* the OS will get it */
    }
  }
});

const dao = (over: Partial<Parameters<StateStore["recordDao"]>[0]> = {}) => ({
  name: "Aurora",
  govPool: "0x1111111111111111111111111111111111111111",
  chainId: 97,
  deployedAt: "2026-08-06T00:00:00.000Z",
  ...over,
});

describe("tempStatePath", () => {
  it("is unique per call, so two writers never share a temp file", () => {
    const seen = new Set(Array.from({ length: 200 }, () => tempStatePath("/x/state.json")));
    expect(seen.size).toBe(200);
  });

  it("carries the pid, so a temp left by a crash names the process that made it", () => {
    expect(tempStatePath("/x/state.json")).toContain(`.${process.pid}.`);
  });

  it("stays in the target's own directory — rename is only atomic within a volume", () => {
    const target = join("/x", "y", "state.json");
    expect(dirname(tempStatePath(target))).toBe(dirname(target));
  });

  it("keeps the .tmp suffix so cleanup globs still match", () => {
    expect(tempStatePath("/x/state.json").endsWith(".tmp")).toBe(true);
  });
});

describe("two sessions sharing one state.json (in-process)", () => {
  it("a second session's write no longer erases the first session's DAOs", () => {
    const p = tmpPath();
    const windowA = new StateStore(p);
    const windowB = new StateStore(p);
    // Both read at startup — this is dexe_context on session open, and it is
    // what made window B's cache stale for the rest of its life.
    windowA.getState();
    windowB.getState();

    windowA.recordDao(dao({ name: "FromA", govPool: "0xaaaa000000000000000000000000000000000001" }));
    windowB.recordDao(dao({ name: "FromB", govPool: "0xbbbb000000000000000000000000000000000002" }));

    const names = new StateStore(p).getState().knownDaos.map((d) => d.name);
    expect(names).toContain("FromB");
    expect(names).toContain("FromA"); // regressed pre-0.30.4: B's stale cache dropped it
  });

  it("interleaved writes from two sessions all survive", () => {
    const p = tmpPath();
    const a = new StateStore(p);
    const b = new StateStore(p);
    a.getState();
    b.getState();
    for (let i = 0; i < 5; i++) {
      a.recordDao(dao({ name: `A${i}`, govPool: `0xaaaa${String(i).padStart(36, "0")}` }));
      b.recordDao(dao({ name: `B${i}`, govPool: `0xbbbb${String(i).padStart(36, "0")}` }));
    }
    const names = new StateStore(p).getState().knownDaos.map((d) => d.name);
    expect(names).toHaveLength(10);
    for (let i = 0; i < 5; i++) {
      expect(names).toContain(`A${i}`);
      expect(names).toContain(`B${i}`);
    }
  });

  it("leaves no temp files behind on a successful write", () => {
    const p = tmpPath();
    new StateStore(p).recordDao(dao());
    const leftovers = readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("an unwritable state path degrades instead of throwing", () => {
  it("survives a directory that cannot be created (parent is a file)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "dexe-state-blocked-"));
    tmpDirs.push(dir);
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "i am a file, not a directory", "utf8");
    const store = new StateStore(join(blocker, "state.json"));

    expect(() => store.recordDao(dao())).not.toThrow();
    // The in-memory view still works, so the tool call that just landed a tx
    // returns its result instead of failing on a bookkeeping error.
    expect(store.getState().knownDaos).toHaveLength(1);
    expect(String(stderr.mock.calls.map((c) => c[0]).join(""))).toContain("could not persist state");
  });

  it("survives a state path that is itself a directory", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "dexe-state-isdir-"));
    tmpDirs.push(dir);
    const store = new StateStore(dir); // the "file" is a directory
    expect(() => store.recordDao(dao())).not.toThrow();
    expect(() => store.getState()).not.toThrow();
  });

  it("leaves no orphan temp file when the write fails", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "dexe-state-orphan-"));
    tmpDirs.push(dir);
    const target = join(dir, "sub");
    writeFileSync(target, "blocking file", "utf8");
    new StateStore(join(target, "state.json")).recordDao(dao());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a corrupt file is replaced by the next write, not propagated", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const p = tmpPath();
    writeFileSync(p, '{"version": 1, "knownDaos": [truncated…', "utf8");
    const store = new StateStore(p);
    expect(() => store.recordDao(dao({ name: "Recovered" }))).not.toThrow();
    const raw = JSON.parse(readFileSync(p, "utf8")) as { knownDaos: Array<{ name: string }> };
    expect(raw.knownDaos[0]!.name).toBe("Recovered");
  });
});

/* ───────────────────── real concurrency: two OS processes ────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "..", "fixtures", "state-writer-child.ts");
const REPO = resolve(here, "..", "..");

function runWriter(statePath: string, label: string, count: number, startAt: number) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CHILD, statePath, label, String(count), String(startAt)],
      { cwd: REPO, windowsHide: true, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        done({ code: typeof code === "number" ? code : error ? 1 : 0, out: stdout, err: stderr });
      },
    );
  });
}

describe("two concurrent OS processes writing one state.json", () => {
  it("both survive and the file is never truncated or partially written", async () => {
    const p = tmpPath();
    // Both children spin until this instant before their first write, so the
    // loops genuinely overlap instead of running back to back.
    const startAt = Date.now() + 4_000;
    const [a, b] = await Promise.all([runWriter(p, "a", 60, startAt), runWriter(p, "b", 60, startAt)]);

    // Both writers survive: neither crashed on the other's temp file.
    expect(a.code, `writer a stderr: ${a.err}`).toBe(0);
    expect(b.code, `writer b stderr: ${b.err}`).toBe(0);
    expect(a.out).toContain("DONE a");
    expect(b.out).toContain("DONE b");

    // The pre-0.30.4 signature: A renamed the shared temp away, B's rename
    // then failed with ENOENT. A per-process temp makes that impossible.
    expect(a.err).not.toContain("ENOENT");
    expect(b.err).not.toContain("ENOENT");

    // The published file is always exactly one complete JSON document.
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as { version: number; knownDaos: Array<{ name: string }> };
    expect(parsed.version).toBe(1);
    expect(parsed.knownDaos.length).toBeGreaterThan(0);
    // Every surviving entry is a whole record from one writer or the other —
    // no field-level interleaving of the two processes' JSON.
    for (const d of parsed.knownDaos) expect(d.name).toMatch(/^[ab]-\d+$/);

    // No writer left its temp behind.
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 120_000);
});

describe("a live store sees a peer process's writes", () => {
  /**
   * D12-1. 0.30.4 hardened the WRITE path — private temp, atomic rename,
   * cross-process lock, compare-and-swap — so a peer's write can no longer be
   * clobbered. The READ path was left a load-once cache, and exactly one
   * StateStore lives for the whole server process. So the file on disk became
   * correct while this window's view of it froze at session open: every DAO
   * another Claude Code window, a swarm subprocess or the CLI recorded was
   * invisible to dexe_context for the rest of the session.
   */

  it("getState() after a peer's recordDao returns the peer's DAO", () => {
    const p = tmpPath();
    const A = new StateStore(p);
    const B = new StateStore(p);
    // B reads at session open — the call that used to pin its cache forever.
    expect(B.getState().knownDaos).toEqual([]);
    A.recordDao(dao({ name: "FromA", govPool: "0xaaaa000000000000000000000000000000000001" }));
    expect(B.getState().knownDaos.map((d) => d.name)).toContain("FromA");
  });

  it("lastDao() reflects a peer's newer DAO", () => {
    const p = tmpPath();
    const A = new StateStore(p);
    const B = new StateStore(p);
    B.getState();
    A.recordDao(dao({ name: "FromA", govPool: "0xaaaa000000000000000000000000000000000001" }));
    expect(B.lastDao()?.name).toBe("FromA");
  });

  it("sees a peer's SAME-LENGTH write", () => {
    // `lastChainId` 97 <-> 56 is the same byte count either way, so an
    // mtimeMs+size stamp alone routinely misses it on NTFS. The inode is what
    // discriminates: every publish renames a fresh temp over the target.
    const p = tmpPath();
    const A = new StateStore(p);
    const B = new StateStore(p);
    B.getState();
    for (let i = 0; i < 5; i++) {
      const want = i % 2 ? 56 : 97;
      A.setLastChainId(want);
      expect(B.getState().lastChainId, `iteration ${i}`).toBe(want);
    }
  });

  it("sees its OWN write immediately", () => {
    const p = tmpPath();
    const store = new StateStore(p);
    store.getState();
    store.recordDao(dao({ name: "Mine", govPool: "0xcccc000000000000000000000000000000000003" }));
    expect(store.getState().knownDaos[0]!.name).toBe("Mine");
  });

  it("survives the file being deleted mid-session", () => {
    const p = tmpPath();
    const store = new StateStore(p);
    store.recordDao(dao());
    rmSync(p, { force: true });
    expect(() => store.getState()).not.toThrow();
  });

  it("keeps serving a record it could NOT persist", () => {
    // The cache is then the only copy of a DAO the user just paid gas for, so
    // a stat failure must never be read as "re-read from disk".
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "dexe-state-unpub-"));
    tmpDirs.push(dir);
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "i am a file, not a directory", "utf8");
    const store = new StateStore(join(blocker, "state.json"));
    store.recordDao(dao());
    expect(store.getState().knownDaos).toHaveLength(1);
    expect(store.getState().knownDaos).toHaveLength(1);
  });
});

describe("walletLabels is capped like every other collection", () => {
  it("keeps the 100 most recently set labels", () => {
    const p = tmpPath();
    const store = new StateStore(p);
    for (let i = 0; i < 120; i++) {
      store.setWalletLabel(`0x${String(i).padStart(40, "0")}`, `label-${i}`);
    }
    const labels = store.getState().walletLabels;
    expect(Object.keys(labels)).toHaveLength(100);
    expect(labels[`0x${String(0).padStart(40, "0")}`]).toBeUndefined();
    expect(labels[`0x${String(119).padStart(40, "0")}`]).toBe("label-119");
  });

  it("re-labelling an address moves it to the newest end, never duplicates it", () => {
    const p = tmpPath();
    const store = new StateStore(p);
    const addr = `0x${"a".repeat(40)}`;
    store.setWalletLabel(addr, "first");
    for (let i = 0; i < 99; i++) store.setWalletLabel(`0x${String(i).padStart(40, "0")}`, `l${i}`);
    store.setWalletLabel(addr, "renamed");
    for (let i = 100; i < 140; i++) store.setWalletLabel(`0x${String(i).padStart(40, "0")}`, `l${i}`);
    const labels = store.getState().walletLabels;
    expect(Object.keys(labels)).toHaveLength(100);
    expect(labels[addr]).toBe("renamed");
  });
});
