import type { JsonRpcProvider, TransactionReceipt, TransactionResponse } from "ethers";

/** Default on-chain confirmation wait budget (ms). Override: DEXE_TX_WAIT_TIMEOUT_MS. */
export const DEFAULT_TX_WAIT_TIMEOUT_MS = 180_000;

function timeoutMessage(txHash: string, chainId: number | bigint | undefined, ms: number): string {
  return (
    `Transaction ${txHash} was broadcast but not mined within ${Math.round(ms / 1000)}s — it may still land. ` +
    `Do NOT re-send blindly (risk of double-execution). Check it with dexe_tx_status {"txHash":"${txHash}"` +
    (chainId !== undefined ? `,"chainId":${chainId}` : "") +
    `} and re-run this call only after it reports not_found.`
  );
}

function isEthersTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "TIMEOUT";
}

/**
 * `tx.wait` with a hard timeout (ethers v6 supports a wait timeout natively;
 * this normalizes the TimeoutError into an actionable message that carries the
 * tx hash + the dexe_tx_status follow-up). A stuck/dropped tx no longer hangs
 * the tool call forever (R2).
 */
export async function waitWithTimeout(
  tx: TransactionResponse,
  opts?: { confirmations?: number; timeoutMs?: number },
): Promise<TransactionReceipt | null> {
  const ms = opts?.timeoutMs ?? DEFAULT_TX_WAIT_TIMEOUT_MS;
  try {
    return await tx.wait(opts?.confirmations ?? 1, ms);
  } catch (err) {
    if (isEthersTimeout(err)) throw new Error(timeoutMessage(tx.hash, tx.chainId, ms));
    throw err;
  }
}

/** `provider.waitForTransaction` with the same timeout normalization (WC path). */
export async function waitForHashWithTimeout(
  provider: JsonRpcProvider,
  txHash: string,
  chainId: number,
  opts?: { confirmations?: number; timeoutMs?: number },
): Promise<TransactionReceipt | null> {
  const ms = opts?.timeoutMs ?? DEFAULT_TX_WAIT_TIMEOUT_MS;
  try {
    return await provider.waitForTransaction(txHash, opts?.confirmations ?? 1, ms);
  } catch (err) {
    if (isEthersTimeout(err)) throw new Error(timeoutMessage(txHash, chainId, ms));
    throw err;
  }
}

/**
 * R3 — a mined-but-reverted tx (receipt.status === 0) must NEVER read as
 * success: dependent composite steps would proceed on top of unchanged state
 * (e.g. a reverted approve followed by a deposit). Throws with the tx hash so
 * the failure is diagnosable.
 */
export function assertReceiptSuccess(
  receipt: TransactionReceipt | null,
  label: string,
): asserts receipt is TransactionReceipt {
  if (!receipt) return; // absent receipt is handled by the timeout path
  if (receipt.status === 0) {
    throw new Error(
      `${label} REVERTED on-chain (tx ${receipt.hash}, status 0) — state was not changed by this step. ` +
        `Inspect the tx on the explorer for the revert reason, fix the cause, and re-run.`,
    );
  }
}

/** Resolve the wait budget from env once per call site (config-independent helper). */
export function txWaitTimeoutMs(): number {
  const raw = process.env.DEXE_TX_WAIT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TX_WAIT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TX_WAIT_TIMEOUT_MS;
}
