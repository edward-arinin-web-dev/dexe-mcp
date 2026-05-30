import { ENV_REGISTRY, type EnvKey, type EnvEntry } from "./schema.js";

export interface EnvIssue {
  key: EnvKey;
  severity: "error" | "warn";
  message: string;
}

export interface EnvParseResult {
  /** Trimmed raw values for every key that passed validation. */
  values: Partial<Record<EnvKey, string>>;
  /** All validation failures + missing-required warnings. */
  issues: EnvIssue[];
}

/**
 * Walk ENV_SPEC, run each entry's zod schema against the provided env table,
 * and collect categorized issues. Pure — no I/O, no logging, no side effects.
 *
 * Callers:
 *   - src/config.ts (startup)
 *   - src/diag/checks.ts (doctor)
 *   - tests (parity / regression)
 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): EnvParseResult {
  const values: Partial<Record<EnvKey, string>> = {};
  const issues: EnvIssue[] = [];

  for (const [key, entry] of Object.entries(ENV_REGISTRY) as [EnvKey, EnvEntry][]) {
    const raw = env[key]?.trim();
    if (!raw) {
      if (entry.required) {
        issues.push({
          key,
          severity: "error",
          message: `Required env var ${key} is not set. ${entry.doc}`,
        });
      }
      continue;
    }
    const r = entry.schema.safeParse(raw);
    if (!r.success) {
      issues.push({
        key,
        severity: "error",
        message: `Invalid ${key}=${entry.secret ? "<redacted>" : raw}: ${r.error.issues
          .map(i => i.message)
          .join("; ")}`,
      });
      continue;
    }
    values[key] = raw;
  }

  return { values, issues };
}
