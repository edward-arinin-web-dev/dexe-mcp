/**
 * dist/ freshness guard for the swarm harness. Plain ESM + JSDoc types so the
 * `.mjs` helper scripts can import it with no build step, and so it never lands
 * in `dist/` itself. Side-effect-free: no top-level work, no process.exit.
 *
 * WHY: the harness and the server under test are built by different mechanisms.
 * `npm run swarm:run` is `tsx scripts/swarm/orchestrator.ts` — tsx compiles the
 * HARNESS from source — but the orchestrator spawns `node dist/index.js`, i.e.
 * whatever `tsc` last emitted. `nightly.sh` pulls, conditionally `npm install`s
 * (and there is no `prepare` script), then runs the BROADCAST sweep. There was
 * no path by which nightly produced a fresh `dist/`, so a regression pass could
 * spend real gas certifying the previously-built server.
 */

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Newest mtimeMs under `dir`, or null when the directory does not exist.
 * @param {string} dir
 * @returns {number|null}
 */
export function newestMtime(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const e of entries) {
    const p = join(dir, e.name);
    let m = null;
    if (e.isDirectory()) {
      m = newestMtime(p);
    } else {
      try {
        m = statSync(p).mtimeMs;
      } catch {
        m = null;
      }
    }
    if (m !== null && (newest === null || m > newest)) newest = m;
  }
  return newest;
}

/** mtimeMs of a single file, or null when it is missing.
 * @param {string} file
 * @returns {number|null}
 */
export function fileMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Pure decision function — no fs, so it is unit-testable.
 *
 * Two tiers on purpose:
 *   - `missing` is deterministic and always fatal (today it surfaces as an
 *     opaque stdio spawn error).
 *   - `stale` is an mtime HEURISTIC and is overridable: `git pull` and the
 *     documented `git -c core.autocrlf=false checkout -- <files>` CRLF fix both
 *     bump `src/**` mtimes with zero content change, and a hard gate would
 *     abort a perfectly current build.
 *
 * @param {number|null} distMtime mtimeMs of dist/index.js, null if absent
 * @param {number|null} newestSrcMtime newest mtimeMs under src/, null if src/ absent
 * @returns {{ok: true} | {ok: false, level: "missing"|"stale", message: string}}
 */
export function assertDistFresh(distMtime, newestSrcMtime) {
  if (distMtime === null || distMtime === undefined) {
    return {
      ok: false,
      level: "missing",
      message:
        "dist/index.js not found — the swarm harness runs the BUILT server over stdio, not the TypeScript " +
        "sources. Run `npm run build` first.",
    };
  }
  if (newestSrcMtime === null || newestSrcMtime === undefined) return { ok: true };
  if (newestSrcMtime > distMtime) {
    return {
      ok: false,
      level: "stale",
      message:
        "dist/index.js is older than src/ — run `npm run build` first, or the swarm will test the " +
        "previously-built server. If you know dist is current (a git checkout can bump src mtimes without " +
        "changing content), set SWARM_SKIP_DIST_CHECK=1.",
    };
  }
  return { ok: true };
}
