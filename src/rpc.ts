import { FetchRequest, JsonRpcProvider, Network } from "ethers";
import { resolveChain, type ChainConfig, type DexeConfig } from "./config.js";
import type { EnvGuardResult } from "./lib/requireEnv.js";
import { redactErrorInPlace, safeErrorMessage } from "./lib/redact.js";

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
  return TRANSPORT_ERR_RE.test(rawMessageForClassification(err));
}

/**
 * The UNREDACTED message, for classification only — never for output.
 *
 * Deliberately not `safeErrorMessage`: redaction rewrites the message to
 * `shortMessage`, which drops the `429` / `timeout` / `50x` token the regex
 * above falls back on when `code` is absent. Redacting here would silently
 * reclassify retryable transport failures as permanent ones.
 *
 * Named rather than inlined so the raw-echo guard in tests can tell "we read
 * this text to make a decision" apart from "we printed this text to a user",
 * which is the case that leaks credentials.
 *
 * raw-error-echo-allowed: classification only — the return value is regex-tested
 * and never emitted; redacting it would drop the token the match depends on.
 */
function rawMessageForClassification(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PUBLIC_RPC_HINT =
  "\n\n[hint] this call used the shared PUBLIC BSC RPC, which rate-limits and can be flaky. " +
  "For reliability set your own endpoint in .env — DEXE_RPC_URL_MAINNET (chain 56) / " +
  "DEXE_RPC_URL_TESTNET (chain 97), e.g. an Alchemy / QuickNode / Ankr URL — then restart " +
  "(Claude Code: quit + relaunch). Run /dexe-setup for a guided walkthrough.";

/** Backoff before retry attempt N (ms). Total worst-case wait ≈ 3.9s. */
const RETRY_DELAYS_MS = [400, 1000, 2500];

/** Attempts per read: 1 on the primary + one per backoff slot (rotating URLs). */
const TOTAL_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ceiling this module budgets against: the timeout a typical MCP client applies
 * to one tool call. Blow through it and the client kills the call with its own
 * generic "request timed out" — the user never sees the actionable message
 * (which URL, which chain, set DEXE_RPC_URL_*) that this release exists to
 * deliver, so a hung endpoint gets QUIETER, not louder.
 */
const CLIENT_TIMEOUT_CEILING_MS = 60_000;

/** Per-request wall clock, in ms, when DEXE_RPC_TIMEOUT_MS is unset/invalid. */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Per-request timeout for every JSON-RPC round trip.
 *
 * ethers' `FetchRequest` defaults to 300_000 ms AND retries inside itself, so a
 * blackholing endpoint (accepts the socket, never answers) parks a single read
 * for ~20 minutes while the MCP client shows nothing but a frozen tool call.
 *
 * The default is sized so the WHOLE retry loop finishes before the client gives
 * up: 10s x 4 attempts + 3.9s backoff ≈ 43.9s, ~16s of headroom under the 60s
 * ceiling above. (The first cut used 15s, i.e. ~63.9s worst case, which the
 * client killed first and turned an explained failure back into a mystery.)
 * `rpcWorstCaseBudgetMs()` below is the arithmetic, pinned by a test.
 *
 * Read per call (not cached) so tests and a future `dexe_doctor` line observe
 * the live value. A garbage value must never make a provider unconstructable —
 * ethers rejects a negative timeout and 0 would expire every request instantly
 * — so anything non-finite or <= 0 falls back to the default (0.30.1 rule: the
 * server never dies on a bad environment variable).
 *
 * Raising DEXE_RPC_TIMEOUT_MS past ~14s re-crosses the ceiling; that is the
 * operator's deliberate escape hatch (slow archive nodes, a host with a longer
 * timeout), not the default anyone gets by accident.
 */
export function rpcTimeoutMs(): number {
  const n = Number(process.env.DEXE_RPC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPC_TIMEOUT_MS;
}

/**
 * Worst-case wall clock for ONE read that never succeeds: every attempt burns
 * its full timeout and every backoff is waited out. Exported so the budget is
 * asserted rather than assumed — the failure it guards against is silent
 * (nobody notices a slow timeout until a user reports a frozen tool call).
 */
export function rpcWorstCaseBudgetMs(): number {
  const backoff = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  return TOTAL_ATTEMPTS * rpcTimeoutMs() + backoff;
}

/** The client-timeout ceiling `rpcWorstCaseBudgetMs()` is sized against (ms). */
export function rpcClientTimeoutCeilingMs(): number {
  return CLIENT_TIMEOUT_CEILING_MS;
}

/**
 * Build the ethers connection explicitly instead of handing `JsonRpcProvider` a
 * bare URL string — a string gets ethers' own 5-minute `FetchRequest` default,
 * and there is no other hook to bound it.
 */
function timedConnection(url: string): FetchRequest {
  const req = new FetchRequest(url);
  req.timeout = rpcTimeoutMs();
  return req;
}

/**
 * JsonRpcProvider with transport-failure resilience (R1):
 *   - retries transport errors (429 / timeout / 5xx / DNS) with backoff, then
 *     rotates through the chain's fallback URLs;
 *   - `eth_sendRawTransaction` is NEVER retried or rotated — resubmitting a
 *     broadcast on flaky transport risks confusing "already known" states; the
 *     composite layer owns re-run semantics for broadcasts;
 *   - contract reverts (CALL_EXCEPTION) keep their `code`/`data` and are thrown
 *     on the first attempt — they are results, not failures;
 *   - every request is bounded by `rpcTimeoutMs()` (a hung endpoint fails fast
 *     as a TIMEOUT, which the retry/rotation logic above already handles);
 *   - EVERY error leaving this class goes through `redactErrorInPlace` — ethers
 *     appends the full request URL to `err.message` on any non-2xx response,
 *     and for a private endpoint that URL carries the operator's API key;
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
    // config always supplies at least one URL; the undefined arm only keeps
    // ethers' own localhost default reachable rather than throwing here.
    const primary = urls[0];
    super(primary ? timedConnection(primary) : undefined, network, { staticNetwork: network });
    this.#urls = urls;
    this.#annotatePublicHint = annotatePublicHint;
  }

  #fallbackAt(i: number): JsonRpcProvider {
    let p = this.#fallbacks[i];
    if (!p) {
      const network = Network.from(this._network.chainId);
      // Fallbacks get the same bounded connection as the primary — an
      // unbounded fallback would re-introduce the 5-minute hang one hop later.
      p = new JsonRpcProvider(timedConnection(this.#urls[i + 1]!), network, {
        staticNetwork: network,
      });
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
    for (let attempt = 0; attempt < TOTAL_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      const fallbackCount = this.#urls.length - 1;
      const useFallback = attempt > 0 && fallbackCount > 0;
      const target = useFallback ? this.#fallbackAt((attempt - 1) % fallbackCount) : undefined;
      try {
        return target
          ? await target.send(method, params)
          : await super.send(method, params);
      } catch (err) {
        // Reverts and other non-transport failures are final — but they still
        // carry the keyed URL in `message`, so they leave redacted too.
        if (!isTransportError(err)) throw redactErrorInPlace(err);
        lastErr = err;
      }
    }
    throw this.#finalize(lastErr);
  }

  #finalize(err: unknown): Error {
    // Classify BEFORE redacting: redaction rewrites `message` to ethers'
    // shortMessage, which can drop the "429"/"timeout" token the classifier
    // falls back on when the error carries no `code`.
    const transport = isTransportError(err);
    const safe = redactErrorInPlace(err);
    if (this.#annotatePublicHint && transport && !safe.message.includes("[hint]")) {
      safe.message += PUBLIC_RPC_HINT;
    }
    return safe;
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
    try {
      const chain = resolveChain(this.config, chainId);
      let provider = this.cache.get(chain.chainId);
      if (!provider) {
        provider = createChainProvider(chain, this.config);
        this.cache.set(chain.chainId, provider);
      }
      return provider;
    } catch (err) {
      // Nothing raw leaves this module: a config/construction failure can quote
      // the configured endpoint, and that endpoint may carry an API key.
      throw redactErrorInPlace(err);
    }
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
