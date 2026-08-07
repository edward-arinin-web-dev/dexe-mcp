/**
 * Secret-redaction helpers for any text that reaches an LLM-visible tool
 * result (`content[].text`) or `structuredContent`.
 *
 * W36: a credentialed RPC URL (Alchemy/Infura/QuickNode key, or a
 * `user:pass@host` form) is appended to ethers v6 `err.message` on any
 * non-2xx provider response (401/429/5xx — routine under load) and was
 * emitted verbatim, leaking the operator's provider API key into the model
 * context and transcript.
 *
 * - `safeErrorMessage(err)` — prefer ethers' `shortMessage` (which stays
 *   URL-free) over the verbose `message`, then redact as a backstop. Use this
 *   wherever a caught error is surfaced to the user.
 * - `redactErrorInPlace(err)` — same sanitation, but for an error that has to
 *   be RETHROWN with its ethers fields (`code`, `data`) intact.
 * - `redactUrlCredentials(text)` — mask every URL found in arbitrary text
 *   (path + query + userinfo), so any embedded API key is removed regardless
 *   of provider.
 * - `maskUrl(url)` — mask a single configured URL for deliberate display
 *   (e.g. `dexe_get_config`, `dexe_doctor`).
 *
 * The masking is provider-agnostic and structural (no host allowlist), so it
 * covers any RPC vendor and cannot be bypassed by an unrecognized host.
 */

/**
 * Userinfo in a URL: `scheme://user:pass@` — used ONLY on the `maskUrl` parse
 * fallback, which always receives a single URL token, never free text.
 *
 * Anchored and length-bounded deliberately. Unanchored, with two adjacent
 * unbounded quantifiers, the engine retries the scheme match at every offset of
 * a long non-matching token — quadratic work on input we do not control, in the
 * one function that runs on every error message (js/polynomial-redos). Since
 * this only ever sees one token, `^` is correct rather than merely defensive,
 * and the ceilings are far above any real scheme or userinfo.
 */
const USERINFO_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)[^/?#\s@]{1,256}@/;

/**
 * Any http(s)/ws(s) URL token, bounded by whitespace / common punctuation.
 * `wss://` is in scope because an RPC or relay endpoint carries its API key in
 * exactly the same path/query position as the https form.
 */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"`)<>\]},;]+/gi;

/**
 * Mask a single URL: keep scheme + host, drop userinfo, and replace any
 * path/query (which may carry the API key) with `***`. Never throws.
 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname && u.pathname !== "/" ? "/***" : "";
    const query = u.search ? "?***" : "";
    // u.host excludes userinfo, so credentials in `user:pass@` are dropped.
    return `${u.protocol}//${u.host}${path}${query}`;
  } catch {
    // Non-parseable token: strip userinfo without recursing.
    return raw.replace(USERINFO_RE, "$1***@");
  }
}

/** Mask credentials/keys in every URL found in `text`. Best-effort, never throws. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_RE, (m) => maskUrl(m));
}

/**
 * Turn a caught error into a user-safe message. Prefers ethers'
 * `shortMessage` (URL-free), falls back to `message`/`String(err)`, then
 * redacts any residual URL credentials.
 */
export function safeErrorMessage(err: unknown): string {
  let msg: string;
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: unknown; message?: unknown };
    if (typeof e.shortMessage === "string" && e.shortMessage.length > 0) {
      msg = e.shortMessage;
    } else if (typeof e.message === "string") {
      msg = e.message;
    } else {
      msg = String(err);
    }
  } else {
    msg = String(err);
  }
  return redactUrlCredentials(msg);
}

/**
 * Sanitize a caught error and return it ready to RETHROW: the human-readable
 * text becomes `safeErrorMessage(err)`, everything else is left alone.
 *
 * WHY in place rather than `new Error(safeErrorMessage(err))`: ethers puts the
 * fields callers branch on ON the error object — `code` ("CALL_EXCEPTION" vs
 * "TIMEOUT"/"SERVER_ERROR") and the revert `data`/`info.error.data`.
 * `src/tools/simulate.ts` uses exactly those to tell a genuine contract revert
 * from a transport failure before it lets a broadcast through, so flattening
 * the error into a plain `Error` would make every revert look like a network
 * blip and defeat that guard. Only the leaky text is rewritten.
 */
/**
 * Overwrite one property when its descriptor allows it. Returns whether the
 * write actually stuck.
 *
 * ESM is strict mode, so assigning to a non-writable property THROWS rather
 * than failing quietly — which is the whole reason each field below needs its
 * own guard instead of one shared try block.
 */
function trySet(obj: object, key: string, value: unknown): boolean {
  try {
    (obj as Record<string, unknown>)[key] = value;
    return (obj as Record<string, unknown>)[key] === value;
  } catch {
    return false;
  }
}

/** Fields worth carrying onto a copy: they classify the failure, not describe it. */
const CLASSIFYING_FIELDS = ["code", "data", "reason"] as const;

export function redactErrorInPlace(err: unknown): Error {
  const safe = safeErrorMessage(err);
  if (err instanceof Error) {
    const e = err as unknown as Record<string, unknown>;
    // Each field is guarded SEPARATELY. ethers declares `shortMessage` as
    // `writable: false`, so a single try wrapping all of these aborts on the
    // first assignment and falls through to the copy path — which used to drop
    // `data`, the field that identifies a custom-error revert (the DeXe/SphereX
    // norm). src/tools/simulate.ts reads `data` to tell a genuine revert from a
    // transport failure, so losing it turned every revert into a "network
    // error" and defeated the B9 pre-broadcast guard.
    const messageStuck = trySet(err, "message", safe);

    // `shortMessage` is declared writable:false AND configurable:false, so it
    // can be neither assigned nor redefined — if it holds a credential there is
    // no way to scrub it on this object. When that happens we must NOT hand the
    // object back: the key would stay one property lookup away. Fall through to
    // the copy instead, which now carries `data`/`code`/`reason` explicitly, so
    // revert classification survives the detour.
    let shortMessageLeaks = false;
    if (typeof e.shortMessage === "string") {
      const cleaned = redactUrlCredentials(e.shortMessage);
      if (cleaned !== e.shortMessage && !trySet(err, "shortMessage", cleaned)) {
        shortMessageLeaks = true;
      }
    }
    // The key also rides in `stack` and in ethers' `info.requestUrl`; redacting
    // only `message` would leave it one property lookup away.
    if (typeof e.stack === "string") trySet(err, "stack", redactUrlCredentials(e.stack));
    const info = e.info;
    if (info && typeof info === "object") {
      const requestUrl = (info as Record<string, unknown>).requestUrl;
      if (typeof requestUrl === "string") trySet(info, "requestUrl", maskUrl(requestUrl));
    }
    if (messageStuck && !shortMessageLeaks) return err;
  }

  // Frozen/sealed error: copy rather than throw a TypeError that would replace
  // the real failure. Carry the classifying fields across explicitly — an
  // allowlist, so nothing that could hold a credential rides along.
  const copy = new Error(safe);
  const src = err as Record<string, unknown> | null | undefined;
  const target = copy as unknown as Record<string, unknown>;
  for (const key of CLASSIFYING_FIELDS) {
    const v = src?.[key];
    if (v !== undefined) target[key] = typeof v === "string" ? redactUrlCredentials(v) : v;
  }
  if (typeof src?.shortMessage === "string") {
    target.shortMessage = redactUrlCredentials(src.shortMessage as string);
  }
  return copy;
}
