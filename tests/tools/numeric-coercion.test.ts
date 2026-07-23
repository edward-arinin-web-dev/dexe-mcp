import { describe, it, expect } from "vitest";
import { numericAmountString, numericIntString } from "../../src/tools/proposalBuildComplex.js";

// Regression for the 0.29.0 review finding: numericAmountString accepted a
// number-typed integer beyond 2^53, whose String() form has already lost
// precision (or gone to scientific notation), producing WRONG raw-wei calldata
// for token_transfer / withdraw_treasury / token_distribution / validators_allocation.
describe("numericAmountString — large-integer precision guard", () => {
  it("passes strings through untouched (any magnitude)", () => {
    expect(numericAmountString.parse("12345678901234567890")).toBe("12345678901234567890");
    expect(numericAmountString.parse("1000000000000000000000")).toBe("1000000000000000000000");
  });

  it("accepts safe integer and fractional human-unit numbers", () => {
    expect(numericAmountString.parse(1000)).toBe("1000");
    expect(numericAmountString.parse(12.5)).toBe("12.5");
    expect(numericAmountString.parse(0)).toBe("0");
  });

  it("REJECTS an unsafe integer number instead of silently rounding it", () => {
    // String(12345678901234567890) === '12345678901234567000' (890 wei short)
    const r = numericAmountString.safeParse(12345678901234567890);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/too large.*pass it as a string/);
  });

  it("REJECTS a value that would stringify to scientific notation", () => {
    // String(1e21) === '1e+21'
    expect(numericAmountString.safeParse(1e21).success).toBe(false);
  });

  it("still rejects non-finite numbers", () => {
    expect(numericAmountString.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(numericAmountString.safeParse(Number.NaN).success).toBe(false);
  });

  it("matches numericIntString's guard for large integers (parity between the two helpers)", () => {
    expect(numericIntString.safeParse(12345678901234567890).success).toBe(false);
    expect(numericAmountString.safeParse(12345678901234567890).success).toBe(false);
  });
});
