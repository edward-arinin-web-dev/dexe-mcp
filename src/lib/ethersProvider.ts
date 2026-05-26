import {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  ZeroAddress,
  getAddress,
  isAddress,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

/**
 * Ethers layer for the Safe{Wallet} multisig integration. Houses everything
 * the `dexe_safe_*` tools need that is *not* a tool registration:
 *
 *  - the Safe Smart Account read ABI + `readSafeState`
 *  - the canonical `SafeTx` EIP-712 type set + domain + `computeSafeTxHash`
 *  - the chainId → Safe Transaction Service endpoint resolver
 *
 * Kept separate from `../rpc.ts` (which is the generic gov-tool provider cache)
 * so the Safe-specific crypto stays in one auditable place.
 */

// ---------------------------------------------------------------------------
// Safe Smart Account — minimal read ABI
// ---------------------------------------------------------------------------

export const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function isOwner(address owner) view returns (bool)",
  "function VERSION() view returns (string)",
] as const;

export interface SafeState {
  safe: string;
  nonce: bigint;
  threshold: bigint;
  owners: string[];
  version: string;
}

/**
 * Read the live Safe state (nonce, threshold, owners, version) over a single
 * provider. Each call is independent; `VERSION` is best-effort because some
 * very old singletons predate it.
 */
export async function readSafeState(
  provider: JsonRpcProvider,
  safeAddress: string,
): Promise<SafeState> {
  if (!isAddress(safeAddress)) throw new Error(`Invalid Safe address: ${safeAddress}`);
  const safe = getAddress(safeAddress);
  const c = new Contract(safe, SAFE_ABI, provider);

  const [nonce, threshold, owners] = await Promise.all([
    c.getFunction("nonce").staticCall() as Promise<bigint>,
    c.getFunction("getThreshold").staticCall() as Promise<bigint>,
    c.getFunction("getOwners").staticCall() as Promise<string[]>,
  ]);

  let version = "unknown";
  try {
    version = (await c.getFunction("VERSION").staticCall()) as string;
  } catch {
    // pre-1.1.0 singleton without VERSION(); leave as "unknown".
  }

  return {
    safe,
    nonce,
    threshold,
    owners: owners.map((o) => getAddress(o)),
    version,
  };
}

// ---------------------------------------------------------------------------
// SafeTx EIP-712
// ---------------------------------------------------------------------------

/** CALL = 0, DELEGATECALL = 1. Safe rejects any other value. */
export const SAFE_OPERATION = { CALL: 0, DELEGATECALL: 1 } as const;

/**
 * The `SafeTx` struct as signed by owners. Field order is consensus-critical:
 * it must match `Safe.encodeTransactionData` exactly or the recovered signer
 * will not be an owner and the service rejects the proposal.
 */
export const SAFE_TX_TYPES: Record<string, TypedDataField[]> = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export interface SafeTx {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: string;
}

/**
 * EIP-712 domain for a Safe >= 1.3.0: `{ chainId, verifyingContract }`. Earlier
 * singletons (< 1.3.0) used `{ verifyingContract }` only; those are not
 * targeted here — `dexe_safe_*` assumes a modern (1.3.0 / 1.4.1) singleton.
 */
export function safeTxDomain(chainId: number, safeAddress: string): TypedDataDomain {
  return { chainId, verifyingContract: getAddress(safeAddress) };
}

/** Build a normalized SafeTx with the protocol defaults filled in. */
export function buildSafeTx(input: {
  to: string;
  value?: string;
  data?: string;
  operation?: number;
  safeTxGas?: string;
  baseGas?: string;
  gasPrice?: string;
  gasToken?: string;
  refundReceiver?: string;
  nonce: string | bigint;
}): SafeTx {
  if (!isAddress(input.to)) throw new Error(`Invalid 'to' address: ${input.to}`);
  const operation = input.operation ?? SAFE_OPERATION.CALL;
  if (operation !== SAFE_OPERATION.CALL && operation !== SAFE_OPERATION.DELEGATECALL) {
    throw new Error(`operation must be 0 (CALL) or 1 (DELEGATECALL), got ${operation}`);
  }
  const gasToken = input.gasToken ?? ZeroAddress;
  const refundReceiver = input.refundReceiver ?? ZeroAddress;
  if (!isAddress(gasToken)) throw new Error(`Invalid gasToken: ${gasToken}`);
  if (!isAddress(refundReceiver)) throw new Error(`Invalid refundReceiver: ${refundReceiver}`);

  return {
    to: getAddress(input.to),
    value: (input.value ?? "0").toString(),
    data: input.data && input.data.length > 0 ? input.data : "0x",
    operation,
    safeTxGas: (input.safeTxGas ?? "0").toString(),
    baseGas: (input.baseGas ?? "0").toString(),
    gasPrice: (input.gasPrice ?? "0").toString(),
    gasToken: getAddress(gasToken),
    refundReceiver: getAddress(refundReceiver),
    nonce: input.nonce.toString(),
  };
}

/**
 * Deterministic `safeTxHash` — the value owners sign and the service indexes
 * the transaction under. Equivalent to `Safe.getTransactionHash(...)` on-chain.
 */
export function computeSafeTxHash(chainId: number, safeAddress: string, tx: SafeTx): string {
  return TypedDataEncoder.hash(safeTxDomain(chainId, safeAddress), SAFE_TX_TYPES, tx);
}

// ---------------------------------------------------------------------------
// Safe Transaction Service endpoint resolution
// ---------------------------------------------------------------------------

/**
 * chainId → Safe Transaction Service "short name" used in the unified
 * `https://api.safe.global/tx-service/<shortname>/api/v2` base. Sourced from
 * the public Safe API reference. BSC testnet (97) has no hosted service — it
 * must be supplied via `DEXE_SAFE_TX_SERVICE_URL`.
 */
export const SAFE_TX_SERVICE_SHORTNAMES: Record<number, string> = {
  1: "eth",
  10: "oeth",
  56: "bnb",
  100: "gno",
  137: "matic",
  324: "zksync",
  8453: "base",
  42161: "arb1",
  43114: "avax",
  11155111: "sep",
  84532: "basesep",
};

export interface SafeServiceEndpoint {
  /** Base URL ending in `/api/v2` (no trailing slash). */
  base: string;
  /** Full POST target for creating a multisig transaction. */
  multisigTransactions: (safe: string) => string;
  /** True when the base was derived from the hosted api.safe.global service. */
  hosted: boolean;
}

/**
 * Resolve the Safe Transaction Service base for a chain. When
 * `override` (DEXE_SAFE_TX_SERVICE_URL) is set it wins unconditionally — that
 * is the escape hatch for self-hosted services and unsupported chains (e.g.
 * BSC testnet). Throws when neither an override nor a known short name exists.
 */
export function resolveSafeServiceEndpoint(
  chainId: number,
  override?: string,
): SafeServiceEndpoint {
  let base: string;
  let hosted: boolean;

  if (override && override.trim().length > 0) {
    base = override.trim().replace(/\/+$/, "");
    hosted = /api\.safe\.global/i.test(base);
  } else {
    const shortname = SAFE_TX_SERVICE_SHORTNAMES[chainId];
    if (!shortname) {
      throw new Error(
        `No Safe Transaction Service endpoint known for chainId=${chainId}. ` +
          `Set DEXE_SAFE_TX_SERVICE_URL to the service base (e.g. ` +
          `https://api.safe.global/tx-service/<shortname>/api/v2).`,
      );
    }
    base = `https://api.safe.global/tx-service/${shortname}/api/v2`;
    hosted = true;
  }

  return {
    base,
    hosted,
    multisigTransactions: (safe: string) =>
      `${base}/safes/${getAddress(safe)}/multisig-transactions/`,
  };
}
