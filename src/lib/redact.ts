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
 * - `redactUrlCredentials(text)` — mask every URL found in arbitrary text
 *   (path + query + userinfo), so any embedded API key is removed regardless
 *   of provider.
 * - `maskUrl(url)` — mask a single configured URL for deliberate display
 *   (e.g. `dexe_get_config`, `dexe_doctor`).
 *
 * The masking is provider-agnostic and structural (no host allowlist), so it
 * covers any RPC vendor and cannot be bypassed by an unrecognized host.
 */

/** Userinfo in a URL: `scheme://user:pass@` (used only in the parse fallback). */
const USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s@]+@/g;

/** Any http(s) URL token, bounded by whitespace / common punctuation. */
const URL_RE = /\bhttps?:\/\/[^\s'"`)<>\]},;]+/gi;

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
