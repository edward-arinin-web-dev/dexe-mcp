import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { simulateCalldata } from "../tools/simulate.js";
import { mapDeployRevert, type DeployRevertVerdict } from "./deployRevertMap.js";

/**
 * Pre-sign simulation for the GovPool deploy — the one on-chain check no
 * offline guard can replace. The DAO deploy is a SINGLE independent payload,
 * so (unlike the dependent multi-step composites, where B9 is rightly skipped)
 * an eth_call against live state proves the exact calldata the wallet is about
 * to sign would not revert: factory paused, SphereX rejection, protocol
 * upgrades, preset drift — all caught here before gas is spent.
 *
 * Policy (user decision, 2026-07-11):
 *   - a GENUINE revert always blocks the broadcast (fail-closed);
 *   - a transport/RPC failure returns "unavailable" and callers proceed with a
 *     warning (fail-open) — an infra hiccup must not wedge a valid deploy.
 *
 * `from` MUST be the deployer: predictGovAddresses salts with deployer+name,
 * and the factory re-derives the same addresses during the deploy, so a sim
 * from a different caller exercises different state.
 */

export interface DeploySimVerdict {
  status: "ok" | "reverted" | "unavailable";
  /** Present when status is "ok". */
  gasEstimate?: string;
  /** Raw revert reason (status "reverted") or transport error (status "unavailable"). */
  reason?: string;
  /** Knowledge-base classification when status is "reverted". */
  known?: DeployRevertVerdict;
  /** One-line human/model-facing summary, ready to embed in a note. */
  summary: string;
}

export async function simulateDeployGovPool(args: {
  to: string;
  data: string;
  deployer: string;
  chainId: number;
  config: DexeConfig;
}): Promise<DeploySimVerdict> {
  // Same chain-view trick as B9 (broadcastGuards.ts): simulateCalldata resolves
  // its provider via the config's default chain, so hand it a view whose
  // default IS the target chain.
  const simCfg: DexeConfig =
    args.chainId === args.config.defaultChainId
      ? args.config
      : { ...args.config, defaultChainId: args.chainId, chainId: args.chainId };
  const rpc = new RpcProvider(simCfg);

  let sim;
  try {
    sim = await simulateCalldata(rpc, { to: args.to, data: args.data, from: args.deployer });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      status: "unavailable",
      reason,
      summary: `⚠️ pre-sign simulation unavailable (${reason}) — proceeding unverified`,
    };
  }

  if (sim.success) {
    const gas = sim.gasEstimate ? `, gas ~${sim.gasEstimate}` : "";
    return {
      status: "ok",
      gasEstimate: sim.gasEstimate,
      summary: `✓ deploy simulated OK against live chain ${args.chainId} state${gas}`,
    };
  }

  if (sim.networkError) {
    return {
      status: "unavailable",
      reason: sim.revertReason,
      summary: `⚠️ pre-sign simulation unavailable (RPC transport error) — proceeding unverified`,
    };
  }

  const known = mapDeployRevert(sim.revertReason);
  return {
    status: "reverted",
    reason: sim.revertReason,
    known,
    summary:
      `✗ deploy WOULD REVERT on chain ${args.chainId} (no gas was spent). ` +
      `Reason: ${sim.revertReason ?? "(no reason string)"} [${known.slug}]. ${known.cause} Fix: ${known.fix}`,
  };
}
