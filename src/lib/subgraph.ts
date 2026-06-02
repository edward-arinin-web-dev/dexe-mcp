/**
 * Minimal GraphQL fetcher for The Graph subgraphs. Uses global `fetch` (Node
 * 18+). We avoid `graphql-request` as a dep for now — the calls we make are
 * simple enough.
 */
export interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
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
