import { describe, expect, it } from "vitest";
import { humanDuration, unixToUtc } from "../../src/lib/time.js";

/**
 * OTC read tools surface tier start/end times. Raw Unix seconds confuse
 * end users (and read as local time in some UIs), so the tools emit a
 * companion `*UTC` string. These assertions pin the format and the
 * on-chain values used in the live 2026-07-03 validation run.
 */
describe("unixToUtc", () => {
  it("formats a Unix timestamp as an explicit UTC string", () => {
    // Tier 1 sale start from the live run (== frontend "5:45 PM UTC").
    expect(unixToUtc(1783100759)).toBe("2026-07-03 17:45:59 UTC");
    // Tier 1 sale end (== frontend "6:45 PM UTC").
    expect(unixToUtc(1783104359)).toBe("2026-07-03 18:45:59 UTC");
  });

  it("accepts bigint and numeric-string inputs identically", () => {
    expect(unixToUtc(1783102356n)).toBe("2026-07-03 18:12:36 UTC");
    expect(unixToUtc("1783102356")).toBe("2026-07-03 18:12:36 UTC");
  });

  it("returns an empty string for the unset (0) sentinel", () => {
    // Contracts use 0 for "no time set" (e.g. no vesting) — "" reads better
    // than a misleading 1970 epoch date.
    expect(unixToUtc(0)).toBe("");
    expect(unixToUtc(0n)).toBe("");
  });

  it("returns an empty string for invalid input", () => {
    expect(unixToUtc(-1)).toBe("");
    expect(unixToUtc("not-a-number")).toBe("");
  });
});

/**
 * D15-8. Durations are NOT timestamps: `unixToUtc(86400)` is
 * "1970-01-02 00:00:00 UTC", which is why a DAO preview printed voting
 * duration and execution delay as bare seconds — the numbers a user has to
 * judge before a config they can never change.
 */
describe("humanDuration", () => {
  it("names whole days, hours and minutes", () => {
    expect(humanDuration(86400)).toBe("1 day");
    expect(humanDuration(259200)).toBe("3 days");
    expect(humanDuration(3600)).toBe("1 hour");
    expect(humanDuration(43200)).toBe("12 hours");
    expect(humanDuration(5400)).toBe("90 minutes");
    expect(humanDuration(60)).toBe("1 minute");
  });

  it("zero is the contract's 'unset', and says so", () => {
    expect(humanDuration(0)).toBe("0 (none)");
  });

  it("keeps the exact seconds when the value is not a whole unit", () => {
    expect(humanDuration(5000)).toBe("1.4 hours (5000s)");
    expect(humanDuration(45)).toBe("45 seconds");
  });

  it("never returns a 1970 date — that is what unixToUtc is for", () => {
    expect(humanDuration(86400)).not.toContain("1970");
    expect(unixToUtc(86400)).toContain("1970");
  });

  it("degrades rather than throwing on nonsense", () => {
    expect(humanDuration(Number.NaN)).toContain("NaN");
    expect(humanDuration(-5)).toBe("-5s");
  });
});
