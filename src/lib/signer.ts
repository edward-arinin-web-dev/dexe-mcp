import { JsonRpcProvider, Wallet } from "ethers";
import { resolveChain, type DexeConfig } from "../config.js";
import { hintFor, type EnvGuardResult } from "./requireEnv.js";

/**
 * Per-chain signer cache. The private key is chain-agnostic; only the
 * provider differs per chain.
 */
export class SignerManager {
  private readonly cache = new Map<number, Wallet>();
  private readonly key: string | undefined;
  private readonly config: DexeConfig;

  constructor(config: DexeConfig) {
    this.key = config.privateKey;
    this.config = config;
  }

  hasSigner(): boolean {
    return !!this.key;
  }

  /** The config this signer was built from — lets broadcast paths reach the guard env. */
  getConfig(): DexeConfig {
    return this.config;
  }

  /**
   * Address of the configured signer (chain-agnostic — same EOA across chains).
   * Throws if no `DEXE_PRIVATE_KEY` is set.
   */
  getAddress(): string {
    if (!this.key) this.failNoKey();
    return new Wallet(this.key).address;
  }

  /**
   * Return a signer bound to the requested chain's RPC. When `chainId` is
   * omitted the default chain is used.
   */
  requireSigner(chainId?: number): Wallet {
    if (!this.key) this.failNoKey();
    const chain = resolveChain(this.config, chainId);
    let wallet = this.cache.get(chain.chainId);
    if (!wallet) {
      const provider = new JsonRpcProvider(chain.rpcUrl);
      wallet = new Wallet(this.key, provider);
      this.cache.set(chain.chainId, wallet);
    }
    return wallet;
  }

  /**
   * Soft variant of `requireSigner` — returns a structured `{error, remediation}`
   * instead of throwing when the key or RPC is missing. Hot tool paths use
   * this so missing env surfaces as a clean MCP error with fix instructions
   * instead of a thrown stack trace.
   */
  trySigner(chainId?: number): EnvGuardResult<Wallet> {
    try {
      return { ok: this.requireSigner(chainId) };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        remediation: hintFor(["DEXE_PRIVATE_KEY"]),
      };
    }
  }

  private failNoKey(): never {
    const dexeEnvKeys = Object.keys(process.env).filter(k => k.startsWith("DEXE_")).join(", ");
    throw new Error(
      `DEXE_PRIVATE_KEY not set. Available DEXE_* env vars: [${dexeEnvKeys}]. Configure it in MCP server env to enable transaction signing.`,
    );
  }
}
