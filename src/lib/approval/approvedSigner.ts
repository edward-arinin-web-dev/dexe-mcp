import type { TransactionResponse } from "ethers";
import {
  ApprovalDeviationError,
  matchesExpected,
  type ApprovalStore,
  type ExpectedTx,
  type KeyHolder,
} from "./store.js";

/** The wallet surface an ApprovedSigner drives (an ethers Wallet bound to a provider). */
export interface SendCapable {
  readonly address: string;
  sendTransaction(tx: {
    to: string;
    data: string;
    value: bigint;
    chainId: bigint;
    gasLimit?: bigint;
  }): Promise<TransactionResponse>;
  /** Server-side gas estimate (an ethers Wallet has it). */
  estimateGas?(tx: { to: string; data: string; value: bigint; chainId: bigint }): Promise<bigint>;
}

/**
 * Ceiling on the gas an approved transaction may use. The gas limit is never
 * taken from the caller in keystore mode (the owner did not approve it): it is
 * estimated here, padded 20%, and refused above this cap. The largest DeXe
 * write — a full DAO deploy — stays well under it.
 */
export const APPROVED_GAS_CAP = 30_000_000n;

export interface ApprovedSignerDeps {
  store: ApprovalStore;
  /** Build a signing wallet for the decrypted key (provider, ledger recorder). Called per send; never cached. */
  connect(privateKey: string): SendCapable;
  /** The per-(chain, sender) broadcast queue (H-12 nonce guard). */
  lock<T>(task: () => Promise<T>): Promise<T>;
}

/** What a caller asks the ApprovedSigner to send. No gasLimit: see APPROVED_GAS_CAP. */
export interface ApprovedTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/**
 * The only object that ever holds a decrypted keystore key, and the only way
 * one is used: it signs EXACTLY the approved transactions, in the approved
 * order, once each.
 *
 * The first transaction that differs in any way — another recipient, value,
 * byte, chain, an extra step, a reordering — drops the key and revokes the
 * approval before anything is signed; the caller gets
 * {@link ApprovalDeviationError}. The key is also dropped when the batch is
 * finished, revoked, superseded or expires (the store calls `drop()`).
 */
export class ApprovedSigner implements KeyHolder {
  /** ES private: not reachable by property access, Object.keys, JSON or spread. */
  #key: string | null;
  private cursor = 0;

  constructor(
    readonly approvalId: string,
    readonly address: string,
    privateKey: string,
    readonly chainId: number,
    private readonly expected: readonly ExpectedTx[],
    private readonly deps: ApprovedSignerDeps,
  ) {
    this.#key = privateKey;
  }

  /** KeyHolder: forget the key. Idempotent. */
  drop(): void {
    this.#key = null;
  }

  get active(): boolean {
    return this.#key !== null;
  }

  /** Never serialize or print key material, even by accident. */
  toJSON(): string {
    return "[ApprovedSigner redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ApprovedSigner { approvalId: ${this.approvalId}, address: ${this.address}, key: [redacted] }`;
  }

  /** Transactions approved but not yet sent. */
  get remaining(): number {
    return this.expected.length - this.cursor;
  }

  /** Sign + broadcast the next approved transaction. Anything else revokes the approval. */
  async send(tx: ApprovedTx): Promise<TransactionResponse> {
    if (this.#key === null) {
      throw new ApprovalDeviationError(
        "This approval is no longer active (used, revoked, superseded or expired) — nothing was signed.",
      );
    }
    const exp = this.expected[this.cursor];
    const deviation =
      tx.chainId !== this.chainId
        ? `chain ${tx.chainId} is not the approved chain ${this.chainId}`
        : !exp
          ? `the approval covered ${this.expected.length} transaction(s) and all were sent`
          : !matchesExpected(exp, tx)
            ? `transaction ${this.cursor + 1} differs from what the owner approved (to / value / calldata)`
            : null;
    if (deviation) {
      this.revoke(`deviation: ${deviation}`);
      throw new ApprovalDeviationError(
        `Refused to sign: ${deviation}. The approval was revoked and the key dropped; nothing further is signed ` +
          `under it. Re-run the call to request a fresh approval for what you actually want to send.`,
      );
    }
    const wallet = this.deps.connect(this.#key);
    const req = { to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), chainId: BigInt(tx.chainId) };
    let gasLimit: bigint | undefined;
    if (wallet.estimateGas) {
      const est = await wallet.estimateGas(req);
      gasLimit = (est * 12n) / 10n;
      if (gasLimit > APPROVED_GAS_CAP) {
        this.revoke(`gas estimate ${est} is above the ${APPROVED_GAS_CAP} cap`);
        throw new ApprovalDeviationError(
          `Refused to sign: the gas estimate (${est}) is above the ${APPROVED_GAS_CAP} cap for an approved transaction. ` +
            "The approval was revoked; nothing was signed.",
        );
      }
    }
    const sent = await this.deps.lock(() => wallet.sendTransaction({ ...req, ...(gasLimit ? { gasLimit } : {}) }));
    this.cursor += 1;
    return sent;
  }

  /** Record that step `index` landed (page progress, dexe_tx_approval_status). */
  landed(index: number, txHash: string): void {
    this.deps.store.markLanded(this.approvalId, index, txHash);
  }

  /** All approved steps sent → consumed; otherwise the unsent remainder is revoked. Drops the key. */
  finish(): void {
    if (this.cursor >= this.expected.length) this.deps.store.finish(this.approvalId);
    else this.revoke(`only ${this.cursor} of ${this.expected.length} approved transaction(s) were sent`);
    this.drop();
  }

  /** Abort: drop the key, revoke the approval, remember what landed for the next page of this flow. */
  revoke(reason: string, landed: Array<{ label: string; txHash: string }> = []): void {
    this.drop();
    this.deps.store.revoke(this.approvalId, reason, landed);
  }
}
