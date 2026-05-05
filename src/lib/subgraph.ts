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

export async function gqlRequest<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
  apiKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey ?? process.env.DEXE_GRAPH_API_KEY?.trim() ?? extractGraphApiKey(endpoint);
  if (key) headers["Authorization"] = `Bearer ${key}`;

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
