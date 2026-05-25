import type { DexeConfig } from "../config.js";

/**
 * Signer broadcast guards. A single `runBroadcastGuards` chains opt-in checks
 * that run **inside `dexe_tx_send` before `wallet.sendTransaction()`**. Each
 * guard is a no-op when its env var is unset, so the default (calldata) posture
 * is unchanged. They only bite once a `DEXE_PRIVATE_KEY` is configured and a
 * broadcast is attempted.
 *
 *   B6  destination allowlist  — `DEXE_SIGNER_ALLOWLIST`
 *   B7  value cap              — `DEXE_SIGNER_MAX_VALUE_WEI`
 */

/** Transaction about to be broadcast. `from`/`chainId` come from the resolved signer. */
export interface BroadcastTx {
  to: string;
  data: string;
  /** Wei value as decimal string. */
  value: string;
  chainId: number;
  /** Signer address — used as the `from` for the B9 eth_call. */
  from: string;
}

/** Thrown when a guard refuses a broadcast. `guard` is the backlog id (B6/B7/B9/B10). */
export class BroadcastGuardError extends Error {
  constructor(
    readonly guard: string,
    message: string,
  ) {
    super(message);
    this.name = "BroadcastGuardError";
  }
}

export async function runBroadcastGuards(
  tx: BroadcastTx,
  cfg: DexeConfig,
): Promise<void> {
  // ---- B6: destination allowlist ----------------------------------------
  if (cfg.signerAllowlist && cfg.signerAllowlist.length > 0) {
    const to = tx.to.toLowerCase();
    if (!cfg.signerAllowlist.includes(to)) {
      throw new BroadcastGuardError(
        "B6",
        `Destination ${tx.to} is not in DEXE_SIGNER_ALLOWLIST (${cfg.signerAllowlist.length} allowed). ` +
          `Refusing to broadcast.`,
      );
    }
  }

  // ---- B7: value cap ----------------------------------------------------
  if (cfg.signerMaxValueWei !== undefined) {
    const v = BigInt(tx.value);
    if (v > cfg.signerMaxValueWei) {
      throw new BroadcastGuardError(
        "B7",
        `Value ${v.toString()} wei exceeds DEXE_SIGNER_MAX_VALUE_WEI cap of ${cfg.signerMaxValueWei.toString()} wei. ` +
          `Refusing to broadcast.`,
      );
    }
  }
}
