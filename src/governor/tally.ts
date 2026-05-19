/**
 * Tally GraphQL parity harness — W4 of research/06-execution-plan.md.
 *
 * Tally exposes proposal state as a string enum
 * (PENDING / ACTIVE / CANCELED / DEFEATED / SUCCEEDED / QUEUED / EXPIRED /
 *  EXECUTED / EXTENDED / ...). We project Tally's string back onto OZ's
 * numeric enum and compare to our `state()` result. Mismatch on any of the 30
 * sampled proposals fails the harness — see plan §2 state-parity metric.
 *
 * Live runs require TALLY_API_KEY (free at https://www.tally.xyz/user/api-keys).
 * When unset the test file marks parity tests as skipped — we keep the
 * comparison logic itself under unit test against synthetic fixtures.
 */

import { PROPOSAL_STATE } from "./adapter.js";

export interface TallyProposalSnapshot {
  /** Tally-side stringly-typed state. */
  status: string;
  /** Numeric proposal id on the governor (uint256 decimal string). */
  onchainId: string;
}

export interface ParityCheckRow {
  proposalId: string;
  expected: { source: "tally"; status: string; mappedIndex: number | null };
  actual: { source: "rpc"; index: number; name: string };
  match: boolean;
}

const STATUS_TO_INDEX: Record<string, number> = {
  // OZ Governor canonical
  PENDING: 0,
  ACTIVE: 1,
  CANCELED: 2,
  CANCELLED: 2,
  DEFEATED: 3,
  SUCCEEDED: 4,
  QUEUED: 5,
  EXPIRED: 6,
  EXECUTED: 7,
  // Tally synonyms / extended states we treat as equivalent
  CALLEXECUTED: 7,
  CROSSCHAINEXECUTED: 7,
  // SUBMITTED / DRAFT are pre-Pending Tally states — we map to Pending for
  // the on-chain comparator because the on-chain `state()` will return Pending
  // until the snapshot block elapses.
  SUBMITTED: 0,
  DRAFT: 0,
};

export function mapTallyStatusToIndex(status: string): number | null {
  const idx = STATUS_TO_INDEX[status.toUpperCase()];
  return idx === undefined ? null : idx;
}

export function compareStateEnum(
  proposalId: string,
  tally: TallyProposalSnapshot,
  actualStateIndex: number,
): ParityCheckRow {
  const mappedIndex = mapTallyStatusToIndex(tally.status);
  const match = mappedIndex !== null && mappedIndex === actualStateIndex;
  return {
    proposalId,
    expected: { source: "tally", status: tally.status, mappedIndex },
    actual: {
      source: "rpc",
      index: actualStateIndex,
      name: PROPOSAL_STATE[actualStateIndex] ?? `Unknown(${actualStateIndex})`,
    },
    match,
  };
}

/**
 * Tally GraphQL query for governor proposals. Caller passes governor ID in
 * Tally's `eip155:<chainId>:<address>` form. Returns `limit` most-recent
 * proposals.
 */
export const TALLY_PROPOSALS_QUERY = `
  query Proposals($input: ProposalsInput!) {
    proposals(input: $input) {
      nodes {
        ... on Proposal {
          onchainId
          status
        }
      }
    }
  }
`;

export interface TallyClient {
  apiKey: string;
  endpoint?: string;
}

export async function fetchTallyProposals(
  client: TallyClient,
  governorChainAddress: string,
  limit: number,
): Promise<TallyProposalSnapshot[]> {
  const endpoint = client.endpoint ?? "https://api.tally.xyz/query";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": client.apiKey,
    },
    body: JSON.stringify({
      query: TALLY_PROPOSALS_QUERY,
      variables: {
        input: {
          filters: { governorId: governorChainAddress },
          page: { limit },
          sort: { sortBy: "id", isDescending: true },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Tally HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as any;
  if (body.errors) throw new Error(`Tally GraphQL: ${JSON.stringify(body.errors)}`);
  const nodes = body.data?.proposals?.nodes ?? [];
  return nodes
    .filter((n: any) => n?.onchainId && n?.status)
    .map((n: any) => ({ onchainId: String(n.onchainId), status: String(n.status) }));
}

export function tallyGovernorId(chainId: number, address: string): string {
  return `eip155:${chainId}:${address.toLowerCase()}`;
}
