import { describe, it, expect } from "vitest";
import {
  parseAmount,
  formatAmount,
  from18,
  GOV_POWER_DECIMALS,
  formatUnitsWithSymbol,
  withFormatted,
} from "../../src/lib/units.js";

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

/**
 * 0.34.0 — read tools used to emit bare wei and leave the 18-decimal division
 * to the model, which is how "0.000495 BNB" got reported as "0.495 BNB". Every
 * literal here is a value read live off BSC mainnet on 2026-09-11.
 */
describe("formatUnitsWithSymbol", () => {
  it("keeps the leading zeros of a tiny native balance", () => {
    // DeXe DAO's actual native balance. ethers TRIMS trailing zeros, so the
    // expectation is "0.0000730011", not a zero-padded 18-place string.
    expect(formatUnitsWithSymbol(73001100000000n, 18, "BNB")).toBe("0.0000730011 BNB");
  });

  it("keeps every digit of a 27-digit balance", () => {
    // BOXY's top holder. A Number()/1e18 implementation yields
    // 8521112653.712523 and fails this — which is the point of the case.
    expect(formatUnitsWithSymbol(8521112653712523724538372026n, 18, "BOXY")).toBe(
      "8521112653.712523724538372026 BOXY",
    );
  });

  it("honours a token's real decimals", () => {
    // CARIB (8 dec) and VALDRA (6 dec) are both in the live DeXe DAO treasury.
    expect(formatUnitsWithSymbol(28189512038297n, 8, "CARIB")).toBe("281895.12038297 CARIB");
    expect(formatUnitsWithSymbol("660000000000", 6, "VALDRA")).toBe("660000.0 VALDRA");
  });

  it("omits the symbol when there is none to state", () => {
    expect(formatUnitsWithSymbol(10n ** 18n, 18)).toBe("1.0");
  });
});

describe("withFormatted", () => {
  it("adds a sibling without touching the wei field", () => {
    const row = { balance: "1282179760730788225547277", symbol: "DEXE" };
    const out = withFormatted(row, ["balance"], 18, "DEXE");
    expect(out.balance).toBe("1282179760730788225547277");
    expect((out as Record<string, unknown>).balanceFormatted).toBe(
      "1282179.760730788225547277 DEXE",
    );
  });

  it("NEVER guesses 18 when decimals are unknown", () => {
    const row = { balance: "1" };
    expect(withFormatted(row, ["balance"], null)).toEqual({ balance: "1" });
    expect("balanceFormatted" in withFormatted(row, ["balance"], null)).toBe(false);
  });

  it("leaves non-numeric and non-string values alone, and never mutates its input", () => {
    const row = { balance: "12", decimals: 18, symbol: "X", note: "n/a" };
    const out = withFormatted(row, ["balance", "decimals", "symbol", "note", "missing"], 18);
    expect(row).toEqual({ balance: "12", decimals: 18, symbol: "X", note: "n/a" });
    expect(out).not.toHaveProperty("decimalsFormatted");
    expect(out).not.toHaveProperty("symbolFormatted");
    expect(out).not.toHaveProperty("noteFormatted");
    expect(out).not.toHaveProperty("missingFormatted");
  });
});

describe("GOV_POWER_DECIMALS", () => {
  it("is 18 — governance amounts are to18-normalized, not token-decimals", () => {
    // GovUserKeeper.sol:564 stores balanceOf(voter).to18(tokenAddress); the
    // inverse from18Safe runs only on withdrawal. Formatting a 6-decimal gov
    // token's power with 6 decimals overstates it by 1e12.
    expect(GOV_POWER_DECIMALS).toBe(18);
  });
});

describe("from18 (R9 — OTC payment-token decimals)", () => {
  it("identity for 18-dec tokens", () => {
    expect(from18(12500000000000000000n, 18)).toBe(12500000000000000000n);
  });
  it("scales down for 6-dec tokens (100 USDT)", () => {
    expect(from18(100_000000000000000000n, 6)).toBe(100_000000n);
  });
  it("rejects precision loss like the contract's from18Safe", () => {
    expect(() => from18(1n, 6)).toThrow(/precision loss/);
  });
  it("scales up for >18-dec tokens", () => {
    expect(from18(5n, 20)).toBe(500n);
  });
});
