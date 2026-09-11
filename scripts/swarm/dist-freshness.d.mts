/** Types for dist-freshness.mjs. The implementation stays plain ESM so the
 *  `.mjs` helper scripts under scripts/ can import it with no build step. */

export type DistFreshness =
  | { ok: true }
  | { ok: false; level: "missing" | "stale"; message: string };

export function newestMtime(dir: string): number | null;
export function fileMtime(file: string): number | null;
export function assertDistFresh(
  distMtime: number | null | undefined,
  newestSrcMtime: number | null | undefined,
): DistFreshness;
