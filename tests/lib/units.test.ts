import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../../src/lib/units.js";

describe("parseAmount (A8 dual mode)", () => {
  it("digits-only string passes through as raw wei (back-compat)", () => {
    expect(parseAmount("12500000000000000000", 18)).toBe(12500000000000000000n);
    expect(parseAmount("1", 18)).toBe(1n);
    expect(parseAmount("0", 18)).toBe(0n);
  });

  it("decimal string scales by the token's real decimals", () => {
    expect(parseAmount("12.5", 18)).toBe(12500000000000000000n);
    expect(parseAmount("12.5", 6)).toBe(12500000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
  });

  it("never assumes 18 decimals", () => {
    expect(parseAmount("1.5", 8)).toBe(150000000n);
  });

  it("rejects more fractional digits than the token supports", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrow(/decimal places/);
  });

  it("rejects unparseable forms with both accepted examples", () => {
    for (const bad of ["-5", "1e18", "12,5", "0x10", "", "12.5.5", "12."]) {
      expect(() => parseAmount(bad, 18)).toThrow(/Cannot parse amount|decimal places/);
    }
  });
});

describe("formatAmount", () => {
  it("renders human + raw", () => {
    expect(formatAmount(12500000000000000000n, 18, "GEC")).toBe("12.5 GEC (raw 12500000000000000000)");
    expect(formatAmount(1n, 6)).toBe("0.000001 (raw 1)");
  });
});
