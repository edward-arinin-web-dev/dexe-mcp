import { JsonRpcProvider } from "ethers";
import { resolveChain, type DexeConfig } from "./config.js";
import type { EnvGuardResult } from "./lib/requireEnv.js";

/**
 * Lazy ethers v6 provider factory. Gov tools that need an RPC endpoint call
 * `requireProvider(chainId?)`; tools that don't (decode_calldata,
 * list_gov_contract_types) never touch this module.
 *
 * One cached provider per chain id. `chainId` is optional — when omitted the
 * configured default chain is used.
 */
export class RpcProvider {
  private readonly cache = new Map<number, JsonRpcProvider>();

  constructor(private readonly config: DexeConfig) {}

  requireProvider(chainId?: number): JsonRpcProvider {
    const chain = resolveChain(this.config, chainId);
    let provider = this.cache.get(chain.chainId);
    if (!provider) {
      provider = new JsonRpcProvider(chain.rpcUrl);
      this.cache.set(chain.chainId, provider);
    }
    return provider;
  }

  /**
   * Soft variant of `requireProvider` — returns a structured
   * `{error, remediation}` instead of throwing when no RPC is configured
   * for the requested chain. Hot read paths use this so missing env surfaces
   * as a clean MCP error with fix instructions instead of a thrown stack.
   */
  tryProvider(chainId?: number): EnvGuardResult<JsonRpcProvider> {
    try {
      return { ok: this.requireProvider(chainId) };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        remediation:
          "Set DEXE_RPC_URL_TESTNET / DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_<chainId> in .env, " +
          "then restart the MCP server (Claude Code: quit + relaunch). Run dexe_doctor to verify.",
      };
    }
  }

  /** Returns the resolved chain id (after applying the default). Cheap. */
  resolveChainId(chainId?: number): number {
    return resolveChain(this.config, chainId).chainId;
  }
}
