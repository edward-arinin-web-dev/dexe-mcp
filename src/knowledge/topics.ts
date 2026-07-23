import type { Topic } from "./types.js";

/**
 * Reference topics — knowledge that is not a step journey. Flows answer
 * "how do I DO X"; topics answer "how do I FIND OUT X". Same authoring rules
 * as flows: self-contained text, tool names spelled out, corrected rules only.
 */
export const TOPICS: readonly Topic[] = [
  {
    id: "read_dao_data",
    title: "Read / query DAO data (subgraph, backend API, on-chain)",
    triggers: [
      "query dao data",
      "subgraph",
      "graphql",
      "graph query",
      "analytics",
      "token holders",
      "protocol stats",
      "dao statistics",
      "who delegated",
      "nfts held",
      "read contract state",
      "voter history",
    ],
    summary:
      "Reference for the whole read surface: free-form subgraph queries via dexe_graph_query, anonymous backend REST reads (stats/holders/NFTs), and free-form on-chain reads via dexe_read_multicall — with bounds, chain coverage, and toolset gating.",
    sections: [
      {
        heading: "Pick the right source",
        text:
          "Prefer the structured dexe_read_* tools first (dexe_read_dao_members, dexe_read_treasury, " +
          "dexe_read_user_activity, dexe_proposal_voters, …) — they return shaped, documented payloads. Reach for " +
          "dexe_graph_query when no structured tool covers the question (custom filters, joins, historical slices). " +
          "Use dexe_read_multicall for arbitrary on-chain contract state, and dexe_sim_calldata to dry-run calldata " +
          "without broadcasting. ALL reads are anonymous: no signer, no private key, no API key required.",
      },
      {
        heading: "Subgraph querying (dexe_graph_query)",
        text:
          "Free-form read-only GraphQL against three subgraphs. subgraph='pools': DaoPool, Proposal, Voter, " +
          "VoterInPool, VoterInPoolPair, ProposalInteraction, TokenSaleTier, ExpertNft, DelegationHistory. " +
          "subgraph='interactions': Transaction feed by type plus per-event entities (DaoPoolCreate, " +
          "DaoPoolDelegate, DaoPoolExecute, DaoPoolVest, DaoProposalCreate, …). subgraph='validators': " +
          "ValidatorInPool, Proposal, ValidatorInProposal. Bound every list with first: (max 1000) and paginate " +
          "with skip:; responses over 120000 chars are rejected. Data covers BSC MAINNET ONLY. The full " +
          "entity/field reference (id conventions, enums, worked queries) is the MCP resource dexe://graph-schema " +
          "(docs/GRAPH.md in the package).",
      },
      {
        heading: "Backend REST reads (anonymous, mainnet)",
        text:
          "Fixed wrappers over the DeXe backend — no auth needed: dexe_read_treasury (every token a wallet/DAO " +
          "holds with USD values; falls back to on-chain RPC on testnet or when the backend is down), " +
          "dexe_read_token_holders (top ERC20 holders, balance-desc), dexe_read_dao_stats (per-DAO TVL/member/" +
          "proposal time series by period), dexe_read_protocol_stats (protocol-wide TVL/DAO/proposal totals, " +
          "chains 1+56, top DAOs), dexe_read_nfts (NFTs held by an address). There is no free-form backend " +
          "endpoint tool by design. Backend-only tools fail or return empty on testnet 97.",
      },
      {
        heading: "Free-form contract reads",
        text:
          "dexe_read_multicall reads ANY contract: each call is {target, signature, method, args} where signature " +
          "is the full fragment 'function balanceOf(address) view returns (uint256)'; all calls batch into one RPC " +
          "round-trip. dexe_sim_calldata (dev toolset) eth_call-simulates arbitrary {to, data, value} and decodes " +
          "revert reasons. To discover DeXe contract methods: dexe_compile once per session, then dexe_get_methods " +
          "/ dexe_get_abi / dexe_find_selector (devtools toolset).",
      },
      {
        heading: "Toolset gating",
        text:
          "The default DEXE_TOOLSETS profile ('core,proposals') exposes only a few reads (dexe_read_treasury, " +
          "dexe_read_settings, dexe_proposal_state, dexe_proposal_list, dexe_dao_info). dexe_graph_query and the " +
          "rest of the dexe_read_* surface need the 'read' set; dexe_sim_calldata needs 'dev'. If a read tool 404s, " +
          "tell the user to set DEXE_TOOLSETS (e.g. 'core,proposals,read' or 'full') and restart — dexe_context " +
          "reports which sets are off.",
      },
    ],
    tools: [
      "dexe_graph_query",
      "dexe_read_dao_list",
      "dexe_read_dao_members",
      "dexe_read_delegation_map",
      "dexe_read_user_activity",
      "dexe_read_treasury",
      "dexe_read_token_holders",
      "dexe_read_dao_stats",
      "dexe_read_protocol_stats",
      "dexe_read_nfts",
      "dexe_read_multicall",
      "dexe_sim_calldata",
      "dexe_proposal_voters",
    ],
    gotchaIds: ["subgraph-backend-mainnet-only", "graph-bound-first", "multicall-signature-form"],
  },
] as const;

/** id → Topic map (validated unique + flow-disjoint in tests/knowledge/integrity.test.ts). */
export const TOPIC_BY_ID: ReadonlyMap<string, Topic> = new Map(TOPICS.map((t) => [t.id, t]));
