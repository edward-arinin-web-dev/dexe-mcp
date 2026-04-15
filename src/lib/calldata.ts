import { Interface } from "ethers";

/**
 * Canonical signable payload shape returned by every `*_build_*` tool.
 * Consumers (agent wallets, Safe, etc.) can feed this straight into
 * `eth_sendTransaction` / `personal_signTypedData` flows.
 */
export interface TxPayload {
  /** Destination contract address. */
  to: string;
  /** ABI-encoded call data (0x-prefixed hex). */
  data: string;
  /** Wei value as decimal string ("0" if none). */
  value: string;
  /** Target chain id. */
  chainId: number;
  /** Human-readable action label, e.g. "GovPool.vote(123, true, 1000000000000000000, [])". */
  description: string;
}

export interface BuildPayloadOpts {
  to: string;
  iface: Interface;
  method: string;
  args: readonly unknown[];
  chainId: number;
  value?: bigint | string | number;
  /** Optional override; otherwise we auto-generate `Contract.method(args…)`. */
  description?: string;
  /** Contract label used in auto-generated description. */
  contractLabel?: string;
}

export function buildPayload(opts: BuildPayloadOpts): TxPayload {
  const data = opts.iface.encodeFunctionData(opts.method, opts.args);
  const value = (opts.value ?? 0n).toString();
  const description =
    opts.description ?? `${opts.contractLabel ?? "Contract"}.${opts.method}(${formatArgs(opts.args)})`;
  return {
    to: opts.to,
    data,
    value,
    chainId: opts.chainId,
    description,
  };
}

function formatArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "bigint") return a.toString();
      if (typeof a === "string") return a.length > 42 ? `${a.slice(0, 10)}…` : a;
      if (Array.isArray(a)) return `[${a.length}]`;
      if (a && typeof a === "object") return "{…}";
      return String(a);
    })
    .join(", ");
}
