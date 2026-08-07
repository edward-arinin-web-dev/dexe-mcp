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
          "/ dexe_get_abi / dexe_find_selector (`dev` toolset).",
      },
      {
        heading: "Toolset gating",
        text:
          "The default DEXE_TOOLSETS profile ('core') carries the reporting reads with no configuration at all: " +
          "dexe_dao_report, dexe_graph_query, dexe_read_dao_list, dexe_read_dao_stats, dexe_read_dao_members, " +
          "dexe_read_token_holders, dexe_read_delegation_map, dexe_read_treasury, dexe_read_settings, " +
          "dexe_proposal_list, dexe_proposal_state, dexe_dao_info, dexe_ipfs_fetch. The long-tail reads " +
          "(dexe_read_multicall, dexe_read_validators, dexe_read_user_activity, dexe_proposal_voters, " +
          "dexe_user_inbox, dexe_read_staking_info, dexe_read_token_sale_*, …) need the 'read' set; " +
          "dexe_sim_calldata needs 'dev'. If a read tool 404s, tell the user to set DEXE_TOOLSETS (e.g. " +
          "'core,read' or 'full') and restart — dexe_context reports which sets are off and what they unlock.",
      },
      {
        heading: "Want a whole report, not one field?",
        text:
          "If the question is 'how is this DAO doing' rather than 'what is this one value', do NOT hand-assemble it " +
          "from these tools — call dexe_dao_report, which gathers identity, settings, treasury, membership, " +
          "delegation, experts, validators, proposals, turnout (who voted, all proposals at once), activity and " +
          "deadlines in ONE call, and can report only what changed since the previous run. Fetch the guide topic " +
          "'report_dao_activity' (dexe_guide flow:\"report_dao_activity\") for the reporting recipe, including " +
          "scheduled/recurring runs.",
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
  {
    id: "report_dao_activity",
    title: "Report on a DAO — activity, members, who voted, statistics (one call, schedulable)",
    // Triggers are deliberately short and generic ("report", "stats",
    // "activity", "monitor"): reporting is what users ASK FOR in their own
    // words, and before 0.31.0 none of those words matched anything at all.
    // They stay disjoint from read_dao_data's ("subgraph", "graphql",
    // "token holders", "protocol stats") so the scorer keeps separating
    // "build me a report" from "how do I query the subgraph".
    triggers: [
      "report",
      "dao report",
      "weekly report",
      "monthly report",
      "weekly digest",
      "daily digest",
      "digest",
      "summary of the dao",
      "stats",
      "activity",
      "who voted",
      "turnout",
      "participation",
      "health check",
      "how is the dao doing",
      "dao doing",
      "monitor",
      "watch the dao",
      "recurring",
      "periodically",
    ],
    summary:
      "Pull a complete DAO report — identity, settings, treasury, membership, delegation, experts, validators, proposals, turnout, activity, deadlines — with ONE dexe_dao_report call, show only what moved via `since`, and run it on a schedule (/schedule cron, /loop interval).",
    sections: [
      {
        heading: "One call, not fifteen",
        text:
          "dexe_dao_report { govPool: \"0x…\", chainId: 56 } returns the whole picture in a single call — eleven " +
          "sections: identity, settings, treasury, membership, delegation (who delegated to whom, no address list " +
          "needed), experts, validators, proposals, turnout (every proposal at once, not one call each), activity, " +
          "deadlines. Do NOT rebuild it by hand from dexe_read_dao_members + dexe_read_treasury + " +
          "dexe_proposal_list + one dexe_proposal_voters per proposal — that is 12-18 calls plus one per proposal, " +
          "and it is exactly what dexe_dao_report replaces. Narrow the work with sections: [\"proposals\", " +
          "\"turnout\"]; pass user: \"0x…\" to add that wallet's unvoted proposals and claimable rewards to " +
          "deadlines; tune proposalLimit (default 30) / memberLimit (default 50). Reach for the individual " +
          "dexe_read_* tools only for a field the report does not carry. The response is typed " +
          "(outputSchema + structuredContent), so render it however the user asked — markdown table, bullet " +
          "digest, one-line health verdict.",
      },
      {
        heading: "Only what changed: the `since` diff",
        text:
          "A recurring report is only useful if it says what MOVED. Pass since: \"last\" and the report fills in " +
          "`changes` against this DAO's previous run — new proposals, proposals that changed state, members " +
          "joined, delegation shifts, treasury deltas — with no bookkeeping on your side: every run persists a " +
          "per-DAO snapshot (persist: false opts out). An explicit anchor also works: ISO-8601 " +
          "(\"2026-08-01T00:00:00Z\"), Unix seconds, or \"block:62000000\". FIRST RUN: since: \"last\" ERRORS when " +
          "no snapshot exists yet — re-run without `since` to lay the baseline down, then use \"last\" from then " +
          "on (say this in any scheduled prompt). Without `since` every run is a full snapshot and the user has to " +
          "spot the deltas themselves — on a schedule that is the difference between a digest and a wall of text.",
      },
      {
        heading: "Chain coverage — say which sections you got",
        text:
          "Subgraph- and backend-backed sections (membership, delegation, turnout, activity, experts) exist for " +
          "BSC MAINNET (56) only. On any other chain each section degrades INDEPENDENTLY: it comes back " +
          "available:false with a reason and a followUp naming the tool to use instead, and is listed in " +
          "`unavailable[]` — never as zero rows. The on-chain sections (identity, settings, proposals, treasury " +
          "via RPC fallback, validators, deadlines) still render. When you relay a report from an unindexed chain, " +
          "say which sections are missing and why; a scheduled run that silently drops half the report is how a " +
          "DAO gets declared healthy while nobody is voting.",
      },
      {
        heading: "Recurring runs (/schedule and /loop)",
        text:
          "`since: \"last\"` is what makes this schedulable. In Claude Code, `/loop 1h call dexe_dao_report " +
          "{govPool:\"0x…\", chainId:56, since:\"last\"} and report only what changed` repeats in THIS session at " +
          "a local interval. `/schedule` creates a CLOUD routine (cron, minimum interval 1 hour, expressions in " +
          "UTC) — it runs in a fresh sandbox with NO access to the local machine, so the dexe MCP server must be " +
          "attached to the routine with its own env, and the prompt must be self-contained (spell out govPool, " +
          "chainId, since, and the output format). A cloud sandbox does not share the local snapshot store, so " +
          "tell the routine to fall back to a full report when since: \"last\" reports no baseline. Full " +
          "paste-able recipes — daily digest, hourly 'needs my vote' watch: docs/REPORTING.md (shipped in the " +
          "package) and the dexe-report skill.",
      },
      {
        heading: "Questions the report does not answer",
        text:
          "For anything custom — a filter, a join, a historical slice, a leaderboard the report does not cut — go " +
          "to dexe_graph_query (default-visible; see topic 'read_dao_data'). NEVER guess an entity or field name: " +
          "read the MCP resource dexe://graph-schema, or call dexe_graph_schema for live introspection — that tool " +
          "is in the 'read' set, so under the default profile the resource is the schema reference. For 'what " +
          "needs MY attention across all my DAOs' use dexe_user_inbox ('read' toolset) rather than one report per DAO.",
      },
    ],
    tools: [
      "dexe_dao_report",
      "dexe_read_dao_stats",
      "dexe_read_dao_members",
      "dexe_read_delegation_map",
      "dexe_read_token_holders",
      "dexe_proposal_voters",
      "dexe_read_user_activity",
      "dexe_read_treasury",
      "dexe_proposal_list",
      "dexe_read_dao_experts",
      "dexe_read_validator_list",
      "dexe_user_inbox",
      "dexe_graph_query",
      "dexe_graph_schema",
    ],
    gotchaIds: ["subgraph-backend-mainnet-only", "graph-bound-first"],
  },
] as const;

/** id → Topic map (validated unique + flow-disjoint in tests/knowledge/integrity.test.ts). */
export const TOPIC_BY_ID: ReadonlyMap<string, Topic> = new Map(TOPICS.map((t) => [t.id, t]));
