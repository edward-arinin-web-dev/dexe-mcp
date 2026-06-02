/**
 * Strict parsing of user-supplied unsigned-integer (wei / id) strings.
 *
 * `BigInt()` silently accepts inputs that are almost never what the caller
 * intended, producing a structurally-valid but semantically-wrong calldata:
 *
 *   BigInt("")      === 0n     → a blank amount field becomes a 0-value tx
 *   BigInt("   ")   === 0n     → whitespace likewise coerces to 0
 *   BigInt("0x10")  === 16n    → a hex string is reinterpreted as a number
 *   BigInt("-5")    === -5n    → a negative wraps to a huge uint256 on-chain
 *
 * and `BigInt("1.5")` throws an opaque `SyntaxError` with no field context.
 *
 * This guard accepts only a plain base-10, non-negative integer string and
 * returns the parsed `bigint`; otherwise it throws a clear, field-named error.
 * Builders run inside the MCP tool callback, so a throw surfaces to the caller
 * as a normal error result rather than a silent mis-encode.
 *
 * Use this everywhere a user-provided amount / id / nftId string flows into
 * `BigInt(...)` before being encoded into transaction calldata.
 */
export function parseUintString(value: string, field = "amount"): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(
      `Invalid ${field}: ${JSON.stringify(value)}. ` +
        `Expected a base-10 wei/id integer string — digits only, ` +
        `no decimals, hex (0x…), sign, whitespace, or empty value.`,
    );
  }
  return BigInt(value);
}
