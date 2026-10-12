import { ENV_SPEC_READ, type EnvSpec } from "../env/schemaRead.js";

/**
 * Result of a soft env guard. `ok` carries the resolved value; the error
 * branch carries both a one-line `error` and a multi-line `remediation`
 * with paste-ready fixes. Tool handlers fold these into MCP `errorResult`.
 *
 * Modeled on the long-standing `requirePinata` pattern in
 * `src/tools/ipfsWrite.ts` so existing call sites need only a minimal
 * refactor. The Pinata-specific guard (`pinataForWrites`, `pinataUploadHint`)
 * is write-edition code and lives in `src/lib/pinata.ts`.
 */
export type EnvGuardResult<T> = { ok: T } | { error: string; remediation: string };

/**
 * Soft env-var guard. Returns `{ ok }` only when every listed key is present
 * and non-blank in `process.env`; otherwise returns a remediation hint that
 * names the missing keys and the flows they unlock. `spec` supplies the
 * per-key documentation — the read spec by default; write code passes the
 * full `ENV_SPEC` (src/env/schema.ts) for its own vars.
 */
export function requireEnv<K extends string>(
  keys: readonly K[],
  spec: EnvSpec = ENV_SPEC_READ,
): EnvGuardResult<Record<K, string>> {
  const missing: K[] = [];
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (!v) {
      missing.push(k);
    } else {
      out[k] = v;
    }
  }
  if (missing.length > 0) {
    return {
      error: `Missing required env: ${missing.join(", ")}`,
      remediation: hintFor(missing, spec),
    };
  }
  return { ok: out };
}

/**
 * Build a human-readable remediation string for a list of (possibly missing)
 * env keys. Pulls per-key documentation and flow-enable metadata out of
 * `spec` and tacks on the restart reminder so MCP clients don't keep
 * retrying without picking up the new env. A key `spec` does not list
 * contributes no line.
 */
export function hintFor(keys: readonly string[], spec: EnvSpec = ENV_SPEC_READ): string {
  const parts: string[] = [];
  for (const k of keys) {
    const entry = Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : undefined;
    if (!entry) continue;
    const flowHint = entry.enablesFlows?.length
      ? ` (enables: ${entry.enablesFlows.join(", ")})`
      : "";
    parts.push(`Set ${k} in .env — ${entry.doc}${flowHint}`);
  }
  parts.push(
    "After editing .env, restart the MCP server (Claude Code: quit + relaunch). " +
      "Run dexe_doctor to verify the new values were picked up.",
  );
  return parts.join("\n");
}
