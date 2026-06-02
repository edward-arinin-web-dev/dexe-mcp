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
 * - `redactUrlCredentials(text)` — strip `user:pass@` userinfo and known
 *   provider key segments / `?apikey=` style params from arbitrary text.
 * - `maskUrl(url)` — for deliberately displaying a configured endpoint
 *   (e.g. `dexe_get_config`, `dexe_doctor`) without its key.
 */

const USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s@]+@/g;

const PROVIDER_KEY_RES: [RegExp, string][] = [
  [/(g\.alchemy\.com\/v2\/)[A-Za-z0-9_-]+/gi, "$1***"],
  [/(\.infura\.io\/v3\/)[A-Za-z0-9_-]+/gi, "$1***"],
  [/(quiknode\.pro\/)[A-Za-z0-9_-]+/gi, "$1***"],
  [/(rpc\.ankr\.com\/[a-z0-9_]+\/)[A-Za-z0-9]+/gi, "$1***"],
  [/(blastapi\.io\/)[A-Za-z0-9-]+/gi, "$1***"],
  [/(nodereal\.io\/v1\/)[A-Za-z0-9]+/gi, "$1***"],
  [/(chainstack\.com\/[A-Za-z0-9]+\/)[A-Za-z0-9]+/gi, "$1***"],
  // Generic api-key style query params.
  [/([?&](?:api[-_]?key|apikey|key|auth|token|access[-_]?token|secret)=)[^&\s#"']+/gi, "$1***"],
];

/** Strip credentials from any URLs found in `text`. Best-effort, never throws. */
export function redactUrlCredentials(text: string): string {
  let out = text.replace(USERINFO_RE, "$1***@");
  for (const [re, rep] of PROVIDER_KEY_RES) out = out.replace(re, rep);
  return out;
}

/**
 * Mask a single configured URL for display: keep scheme + host, drop userinfo,
 * and replace any path/query (which may carry the API key) with `***`.
 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname && u.pathname !== "/" ? "/***" : "";
    const query = u.search ? "?***" : "";
    return `${u.protocol}//${u.host}${path}${query}`;
  } catch {
    return redactUrlCredentials(raw);
  }
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
