import { Contract, Interface, JsonRpcProvider } from "ethers";

/**
 * Multicall3 — deployed at the same address on ~every EVM chain.
 * https://www.multicall3.com
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

export interface Call {
  /** Target contract address. */
  target: string;
  /** ABI fragment or full Interface covering `method`. */
  iface: Interface;
  /** Method name or full signature. */
  method: string;
  /** Positional args (empty array if none). */
  args: readonly unknown[];
  /** If true, failures don't revert the whole batch (decoded as `null`). */
  allowFailure?: boolean;
}

export interface CallResult<T = unknown> {
  success: boolean;
  value: T | null;
  /** Hex-encoded raw return data. */
  raw: string;
  /** Error message if decoding failed or call reverted with allowFailure. */
  error?: string;
}

/**
 * Batch `calls` into a single Multicall3 aggregate3 RPC round-trip. Each call
 * is decoded via its own `iface`. Failed calls with `allowFailure: true`
 * yield `{ success: false, value: null }` instead of throwing.
 */
export async function multicall(
  provider: JsonRpcProvider,
  calls: Call[],
): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const mc = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const payload = calls.map((c) => ({
    target: c.target,
    allowFailure: c.allowFailure ?? false,
    callData: c.iface.encodeFunctionData(c.method, c.args),
  }));

  const results: Array<{ success: boolean; returnData: string }> =
    await mc.getFunction("aggregate3").staticCall(payload);

  return results.map((r, i) => {
    const c = calls[i]!;
    if (!r.success) {
      return { success: false, value: null, raw: r.returnData, error: "call reverted" };
    }
    try {
      const decoded = c.iface.decodeFunctionResult(c.method, r.returnData);
      // Unwrap single-return-value tuples for ergonomic use.
      const value = decoded.length === 1 ? decoded[0] : decoded;
      return { success: true, value, raw: r.returnData };
    } catch (err) {
      return {
        success: false,
        value: null,
        raw: r.returnData,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
