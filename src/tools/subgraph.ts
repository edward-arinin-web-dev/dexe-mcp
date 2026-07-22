import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { gqlRequest } from "../lib/subgraph.js";
import { unixToUtc } from "../lib/time.js";
import { GET_TIER_VIEWS_FRAGMENT } from "./otc.js";
import { chainIdParam } from "../lib/params.js";
import { transactionTypeLabels } from "../lib/interactionTypes.js";

/**
 * Subgraph-backed read tools. Each tool queries one of the three DeXe
 * subgraphs (pools, validators, interactions) and returns structured data
 * for AI agent decision-making.
 *
 * Env vars required:
 *   DEXE_SUBGRAPH_POOLS_URL        — The Graph endpoint for DAO pools
 *   DEXE_SUBGRAPH_VALIDATORS_URL   — The Graph endpoint for validators
 *   DEXE_SUBGRAPH_INTERACTIONS_URL — The Graph endpoint for interactions
 */

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function requireUrl(ctx: ToolContext, key: "subgraphPoolsUrl" | "subgraphValidatorsUrl" | "subgraphInteractionsUrl"): string | null {
  const url = ctx.config[key];
  if (!url) return null;
  return url;
}

const ENV_HINT: Record<string, string> = {
  subgraphPoolsUrl: "DEXE_SUBGRAPH_POOLS_URL",
  subgraphValidatorsUrl: "DEXE_SUBGRAPH_VALIDATORS_URL",
  subgraphInteractionsUrl: "DEXE_SUBGRAPH_INTERACTIONS_URL",
};

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

const SUBGRAPH_URL_KEY = {
  pools: "subgraphPoolsUrl",
  interactions: "subgraphInteractionsUrl",
  validators: "subgraphValidatorsUrl",
} as const;

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
        "Full entity/field reference: docs/GRAPH.md (also summarized by dexe_guide). " +
        "ALWAYS bound results with `first:` (max 1000) and paginate with `skip:`; oversized responses are rejected. " +
        "Data covers BSC mainnet only (endpoints are env-bound: DEXE_SUBGRAPH_*_URL). " +
        "Example — most active DAOs by recent proposals: subgraph='pools', query='{ proposals(first: 20, orderBy: creationTime, orderDirection: desc) { pool { id } creationTime } }'.",
      inputSchema: {
        subgraph: z.enum(["pools", "interactions", "validators"]).describe("Which DeXe subgraph to query"),
        query: z.string().min(1).max(10_000).describe("GraphQL query document (read-only)"),
        variables: z.record(z.unknown()).optional().describe("GraphQL variables referenced by the query"),
      },
    },
    async ({ subgraph, query, variables }) => {
      const guardError = graphQueryGuard(query);
      if (guardError) return errorResult(guardError);
      const url = requireUrl(ctx, SUBGRAPH_URL_KEY[subgraph]);
      if (!url) return errorResult(`${ENV_HINT[SUBGRAPH_URL_KEY[subgraph]]} is not set.`);
      try {
        const data = await gqlRequest<Record<string, unknown>>(url, query, variables as Record<string, unknown> | undefined);
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
          content: [{ type: "text" as const, text: `graph_query(${subgraph}) → ${topLevel}` }],
          structuredContent: { subgraph, data },
        };
      } catch (err) {
        return errorResult(`graph_query failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Paginated DAO discovery via the pools subgraph. Search by name (case-insensitive), ordered by voter count descending. Requires DEXE_SUBGRAPH_POOLS_URL.",
      inputSchema: {
        query: z.string().default("").describe("Name search (case-insensitive, empty = all)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query = "", offset = 0, limit = 20 }) => {
      const url = requireUrl(ctx, "subgraphPoolsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphPoolsUrl} is not set.`);
      try {
        const data = await gqlRequest<{ daoPools: unknown[] }>(url, DAO_LIST_QUERY, {
          offset,
          limit,
          queryString: query,
        });
        const pools = data.daoPools;
        const text = `Found ${pools.length} DAO(s) (offset=${offset}, limit=${limit}, query="${query}")`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { query, offset, limit, daoPools: pools },
        };
      } catch (err) {
        return errorResult(`read_dao_list failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Paginated member list for a DAO — includes voting power, delegation counts, rewards, expert status. Requires DEXE_SUBGRAPH_POOLS_URL.",
      inputSchema: {
        govPool: z.string().describe("GovPool address (lowercased for subgraph)"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ govPool, offset = 0, limit = 20 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const url = requireUrl(ctx, "subgraphPoolsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphPoolsUrl} is not set.`);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(url, DAO_MEMBERS_QUERY, {
          poolId: govPool.toLowerCase(),
          offset,
          limit,
        });
        const members = data.voterInPools;
        const text = `${members.length} member(s) in ${govPool} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, members },
        };
      } catch (err) {
        return errorResult(`read_dao_members failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Query delegation pairs from the pools subgraph. Use direction='outgoing' to see who a user delegated to, or 'incoming' to see who delegated to them. Requires DEXE_SUBGRAPH_POOLS_URL. NOTE: the subgraph URL is env-bound to ONE chain (DEXE_SUBGRAPH_POOLS_URL); pass `chainId` matching that subgraph — a mismatch with the configured default chain is surfaced as a warning (the URL is not switched per call).",
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
      const url = requireUrl(ctx, "subgraphPoolsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphPoolsUrl} is not set.`);
      const warnings: string[] = [];
      if (chainId !== undefined && chainId !== ctx.config.defaultChainId) {
        warnings.push(
          `chainId ${chainId} differs from the configured default chain ${ctx.config.defaultChainId}; the pools subgraph URL is env-bound (DEXE_SUBGRAPH_POOLS_URL) and is NOT switched per call — results come from whatever chain that URL indexes. Set DEXE_SUBGRAPH_POOLS_URL to the chain you want.`,
        );
      }
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
        const data = await gqlRequest<{ voterInPoolPairs: unknown[] }>(url, query, variables);
        const pairs = data.voterInPoolPairs;
        const text = `${pairs.length} ${direction} delegation(s) for ${addresses.length} address(es)${warnings.length ? `\n⚠ ${warnings.join(" ")}` : ""}`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { addresses, direction, offset, limit, delegations: pairs, ...(warnings.length ? { warnings } : {}) },
        };
      } catch (err) {
        return errorResult(`read_delegation_map failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Paginated validator list ordered by balance descending. Requires DEXE_SUBGRAPH_VALIDATORS_URL.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ govPool, offset = 0, limit = 50 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const url = requireUrl(ctx, "subgraphValidatorsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphValidatorsUrl} is not set.`);
      try {
        const data = await gqlRequest<{ validatorInPools: unknown[] }>(url, VALIDATORS_QUERY, {
          offset,
          limit,
          address: govPool.toLowerCase(),
        });
        const validators = data.validatorInPools;
        const text = `${validators.length} validator(s) in ${govPool} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, validators },
        };
      } catch (err) {
        return errorResult(`read_validator_list failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Paginated transaction history for a user — proposals created, votes cast, delegations, claims. Ordered by timestamp descending. Requires DEXE_SUBGRAPH_INTERACTIONS_URL.",
      inputSchema: {
        user: z.string().describe("User wallet address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ user, offset = 0, limit = 50 }) => {
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      const url = requireUrl(ctx, "subgraphInteractionsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphInteractionsUrl} is not set.`);
      try {
        const data = await gqlRequest<{ transactions: Array<Record<string, unknown>> }>(url, USER_ACTIVITY_QUERY, {
          offset,
          limit,
          address: user.toLowerCase(),
        });
        const txs = data.transactions.map((tx) => ({
          ...tx,
          typeLabels: transactionTypeLabels(Array.isArray(tx.type) ? tx.type : [tx.type]),
        }));
        const text = `${txs.length} transaction(s) for ${user} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { user, offset, limit, transactions: txs },
        };
      } catch (err) {
        return errorResult(`read_user_activity failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Paginated list of local experts (holders of DAO-specific expert NFTs) with their delegation info. Requires DEXE_SUBGRAPH_POOLS_URL.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ govPool, offset = 0, limit = 50 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const url = requireUrl(ctx, "subgraphPoolsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphPoolsUrl} is not set.`);
      try {
        const data = await gqlRequest<{ voterInPools: unknown[] }>(url, EXPERTS_QUERY, {
          offset,
          limit,
          daoAddress: govPool.toLowerCase(),
        });
        const experts = data.voterInPools;
        const text = `${experts.length} expert(s) in ${govPool} (offset=${offset}, limit=${limit})`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { govPool, offset, limit, experts },
        };
      } catch (err) {
        return errorResult(`read_dao_experts failed: ${err instanceof Error ? err.message : String(err)}`);
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
        "Reads `latestTierId()` then `getTierViews(0, latestTierId)` on the DAO's TokenSaleProposal helper. Returns tier list with `totalSold` and status (`upcoming` / `active` / `ended` / `off`) computed against current block timestamp and the tier's on-chain isOff flag. On-chain reads follow the optional `chainId` param (defaults to the MCP's default chain); no subgraph required, though subgraph indexing only exists on mainnet. " +
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
                text: `${tokenSaleProposal}: zero tiers (latestTierId=0). DAO has not opened a sale yet.`,
              },
            ],
            structuredContent: {
              govPool,
              tokenSaleProposal,
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
              text: `${tokenSaleProposal}: ${tiers.length} tier(s) — ${counts.active} active, ${counts.upcoming} upcoming, ${counts.ended} ended, ${counts.off} off (block ts ${nowSec}).`,
            },
          ],
          structuredContent: {
            govPool,
            tokenSaleProposal,
            tiers,
            counts,
          },
        };
      } catch (e) {
        return errorResult(
          `otc_list_sales_for_dao failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
