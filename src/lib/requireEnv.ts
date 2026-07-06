import { ENV_REGISTRY, type EnvKey } from "../env/schema.js";

/**
 * Result of a soft env guard. `ok` carries the resolved value; the error
 * branch carries both a one-line `error` and a multi-line `remediation`
 * with paste-ready fixes. Tool handlers fold these into MCP `errorResult`.
 *
 * Modeled on the long-standing `requirePinata` pattern in
 * `src/tools/ipfs.ts:129-137` so existing call sites need only a minimal
 * refactor.
 */
export type EnvGuardResult<T> = { ok: T } | { error: string; remediation: string };

/**
 * Soft env-var guard. Returns `{ ok }` only when every listed key is present
 * and non-blank in `process.env`; otherwise returns a remediation hint that
 * names the missing keys and the flows they unlock.
 */
export function requireEnv<K extends EnvKey>(
  keys: readonly K[],
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
      remediation: hintFor(missing),
    };
  }
  return { ok: out };
}

/**
 * Build a human-readable remediation string for a list of (possibly missing)
 * env keys. Pulls per-key documentation and flow-enable metadata out of
 * ENV_SPEC and tacks on the restart reminder so MCP clients don't keep
 * retrying without picking up the new env.
 */
export function hintFor(keys: readonly EnvKey[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const spec = ENV_REGISTRY[k];
    if (!spec) continue;
    const flowHint = spec.enablesFlows?.length
      ? ` (enables: ${spec.enablesFlows.join(", ")})`
      : "";
    parts.push(`Set ${k} in .env — ${spec.doc}${flowHint}`);
  }
  parts.push(
    "After editing .env, restart the MCP server (Claude Code: quit + relaunch). " +
      "Run dexe_doctor to verify the new values were picked up.",
  );
  return parts.join("\n");
}

/**
 * Consistent, actionable message for the one env var that reads can't default
 * around: the Pinata JWT needed to pin metadata to IPFS. Used by every upload
 * site (dao create, proposal create, direct IPFS uploads) so the guidance —
 * and the /dexe-setup pointer — is identical everywhere.
 */
export function pinataUploadHint(context: string): string {
  return (
    `DEXE_PINATA_JWT is required ${context}. Reads work without it, but pinning ` +
    `metadata to IPFS needs a Pinata JWT.\n` +
    hintFor(["DEXE_PINATA_JWT"]) +
    "\nGuided setup: run /dexe-setup. Get a free JWT at https://app.pinata.cloud " +
    "(API Keys → New Key, grant pinJSONToIPFS + pinFileToIPFS)."
  );
}
