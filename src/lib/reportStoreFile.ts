import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ReadConfig } from "../configRead.js";
import type { ReportSnapshot, ReportSnapshotStore } from "../tools/report.js";
import { renameWithRetry, tempStatePath, withWriteLock } from "./stateStore.js";
import { safeErrorMessage } from "./redact.js";
import { debugLog } from "../runtime.js";

/**
 * ── `dexe_dao_report` snapshots on disk (`reports.json`) ───────────────────
 *
 * The single server's report store: a `ReportSnapshotStore` that persists each
 * full run beside `state.json`, so `since: "last"` and the state-change diff
 * work across sessions. Handed to `registerReportTools` by the composition root
 * (src/tools/index.ts). The read edition passes no store — it keeps nothing
 * between calls — so the report tool itself (src/tools/report.ts) writes no
 * file, and this module is the only place a report touches the disk.
 */

/** Snapshots retained in the report store (one per chain+DAO, newest first). */
const MAX_SNAPSHOTS = 100;

interface ReportStoreFile {
  version: number;
  snapshots: ReportSnapshot[];
}

const REPORT_STORE_VERSION = 1;

const snapshotKey = (chainId: number, govPool: string) =>
  `${chainId}:${govPool.toLowerCase()}`;

/**
 * Per-DAO report snapshots, stored beside `state.json`.
 *
 * Kept OUT of `PersistedState` on purpose: that file is the record of DAOs the
 * user paid gas for, and pushing a growing per-DAO blob through the same
 * read-modify-write would make every deploy re-serialize report history.
 *
 * Same write discipline as `StateStore` — private temp file, cross-process lock
 * (`withWriteLock`), atomic publish (`renameWithRetry`), and a compare-and-swap
 * on the bytes we computed from, so a writer that could not take the lock still
 * cannot erase another window's snapshots. Tolerant at every layer: a missing,
 * corrupt or unwritable store degrades to "no previous run", never to a failed
 * report.
 */
export class FileReportStore implements ReportSnapshotStore {
  readonly persistent = true;

  constructor(private readonly path: string) {}

  get(chainId: number, govPool: string): ReportSnapshot | null {
    const key = snapshotKey(chainId, govPool);
    return (
      this.read().state.snapshots.find((s) => snapshotKey(s.chainId, s.govPool) === key) ?? null
    );
  }

  put(next: ReportSnapshot): void {
    withWriteLock(this.path, () => {
      const key = snapshotKey(next.chainId, next.govPool);
      // Three tries against a concurrent writer, then publish anyway: losing a
      // snapshot costs one noisier report, so blocking longer buys nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { raw, state } = this.read();
        const merged: ReportStoreFile = {
          version: REPORT_STORE_VERSION,
          snapshots: [
            next,
            ...state.snapshots.filter((s) => snapshotKey(s.chainId, s.govPool) !== key),
          ].slice(0, MAX_SNAPSHOTS),
        };
        if (this.publish(merged, raw) !== "stale") return;
      }
      const { state } = this.read();
      this.publish(
        {
          version: REPORT_STORE_VERSION,
          snapshots: [
            next,
            ...state.snapshots.filter((s) => snapshotKey(s.chainId, s.govPool) !== key),
          ].slice(0, MAX_SNAPSHOTS),
        },
        undefined,
      );
    });
  }

  private read(): { raw: string | null; state: ReportStoreFile } {
    const empty: ReportStoreFile = { version: REPORT_STORE_VERSION, snapshots: [] };
    try {
      if (!existsSync(this.path)) return { raw: null, state: empty };
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ReportStoreFile>;
      if (parsed?.version !== REPORT_STORE_VERSION || !Array.isArray(parsed.snapshots)) {
        return { raw, state: empty };
      }
      return { raw, state: { version: REPORT_STORE_VERSION, snapshots: parsed.snapshots } };
    } catch (err) {
      debugLog("report", `could not read snapshots at ${this.path}`, err);
      return { raw: null, state: empty };
    }
  }

  /** `undefined` for `expect` skips the compare-and-swap (last-resort publish). */
  private publish(
    file: ReportStoreFile,
    expect: string | null | undefined,
  ): "published" | "stale" | "failed" {
    const tmp = tempStatePath(this.path);
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
      if (expect !== undefined) {
        const now = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
        if (now !== expect) {
          rmSync(tmp, { force: true });
          return "stale";
        }
      }
      renameWithRetry(tmp, this.path);
      return "published";
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Same permission problem that failed the write; nothing more to do.
      }
      // stderr only — stdout is the MCP protocol channel. A store that cannot be
      // written costs future diffs, never this report.
      process.stderr.write(
        `[dexe-mcp] could not persist report snapshot to ${this.path} ` +
          `(${safeErrorMessage(err)}); the next \`since\` diff will have no baseline.\n`,
      );
      return "failed";
    }
  }
}

/** Sibling of `state.json` — same directory, same lifecycle, separate file. */
export function reportStorePath(config: Pick<ReadConfig, "statePath">): string {
  return join(dirname(config.statePath), "reports.json");
}
