import { JsonRpcProvider } from "ethers";
import { resolveChain, type DexeConfig } from "./config.js";
import type { EnvGuardResult } from "./lib/requireEnv.js";
import { safeErrorMessage } from "./lib/redact.js";

/**
 * Transport-layer failures (rate limits, timeouts, DNS, 5xx, network detect) —
 * as opposed to contract reverts (CALL_EXCEPTION), which are legitimate results
 * a caller may branch on and must pass through untouched.
 */
const TRANSPORT_ERR_RE =
  /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|rate.?limit|\b429\b|\b50[234]\b|could not detect network|SERVER_ERROR|NETWORK_ERROR|TIMEOUT|failed to fetch|fetch failed/i;

function isTransportError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "TIMEOUT" || code === "SERVER_ERROR" || code === "NETWORK_ERROR") return true;
  if (code === "CALL_EXCEPTION") return false; // a real revert — never annotate
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSPORT_ERR_RE.test(msg);
}

const PUBLIC_RPC_HINT =
  "\n\n[hint] this call used the shared PUBLIC BSC RPC, which rate-limits and can be flaky. " +
  "For reliability set your own endpoint in .env — DEXE_RPC_URL_MAINNET (chain 56) / " +
  "DEXE_RPC_URL_TESTNET (chain 97), e.g. an Alchemy / QuickNode / Ankr URL — then restart " +
  "(Claude Code: quit + relaunch). Run /dexe-setup for a guided walkthrough.";

/**
 * JsonRpcProvider that annotates *transport* failures with a nudge to configure
 * a private RPC. Used only for chains served by the zero-config public fallback,
 * so users who never set an RPC get an actionable message instead of a bare
 * timeout. In ethers v6 every read perform (`call`, `getBalance`, block reads,
 * multicall's `eth_call`) routes through `send`, so this one override covers the
 * hot read paths. Contract reverts (CALL_EXCEPTION) are excluded and pass through.
 */
class PublicRpcProvider extends JsonRpcProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async send(method: string, params: Array<any>): Promise<any> {
    try {
      return await super.send(method, params);
    } catch (err) {
      if (isTransportError(err)) {
        const base = safeErrorMessage(err);
        throw new Error(base.includes("[hint]") ? base : base + PUBLIC_RPC_HINT);
      }
      throw err;
    }
  }
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
      // Wrap with the annotating provider only when this chain is served by the
      // zero-config public fallback — a user-configured RPC gets no false nudge.
      provider = this.config.usingPublicRpcFallback
        ? new PublicRpcProvider(chain.rpcUrl)
        : new JsonRpcProvider(chain.rpcUrl);
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
