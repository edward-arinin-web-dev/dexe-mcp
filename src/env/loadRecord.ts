import type { EnvLoadReport } from "@dexe-network/dexe-mcp/core";

/**
 * What this process resolved and loaded as `.env` at startup — for
 * `dexe_write_doctor`'s `env.*` rows.
 *
 * The read edition records the same thing inside its own loader, but exports
 * the record only through its test entry point, so the write server keeps its
 * own: src/index.ts `loadEnvironment()` stores the candidate list and every
 * report `loadEnvFile` returned, once, before any tool exists. Re-deriving it
 * later would answer a different question (the launcher's cwd and the pre-load
 * `process.env` are gone by then).
 */
export interface EnvLoadRecord {
  /** Paths tried, in precedence order (`resolveEnvCandidates`). */
  candidates: readonly string[];
  /** One report per path passed to `loadEnvFile`, in load order. */
  reports: readonly EnvLoadReport[];
}

let record: EnvLoadRecord | null = null;

export function recordEnvLoad(next: EnvLoadRecord): void {
  record = { candidates: [...next.candidates], reports: [...next.reports] };
}

/** The startup record, or null when nothing was recorded (a test, an embedder). */
export function envLoadRecord(): EnvLoadRecord | null {
  return record;
}

/** Test seam — drop the record. */
export function resetEnvLoadRecord(): void {
  record = null;
}
