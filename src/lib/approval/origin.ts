/**
 * The Origin check of the keystore approval page (./server.ts). Kept in the
 * write edition on purpose — the read package has the same check for its HTTP
 * server, but the gate in front of a signing approval must not change with a
 * read-edition release (tests/lib/approval-origin.test.ts).
 */

export type OriginVerdict = "absent" | "allowed" | "rejected";

/**
 * `absent` for a missing or empty header; otherwise `allowed` only when the
 * header parses to one of `allowed`'s origins (scheme + host + port, compared
 * lower-case). The literal `Origin: null` (sandboxed iframes, file://) is
 * present but not a real origin, so it is rejected. A `null` allowlist turns
 * the check off.
 */
export function checkOrigin(header: string | undefined, allowed: readonly string[] | null): OriginVerdict {
  if (header === undefined || header.trim() === "") return "absent";
  if (allowed === null) return "allowed";
  let origin: string;
  try {
    origin = new URL(header.trim()).origin.toLowerCase();
  } catch {
    return "rejected";
  }
  if (origin === "null") return "rejected";
  return allowed.includes(origin) ? "allowed" : "rejected";
}
