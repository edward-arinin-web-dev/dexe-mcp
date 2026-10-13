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
 * An unset `DEXE_SIGNER_MODE` never signs with a hot key (since 1.0.0; 0.37.x
 * signed unattended implicitly when one was present). A hot key is read only
 * after an explicit `DEXE_SIGNER_MODE=unattended`, and then only on
 * `DEXE_UNATTENDED_CHAINS` (default 97).
 *
 * Pure: no env reads, no I/O. Inputs in, decision out — so it can be tested
 * exhaustively and called from the config loader before anything else exists.
 */

export const SIGNER_MODES = ["walletconnect", "keystore", "readonly", "unattended"] as const;
export type SignerMode = (typeof SIGNER_MODES)[number];

/**
 * Where the mode came from:
 *   explicit  DEXE_SIGNER_MODE was set (and valid)
 *   default   unset or invalid → walletconnect (or readonly without a WC project
 *             id), whether or not a hot key is present
 */
export type SignerModeSource = "explicit" | "default";

export interface SignerModeResolution {
  mode: SignerMode;
  source: SignerModeSource;
  /** The raw value when DEXE_SIGNER_MODE was set but not one of SIGNER_MODES. */
  invalid?: string;
}

export interface SignerModeInputs {
  /** Raw `DEXE_SIGNER_MODE`, untrimmed. */
  requested?: string;
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
    // default — never to `unattended`.
    return { mode: inputs.walletConnectConfigured ? "walletconnect" : "readonly", source: "default", invalid: raw };
  }
  // No hot-key branch: a key in the environment is not a choice of mode.
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
 * The chain fence for unattended signing: `DEXE_UNATTENDED_CHAINS` when set,
 * else the default (97). Never "no fence".
 */
export function unattendedChainFence(configured: number[] | null): number[] {
  return configured ? [...configured] : [...DEFAULT_UNATTENDED_CHAINS];
}

/** The ways out of an ignored hot key, safest first — unattended last and only with the owner's go-ahead. */
const HOT_KEY_WAYS_OUT =
  "Ways out, safest first: delete the key lines and connect a phone wallet with dexe_wc_connect; or, in a " +
  "terminal, run `dexe-mcp key import --from-env` (encrypts DEXE_PRIVATE_KEY, removes the plaintext line, sets " +
  "DEXE_SIGNER_MODE=keystore — the owner then approves every batch); or, for bots/CI and only with the owner's " +
  "go-ahead, set DEXE_SIGNER_MODE=unattended (signs with NO confirmation, only on DEXE_UNATTENDED_CHAINS, " +
  "default 97; the agent keyring DEXE_AGENT_PK_* / AGENT_PK_* exists only in that mode). Restart after editing .env.";

/**
 * Said when a hot key is present but `DEXE_SIGNER_MODE` is unset — the setup
 * that signed unattended before 1.0.0 and does not any more. One string: the
 * startup banner, dexe_doctor, dexe_write_context and the no-signer write
 * responses all print it.
 */
export const UNSET_MODE_HOT_KEY_IGNORED =
  "A hot key is set but DEXE_SIGNER_MODE is not, so the key is IGNORED: since dexe-mcp 1.0.0 an unset mode " +
  "never signs with a hot key (0.37 and earlier signed unattended by default). " +
  HOT_KEY_WAYS_OUT;

/** Same, when DEXE_SIGNER_MODE was set to something invalid (rejected at startup). */
export const INVALID_MODE_HOT_KEY_IGNORED =
  "A hot key is set but DEXE_SIGNER_MODE was rejected as invalid, so this server runs walletconnect and the key " +
  "is IGNORED. Valid modes: walletconnect | keystore | readonly | unattended. " +
  HOT_KEY_WAYS_OUT;

/** Hot-key env vars present but not loaded because the mode was unset or invalid. */
export interface IgnoredHotKeys {
  vars: string[];
  reason: "unset" | "invalid";
}

export function ignoredHotKeySentence(ignored: IgnoredHotKeys): string {
  return `${ignored.vars.join(", ")}: ${ignored.reason === "invalid" ? INVALID_MODE_HOT_KEY_IGNORED : UNSET_MODE_HOT_KEY_IGNORED}`;
}

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
