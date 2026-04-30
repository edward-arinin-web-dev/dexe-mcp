/**
 * Minimal GraphQL fetcher for The Graph subgraphs. Uses global `fetch` (Node
 * 18+). We avoid `graphql-request` as a dep for now — the calls we make are
 * simple enough.
 */
export interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function gqlRequest<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Subgraph HTTP ${res.status} ${res.statusText}`);
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
