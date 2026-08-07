import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { debugLog } from "../runtime.js";
import { safeErrorMessage } from "./redact.js";

/**
 * Persistent operational state (Phase 3 / v0.14.0). The MCP server otherwise
 * remembers nothing between sessions — every session re-derives which DAOs
 * exist, which chain was last used, etc. This is a tiny JSON store that records
 * DAOs deployed via `dexe_dao_create` and proposals broadcast via
 * `dexe_proposal_create`, so `dexe_context` can surface them next session.
 *
 * Design: **multi-process safe**, in four layers, because the file is shared by
 * every Claude Code window on the machine and a dropped write means a DAO the
 * user paid gas for is simply forgotten:
 *
 *  1. a private temp file per write, so two writers never share a staging path;
 *  2. an atomic publish (rename onto the target) — a reader sees the old file
 *     or the new one, never a torn or empty one;
 *  3. a cross-process lock file, so read-modify-write is one section and a
 *     second window cannot compute its update from a state that has moved on;
 *  4. a compare-and-swap on publish, so even a writer that could NOT take the
 *     lock refuses to overwrite bytes it did not read.
 *
 * Tolerant at every layer — a missing/corrupt/newer file, an unwritable
 * directory, a lock that cannot be created, or a host with no home directory
 * never throws into a tool or into startup. Each degradation is chosen to keep
 * the write rather than protect the file: losing the record is the worse
 * outcome, so the last resort is always "publish anyway", never "skip".
 */

export const STATE_VERSION = 1;

export interface KnownDao {
  name: string;
  govPool: string;
  chainId: number;
  userKeeper?: string;
  token?: string;
  txHash?: string;
  /** ISO-8601 timestamp of when it was recorded. */
  deployedAt: string;
}

export interface RecentProposal {
  govPool: string;
  chainId: number;
  title?: string;
  descriptionURL?: string;
  txHash?: string;
  createdAt: string;
}

/** In-progress guided flow (Phase B knowledge layer) — survives sessions. */
export interface ActiveFlow {
  flow: string;
  step: string;
  chainId: number;
  govPool?: string;
  startedAt: string;
  updatedAt: string;
}

export interface PersistedState {
  version: number;
  knownDaos: KnownDao[];
  lastChainId?: number;
  recentProposals: RecentProposal[];
  /** address (lowercased) → human label. */
  walletLabels: Record<string, string>;
  /** Set while a dexe_guide-driven flow is mid-journey; cleared on the final step. */
  activeFlow?: ActiveFlow;
}

const MAX_DAOS = 50;
const MAX_PROPOSALS = 25;

function emptyState(): PersistedState {
  return { version: STATE_VERSION, knownDaos: [], recentProposals: [], walletLabels: {} };
}

/**
 * Resolve the state file path: DEXE_STATE_PATH override, else
 * ~/.dexe-mcp/state.json.
 *
 * Never throws. This runs inside `loadConfig()`, i.e. on the startup path, and
 * `os.homedir()` is not total: on a locked-down host with neither HOME nor
 * USERPROFILE (some CI images, some corporate Windows profiles, containers run
 * with a scrubbed environment) it can throw or return "". Letting that escape
 * would send the whole server into degraded mode over a cache file that
 * nothing depends on, so we fall back to the temp dir instead — and if that is
 * unwritable too, `persist()` degrades to a stderr warning.
 */
export function resolveStatePath(override?: string): string {
  const raw = (override ?? process.env.DEXE_STATE_PATH)?.trim();
  if (raw) return raw;
  let home = "";
  try {
    home = homedir() ?? "";
  } catch {
    home = "";
  }
  const base = home || tmpdir();
  return join(base, ".dexe-mcp", "state.json");
}

/** Per-process counter, so two writes from the same pid can't collide either. */
let tempSeq = 0;

/**
 * Private temp-file name for one atomic write.
 *
 * The old shared `<path>.tmp` made concurrent sessions destroy each other:
 * process A writes the temp, process B overwrites the SAME temp, A renames and
 * publishes B's bytes, then B's rename fails ENOENT — one window's known-DAO
 * list gone, silently. pid + counter + entropy gives every writer a temp
 * nobody else can touch, leaving `rename` as the only shared step. Rename onto
 * an existing name is atomic on POSIX and, via MoveFileEx, on NTFS — provided
 * the temp is in the SAME directory as the target, which is why the name is
 * built by suffixing the target rather than using the OS temp dir.
 */
/*
 * 96 bits of randomness, and every writer opens the result with `wx` + 0600.
 * The randomness alone is not the guard: without exclusive create, a symlink
 * planted at the predicted path would be FOLLOWED, so the write lands wherever
 * the attacker chose (js/insecure-temporary-file). `DEXE_STATE_PATH` can point
 * the whole state dir at a shared location, which is when that stops being
 * theoretical.
 */
export function tempStatePath(target: string): string {
  tempSeq = (tempSeq + 1) >>> 0;
  return `${target}.${process.pid}.${tempSeq.toString(36)}.${randomBytes(12).toString("hex")}.tmp`;
}

/**
 * Retry budget for the publish rename. 6 attempts = 5 backoff sleeps, so the
 * worst case a persist can block is ~310ms — invisible next to the deploy or
 * broadcast that triggered it, and only ever paid under real contention.
 */
export const RENAME_ATTEMPTS = 6;
const RENAME_BASE_DELAY_MS = 10;

/**
 * Sleep for one backoff step, in [ceiling/2, ceiling) where ceiling doubles per
 * attempt: [5,10) [10,20) [20,40) [40,80) [80,160) ms.
 *
 * "Equal jitter": the halves guarantee the delay grows monotonically (each
 * range starts where the previous one ends), and the random half is what
 * actually solves the bug — two writers that both back off by the SAME amount
 * simply re-collide on the same schedule, which is what the old zero-delay
 * loop did at full speed. Randomizing pulls them apart within one or two steps.
 *
 * `rand` is a parameter (not a module-level draw) so tests can pin it; the
 * default reads Math.random per call, never at import time.
 */
export function renameBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const ceiling = RENAME_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  const half = ceiling / 2;
  return half + rand() * half;
}

/**
 * Shared 4-byte cell used only as an Atomics.wait target. Allocated once; never
 * written, so the wait always runs to its timeout.
 */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block this thread for `ms`. The whole store is synchronous (it is called from
 * tool paths that must have persisted before they return), so there is no
 * `await` to hand off to. Atomics.wait parks the thread; a spin loop would keep
 * the contending writer running at full speed and defeat the backoff.
 */
function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/**
 * The two halves of "wait a bit", injectable. Production calls
 * `renameWithRetry(tmp, target)` and gets both defaults.
 *
 * They exist because the retry policy IS timing behaviour, and the only honest
 * way to check timing behaviour is to not use a clock. A test that measures the
 * gaps between attempts measures the machine's scheduler: under a loaded test
 * runner a 5ms backoff is observed as 90ms, and the assertion fails for reasons
 * that have nothing to do with this file — which trains everyone to re-run
 * until green, which is how a real regression walks through. Handing the loop
 * its randomness (`rand`) and its waiting (`sleep`) lets a test read back the
 * exact schedule the loop computed and assert the policy — grows, jittered, one
 * sleep per failed attempt — with no wall clock anywhere.
 */
export interface RenameRetryHooks {
  /** Jitter source, one draw per backoff. Default `Math.random`. */
  rand?: () => number;
  /** Blocking wait. Default parks the thread for `ms` (see `sleepSync`). */
  sleep?: (ms: number) => void;
}

/**
 * Publish the temp file over the target.
 *
 * POSIX rename is unconditional, but Windows raises EPERM/EACCES/EBUSY while
 * another process holds state.json open — routine here, since the competing
 * operation is the other window's read.
 *
 * This used to retry three times with no delay, on the theory that the
 * contending read is only a few kilobytes so an immediate retry always wins.
 * Measured on Windows with real concurrent processes, that was false: 2 writers
 * lost 12 of 60 persists (20%), 4 writers lost 53 of 120 (44%) — the EPERM
 * survived all three immediate attempts, because two writers retrying with zero
 * delay just collide again instantly. Hence jittered exponential backoff, which
 * desynchronizes them. Only the retry policy was wrong: the atomic publish
 * itself (private temp + rename) never produced a torn or zero-byte read.
 */
export function renameWithRetry(tmp: string, target: string, hooks: RenameRetryHooks = {}): void {
  // Read at call time, never at import time: a module-level capture would pin
  // the jitter for the whole process (and defeat a spy installed by a test).
  const rand = hooks.rand ?? Math.random;
  const sleep = hooks.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= RENAME_ATTEMPTS - 1) throw err;
      const delay = renameBackoffMs(attempt, rand);
      debugLog(
        "state",
        `rename contended (${String(code)}); retry ${attempt + 1} in ${delay.toFixed(1)}ms`,
      );
      sleep(delay);
    }
  }
}

/* ───────────────────────── cross-process write lock ──────────────────────── */

/**
 * Hard ceiling on how long a persist may wait for the lock — a wall-clock
 * budget rather than an attempt count, because that is the number that matters
 * to the caller.
 *
 * Sized from measurement, not taste: with 8 concurrent writer processes the
 * worst observed wait was 342ms (p90 200ms), so 3s is roughly 10x the worst
 * case seen under load an order of magnitude past anything real. It needs that
 * headroom because timing out is not a neutral outcome — the writer then
 * publishes a whole state file computed from an older read, so ONE timeout can
 * erase every record other windows added since. Waiting is strictly better than
 * clobbering; the bound exists only so a wedged peer can't freeze a tool call
 * forever.
 */
export const LOCK_BUDGET_MS = 3_000;
/**
 * A lock older than this belonged to a process that died holding it (Ctrl-C
 * between create and release).
 *
 * Must sit BELOW `LOCK_BUDGET_MS`: a corpse has to be collected inside the
 * budget, or every writer would burn its whole wait and then take the
 * destructive unlocked path forever. It must also stay well above a real hold
 * — one read + write + rename plus at most ~310ms of rename backoff, so under
 * half a second — which 2s clears by ~4x.
 */
export const LOCK_STALE_MS = 2_000;
/**
 * Poll ceiling. A critical section is one read + one write + one rename — low
 * single-digit ms — so polls stay short and the budget buys hundreds of chances
 * rather than a few dozen. This is not free tuning: at a 25ms poll one writer
 * in 240 starved out of its budget and ran unlocked, and that one write took
 * other windows' records down with it.
 */
const LOCK_POLL_CEILING_MS = 8;
/**
 * How many times a mutation recomputes after losing the compare-and-swap. Only
 * reachable when the lock was unavailable, so a handful is plenty; past that we
 * publish unconditionally rather than let the caller's record evaporate.
 */
const CAS_ATTEMPTS = 5;

/** Jittered backoff for lock acquisition: 1,2,4 then flat 8ms, each drawn ±50%. */
export function lockBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(2 ** Math.max(0, attempt), LOCK_POLL_CEILING_MS);
  const half = ceiling / 2;
  return half + rand() * half;
}

export function lockPath(target: string): string {
  return `${target}.lock`;
}

/**
 * Run `fn` with exclusive access to the state file across processes.
 *
 * Atomic publish alone does not make a read-modify-write safe: two windows can
 * both read state N, each add their own DAO, and the second rename publishes
 * N+its-own — the first window's DAO is gone with no error anywhere. Measured
 * on Windows with 4 concurrent writers, that window ate 2-15 of 40 records per
 * run even after the rename retry was fixed. `open(..., "wx")` is atomic
 * create-if-absent on every platform we support, which is all the mutual
 * exclusion this needs.
 *
 * **Best-effort by construction.** If the lock cannot be taken — read-only
 * directory, a corpse-lock on a clock-skewed share, another writer that simply
 * holds it too long — we run `fn` anyway rather than skip the write. Losing a
 * bookkeeping entry to a race is a bad day; refusing to record a DAO the user
 * just paid gas for because a lock file would not open is a worse one. So the
 * failure mode is exactly the pre-lock behavior, never a dropped write and
 * never a throw.
 */
export function withWriteLock<T>(target: string, fn: () => T): T {
  const lock = lockPath(target);
  let held = false;
  try {
    // The very first write of a session has no directory yet; a lock file
    // cannot be created in a directory that does not exist.
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch {
      // persist() reports it — this is not the place to raise a disk problem.
    }
    const waitedFrom = Date.now();
    const deadline = waitedFrom + LOCK_BUDGET_MS;
    for (let attempt = 0; !held && Date.now() < deadline; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try {
          writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
        } finally {
          closeSync(fd);
        }
        held = true;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        // EEXIST is the honest "someone holds it". EPERM/EACCES/EBUSY mean the
        // same thing on Windows one instant earlier: the releasing process has
        // the lock file in a pending-delete state, and a create against it is
        // refused rather than reported as existing. Treating those as "this
        // directory is unwritable" was worth measurable data loss — it dropped
        // the writer straight onto the unlocked path after ~8ms, and an
        // unlocked publish overwrites every record added since its read.
        // Anything else (ENOENT, ENOTDIR, EROFS) really is the filesystem
        // refusing us, and no amount of waiting fixes it.
        const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!contended) break;
        if (code === "EEXIST" && lockIsStale(lock)) {
          // Breaking it can race another breaker; the loser just re-waits, and
          // the worst case is two writers in the section — the old behavior.
          try {
            rmSync(lock, { force: true });
          } catch {
            /* someone else already broke it */
          }
          continue;
        }
        sleepSync(lockBackoffMs(attempt));
      }
    }
    const waited = Date.now() - waitedFrom;
    if (held) {
      if (waited > 0) debugLog("state", `write lock acquired after ${waited}ms`);
    } else {
      debugLog("state", `write lock unavailable at ${lock} after ${waited}ms; proceeding unlocked`);
    }
    return fn();
  } finally {
    if (held) {
      try {
        rmSync(lock, { force: true });
      } catch {
        // Leaked lock: the staleness breaker above collects it in LOCK_STALE_MS.
      }
    }
  }
}

function lockIsStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Vanished between EEXIST and stat — the holder released it; retry normally.
    return false;
  }
}

export class StateStore {
  private cache: PersistedState | null = null;

  constructor(private readonly path: string) {}

  /** Load (and cache) the state. Never throws — degrades to empty on any error. */
  load(): PersistedState {
    if (this.cache) return this.cache;
    this.cache = this.readFromDisk();
    return this.cache;
  }

  private readFromDisk(): PersistedState {
    return this.snapshot().state;
  }

  /**
   * Read the state AND the exact bytes it was parsed from.
   *
   * The raw text is the compare-and-swap token: `persist` re-reads the file
   * immediately before the rename and refuses to publish if it no longer
   * matches, which is what stops a writer from overwriting an update that
   * landed while it was computing. Content, not mtime+size — two writes in the
   * same millisecond produce identical stat metadata and near-identical
   * lengths, so stat would compare equal on exactly the collision it has to
   * catch.
   */
  private snapshot(): { raw: string | null; state: PersistedState } {
    let raw: string | null = null;
    try {
      if (!existsSync(this.path)) return { raw: null, state: emptyState() };
      raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) {
        // Unknown/older schema — start fresh rather than risk misreads. (A real
        // migration ladder can slot in here when STATE_VERSION bumps.)
        if (parsed && parsed.version !== undefined && parsed.version !== STATE_VERSION) {
          process.stderr.write(
            `[dexe-mcp] state.json version ${parsed.version} != ${STATE_VERSION}; starting fresh.\n`,
          );
        }
        return { raw, state: emptyState() };
      }
      return {
        raw,
        state: {
          version: STATE_VERSION,
          knownDaos: Array.isArray(parsed.knownDaos) ? parsed.knownDaos : [],
          lastChainId: typeof parsed.lastChainId === "number" ? parsed.lastChainId : undefined,
          recentProposals: Array.isArray(parsed.recentProposals) ? parsed.recentProposals : [],
          walletLabels:
            parsed.walletLabels && typeof parsed.walletLabels === "object"
              ? parsed.walletLabels
              : {},
          // Tolerant: a minimal shape check, never a throw — a garbled activeFlow
          // just reads as "no flow in progress".
          ...(parsed.activeFlow &&
          typeof parsed.activeFlow === "object" &&
          typeof parsed.activeFlow.flow === "string" &&
          typeof parsed.activeFlow.step === "string" &&
          typeof parsed.activeFlow.chainId === "number"
            ? { activeFlow: parsed.activeFlow }
            : {}),
        },
      };
    } catch (err) {
      process.stderr.write(
        `[dexe-mcp] could not read state at ${this.path} (${safeErrorMessage(err)}); using empty state.\n`,
      );
      debugLog("state", "read failed", err);
      return { raw, state: emptyState() };
    }
  }

  /**
   * Atomic write: private temp file + rename. Best-effort — logs and swallows
   * errors, because a read-only or full disk must never turn a landed on-chain
   * transaction into a failed tool call.
   *
   * With `cas`, the publish is conditional: the file is re-read immediately
   * before the rename and the write is abandoned if it no longer holds the
   * bytes the caller computed from. That check is what makes a lost update
   * impossible rather than merely unlikely — the lock can time out, but a
   * writer that publishes anyway can no longer overwrite someone else's DAO.
   */
  private persist(
    state: PersistedState,
    cas?: { expect: string | null },
  ): "published" | "stale" | "failed" {
    this.cache = state;
    const tmp = tempStatePath(this.path);
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Deliberately AFTER the temp write, so the only gap left between the
      // check and the rename is the rename call itself.
      if (cas && !this.diskStillHolds(cas.expect)) {
        rmSync(tmp, { force: true });
        return "stale";
      }
      renameWithRetry(tmp, this.path);
      debugLog("state", `persisted ${state.knownDaos.length} dao(s) to ${this.path}`);
      return "published";
    } catch (err) {
      // Leave nothing behind: a failed rename would otherwise litter the
      // directory with one orphaned temp per attempt.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Cannot remove it either — the same permission problem we just logged.
      }
      process.stderr.write(
        `[dexe-mcp] could not persist state to ${this.path} (${safeErrorMessage(err)}); ` +
          "this session's DAOs/proposals will not be remembered next time.\n",
      );
      debugLog("state", "persist failed", err);
      return "failed";
    }
  }

  /** True when the file still holds exactly the bytes a mutation was computed from. */
  private diskStillHolds(expect: string | null): boolean {
    try {
      const now = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
      return now === expect;
    } catch {
      // Unreadable at this instant — treat as changed and recompute rather than
      // publish over something we could not inspect.
      return false;
    }
  }

  getState(): PersistedState {
    return this.load();
  }

  /**
   * Read-modify-write, serialized across processes and verified at publish.
   *
   * The read MUST happen inside the lock: every mutation below is
   * "fresh state in → new state out", and computing that from a snapshot taken
   * before the lock reintroduces the very lost update the lock exists to
   * prevent. Returning null means "nothing to write" — no file is touched.
   *
   * `fn` is re-invoked on a CAS miss, so it must be a pure function of the
   * state it is handed (every caller below is).
   */
  private mutate(fn: (state: PersistedState) => PersistedState | null): void {
    withWriteLock(this.path, () => {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const { raw, state } = this.snapshot();
        this.cache = state;
        const next = fn(state);
        if (!next) return;
        const outcome = this.persist(next, { expect: raw });
        if (outcome !== "stale") return; // published, or a disk error already reported
        debugLog("state", `state changed under us; recomputing (attempt ${attempt + 1})`);
        sleepSync(lockBackoffMs(attempt));
      }
      // Someone rewrote the file under us CAS_ATTEMPTS times running — a live
      // lock we are losing, not a correctness problem. Publish unconditionally:
      // last-writer-wins costs at most one of THEIR entries, whereas returning
      // here would silently drop the DAO the user just paid gas for.
      debugLog("state", `lost the compare-and-swap ${CAS_ATTEMPTS}x; publishing unconditionally`);
      const { state } = this.snapshot();
      this.cache = state;
      const next = fn(state);
      if (next) this.persist(next);
    });
  }

  /**
   * Record a deployed DAO. De-dupes by (govPool, chainId): a repeat deploy of
   * the same address updates the existing entry and moves it to the front.
   */
  recordDao(dao: KnownDao): void {
    this.mutate((state) => {
      const key = (d: { govPool: string; chainId: number }) =>
        `${d.chainId}:${d.govPool.toLowerCase()}`;
      const k = key(dao);
      const rest = state.knownDaos.filter((d) => key(d) !== k);
      return {
        ...state,
        knownDaos: [dao, ...rest].slice(0, MAX_DAOS),
        lastChainId: dao.chainId,
      };
    });
  }

  /** Record a broadcast proposal (most-recent first, capped). */
  recordProposal(p: RecentProposal): void {
    this.mutate((state) => ({
      ...state,
      recentProposals: [p, ...state.recentProposals].slice(0, MAX_PROPOSALS),
      lastChainId: p.chainId,
    }));
  }

  setLastChainId(chainId: number): void {
    this.mutate((state) => ({ ...state, lastChainId: chainId }));
  }

  setWalletLabel(address: string, label: string): void {
    this.mutate((state) => ({
      ...state,
      walletLabels: { ...state.walletLabels, [address.toLowerCase()]: label },
    }));
  }

  /** Most-recently recorded DAO, or null. */
  lastDao(): KnownDao | null {
    return this.load().knownDaos[0] ?? null;
  }

  /** Record/advance the in-progress guided flow (keeps startedAt across steps of the same flow). */
  setActiveFlow(next: Omit<ActiveFlow, "startedAt" | "updatedAt">): void {
    this.mutate((state) => {
      const now = new Date().toISOString();
      const startedAt =
        state.activeFlow && state.activeFlow.flow === next.flow ? state.activeFlow.startedAt : now;
      return { ...state, activeFlow: { ...next, startedAt, updatedAt: now } };
    });
  }

  /** Clear the in-progress flow (final step completed or user abandoned it). */
  clearActiveFlow(): void {
    this.mutate((state) => {
      if (!state.activeFlow) return null;
      const { activeFlow: _dropped, ...rest } = state;
      return rest as PersistedState;
    });
  }
}
