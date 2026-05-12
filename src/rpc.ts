import { JsonRpcProvider } from "ethers";
import { resolveChain, type DexeConfig } from "./config.js";

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

  /** Returns the resolved chain id (after applying the default). Cheap. */
  resolveChainId(chainId?: number): number {
    return resolveChain(this.config, chainId).chainId;
  }
}
