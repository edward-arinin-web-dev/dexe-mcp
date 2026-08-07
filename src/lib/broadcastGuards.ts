import pLimit from "p-limit";
import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { simulateCalldata } from "../tools/simulate.js";
import { scanForbiddenCalldata, forbiddenBroadcastError } from "./dangerousSelectors.js";

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
 *   B11 wrong-chain broadcast  — (always) payload chain vs send chain + code at `to`
 *   B12 GovUserKeeper denylist — (always) refuse denylisted selectors, leading or embedded
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
  /**
   * The `chainId` stamped on the built payload, when the caller supplied it
   * separately from the chain it is being broadcast on. B11 refuses a mismatch.
   */
  payloadChainId?: number;
}

/** Thrown when a guard refuses a broadcast. `guard` is the backlog id (B6/B7/B9/B10/B11/B12). */
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

/**
 * B6 + B7: the stateless destination-allowlist and value-cap checks. Unlike B9
 * (sim) and B10 (rate limit), these are safe to apply to ANY signed/queued tx —
 * including a Safe-TX-Service propose (L-1), which previously signed and queued
 * without any guard.
 */
export function assertAllowlistAndValueCap(tx: { to: string; value: string }, cfg: DexeConfig): void {
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

/**
 * B11: wrong-chain broadcast. Builders stamp a `chainId` on every payload, but
 * nothing stopped that payload from being handed to a send on another chain —
 * where the same address is a different contract, or nobody at all. Two checks,
 * both fatal:
 *
 *   a. payload chain vs send chain — a payload built for 56 broadcast on 97 is
 *      never intentional, so name both chains and refuse;
 *   b. no contract code at `to` on the chain we are about to send on.
 *
 * (b) is skipped for a plain value transfer: paying an EOA is legitimate, and an
 * EOA has no code by definition. It is also invisible to B9 — `eth_call` to a
 * codeless address SUCCEEDS with empty returndata, so the sim preflight can
 * never catch this class. A `getCode` failure fails OPEN (same posture as B9's
 * networkError): a flaky RPC must not wedge a valid broadcast.
 */
export async function assertChainCoherence(
  tx: { to: string; data: string; chainId: number; payloadChainId?: number },
  getCode: (to: string) => Promise<string>,
): Promise<void> {
  if (tx.payloadChainId !== undefined && tx.payloadChainId !== tx.chainId) {
    throw new BroadcastGuardError(
      "B11",
      `Payload was built for chain ${tx.payloadChainId} but you are broadcasting on chain ${tx.chainId}. ` +
        `Refusing: an address holds a different contract (or none) on each chain. ` +
        `Rebuild the payload with chainId ${tx.chainId}, or send it with chainId ${tx.payloadChainId}.`,
    );
  }

  if (!tx.data || tx.data === "0x") return; // value transfer to an EOA — no code expected

  let code: string;
  try {
    code = await getCode(tx.to);
  } catch {
    return; // no RPC for this chain, or a transport hiccup — fail open, never wedge
  }
  // "0x" is the canonical empty-code answer; tolerate providers that pad it.
  if (/^0x0*$/i.test(code)) {
    throw new BroadcastGuardError(
      "B11",
      `Destination ${tx.to} has no contract code on chain ${tx.chainId} — you are probably ` +
        `broadcasting a payload built for a different chain. Refusing to send calldata to an ` +
        `address that holds no code here.`,
    );
  }
}

export async function runBroadcastGuards(
  tx: BroadcastTx,
  cfg: DexeConfig,
  opts?: { skipSimulation?: boolean },
): Promise<void> {
  // ---- B6 + B7: destination allowlist & value cap -----------------------
  assertAllowlistAndValueCap(tx, cfg);

  // ---- B12: GovUserKeeper denylist --------------------------------------
  // First, because it is free and unconditional: no config enables it, nothing
  // overrides it. It lives HERE rather than at each call site because that is
  // what failed — 0.32.0 added the check at dexe_tx_send, and review then
  // proved the identical drain calldata still reached the chain through
  // dexe_proposal_create's `custom` type, which copies caller-supplied action
  // data through verbatim. Every broadcast path already funnels through this
  // function, so putting it here makes the "hard block, no override" claim
  // true by construction instead of by everyone remembering.
  assertNoForbiddenCalldata(tx);

  // ---- B11: wrong-chain broadcast ---------------------------------------
  // Before B9: the chain compare is free, and the getCode probe answers a
  // question the sim structurally cannot (eth_call to a codeless address
  // succeeds). Provider is built lazily inside the probe, so a value transfer
  // costs no RPC at all.
  await assertChainCoherence(tx, (to) => new RpcProvider(cfg).requireProvider(tx.chainId).getCode(to));

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

/**
 * B12 — refuse calldata carrying a denylisted `GovUserKeeper` selector, whether
 * it leads the payload or is embedded in an argument (how a proposal action
 * carries one). Unconditional: no env enables it, nothing overrides it.
 */
export function assertNoForbiddenCalldata(tx: BroadcastTx): void {
  const hit = scanForbiddenCalldata(tx.data ?? "0x");
  if (hit) throw new BroadcastGuardError("B12", forbiddenBroadcastError(hit, tx.to));
}
