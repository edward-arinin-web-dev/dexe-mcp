/**
 * Neutralize attacker-controlled strings before they are interpolated into a
 * human/LLM-visible tool result (`content[].text`).
 *
 * On-chain `descriptionURL`, ERC20 `symbol()`, and IPFS-JSON values are fully
 * attacker-controlled. Rendered verbatim they enable:
 *   - prompt-injection (H-13): instructions smuggled into the model context;
 *   - structural forgery (W24/H-13): an unescaped newline in `symbol()` paints
 *     a fake treasury line with an attacker-chosen address;
 *   - homoglyph / look-alike spoofing: Cyrillic/zero-width chars that read as a
 *     trusted token but are not.
 *
 * `sanitizeUntrusted` NFKC-normalizes, escapes C0/C1 control chars (so newlines
 * can't forge lines), and drops zero-width / bidi-override / BOM characters.
 * `renderUntrusted` additionally length-caps and appends a non-ASCII flag so an
 * automated approver doesn't trust a look-alike. Regexes are character-class
 * only (no host matching, no backtracking) to stay clear of ReDoS, and are
 * built from escaped ASCII strings so the source stays free of literal control
 * bytes.
 */

// C0 controls (incl. \n \r \t), DEL, and C1 controls.
const CONTROL_RE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
// Zero-width + bidi marks, bidi embeddings/overrides, word-joiner/invisible
// math range, bidi isolates, and the BOM — all usable for visual spoofing.
const INVISIBLE_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]",
  "g",
);
// Anything outside printable ASCII (space..tilde).
const NON_ASCII_RE = new RegExp("[^\\u0020-\\u007E]");

/** NFKC-normalize, escape control chars to visible `\xNN`, drop invisible chars. */
export function sanitizeUntrusted(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : String(raw)).normalize("NFKC");
  return s
    .replace(CONTROL_RE, (c) => "\\x" + (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .replace(INVISIBLE_RE, "");
}

/** True if the string contains any non-printable-ASCII char (homoglyph risk). */
export function hasNonAscii(s: string): boolean {
  return NON_ASCII_RE.test(s);
}

/**
 * Render an attacker-controlled value for a single-line human/LLM context:
 * sanitized, length-capped, and tagged `<non-ASCII>` when it contains non-ASCII
 * characters (possible homoglyph) so a look-alike token isn't silently trusted.
 */
export function renderUntrusted(raw: unknown, maxLen = 200): string {
  const s = sanitizeUntrusted(raw);
  // Flag on the actual content, not the (ASCII) truncation marker.
  const flagged = hasNonAscii(s);
  const capped = s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
  return flagged ? `${capped} <non-ASCII>` : capped;
}
