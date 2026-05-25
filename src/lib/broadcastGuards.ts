import pLimit from "p-limit";
import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { simulateCalldata } from "../tools/simulate.js";

/**
 * Signer broadcast guards. A single `runBroadcastGuards` chains opt-in checks
 * that run before every `wallet.sendTransaction()` — both the single-shot
 * `dexe_tx_send` and the shared composite-flow loop (`sendOrCollect`). Each
 * guard is a no-op when its env var is unset, so the default (calldata) posture
 * is unchanged. They only bite once a `DEXE_PRIVATE_KEY` is configured and a
 * broadcast is attempted.
 *
 *   B6  destination allowlist  — `DEXE_SIGNER_ALLOWLIST`
 *   B7  value cap              — `DEXE_SIGNER_MAX_VALUE_WEI`
 *   B9  auto-simulation        — eth_call preflight, abort on revert
 *   B10 rate limit             — `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN`
 *
 * B6/B7/B10 are stateless and safe on any broadcast. B9 simulates against
 * *current* chain state, so it is unsound for dependent multi-step sequences
 * (e.g. approve→deposit→createProposal): step N would be simmed before step
 * N-1 is mined and falsely "revert". Composite flows therefore pass
 * `skipSimulation: true`; the security-relevant guards still apply.
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

// ---- B10 sliding-window state -------------------------------------------
// Module-scoped so the window survives across tool calls for the process
// lifetime. Serialized through p-limit(1) so concurrent broadcasts cannot
// race the prune/append on the timestamp array.
const rateLimitGate = pLimit(1);
const broadcastTimestamps: number[] = [];

/** Reset the B10 window. Test-only. */
export function __resetBroadcastWindow(): void {
  broadcastTimestamps.length = 0;
}

export async function runBroadcastGuards(
  tx: BroadcastTx,
  cfg: DexeConfig,
  opts?: { skipSimulation?: boolean },
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
  // Skipped for dependent multi-step composite flows (see header).
  if (!opts?.skipSimulation) {
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
    // Only a *genuine* revert aborts. A transport/RPC failure (sim.networkError)
    // means the call never ran — fail open rather than wedge a valid broadcast
    // and mislabel an infra hiccup as a revert.
    if (!sim.success && !sim.networkError) {
      throw new BroadcastGuardError(
        "B9",
        `Pre-broadcast simulation (eth_call) reverted: ${sim.revertReason ?? "unknown"}. ` +
          `Aborting before spending gas.`,
      );
    }
  }

  // ---- B10: rate limit (N per rolling 60s) ------------------------------
  if (cfg.signerMaxBroadcastsPerMin !== undefined) {
    const cap = cfg.signerMaxBroadcastsPerMin;
    await rateLimitGate(() => {
      const now = Date.now();
      const cutoff = now - 60_000;
      while (broadcastTimestamps.length > 0 && broadcastTimestamps[0]! < cutoff) {
        broadcastTimestamps.shift();
      }
      if (broadcastTimestamps.length >= cap) {
        const oldest = broadcastTimestamps[0]!;
        const waitS = Math.ceil((oldest + 60_000 - now) / 1000);
        throw new BroadcastGuardError(
          "B10",
          `Broadcast rate limit reached: ${cap} per minute (DEXE_SIGNER_MAX_BROADCASTS_PER_MIN). ` +
            `Retry in ~${waitS}s.`,
        );
      }
      broadcastTimestamps.push(now);
    });
  }
}
