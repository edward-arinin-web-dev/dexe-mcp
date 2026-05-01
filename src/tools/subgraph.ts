import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { gqlRequest } from "../lib/subgraph.js";

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

function registerDelegationMap(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_read_delegation_map",
    {
      title: "Delegation relationships — outgoing or incoming (subgraph)",
      description:
        "Query delegation pairs from the pools subgraph. Use direction='outgoing' to see who a user delegated to, or 'incoming' to see who delegated to them. Requires DEXE_SUBGRAPH_POOLS_URL.",
      inputSchema: {
        addresses: z.array(z.string()).min(1).describe("VoterInPool IDs (format: govPool-voterAddress, lowercased)"),
        direction: z.enum(["outgoing", "incoming"]).default("outgoing").describe("outgoing = who I delegated to; incoming = who delegated to me"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ addresses, direction = "outgoing", offset = 0, limit = 50 }) => {
      const url = requireUrl(ctx, "subgraphPoolsUrl");
      if (!url) return errorResult(`${ENV_HINT.subgraphPoolsUrl} is not set.`);
      try {
        const lc = addresses.map((a) => a.toLowerCase());
        const query = direction === "outgoing" ? DELEGATION_MAP_QUERY : DELEGATION_INCOMING_QUERY;
        const variables =
          direction === "outgoing"
            ? { offset, limit, delegatorIn: lc }
            : { offset, limit, voterIn: lc };
        const data = await gqlRequest<{ voterInPoolPairs: unknown[] }>(url, query, variables);
        const pairs = data.voterInPoolPairs;
        const text = `${pairs.length} ${direction} delegation(s) for ${addresses.length} address(es)`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { addresses, direction, offset, limit, delegations: pairs },
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
        const data = await gqlRequest<{ transactions: unknown[] }>(url, USER_ACTIVITY_QUERY, {
          offset,
          limit,
          address: user.toLowerCase(),
        });
        const txs = data.transactions;
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

const TOKEN_SALE_DISCOVERY_ABI = new Interface([
  "function latestTierId() view returns (uint256)",
  "function getTierViews(uint256 offset, uint256 limit) view returns (tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint256 saleStartTime, uint256 saleEndTime, address saleTokenAddress, uint256 claimLockDuration, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 cliffPeriod, uint256 unlockStep, uint256 vestingDuration, uint256 vestingPercentage) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
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
        "Reads `latestTierId()` then `getTierViews(0, latestTierId)` on the DAO's TokenSaleProposal helper. Returns tier list with status (`upcoming` / `active` / `ended`) computed against current block timestamp. Works on chain 56 (mainnet) and 97 (testnet) — no subgraph required. " +
        "When `tokenSaleProposal` is omitted the tool returns an error pointing at the helper-discovery follow-up; supply it explicitly until per-DAO helper discovery lands.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        tokenSaleProposal: z
          .string()
          .describe("TokenSaleProposal helper address. Look up via dexe_dao_predict_addresses or DAO deploy receipt."),
      },
    },
    async ({ govPool, tokenSaleProposal }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(tokenSaleProposal))
        return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);

      try {
        const provider = rpc.requireProvider();

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
          metadata: { name: string; description: string };
          totalTokenProvided: bigint;
          saleStartTime: bigint;
          saleEndTime: bigint;
          saleTokenAddress: string;
          purchaseTokenAddresses: string[];
        }>;

        const tiers = rawTiers.map((t, i) => {
          const tierId = String(i + 1);
          let status: "upcoming" | "active" | "ended";
          if (nowSec < t.saleStartTime) status = "upcoming";
          else if (nowSec <= t.saleEndTime) status = "active";
          else status = "ended";

          return {
            tierId,
            name: t.metadata.name,
            saleStartTime: t.saleStartTime.toString(),
            saleEndTime: t.saleEndTime.toString(),
            saleToken: t.saleTokenAddress,
            purchaseTokens: t.purchaseTokenAddresses,
            totalProvided: t.totalTokenProvided.toString(),
            // totalSold is not exposed via getTierViews — would require an
            // event/subgraph query. v1 leaves this null; caller can derive
            // from getUserViews aggregation.
            totalSold: null as string | null,
            status,
          };
        });

        const counts = {
          upcoming: tiers.filter((t) => t.status === "upcoming").length,
          active: tiers.filter((t) => t.status === "active").length,
          ended: tiers.filter((t) => t.status === "ended").length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${tokenSaleProposal}: ${tiers.length} tier(s) — ${counts.active} active, ${counts.upcoming} upcoming, ${counts.ended} ended (block ts ${nowSec}).`,
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
