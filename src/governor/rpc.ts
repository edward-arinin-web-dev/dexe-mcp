import type { JsonRpcProvider } from "ethers";
import { ResilientRpcProvider } from "../rpc.js";
import { safeErrorMessage } from "../lib/redact.js";
import type { GovernorConfig } from "./loader.js";

/**
 * Zero-config RPC for the chains the Governor fixtures live on.
 *
 * `src/config.ts`'s `PUBLIC_RPC_FALLBACK` covers only BSC (56 / 97) and is
 * additionally gated on "no chain configured at all", so a user who set
 * `DEXE_RPC_URL_MAINNET` for DeXe still had NO endpoint for Ethereum or
 * Optimism — every `dexe_gov_*` read failed on first call with a remediation
 * string that named only the BSC variables.
 *
 * Ordered **archive-capable first**: Governor reads are historical by
 * construction (`getPastVotes(account, snapshot)`, `quorum(snapshotBlock)`,
 * `dexe_gov_simulate_vote_impact` always reads quorum at the proposal's
 * snapshot block). Verified 2026-09-11 against each endpoint with
 * `eth_chainId` + an `eth_getBalance` at block 16,000,000 (chain 1) /
 * 100,000,000 (chain 10):
 *   - eth.drpc.org, eth.merkle.io, optimism.drpc.org, mainnet.optimism.io → archive OK
 *   - both publicnode hosts → HTTP 403 `-32602 "Archive requests require a
 *     personal token"` (latest-block reads still work, hence last place)
 *   - eth.llamarpc.com → HTTP 525, HTML not JSON-RPC. Do NOT add it back.
 *
 * Endpoints churn; keep the list short and re-probe when it is edited.
 */
export const EXTRA_PUBLIC_RPC: Record<number, string[]> = {
  1: ["https://eth.drpc.org", "https://eth.merkle.io", "https://ethereum-rpc.publicnode.com"],
  10: ["https://optimism.drpc.org", "https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
};

/** Structural view of `RpcProvider` — keeps this module stubbable in tests. */
export interface TryProviderLike {
  tryProvider(chainId?: number): { ok: JsonRpcProvider } | { error: string; remediation: string };
}

export type GovernorProviderResult =
  | { ok: JsonRpcProvider; fallback: false }
  | { ok: JsonRpcProvider; fallback: true; note: string }
  | { error: string };

/** One provider per chain for the whole session — ethers providers hold timers. */
const fallbackCache = new Map<number, JsonRpcProvider>();
const warnedChains = new Set<number>();

/** Test seam — the module-level cache would otherwise leak across cases. */
export function resetGovernorProviderCache(): void {
  fallbackCache.clear();
  warnedChains.clear();
}

function publicFallbackDisabled(): boolean {
  return process.env.DEXE_DISABLE_PUBLIC_RPC?.trim() === "1";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function noRpcError(cfg: GovernorConfig): string {
  const urls = EXTRA_PUBLIC_RPC[cfg.chainId];
  const example = urls?.[0] ?? "https://<your-archive-endpoint>";
  const why = publicFallbackDisabled()
    ? "the built-in public fallback is off (DEXE_DISABLE_PUBLIC_RPC=1)"
    : `there is no built-in public fallback for chain ${cfg.chainId}`;
  return (
    `No RPC configured for chain ${cfg.chainId}, where the "${cfg.id}" Governor lives ` +
    `(${cfg.governorAddress}), and ${why}. ` +
    `Set DEXE_RPC_URL_${cfg.chainId}=<your endpoint> in .env (e.g. ${example}), then restart the MCP server. ` +
    `DeXe's BSC vars (DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET) do not cover chain ${cfg.chainId}. ` +
    `See docs/GOVERNOR.md "Runtime RPC setup".`
  );
}

/**
 * `rpc.tryProvider` plus an opt-out public fallback for the governor chains.
 *
 * The fallback provider is built by `ResilientRpcProvider` — the same class
 * `createChainProvider` uses — so the bounded `FetchRequest` timeout, retry,
 * URL rotation and error redaction are identical to a configured chain. A bare
 * `new JsonRpcProvider(url)` would re-open the 5-minute-hang bug class that
 * 0.30.4 shipped to kill.
 *
 * `annotatePublicHint` is deliberately `false`: `PUBLIC_RPC_HINT` in src/rpc.ts
 * is worded for BSC and would tell a chain-1 user to set `DEXE_RPC_URL_MAINNET`.
 * The chain-aware advice lives in `note` / `governorReadError` instead.
 */
export function governorProvider(rpc: TryProviderLike, cfg: GovernorConfig): GovernorProviderResult {
  const pr = rpc.tryProvider(cfg.chainId);
  if (!("error" in pr)) return { ok: pr.ok, fallback: false };

  const urls = EXTRA_PUBLIC_RPC[cfg.chainId];
  if (!urls || urls.length === 0 || publicFallbackDisabled()) {
    return { error: noRpcError(cfg) };
  }

  let provider = fallbackCache.get(cfg.chainId);
  if (!provider) {
    provider = new ResilientRpcProvider(urls, cfg.chainId, false);
    fallbackCache.set(cfg.chainId, provider);
  }
  if (!warnedChains.has(cfg.chainId)) {
    warnedChains.add(cfg.chainId);
    console.error(
      `[dexe-mcp] no RPC configured for chain ${cfg.chainId}; using the shared public endpoint ` +
        `${hostOf(urls[0]!)} for dexe_gov_* reads. Set DEXE_RPC_URL_${cfg.chainId} for reliability.`,
    );
  }
  return {
    ok: provider,
    fallback: true,
    note:
      `public fallback for chain ${cfg.chainId} (${hostOf(urls[0]!)}) — rate-limited, archive history not ` +
      `guaranteed; set DEXE_RPC_URL_${cfg.chainId} for reliability`,
  };
}

/** Adds `{ rpc: note }` to a success payload only when the fallback was used. */
export function rpcNote(pr: GovernorProviderResult): { rpc?: string } {
  return "ok" in pr && pr.fallback ? { rpc: pr.note } : {};
}

const ARCHIVE_REFUSAL_RE =
  /archive|pruned|no state found|missing trie node|state at block .* is (?:not available|pruned)|older than \d+ blocks/i;

/**
 * Turns an RPC's "I am not an archive node" refusal into advice, and redacts
 * everything else. Public endpoints answer latest-block reads and refuse
 * snapshot-block reads, which is exactly the half of the Governor surface that
 * matters — without this the user sees a vendor upsell string and no remedy.
 *
 * raw-error-echo-allowed: classification only — `raw` is regex-tested and never
 * emitted; redaction rewrites the message to `shortMessage`, which drops the
 * "archive"/"pruned" token the match depends on. Only `safe` reaches the user.
 */
export function governorReadError(e: unknown, cfg: GovernorConfig, usedFallback: boolean): string {
  const raw = e instanceof Error ? e.message : String(e);
  const safe = safeErrorMessage(e);
  if (!ARCHIVE_REFUSAL_RE.test(raw)) return safe;
  return (
    `${safe}\n\nReading historical state for ${cfg.id} (chain ${cfg.chainId}) needs an archive node; ` +
    `${usedFallback ? "the public fallback endpoint" : "the configured endpoint"} refused it. ` +
    `Set DEXE_RPC_URL_${cfg.chainId} to an archive endpoint (Alchemy / QuickNode / drpc) and restart. ` +
    `Latest-block reads (dexe_gov_get_state, dexe_gov_has_voted) keep working without one.`
  );
}
