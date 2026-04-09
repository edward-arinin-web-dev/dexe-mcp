import { JsonRpcProvider } from "ethers";
import type { DexeConfig } from "./config.js";

/**
 * Lazy ethers v6 provider factory. Gov tools that need an RPC endpoint call
 * `requireProvider()`; tools that don't (decode_calldata, list_gov_contract_types)
 * never touch this module. Single-shared-provider per process.
 */
export class RpcProvider {
  private provider: JsonRpcProvider | null = null;

  constructor(private readonly config: DexeConfig) {}

  requireProvider(): JsonRpcProvider {
    if (!this.config.rpcUrl) {
      throw new Error(
        "DEXE_RPC_URL is not set. This tool requires a JSON-RPC endpoint — add DEXE_RPC_URL to the MCP env block.",
      );
    }
    if (!this.provider) {
      this.provider = new JsonRpcProvider(this.config.rpcUrl);
    }
    return this.provider;
  }
}
