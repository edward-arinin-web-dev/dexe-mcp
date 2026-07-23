import { Wallet } from "ethers";
import { resolveChain, type DexeConfig } from "../config.js";
import { createChainProvider } from "../rpc.js";
import { hintFor, type EnvGuardResult } from "./requireEnv.js";

/**
 * Signer registry. The primary key (`DEXE_PRIVATE_KEY`) is the default; the
 * opt-in agent keyring (`DEXE_AGENT_PK_1..16` → signerKey "agent1"…"agent16")
 * backs multi-persona/swarm flows. Keys are chain-agnostic; only the provider
 * differs per chain, so wallets are cached per (signer, chain).
 */
export class SignerManager {
  private readonly cache = new Map<string, Wallet>();
  /** Per-(chain, signer-address) broadcast serialization queue (H-12 nonce guard). */
  private readonly broadcastQueues = new Map<string, Promise<unknown>>();
  private readonly key: string | undefined;
  private readonly agentKeys: Record<string, string>;
  private readonly config: DexeConfig;

  constructor(config: DexeConfig) {
    this.key = config.privateKey;
    this.agentKeys = config.agentKeys ?? {};
    this.config = config;
  }

  /**
   * `signerKey` semantics everywhere in this class:
   *   undefined      → the primary DEXE_PRIVATE_KEY signer
   *   "agent<n>"     → keyring slot (case-insensitive)
   *   an 0x address  → whichever configured key (primary or agent) derives it
   */
  private resolveKey(signerKey?: string): string | undefined {
    if (!signerKey) return this.key;
    const norm = signerKey.trim().toLowerCase();
    const byName = this.agentKeys[norm];
    if (byName) return byName;
    if (norm.startsWith("0x") && norm.length === 42) {
      for (const k of [this.key, ...Object.values(this.agentKeys)]) {
        if (k && new Wallet(k).address.toLowerCase() === norm) return k;
      }
      this.failUnknownSigner(signerKey);
    }
    this.failUnknownSigner(signerKey);
  }

  /** Registered keyring entries (never the keys themselves). */
  listAgents(): Array<{ signerKey: string; address: string }> {
    return Object.entries(this.agentKeys).map(([signerKey, pk]) => ({
      signerKey,
      address: new Wallet(pk).address,
    }));
  }

  hasAgents(): boolean {
    return Object.keys(this.agentKeys).length > 0;
  }

  hasSigner(signerKey?: string): boolean {
    if (!signerKey) return !!this.key;
    try {
      return !!this.resolveKey(signerKey);
    } catch {
      return false;
    }
  }

  /** The config this signer was built from — lets broadcast paths reach the guard env. */
  getConfig(): DexeConfig {
    return this.config;
  }

  /**
   * Address of a configured signer (chain-agnostic — same EOA across chains).
   * Throws if the requested key is not configured.
   */
  getAddress(signerKey?: string): string {
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    return new Wallet(key).address;
  }

  /**
   * Return a signer bound to the requested chain's RPC. When `chainId` is
   * omitted the default chain is used; when `signerKey` is omitted the
   * primary key is used.
   */
  requireSigner(chainId?: number, signerKey?: string): Wallet {
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    const chain = resolveChain(this.config, chainId);
    const cacheKey = `${chain.chainId}:${signerKey ? new Wallet(key).address : "primary"}`;
    let wallet = this.cache.get(cacheKey);
    if (!wallet) {
      // Shared resilient factory (R1): the signer's reads (nonce, gas
      // estimate, receipt polling) get the same retry + URL-rotation + hint
      // behavior as every read tool. Broadcasts themselves are never retried
      // at the transport layer (see ResilientRpcProvider).
      const provider = createChainProvider(chain, this.config);
      wallet = new Wallet(key, provider);
      this.cache.set(cacheKey, wallet);
    }
    return wallet;
  }

  /**
   * Soft variant of `requireSigner` — returns a structured `{error, remediation}`
   * instead of throwing when the key or RPC is missing. Hot tool paths use
   * this so missing env surfaces as a clean MCP error with fix instructions
   * instead of a thrown stack trace.
   */
  trySigner(chainId?: number, signerKey?: string): EnvGuardResult<Wallet> {
    try {
      return { ok: this.requireSigner(chainId, signerKey) };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        remediation: hintFor(["DEXE_PRIVATE_KEY"]),
      };
    }
  }

  /**
   * Sign an arbitrary message (EIP-191 personal_sign) with a configured EOA
   * key. Used for off-chain backend auth (nonce login) — the same opt-in signer
   * surface as `requireSigner`/`dexe_tx_send`, so an AI agent never has to
   * extract the key into its own signing code. Chain-agnostic (no provider
   * needed for message signing). Throws if the key is not configured.
   */
  async signMessage(message: string, signerKey?: string): Promise<string> {
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    return new Wallet(key).signMessage(message);
  }

  /**
   * Serialize broadcasts per (chain, signer address). Concurrent
   * `dexe_tx_send` / composite-flow calls that share ONE EOA would otherwise
   * invoke `sendTransaction` at the same time, both read the same pending
   * nonce, and one transaction is silently dropped (or hangs until timeout) —
   * H-12. Distinct agent signers have independent nonces, so they get
   * independent queues and still broadcast concurrently. Task failures are
   * isolated so a queue keeps flowing.
   */
  async withBroadcastLock<T>(chainId: number, task: () => Promise<T>, signerAddress?: string): Promise<T> {
    const queueKey = `${chainId}:${(signerAddress ?? "primary").toLowerCase()}`;
    const prev = this.broadcastQueues.get(queueKey) ?? Promise.resolve();
    const run = prev.then(
      () => task(),
      () => task(),
    );
    this.broadcastQueues.set(
      queueKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private failNoKey(): never {
    const dexeEnvKeys = Object.keys(process.env).filter(k => k.startsWith("DEXE_")).join(", ");
    throw new Error(
      `DEXE_PRIVATE_KEY not set. Available DEXE_* env vars: [${dexeEnvKeys}]. Configure it in MCP server env to enable transaction signing.`,
    );
  }

  private failUnknownSigner(signerKey: string): never {
    const known = Object.keys(this.agentKeys);
    throw new Error(
      `Unknown signerKey "${signerKey}". Configured keyring: ${
        known.length ? known.join(", ") : "(empty — set DEXE_AGENT_PK_1..16 or AGENT_PK_1..16 / AGENT_FUNDER_PK)"
      }; the primary signer is selected by omitting signerKey.`,
    );
  }
}
