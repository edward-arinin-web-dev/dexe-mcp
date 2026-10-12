import { ENV_SPEC_READ, type EnvSpec } from "./schemaRead.js";

export interface EnvIssue {
  key: string;
  severity: "error" | "warn";
  message: string;
}

export interface EnvParseResult {
  /** Trimmed raw values for every key that passed validation. */
  values: Partial<Record<string, string>>;
  /** All validation failures + missing-required warnings. */
  issues: EnvIssue[];
}

/**
 * Walk `spec`, run each entry's zod schema against the provided env table,
 * and collect categorized issues. Pure — no I/O, no logging, no side effects.
 *
 * Only `spec`'s keys are looked at: a var the spec does not list is neither
 * validated nor returned. That is how a read-only load ignores the write
 * edition's keys (signing keys, Pinata, WalletConnect) — it passes the read
 * spec, the default here. The single server passes the full `ENV_SPEC` from
 * ./schema.ts.
 *
 * Callers:
 *   - src/configRead.ts / src/config.ts (startup)
 *   - src/diag/checks.ts (doctor)
 *   - tests (parity / regression)
 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env, spec: EnvSpec = ENV_SPEC_READ): EnvParseResult {
  const values: Partial<Record<string, string>> = {};
  const issues: EnvIssue[] = [];

  for (const [key, entry] of Object.entries(spec)) {
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
