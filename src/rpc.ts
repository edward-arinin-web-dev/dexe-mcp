import { JsonRpcProvider, Network } from "ethers";
import { resolveChain, type ChainConfig, type DexeConfig } from "./config.js";
import type { EnvGuardResult } from "./lib/requireEnv.js";
import { safeErrorMessage } from "./lib/redact.js";

/**
 * Transport-layer failures (rate limits, timeouts, DNS, 5xx, network detect) —
 * as opposed to contract reverts (CALL_EXCEPTION), which are legitimate results
 * a caller may branch on and must pass through untouched.
 */
const TRANSPORT_ERR_RE =
  /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|rate.?limit|\b429\b|\b50[234]\b|could not detect network|SERVER_ERROR|NETWORK_ERROR|TIMEOUT|failed to fetch|fetch failed/i;

export function isTransportError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "TIMEOUT" || code === "SERVER_ERROR" || code === "NETWORK_ERROR") return true;
  if (code === "CALL_EXCEPTION") return false; // a real revert — never annotate/retry
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSPORT_ERR_RE.test(msg);
}

const PUBLIC_RPC_HINT =
  "\n\n[hint] this call used the shared PUBLIC BSC RPC, which rate-limits and can be flaky. " +
  "For reliability set your own endpoint in .env — DEXE_RPC_URL_MAINNET (chain 56) / " +
  "DEXE_RPC_URL_TESTNET (chain 97), e.g. an Alchemy / QuickNode / Ankr URL — then restart " +
  "(Claude Code: quit + relaunch). Run /dexe-setup for a guided walkthrough.";

/** Backoff before retry attempt N (ms). Total worst-case wait ≈ 3.9s. */
const RETRY_DELAYS_MS = [400, 1000, 2500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JsonRpcProvider with transport-failure resilience (R1):
 *   - retries transport errors (429 / timeout / 5xx / DNS) with backoff, then
 *     rotates through the chain's fallback URLs;
 *   - `eth_sendRawTransaction` is NEVER retried or rotated — resubmitting a
 *     broadcast on flaky transport risks confusing "already known" states; the
 *     composite layer owns re-run semantics for broadcasts;
 *   - contract reverts (CALL_EXCEPTION) pass through untouched on the first
 *     attempt — they are results, not failures;
 *   - when the chain is served by the zero-config public fallback, the final
 *     transport failure is annotated with a configure-your-own-RPC hint.
 *
 * In ethers v6 every read (`call`, `getBalance`, receipt polling, multicall's
 * `eth_call`) routes through `send`, so this one override covers all paths.
 */
export class ResilientRpcProvider extends JsonRpcProvider {
  readonly #fallbacks: JsonRpcProvider[] = [];
  readonly #urls: string[];
  readonly #annotatePublicHint: boolean;

  constructor(urls: string[], chainId: number, annotatePublicHint: boolean) {
    // staticNetwork: skip per-call eth_chainId detection — fewer requests
    // against rate-limited public nodes, and the chain id is known from config.
    const network = Network.from(chainId);
    super(urls[0], network, { staticNetwork: network });
    this.#urls = urls;
    this.#annotatePublicHint = annotatePublicHint;
  }

  #fallbackAt(i: number): JsonRpcProvider {
    let p = this.#fallbacks[i];
    if (!p) {
      const network = Network.from(this._network.chainId);
      p = new JsonRpcProvider(this.#urls[i + 1], network, { staticNetwork: network });
      this.#fallbacks[i] = p;
    }
    return p;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async send(method: string, params: Array<any>): Promise<any> {
    // Broadcasts: single attempt, primary URL only (see class doc).
    if (method === "eth_sendRawTransaction") {
      try {
        return await super.send(method, params);
      } catch (err) {
        throw this.#finalize(err);
      }
    }

    // attempt 0 = primary; attempts 1..N alternate across fallback URLs (when
    // present) with backoff. Each URL gets at least one try; the primary gets
    // the retries left over when there are fewer fallbacks than delays.
    let lastErr: unknown;
    const totalAttempts = 1 + RETRY_DELAYS_MS.length;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      const fallbackCount = this.#urls.length - 1;
      const useFallback = attempt > 0 && fallbackCount > 0;
      const target = useFallback ? this.#fallbackAt((attempt - 1) % fallbackCount) : undefined;
      try {
        return target
          ? await target.send(method, params)
          : await super.send(method, params);
      } catch (err) {
        if (!isTransportError(err)) throw err;
        lastErr = err;
      }
    }
    throw this.#finalize(lastErr);
  }

  #finalize(err: unknown): Error {
    if (this.#annotatePublicHint && isTransportError(err)) {
      const base = safeErrorMessage(err);
      return new Error(base.includes("[hint]") ? base : base + PUBLIC_RPC_HINT);
    }
    return err instanceof Error ? err : new Error(safeErrorMessage(err));
  }
}

/**
 * THE provider factory — every module that needs a provider for a resolved
 * chain must come through here (RpcProvider reads, SignerManager broadcasts,
 * dexe_tx_send / dexe_tx_status lookups), so retry + failover + the public-RPC
 * hint behave identically everywhere (the old signer path bypassed both).
 */
export function createChainProvider(chain: ChainConfig, config: DexeConfig): JsonRpcProvider {
  return new ResilientRpcProvider(
    chain.rpcUrls ?? [chain.rpcUrl],
    chain.chainId,
    config.usingPublicRpcFallback,
  );
}

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
      provider = createChainProvider(chain, this.config);
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
        error: safeErrorMessage(err),
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
