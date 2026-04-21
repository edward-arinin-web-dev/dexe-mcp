import { JsonRpcProvider, Wallet } from "ethers";
import type { DexeConfig } from "../config.js";

export class SignerManager {
  private wallet: Wallet | null = null;
  private readonly key: string | undefined;
  private readonly rpcUrl: string | undefined;

  constructor(config: DexeConfig) {
    this.key = config.privateKey;
    this.rpcUrl = config.rpcUrl;
  }

  hasSigner(): boolean {
    return !!this.key;
  }

  getAddress(): string {
    return this.requireSigner().address;
  }

  requireSigner(): Wallet {
    if (!this.key) {
      throw new Error(
        "DEXE_PRIVATE_KEY not set. Configure it in MCP server env to enable transaction signing.",
      );
    }
    if (!this.wallet) {
      if (!this.rpcUrl) {
        throw new Error("DEXE_RPC_URL required when DEXE_PRIVATE_KEY is set.");
      }
      const provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(this.key, provider);
    }
    return this.wallet;
  }
}
