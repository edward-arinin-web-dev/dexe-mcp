/**
 * ── Signer mode: the ONE place that decides how this server signs ──────────
 *
 * Before 0.37.0 the question "how does this session sign?" was answered three
 * times, in three tools (dexe_write_context, dexe_wc_status, dexe_auth_login),
 * each from `signer.hasSigner()` + whatever else it happened to look at. They
 * agreed only by accident. `resolveSignerMode` is now the single answer; the
 * config loader calls it once and every surface reads the result from the
 * config / `SignerManager.mode`.
 *
 *   walletconnect  the phone wallet signs and broadcasts; the human taps
 *                  approve on every transaction. Fresh-install default.
 *   keystore       an encrypted local key (keystore v3). Every batch is
 *                  approved on a local web page with the keystore password —
 *                  the one secret the AI does not hold.
 *   readonly       nothing is signed; write tools return unsigned payloads.
 *   unattended     hot keys (DEXE_PRIVATE_KEY, the agent keyring). Nobody
 *                  confirms anything. The ONLY mode that reads hot keys.
 *
 * Transitional rule (0.37.x, removed in the next major): with
 * `DEXE_SIGNER_MODE` unset and a hot key present, the mode is `unattended`
 * IMPLICITLY — today's behaviour, chain fence off — and every surface says it
 * is deprecated. Set `DEXE_SIGNER_MODE=unattended` to keep it (fenced to
 * `DEXE_UNATTENDED_CHAINS`, default 97), or move the key into the keystore.
 *
 * Pure: no env reads, no I/O. Inputs in, decision out — so it can be tested
 * exhaustively and called from the config loader before anything else exists.
 */

export const SIGNER_MODES = ["walletconnect", "keystore", "readonly", "unattended"] as const;
export type SignerMode = (typeof SIGNER_MODES)[number];

/**
 * Where the mode came from:
 *   explicit          DEXE_SIGNER_MODE was set (and valid)
 *   implicit-hot-key  unset, but a hot key is present → unattended (deprecated)
 *   default           unset, no hot key → walletconnect (or readonly without a WC project id)
 */
export type SignerModeSource = "explicit" | "implicit-hot-key" | "default";

export interface SignerModeResolution {
  mode: SignerMode;
  source: SignerModeSource;
  /** The raw value when DEXE_SIGNER_MODE was set but not one of SIGNER_MODES. */
  invalid?: string;
}

export interface SignerModeInputs {
  /** Raw `DEXE_SIGNER_MODE`, untrimmed. */
  requested?: string;
  /** Any hot key configured: DEXE_PRIVATE_KEY or any keyring slot (DEXE_AGENT_PK_* / AGENT_PK_* / funder). */
  hasHotKey: boolean;
  /** A WalletConnect project id is available (the shared default counts). */
  walletConnectConfigured: boolean;
}

/** True when `v` names a signer mode (case-insensitive, trimmed). */
export function isSignerMode(v: string | undefined): v is SignerMode {
  return v !== undefined && (SIGNER_MODES as readonly string[]).includes(v.trim().toLowerCase());
}

export function resolveSignerMode(inputs: SignerModeInputs): SignerModeResolution {
  const raw = inputs.requested?.trim();
  if (raw) {
    const norm = raw.toLowerCase();
    if (isSignerMode(norm)) return { mode: norm, source: "explicit" };
    // A typo must never widen what signs: an unrecognized value falls to the
    // default for a session WITHOUT a hot key — never to `unattended`.
    return { mode: inputs.walletConnectConfigured ? "walletconnect" : "readonly", source: "default", invalid: raw };
  }
  if (inputs.hasHotKey) return { mode: "unattended", source: "implicit-hot-key" };
  return { mode: inputs.walletConnectConfigured ? "walletconnect" : "readonly", source: "default" };
}

/** Chains unattended mode signs on when `DEXE_UNATTENDED_CHAINS` is unset: BSC testnet only. */
export const DEFAULT_UNATTENDED_CHAINS: readonly number[] = [97];

/**
 * Parse `DEXE_UNATTENDED_CHAINS` ("97" / "97,56"). Returns null for unset/empty,
 * or `{ invalid }` naming the bad entry. Duplicates are dropped.
 */
export function parseUnattendedChains(raw: string | undefined): number[] | null | { invalid: string } {
  const t = raw?.trim();
  if (!t) return null;
  const out: number[] = [];
  for (const part of t.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!/^\d+$/.test(part) || Number(part) <= 0 || !Number.isSafeInteger(Number(part))) return { invalid: part };
    const n = Number(part);
    if (!out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : null;
}

/**
 * The chain fence for unattended signing, or null for "no fence".
 *
 *   - `DEXE_UNATTENDED_CHAINS` set → exactly those chains, whatever the source.
 *   - explicit `DEXE_SIGNER_MODE=unattended` → the default fence (97).
 *   - implicit (transitional) unattended → null: today's behaviour, every
 *     configured chain. The next major removes this branch.
 */
export function unattendedChainFence(
  source: SignerModeSource,
  configured: number[] | null,
): number[] | null {
  if (configured) return configured;
  if (source === "explicit") return [...DEFAULT_UNATTENDED_CHAINS];
  return null;
}

/**
 * The deprecation sentence for the implicit hot-key default. One string: the
 * startup banner, dexe_doctor and dexe_write_context all print it.
 */
export const IMPLICIT_UNATTENDED_DEPRECATION =
  "DEPRECATED: a hot key is set but DEXE_SIGNER_MODE is not, so this server signs UNATTENDED (no human " +
  "confirmation) by implicit default. Set DEXE_SIGNER_MODE=unattended explicitly (then it signs only on " +
  "DEXE_UNATTENDED_CHAINS, default 97), or move the key into an encrypted keystore with " +
  "`dexe-mcp key import --from-env` and set DEXE_SIGNER_MODE=keystore. The implicit default flips in the next " +
  "major: an unset mode will no longer sign with a hot key.";

/**
 * The legacy dispatch label `dexe_write_context` / `dexe_wc_status` reported
 * before 0.37.0 (`eoa` / `safe` / `walletconnect` / `readonly`), plus
 * `keystore`. Kept as `signer.dispatch` so a reader of the old field has a
 * one-line migration.
 */
export type SignerDispatch = "readonly" | "eoa" | "safe" | "walletconnect" | "keystore";

export function signerDispatch(
  mode: SignerMode,
  hasSigner: boolean,
  safeServiceUrl: string | undefined,
): SignerDispatch {
  switch (mode) {
    case "unattended":
      return hasSigner ? (safeServiceUrl ? "safe" : "eoa") : "readonly";
    case "keystore":
      return hasSigner ? "keystore" : "readonly";
    case "walletconnect":
      return "walletconnect";
    default:
      return "readonly";
  }
}

/** Does this mode put a human in front of every signature? */
export function humanConfirms(mode: SignerMode): boolean {
  return mode === "walletconnect" || mode === "keystore";
}
