import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import {
  gqlRequest,
  resolveSubgraphUrl,
  subgraphChains,
  type ResolvedSubgraph,
  type SubgraphKind,
} from "../lib/subgraph.js";
import { SUBGRAPH_KINDS, subgraphEnvVar } from "../config.js";
import { unixToUtc } from "../lib/time.js";
import { GET_TIER_VIEWS_FRAGMENT } from "./otc.js";
import { chainIdParam } from "../lib/params.js";
import { transactionTypeLabels } from "../lib/interactionTypes.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/errors.js";

/**
 * Subgraph-backed read tools. Each tool queries one of the three DeXe
 * subgraphs (pools, validators, interactions) and returns structured data
 * for AI agent decision-making.
 *
 * A subgraph endpoint indexes exactly ONE chain, so every tool here takes
 * `chainId` and resolves its endpoint through `resolveSubgraphUrl`. A chain
 * with no endpoint is an error, never a silent substitution: serving BSC
 * mainnet rows to someone working on testnet looks like a successful read, and
 * an agent will act on it. Every response also carries `indexedChainId` — the
 * chain the rows actually came from — so the payload states its own provenance
 * even if resolution is ever wrong again.
 *
 * Endpoints come from `DEXE_SUBGRAPH_<KIND>_URL_<chainId>`, falling back to the
 * unsuffixed `DEXE_SUBGRAPH_<KIND>_URL` / baked defaults for the chain named by
 * `DEXE_SUBGRAPH_CHAIN_ID` (BSC mainnet, 56).
 */

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * The endpoint for `kind` on `chainId`, or the resolver's message as a plain
 * string. That message is already written as user-facing remediation (it names
 * the chain, the chains that DO have this subgraph, the on-chain alternatives,
 * and the exact env var to set), so callers surface it verbatim through
 * `errorResult` instead of letting a throw escape as a stack trace.
 */
function resolveEndpoint(
  ctx: ToolContext,
  kind: SubgraphKind,
  chainId?: number,
): ResolvedSubgraph | string {
  try {
    return resolveSubgraphUrl(ctx.config, kind, chainId);
  } catch (err) {
    return safeErrorMessage(err);
  }
}

/**
 * The chain paragraph appended to each tool description, built at registration
 * from the endpoints this install actually has. A hardcoded "BSC mainnet only"
 * sentence goes stale the moment someone sets DEXE_SUBGRAPH_POOLS_URL_97.
 */
function chainNote(ctx: ToolContext, kind: SubgraphKind): string {
  const indexed = subgraphChains(ctx.config, kind);
  const where = indexed.length
    ? `chains with a ${kind} endpoint here: ${indexed.join(", ")}`
    : `NO chain has a ${kind} endpoint here`;
  return (
    ` Chain-explicit: pass \`chainId\` (${where}; default ${ctx.config.defaultChainId}); ` +
    `the response reports \`indexedChainId\` = the chain the rows came from. A chain with no endpoint ` +
    `returns an error naming ${subgraphEnvVar(kind)}_<chainId> plus the on-chain alternatives ` +
    `(dexe_read_gov_state / dexe_proposal_list / dexe_read_multicall) — it never answers from another chain.`
  );
}

// ---------- queries ----------

const DAO_LIST_QUERY = /* GraphQL */ `
  query getGovPoolsList($offset: Int!, $limit: Int!, $queryString: String!) {
    daoPools(
      skip: $offset
      first: $limit
      where: { name_contains_nocase: $queryString }
      orderBy: votersCount
      orderDirection: desc
    ) {
      id
      name
      erc20Token
      erc721Token
      votersCount
      proposalCount
      totalCurrentTokenDelegated
      totalCurrentTokenDelegatees
      creationTime
      creationBlock
    }
  }
`;

const DAO_MEMBERS_QUERY = /* GraphQL */ `
  query getVotersInPool($poolId: String!, $offset: Int!, $limit: Int!) {
    voterInPools(skip: $offset, first: $limit, where: { pool: $poolId }) {
      id
      APR
      currentDelegateesCount
      currentDelegatorsCount
      engagedProposalsCount
      joinedTimestamp
      receivedDelegation
      receivedNFTDelegation
      receivedTreasuryDelegation
      totalClaimedUSD
      totalLockedUSD
      totalPersonalVotingRewardUSD
      totalMicropoolVotingRewardUSD
      totalTreasuryVotingRewardUSD
      expertNft {
        id
        tokenId
      }
      voter {
        id
        totalProposalsCreated
        totalVotedProposals
        totalVotes
        currentVotesReceived
        currentVotesDelegated
        totalClaimedUSD
      }
    }
  }
`;

const DELEGATION_MAP_QUERY = /* GraphQL */ `
  query getDefaultDelegationsFromPool($offset: Int!, $limit: Int!, $delegatorIn: [String!]) {
    voterInPoolPairs(
      skip: $offset
      first: $limit
      where: { delegator_: { voter_in: $delegatorIn } }
    ) {
      id
      creationTimestamp
      delegatedAmount
      delegatedNfts
      delegatedUSD
      delegatedVotes
      delegatee {
        expertNft {
          id
        }
        voter {
          id
        }
        totalClaimedUSD
      }
      delegator {
        voter {
          id
        }
        pool {
          id
          erc20Token
        }
      }
    }
  }
`;

const DELEGATION_INCOMING_QUERY = /* GraphQL */ `
  query getPoolIncomingDelegations($offset: Int!, $limit: Int!, $voterIn: [String!]) {
    voterInPoolPairs(
      skip: $offset
      first: $limit
      where: { delegatee_: { voter_in: $voterIn } }
    ) {
      id
      delegatedAmount
      delegatedNfts
      delegatedUSD
      delegatedVotes
      delegator {
        voter {
          id
        }
      }
      delegatee {
        voter {
          id
        }
      }
    }
  }
`;

const VALIDATORS_QUERY = /* GraphQL */ `
  query getDaoPoolValidators($offset: Int!, $limit: Int!, $address: String!) {
    validatorInPools(
      skip: $offset
      first: $limit
      orderBy: balance
      orderDirection: desc
      where: { pool: $address }
    ) {
      id
      balance
      validatorAddress
    }
  }
`;

const USER_ACTIVITY_QUERY = /* GraphQL */ `
  query getUserTransactions($offset: Int!, $limit: Int!, $address: Bytes!) {
    transactions(
      skip: $offset
      first: $limit
      where: { user: $address }
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      type
      user
      timestamp
      interactionsCount
    }
  }
`;

const EXPERTS_QUERY = /* GraphQL */ `
  query getLocalExpertsByPool($offset: Int!, $limit: Int!, $daoAddress: Bytes!) {
    voterInPools(
      skip: $offset
      first: $limit
      where: { pool_: { id: $daoAddress }, expertNft_: { id_not: null } }
    ) {
      id
      receivedTreasuryDelegation
      receivedDelegation
      voter {
        id
      }
      expertNft {
        id
        tokenId
      }
      pool {
        id
      }
    }
  }
`;

// ---------- register ----------

export function registerSubgraphTools(server: McpServer, ctx: ToolContext): void {
  registerDaoList(server, ctx);
  registerDaoMembers(server, ctx);
  registerDelegationMap(server, ctx);
  registerValidatorList(server, ctx);
  registerUserActivity(server, ctx);
  registerDaoExperts(server, ctx);
  registerOtcListSalesForDao(server, ctx);
  registerGraphQuery(server, ctx);
}

// ---------- dexe_graph_query ----------

/**
 * graph_query picks its subgraph per call, so it advertises coverage for all
 * three kinds rather than the single-kind note the other tools use.
 */
function graphQueryChainNote(ctx: ToolContext): string {
  const per = SUBGRAPH_KINDS.map(
    (k) => `${k}: ${subgraphChains(ctx.config, k).join("/") || "none"}`,
  ).join(", ");
  return (
    `Chain-explicit: pass \`chainId\` (endpoints configured here — ${per}; default ${ctx.config.defaultChainId}); ` +
    "the response reports `indexedChainId`. Asking for a chain that has no endpoint for the chosen subgraph " +
    "returns an error naming DEXE_SUBGRAPH_<KIND>_URL_<chainId>, never another chain's rows. "
  );
}

/** Response cap — beyond this the caller should paginate, not stream megabytes into a conversation. */
const GRAPH_QUERY_MAX_RESPONSE_CHARS = 120_000;

/**
 * Light read-only guard. The Graph gateway has no mutations, but reject the
 * keywords up front so a bad query fails with a clear message instead of a
 * gateway error.
 */
export function graphQueryGuard(query: string): string | null {
  const stripped = query.replace(/#[^\n]*/g, "").trim();
  if (!stripped) return "Empty query.";
  if (/^\s*(mutation|subscription)\b/i.test(stripped)) {
    return "Only read queries are supported (subgraphs have no mutations/subscriptions).";
  }
  if (!/^\s*(query\b|\{)/i.test(stripped)) {
    return "Query must start with 'query' or '{'.";
  }
  return null;
}

function registerGraphQuery(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_graph_query",
    {
      title: "Free-form GraphQL query against a DeXe subgraph",
      description:
        "Run ANY read-only GraphQL query against one of the three DeXe subgraphs: " +
        "'pools' (DaoPool, Proposal, Voter, VoterInPool, VoterInPoolPair, ProposalInteraction, TokenSaleTier, ExpertNft, DelegationHistory, …), " +
        "'interactions' (Transaction feed by type + per-event entities: DaoPoolCreate, DaoPoolDelegate, DaoPoolExecute, DaoPoolVest, DaoProposalCreate, …), " +
        "'validators' (ValidatorInPool, Proposal, ValidatorInProposal, …). " +
        "Full entity/field reference: MCP resource dexe://graph-schema (docs/GRAPH.md in the package); " +
        "usage rules + source-picking guidance: dexe_guide flow:'read_dao_data'. " +
        "ALWAYS bound results with `first:` (max 1000) and paginate with `skip:`; oversized responses are rejected. " +
        graphQueryChainNote(ctx) +
        "Example — most-voted proposals with their DAO: subgraph='pools', query='{ proposals(first: 20, orderBy: votersVoted, orderDirection: desc) { proposalId votersVoted currentVotesFor pool { id name } } }'. " +
        "Proposal has NO `creationTime` — order by `votersVoted`/`quorumReachedTimestamp`/`executionTimestamp`, or use DaoPool.creationTime for DAOs. " +
        "Schema unsure? Introspect: query='{ __type(name: \"Proposal\") { fields { name } } }'.",
      inputSchema: {
        subgraph: z.enum(["pools", "interactions", "validators"]).describe("Which DeXe subgraph to query"),
        query: z.string().min(1).max(10_000).describe("GraphQL query document (read-only)"),
        variables: z.record(z.unknown()).optional().describe("GraphQL variables referenced by the query"),
        chainId: chainIdParam,
      },
    },
    async ({ subgraph, query, variables, chainId }) => {
      const guardError = graphQueryGuard(query);
      if (guardError) return errorResult(guardError);
      const sg = resolveEndpoint(ctx, subgraph, chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<Record<string, unknown>>(sg.url, query, variables as Record<string, unknown> | undefined);
        const json = JSON.stringify(data);
        if (json.length > GRAPH_QUERY_MAX_RESPONSE_CHARS) {
          return errorResult(
            `Response too large (${json.length} chars > ${GRAPH_QUERY_MAX_RESPONSE_CHARS}). ` +
              `Narrow the selection set or paginate with first/skip.`,
          );
        }
        const topLevel = Object.entries(data)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} row(s)` : typeof v}`)
          .join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `graph_query(${subgraph}, chain ${sg.chainId}) → ${topLevel}`,
            },
          ],
          structuredContent: { subgraph, indexedChainId: sg.chainId, data },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_graph_query").message);
      }
    },
  );
}

// ---------- tools ----------

function registerDaoList(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_list",
    {
      title: "Discover and list DAOs (subgraph)",
      description:
        "Paginated DAO discovery via the pools subgraph. Search by name (case-insensitive), ordered by voter count descending." +
        chainNote(ctx, "pools"),
      inputSchema: {
        query: z.string().default("").describe("Name search (case-insensitive, empty = all)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        chainId: chainIdParam,
      },
    },
    async ({ query = "", offset = 0, limit = 20, chainId }) => {
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ daoPools: unknown[] }>(sg.url, DAO_LIST_QUERY, {
          offset,
          limit,
          queryString: query,
        });
        const pools = data.daoPools;
        const text = `Found ${pools.length} DAO(s) on chain ${sg.chainId} (offset=${offset}, limit=${limit}, query="${query}")`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { query, offset, limit, indexedChainId: sg.chainId, daoPools: pools },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_list").message);
      }
    },
  );
}

function registerDaoMembers(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_members",
    {
      title: "List DAO members with voting power (subgraph)",
      description:
        "Paginated member list for a DAO — includes voting power, delegation counts, rewards, expert status." +
        chainNote(ctx, "pools"),
      inputSchema: {
        govPool: z.string().describe("GovPool address (lowercased for subgraph)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 20, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(sg.url, DAO_MEMBERS_QUERY, {
          poolId: govPool.toLowerCase(),
          offset,
          limit,
        });
        const members = data.voterInPools;
        const text = `${members.length} member(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, indexedChainId: sg.chainId, members },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_members").message);
      }
    },
  );
}

/**
 * The delegation queries filter on `delegator_.voter_in` / `delegatee_.voter_in`,
 * which match VOTER WALLET addresses — NOT VoterInPool composite ids. A composite
 * id reaches the store's Bytes parser and fails with "Odd number of digits".
 * Accept both shapes and extract the wallet: 'govPool-voter' → part after the
 * dash; 80-hex 'voter+pool' (the real VoterInPool id) → first 40 hex chars.
 */
export function toVoterAddress(input: string): string {
  let s = input.trim().toLowerCase();
  const dash = s.lastIndexOf("-");
  if (dash >= 0) s = s.slice(dash + 1);
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  return `0x${hex.length > 40 ? hex.slice(0, 40) : hex}`;
}

function registerDelegationMap(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_delegation_map",
    {
      title: "Delegation relationships — outgoing or incoming (subgraph)",
      description:
        "Query delegation pairs from the pools subgraph. Use direction='outgoing' to see who a user delegated to, or 'incoming' to see who delegated to them." +
        chainNote(ctx, "pools"),
      inputSchema: {
        addresses: z
          .array(z.string())
          .min(1)
          .describe(
            "Voter WALLET addresses (plain 0x…40-hex). Composite VoterInPool ids ('govPool-voter' or 80-hex 'voter+pool' concatenations) are also accepted — the voter part is extracted automatically.",
          ),
        direction: z.enum(["outgoing", "incoming"]).default("outgoing").describe("outgoing = who I delegated to; incoming = who delegated to me"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ addresses, direction = "outgoing", offset = 0, limit = 50, chainId }) => {
      // Pre-0.30.2 this only WARNED on a chain mismatch, because one env var
      // held one URL and there was nothing to switch to. Now the endpoint is
      // per chain, so the mismatch is resolved rather than narrated.
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      const lc = addresses.map(toVoterAddress);
      const bad = lc.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
      if (bad.length) {
        return errorResult(
          `Not a voter wallet address (expected 0x + 40 hex, or a 'govPool-voter' / 80-hex composite id): ${bad.join(", ")}`,
        );
      }
      try {
        const query = direction === "outgoing" ? DELEGATION_MAP_QUERY : DELEGATION_INCOMING_QUERY;
        const variables =
          direction === "outgoing"
            ? { offset, limit, delegatorIn: lc }
            : { offset, limit, voterIn: lc };
        const data = await gqlRequest<{ voterInPoolPairs: unknown[] }>(sg.url, query, variables);
        const pairs = data.voterInPoolPairs;
        const text = `${pairs.length} ${direction} delegation(s) for ${addresses.length} address(es) on chain ${sg.chainId}`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            addresses,
            direction,
            offset,
            limit,
            indexedChainId: sg.chainId,
            delegations: pairs,
          },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_delegation_map").message);
      }
    },
  );
}

function registerValidatorList(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_validator_list",
    {
      title: "List validators in a DAO (subgraph)",
      description:
        "Paginated validator list ordered by balance descending." + chainNote(ctx, "validators"),
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "validators", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ validatorInPools: unknown[] }>(sg.url, VALIDATORS_QUERY, {
          offset,
          limit,
          address: govPool.toLowerCase(),
        });
        const validators = data.validatorInPools;
        const text = `${validators.length} validator(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, indexedChainId: sg.chainId, validators },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_validator_list").message);
      }
    },
  );
}

function registerUserActivity(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_user_activity",
    {
      title: "User transaction history across DAOs (subgraph)",
      description:
        "Paginated transaction history for a user — proposals created, votes cast, delegations, claims. Ordered by timestamp descending." +
        chainNote(ctx, "interactions"),
      inputSchema: {
        user: z.string().describe("User wallet address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ user, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      const sg = resolveEndpoint(ctx, "interactions", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ transactions: Array<Record<string, unknown>> }>(sg.url, USER_ACTIVITY_QUERY, {
          offset,
          limit,
          address: user.toLowerCase(),
        });
        const txs = data.transactions.map((tx) => ({
          ...tx,
          typeLabels: transactionTypeLabels(Array.isArray(tx.type) ? tx.type : [tx.type]),
        }));
        const text = `${txs.length} transaction(s) for ${user} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { user, offset, limit, indexedChainId: sg.chainId, transactions: txs },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_user_activity").message);
      }
    },
  );
}

function registerDaoExperts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_dao_experts",
    {
      title: "List local experts in a DAO (subgraph)",
      description:
        "Paginated list of local experts (holders of DAO-specific expert NFTs) with their delegation info." +
        chainNote(ctx, "pools"),
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, offset = 0, limit = 50, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const sg = resolveEndpoint(ctx, "pools", chainId);
      if (typeof sg === "string") return errorResult(sg);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(sg.url, EXPERTS_QUERY, {
          offset,
          limit,
          daoAddress: govPool.toLowerCase(),
        });
        const experts = data.voterInPools;
        const text = `${experts.length} expert(s) in ${govPool} on chain ${sg.chainId} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, indexedChainId: sg.chainId, experts },
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_experts").message);
      }
    },
  );
}

// ---------- OTC discovery ----------

// Nested TierView decode — single source of truth in src/tools/otc.ts
// (mirrors ITokenSaleProposal.TierView; the old flat shape decoded garbage).
const TOKEN_SALE_DISCOVERY_ABI = new Interface([
  "function latestTierId() view returns (uint256)",
  GET_TIER_VIEWS_FRAGMENT,
]);

const GOV_POOL_HELPERS_DISCOVERY_ABI = new Interface([
  // Some deployments expose the TokenSaleProposal address via a custom getter;
  // we don't rely on it. Caller passes the address directly when known. Keep
  // the placeholder ABI for forward-compat.
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
]);

function registerOtcListSalesForDao(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  server.registerTool(
    "dexe_otc_list_sales_for_dao",
    {
      title: "List OTC sale tiers for a DAO",
      description:
        "Reads `latestTierId()` then `getTierViews(0, latestTierId)` on the DAO's TokenSaleProposal helper. Returns tier list with `totalSold` and status (`upcoming` / `active` / `ended` / `off`) computed against current block timestamp and the tier's on-chain isOff flag. Pure on-chain read — no subgraph involved, so it works on any chain with an RPC. `chainId` selects the chain (defaults to the MCP's default chain) and the response echoes the resolved `chainId`. " +
        "When `tokenSaleProposal` is omitted the tool returns an error pointing at the helper-discovery follow-up; supply it explicitly until per-DAO helper discovery lands.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        tokenSaleProposal: z
          .string()
          .describe("TokenSaleProposal helper address. Look up via dexe_dao_predict_addresses or DAO deploy receipt."),
        chainId: chainIdParam,
      },
    },
    async ({ govPool, tokenSaleProposal, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(tokenSaleProposal))
        return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);

      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        // Echoed on every return: this read is on-chain, so the answer belongs
        // to the chain the provider resolved to, not to any subgraph index.
        const readChainId = rpc.resolveChainId(chainId);

        // Validate the GovPool actually exists (helper read is the cheapest
        // smoke test — reverts cleanly on EOA/empty address).
        const [helpersR] = await multicall(provider, [
          {
            target: govPool,
            iface: GOV_POOL_HELPERS_DISCOVERY_ABI,
            method: "getHelperContracts",
            args: [],
            allowFailure: true,
          },
        ]);
        if (!helpersR?.success) {
          return errorResult(
            `${govPool} does not look like a GovPool (getHelperContracts reverted): ${helpersR?.error ?? "unknown"}`,
          );
        }

        // Read latestTierId, then page with offset=0 limit=latestTierId.
        const [latestR] = await multicall(provider, [
          {
            target: tokenSaleProposal,
            iface: TOKEN_SALE_DISCOVERY_ABI,
            method: "latestTierId",
            args: [],
            allowFailure: true,
          },
        ]);
        if (!latestR?.success) {
          return errorResult(
            `${tokenSaleProposal} does not look like a TokenSaleProposal (latestTierId reverted): ${latestR?.error ?? "unknown"}`,
          );
        }
        const latestTierId = Number(latestR.value as bigint);
        if (latestTierId === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${tokenSaleProposal}: zero tiers (latestTierId=0) on chain ${readChainId}. DAO has not opened a sale yet.`,
              },
            ],
            structuredContent: {
              govPool,
              tokenSaleProposal,
              chainId: readChainId,
              tiers: [],
            },
          };
        }

        const [tiersR] = await multicall(provider, [
          {
            target: tokenSaleProposal,
            iface: TOKEN_SALE_DISCOVERY_ABI,
            method: "getTierViews",
            args: [0n, BigInt(latestTierId)],
            allowFailure: true,
          },
        ]);
        if (!tiersR?.success) {
          return errorResult(`getTierViews(0, ${latestTierId}) reverted: ${tiersR?.error ?? "unknown"}`);
        }

        const block = await provider.getBlock("latest");
        const nowSec = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));

        const rawTiers = tiersR.value as unknown as Array<{
          tierInitParams: {
            metadata: { name: string; description: string };
            totalTokenProvided: bigint;
            saleStartTime: bigint;
            saleEndTime: bigint;
            saleTokenAddress: string;
            purchaseTokenAddresses: string[];
          };
          tierInfo: { isOff: boolean; totalSold: bigint; uri: string };
        }>;

        const tiers = rawTiers.map((t, i) => {
          const tierId = String(i + 1);
          const p = t.tierInitParams;
          let status: "upcoming" | "active" | "ended" | "off";
          if (t.tierInfo.isOff) status = "off";
          else if (nowSec < p.saleStartTime) status = "upcoming";
          else if (nowSec <= p.saleEndTime) status = "active";
          else status = "ended";

          return {
            tierId,
            name: p.metadata.name,
            saleStartTime: p.saleStartTime.toString(),
            saleEndTime: p.saleEndTime.toString(),
            saleStartTimeUTC: unixToUtc(p.saleStartTime),
            saleEndTimeUTC: unixToUtc(p.saleEndTime),
            saleToken: p.saleTokenAddress,
            purchaseTokens: [...p.purchaseTokenAddresses],
            totalProvided: p.totalTokenProvided.toString(),
            totalSold: t.tierInfo.totalSold.toString() as string | null,
            status,
          };
        });

        const counts = {
          upcoming: tiers.filter((t) => t.status === "upcoming").length,
          active: tiers.filter((t) => t.status === "active").length,
          ended: tiers.filter((t) => t.status === "ended").length,
          off: tiers.filter((t) => t.status === "off").length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${tokenSaleProposal}: ${tiers.length} tier(s) on chain ${readChainId} — ${counts.active} active, ${counts.upcoming} upcoming, ${counts.ended} ended, ${counts.off} off (block ts ${nowSec}).`,
            },
          ],
          structuredContent: {
            govPool,
            tokenSaleProposal,
            chainId: readChainId,
            tiers,
            counts,
          },
        };
      } catch (e) {
        return errorResult(
          toActionableError(e, "dexe_otc_list_sales_for_dao").message,
        );
      }
    },
  );
}
