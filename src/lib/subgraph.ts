import type { DexeConfig, SubgraphKind } from "../config.js";
import { DEFAULT_SUBGRAPH_CHAIN_ID, DEFAULTS, SUBGRAPH_KINDS, subgraphEnvVar } from "../config.js";
import { maskUrl, safeErrorMessage } from "./redact.js";

export type { SubgraphKind };

/**
 * Minimal GraphQL fetcher for The Graph subgraphs. Uses global `fetch` (Node
 * 18+). We avoid `graphql-request` as a dep for now — the calls we make are
 * simple enough.
 */
export interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** The endpoint to query, plus the chain it actually indexes. */
export interface ResolvedSubgraph {
  url: string;
  /** Always the chain that was asked for — never a substitute. */
  chainId: number;
}

/**
 * Chains that have an endpoint, ascending. Pass `kind` to narrow to one
 * subgraph; omit it for chains covered by any of the three. Tools use this to
 * tell the user where they CAN look.
 */
export function subgraphChains(config: DexeConfig, kind?: SubgraphKind): number[] {
  const out: number[] = [];
  for (const [chainId, endpoints] of config.subgraphUrls) {
    const has = kind ? !!endpoints[kind] : SUBGRAPH_KINDS.some((k) => !!endpoints[k]);
    if (has) out.push(chainId);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The single entry point for "which subgraph do I query for this chain?".
 *
 * Every subgraph-backed tool must route through here rather than reading
 * `config.subgraphPoolsUrl` & co. Those flat fields carry ONE chain's endpoint
 * (see `DexeConfig.subgraphChainId`), so a tool that reads them while working
 * on another chain returns that other chain's data with no hint that it did —
 * which an agent will then act on. Answering with the wrong chain is worse
 * than not answering, so an unconfigured chain throws.
 *
 * @param chainId chain to query; defaults to the config's default chain.
 */
export function resolveSubgraphUrl(
  config: DexeConfig,
  kind: SubgraphKind,
  chainId?: number,
): ResolvedSubgraph {
  const target = chainId ?? config.defaultChainId;
  const url = config.subgraphUrls.get(target)?.[kind];
  if (url) return { url, chainId: target };

  const available = subgraphChains(config, kind);
  const where =
    available.length > 0
      ? `A ${kind} subgraph IS configured for chain(s): ${available.join(", ")}.`
      : `No ${kind} subgraph is configured for ANY chain.`;
  // Only meaningful when the caller asked for something other than mainnet —
  // saying "mainnet rows would be wrong" while the caller IS on mainnet would
  // be noise.
  const whyStop =
    target === DEFAULT_SUBGRAPH_CHAIN_ID
      ? ""
      : `The DeXe subgraphs index BSC mainnet (${DEFAULT_SUBGRAPH_CHAIN_ID}); answering chain ${target} from a mainnet endpoint would be wrong data, so this read stops here. `;
  const queryMainnet = available.includes(DEFAULT_SUBGRAPH_CHAIN_ID)
    ? `pass chainId: ${DEFAULT_SUBGRAPH_CHAIN_ID} to query BSC mainnet, `
    : "";
  throw new Error(
    `No DeXe ${kind} subgraph is configured for chain ${target}. ${where} ${whyStop}` +
      `Either ${queryMainnet}read chain ${target} on-chain instead with dexe_read_gov_state / dexe_proposal_list / dexe_read_multicall (no subgraph needed), ` +
      `or set ${subgraphEnvVar(kind, target)} to your own indexer endpoint and restart.`,
  );
}

/**
 * Extracts a Graph API key from URLs of the shape
 * `…/api/<key>/subgraphs/id/<id>`. Returns `undefined` for URLs that don't
 * embed a key (e.g. `…/api/subgraphs/id/<id>` — Bearer-only style).
 */
export function extractGraphApiKey(endpoint: string): string | undefined {
  const m = endpoint.match(/\/api\/([0-9a-f]{32,})\/subgraphs\//i);
  return m ? m[1] : undefined;
}

/**
 * Trusted hosts for The Graph's decentralized gateway / Studio. The Graph API
 * key is only meaningful for these; we refuse to attach it as a Bearer to any
 * other configured endpoint so a hostile `DEXE_SUBGRAPH_*_URL` can't harvest
 * the operator's key (W21 companion / L-6).
 */
export function isTrustedGraphHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "thegraph.com" || host.endsWith(".thegraph.com");
  } catch {
    return false;
  }
}

/**
 * Per-attempt deadline for a subgraph query. 8s matches the DeXe backend client
 * in `src/tools/read.ts`: a gateway that hasn't answered a paged GraphQL query
 * in 8s is not about to, and without a deadline a blackholing endpoint freezes
 * the MCP tool call until the client gives up (~20 min).
 */
export const SUBGRAPH_TIMEOUT_MS = 8_000;

/** Backoff before the single retry. One pause, not a ladder — see `gqlRequest`. */
export const SUBGRAPH_RETRY_DELAY_MS = 750;

export interface GqlRequestOptions {
  /** Per-attempt deadline in ms. Default {@link SUBGRAPH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Backoff before the retry. Default {@link SUBGRAPH_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
}

/**
 * A subgraph failure, pre-formatted with its remediation. `transient` marks the
 * ones a second attempt can plausibly fix (429 / 5xx / timeout / socket error).
 * Everything else — a 400 the gateway will reject identically forever, a
 * GraphQL error in the response body — must NOT be retried: retrying a
 * deterministic rejection only doubles how long the caller sits frozen.
 */
class SubgraphError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "SubgraphError";
  }
}

const SHIPPED_DEFAULT_SUBGRAPH_URLS: ReadonlySet<string> = new Set([
  DEFAULTS.subgraphPoolsUrl,
  DEFAULTS.subgraphValidatorsUrl,
  DEFAULTS.subgraphInteractionsUrl,
]);

/** True when the endpoint is still one of the keys baked into the package. */
export function isShippedDefaultSubgraph(endpoint: string): boolean {
  return SHIPPED_DEFAULT_SUBGRAPH_URLS.has(endpoint.trim());
}

/**
 * Mirrors `PUBLIC_RPC_HINT` in src/rpc.ts. The baked Graph key ships publicly on
 * npm, so every install shares one billable rate budget — which is exactly why a
 * 429/403 here is so often "you never set your own key" rather than "you are
 * querying too hard". Say so, instead of leaving the user to guess.
 */
const SHIPPED_DEFAULT_HINT =
  "\n\n[hint] this query used the shared DEFAULT Graph endpoint baked into dexe-mcp — its API " +
  "key is billable and shared by every install, so it rate-limits and can be revoked. Get a free " +
  "key at thegraph.com/studio and set DEXE_SUBGRAPH_POOLS_URL / DEXE_SUBGRAPH_VALIDATORS_URL / " +
  "DEXE_SUBGRAPH_INTERACTIONS_URL in .env, then restart (Claude Code: quit + relaunch). " +
  "Run /dexe-setup for a guided walkthrough.";

/** Append the shipped-default nudge only where a different key would help. */
function defaultEndpointHint(endpoint: string): string {
  return isShippedDefaultSubgraph(endpoint) ? SHIPPED_DEFAULT_HINT : "";
}

/**
 * Status → what the user should actually do about it. The endpoint is masked
 * (`maskUrl`) because the Graph API key rides in the URL path — echoing the raw
 * endpoint into a tool result would leak it into the transcript (W36).
 */
function httpRemediation(status: number, endpoint: string): { message: string; transient: boolean } {
  const where = maskUrl(endpoint);
  if (status === 401 || status === 403) {
    return {
      transient: false,
      message:
        `Subgraph HTTP ${status} from ${where} — the configured Graph endpoint rejected the request. ` +
        `Set DEXE_SUBGRAPH_*_URL to your own gateway key from thegraph.com/studio and restart.`,
    };
  }
  if (status === 429) {
    return {
      transient: true,
      message:
        `Subgraph HTTP 429 from ${where} — rate-limited. Set your own DEXE_SUBGRAPH_*_URL, or retry.`,
    };
  }
  if (status >= 500) {
    return {
      transient: true,
      message: `Subgraph HTTP ${status} from ${where} — the Graph gateway is failing; transient, re-run the call.`,
    };
  }
  return {
    transient: false,
    message:
      `Subgraph HTTP ${status} from ${where} — the gateway rejected this query and will reject it ` +
      `identically on a retry. Check the query and the entity names (see the dexe://graph-schema resource).`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One attempt, with a deadline that covers the body read as well as the
 * headers — a gateway that answers 200 and then stalls the body would otherwise
 * hang forever past the timeout, since the abort timer is what bounds it.
 */
async function gqlAttempt<T>(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      // Best-effort detail: the status already decides what we tell the user,
      // and a stalled error body must not extend the stall.
      const detail = await res.text().catch(() => "");
      const { message, transient } = httpRemediation(res.status, endpoint);
      throw new SubgraphError(
        `${message}${detail ? ` — gateway said: ${detail.slice(0, 200)}` : ""}${defaultEndpointHint(endpoint)}`,
        transient,
      );
    }
    const parsed = (await res.json()) as GqlResponse<T>;
    if (parsed.errors?.length) {
      // A GraphQL-level error is a bad query, not a bad connection — never retry.
      throw new SubgraphError(
        `Subgraph errors: ${parsed.errors.map((e) => e.message).join("; ")}`,
        false,
      );
    }
    if (!parsed.data) throw new SubgraphError("Subgraph returned empty data", false);
    return parsed.data;
  } catch (err) {
    // Already classified (we saw a status or a GraphQL body) — that is strictly
    // more informative than "timed out", and the deadline can legitimately fire
    // while we're reading the error body of a status we already have.
    if (err instanceof SubgraphError) throw err;
    // Otherwise classify on the signal, not on err.name: an abort surfaces
    // differently depending on where in the exchange it lands (fetch reject vs
    // body read).
    if (controller.signal.aborted) {
      throw new SubgraphError(
        `Subgraph request to ${maskUrl(endpoint)} timed out after ${timeoutMs}ms — ` +
          `transient, re-run the call.${defaultEndpointHint(endpoint)}`,
        true,
      );
    }
    // Anything left is a socket-level failure from fetch (DNS, reset, TLS) or a
    // non-JSON body — both plausibly survivable on a second try.
    throw new SubgraphError(
      `Subgraph request to ${maskUrl(endpoint)} failed: ${safeErrorMessage(err)} — ` +
        `transient, re-run the call.${defaultEndpointHint(endpoint)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function gqlRequest<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
  apiKey?: string,
  opts?: GqlRequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const extracted = extractGraphApiKey(endpoint);
  const key = apiKey ?? process.env.DEXE_GRAPH_API_KEY?.trim() ?? extracted;
  // W21/L-6: only attach the key as a Bearer when the endpoint is a trusted
  // Graph host, or when the key is already embedded in the endpoint URL
  // (sending it back to the same URL leaks nothing new). A hostile
  // DEXE_SUBGRAPH_*_URL must not receive the operator's separate Graph API key.
  const keyAlreadyInUrl = extracted !== undefined && key === extracted;
  if (key && (keyAlreadyInUrl || isTrustedGraphHost(endpoint))) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  const timeoutMs = opts?.timeoutMs ?? SUBGRAPH_TIMEOUT_MS;
  const retryDelayMs = opts?.retryDelayMs ?? SUBGRAPH_RETRY_DELAY_MS;
  const body = JSON.stringify({ query, variables });

  // Exactly two attempts. The Graph gateway 429s in bursts and 5xxs on
  // reindex, both of which a single retry usually rides out; more attempts
  // would just multiply the worst-case freeze the deadline exists to bound.
  let lastErr: unknown;
  let retried = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await gqlAttempt<T>(endpoint, headers, body, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt === 1 || !(err instanceof SubgraphError) || !err.transient) break;
      retried = true;
      await sleep(retryDelayMs);
    }
  }
  if (retried && lastErr instanceof Error) {
    throw new Error(`${lastErr.message} (retried once; both attempts failed)`);
  }
  throw lastErr;
}

/** Ported from frontend gov-pools subgraph `proposalInteractions` query. */
export const PROPOSAL_INTERACTIONS_QUERY = /* GraphQL */ `
  query ProposalInteractions($proposalId: String!, $first: Int!, $skip: Int!) {
    proposalInteractions(
      where: { proposal: $proposalId }
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      hash
      timestamp
      interactionType
      totalVote
      voter {
        id
        voter {
          id
        }
      }
    }
  }
`;
