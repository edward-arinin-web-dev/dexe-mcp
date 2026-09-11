import { parseUnits, formatUnits } from "ethers";

/**
 * Dual-mode token-amount parsing shared by every tool that accepts an amount.
 *
 * Rules (back-compat by construction):
 *   - digits-only string ("12500000000000000000") → treated as RAW smallest
 *     units (wei) and returned unchanged. This is what every pre-0.22 caller
 *     passed, so existing integrations keep byte-identical behavior.
 *   - decimal string ("12.5") → HUMAN units, scaled by the token's real
 *     `decimals` (never assume 18 — mirrors the frontend, which calls
 *     `parseUnits(amount, token.decimals)` per token).
 *
 * Anything else (negative, hex, scientific notation, thousands separators)
 * is rejected with an example of both accepted forms.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim();
  if (/^\d+$/.test(s)) return BigInt(s);
  if (/^\d+\.\d+$/.test(s)) {
    const frac = s.split(".")[1]!;
    if (frac.length > decimals) {
      throw new Error(
        `Amount '${s}' has ${frac.length} decimal places but the token only has ${decimals} — ` +
          `it cannot be represented on-chain. Use at most ${decimals} decimal places.`,
      );
    }
    return parseUnits(s, decimals);
  }
  throw new Error(
    `Cannot parse amount '${input}'. Pass either raw smallest units as a digits-only string ` +
      `(e.g. '12500000000000000000') or human units with a decimal point (e.g. '12.5', scaled by the ` +
      `token's ${decimals} decimals).`,
  );
}

/**
 * Human-readable rendering of a raw token amount — used by error messages so
 * the model/user never has to convert wei by hand. "12.5 GEC (raw 12500…000)".
 */
export function formatAmount(raw: bigint, decimals: number, symbol?: string): string {
  const human = formatUnits(raw, decimals);
  return `${human}${symbol ? ` ${symbol}` : ""} (raw ${raw.toString()})`;
}

/**
 * Voting power, deposits, rewards and credit limits held inside DeXe governance
 * are ALWAYS 18-decimal-normalized, whatever the gov token's own `decimals()`:
 * `GovUserKeeper.sol:564` stores `ERC20(token).balanceOf(voter).to18(token)` and
 * the inverse `from18Safe` is applied only on the way OUT (withdrawals,
 * `TokenBalance.sendFunds`). Formatting those numbers with the token's decimals
 * overstates a 6-decimal gov token by 10^12 — the exact digit-shift class this
 * constant exists to prevent. Raw ERC20 balances (`balanceOf`, backend holder
 * lists) are the opposite: they use the token's READ decimals, or nothing.
 */
export const GOV_POWER_DECIMALS = 18;

/**
 * Human rendering for STRUCTURED output: `"1282179.760730788225547277 DEXE"`.
 * No parentheses and no `raw` — the wei value stays in its own untouched field,
 * unlike {@link formatAmount}, which is prose-shaped.
 *
 * Note ethers trims trailing zeros: `formatUnits(73001100000000n, 18)` is
 * `"0.0000730011"`, and `formatUnits(10n ** 18n, 18)` is `"1.0"`.
 */
export function formatUnitsWithSymbol(
  raw: bigint | string,
  decimals: number,
  symbol?: string,
): string {
  return `${formatUnits(BigInt(raw), decimals)}${symbol ? ` ${symbol}` : ""}`;
}

/**
 * ADD-ONLY: attach `<field>Formatted` siblings for the named wei fields. Every
 * pre-existing key is returned byte-identical, so a pre-0.34 consumer is
 * unaffected.
 *
 * `decimals === null` means "unknown" and suppresses formatting entirely —
 * never guess 18 for a raw ERC20 balance. Non-string and non-numeric values are
 * left alone, and the input object is never mutated.
 */
export function withFormatted<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
  decimals: number | null,
  symbol?: string,
): T {
  if (decimals == null) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = row[f];
    if (typeof v === "string" && /^\d+$/.test(v)) {
      out[`${f}Formatted`] = formatUnitsWithSymbol(v, decimals, symbol);
    }
  }
  return out as T;
}

/**
 * Convert an 18-decimal-normalized amount to a token's native raw units —
 * mirrors the protocol's from18Safe (DecimalsConverter). Used by the OTC buy
 * preflight: `TokenSaleProposal.buy` takes the 18-dec-normalized amount but
 * `transferFrom` pulls the converted RAW amount, so balance checks and the
 * exact-amount approve must use this value (R9).
 *
 * Throws on precision loss for <18-dec tokens (the contract's Safe variant
 * rejects those too — better to fail here with a readable message).
 */
export function from18(normalized: bigint, decimals: number): bigint {
  if (decimals === 18) return normalized;
  if (decimals < 18) {
    const factor = 10n ** BigInt(18 - decimals);
    if (normalized % factor !== 0n) {
      throw new Error(
        `Amount ${normalized.toString()} (18-dec normalized) cannot be represented in the payment token's ` +
          `${decimals} decimals without precision loss — the contract's from18Safe would revert. ` +
          `Use a multiple of 10^${18 - decimals}.`,
      );
    }
    return normalized / factor;
  }
  return normalized * 10n ** BigInt(decimals - 18);
}
