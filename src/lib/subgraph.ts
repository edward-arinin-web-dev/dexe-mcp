import type { DexeConfig, SubgraphKind } from "../config.js";
import { DEFAULT_SUBGRAPH_CHAIN_ID, SUBGRAPH_KINDS, subgraphEnvVar } from "../config.js";

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

export async function gqlRequest<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
  apiKey?: string,
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

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Subgraph HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Subgraph errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Subgraph returned empty data");
  return body.data;
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
