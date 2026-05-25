import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { simulateCalldata } from "../tools/simulate.js";

/**
 * Signer broadcast guards. A single `runBroadcastGuards` chains opt-in checks
 * that run **inside `dexe_tx_send` before `wallet.sendTransaction()`**. Each
 * guard is a no-op when its env var is unset, so the default (calldata) posture
 * is unchanged. They only bite once a `DEXE_PRIVATE_KEY` is configured and a
 * broadcast is attempted.
 *
 *   B6  destination allowlist  — `DEXE_SIGNER_ALLOWLIST`
 *   B7  value cap              — `DEXE_SIGNER_MAX_VALUE_WEI`
 *   B9  auto-simulation        — eth_call preflight, abort on revert
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

  // ---- B9: auto-simulation (eth_call preflight) -------------------------
  // Reuses the shared sim core; aborts before spending gas if the call would
  // revert. Must run against the SAME chain the broadcast targets — otherwise
  // the preflight is meaningless (sims one chain, sends to another). The shared
  // `simulateCalldata` resolves its provider via the config's default chain and
  // takes no chainId, so hand it a config view whose default IS `tx.chainId`.
  const simCfg: DexeConfig =
    tx.chainId === cfg.defaultChainId
      ? cfg
      : { ...cfg, defaultChainId: tx.chainId, chainId: tx.chainId };
  const rpc = new RpcProvider(simCfg);
  const sim = await simulateCalldata(rpc, {
    to: tx.to,
    data: tx.data,
    value: tx.value,
    from: tx.from,
  });
  if (!sim.success) {
    throw new BroadcastGuardError(
      "B9",
      `Pre-broadcast simulation (eth_call) reverted: ${sim.revertReason ?? "unknown"}. ` +
        `Aborting before spending gas.`,
    );
  }
}
