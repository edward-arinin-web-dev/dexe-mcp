/**
 * Time formatting helpers for on-chain timestamps.
 *
 * Contracts store times as Unix seconds (UTC-based, timezone-agnostic). Raw
 * seconds are unreadable to humans, so read tools should surface a companion
 * UTC string alongside the raw value to avoid any local-timezone confusion.
 */

/**
 * Format a Unix timestamp (seconds) as an unambiguous UTC string.
 *
 * @example unixToUtc(1783100759) // "2026-07-03 17:45:59 UTC"
 * @returns "" for zero/invalid input — `0` is the contract's "unset" sentinel
 *          (e.g. no vesting), and an empty string reads better than "1970-...".
 */
export function unixToUtc(sec: bigint | number | string): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}
