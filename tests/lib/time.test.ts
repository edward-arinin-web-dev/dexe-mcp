import { describe, expect, it } from "vitest";
import { unixToUtc } from "../../src/lib/time.js";

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
