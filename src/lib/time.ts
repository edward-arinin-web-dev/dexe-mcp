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

/**
 * Render a DURATION in seconds as something a person can judge: "1 day",
 * "12 hours", "90 minutes", "0 (none)".
 *
 * Distinct from {@link unixToUtc}, which formats a POINT IN TIME —
 * `unixToUtc(86400)` is "1970-01-02 00:00:00 UTC", not "1 day". Contract
 * settings (voting duration, execution delay, validator duration) are
 * durations, and printing them as bare seconds is how "86400" reaches a user
 * deciding whether a governance config is livable.
 *
 * Falls back to plain seconds for anything non-finite or negative.
 */
export function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return `${sec}s`;
  if (sec === 0) return "0 (none)";
  const units: Array<[number, string]> = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (sec % size === 0 && sec >= size) {
      const n = sec / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  // Not a whole number of any unit — name the largest that fits, with the
  // exact seconds alongside so nothing is rounded away silently.
  for (const [size, name] of units) {
    if (sec >= size) {
      return `${(sec / size).toFixed(1)} ${name}s (${sec}s)`;
    }
  }
  return `${sec} second${sec === 1 ? "" : "s"}`;
}
