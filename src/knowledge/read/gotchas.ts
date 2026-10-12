import type { Gotcha } from "../types.js";

/**
 * The READ gotchas: rules an agent needs to read DeXe data correctly — the two
 * quorum units, chain coverage of the subgraph and backend, bounding a graph
 * query, and the multicall input contract. No step journey, no signer.
 *
 * Served by the read topics, and cited by id from write flows too: the write
 * corpus (../write/gotchas.ts) imports these instead of copying them, so a
 * correction lands in one place.
 *
 * Same authoring rules as the rest of the corpus (../types.ts): self-contained
 * imperatives, tool names spelled out, corrected rules only. Read text must
 * not route an agent to a write-edition tool (tests/knowledge/corpus-split.test.ts).
 */
export const READ_GOTCHAS: readonly Gotcha[] = [
  // ── quorum units ──────────────────────────────────────────────────────────
  {
    // D1 audit 2026-09-11 (D1-3): dexe_proposal_forecast divided token-wei votes
    // by the raw 1e25-scaled SETTING. Protocol truth: GovPoolVote._quorumReached
    // (per-side) and GovPool.getProposalRequiredQuorum (absolute weight, 0 when
    // the proposal does not exist / has not started).
    id: "quorum-two-units",
    severity: "warn",
    text:
      "DeXe expresses quorum in TWO units and mixing them is the classic error. (1) The SETTING — " +
      "GovSettings.getDefaultSettings().quorum, the pools subgraph's Proposal.quorum, and the raw " +
      "`quorum`/`quorumSettingRaw` on dexe_read_settings and dexe_dao_report — is a PERCENTAGE scaled by 1e25 " +
      "(5e26 = 50%); read it as `quorumPct`/`quorumSettingPct`. (2) The TARGET — GovPool." +
      "getProposalRequiredQuorum(id), the `requiredQuorum` field on getProposals rows, dexe_proposal_state and " +
      "dexe_proposal_list — is an ABSOLUTE vote weight in token wei, equal to GovUserKeeper.getTotalPower() × " +
      "setting / 1e27. Compare votes ONLY against the TARGET; against the SETTING you are off by " +
      "totalPower/1e27 — orders of magnitude, in either direction. Quorum is also per-SIDE: " +
      "GovPoolVote._quorumReached is true when EITHER votesFor OR votesAgainst clears the target, never their " +
      "sum. getProposalRequiredQuorum returns 0 for a proposal that does not exist or has not started — treat " +
      "0 as unknown, never as \"already reached\".",
    applies: {
      tools: [
        "dexe_proposal_state",
        "dexe_proposal_list",
        "dexe_proposal_forecast",
        "dexe_dao_report",
        "dexe_read_settings",
        "dexe_graph_query",
      ],
    },
  },

  // ── reading / querying data ───────────────────────────────────────────────
  {
    // docs/GRAPH.md ground rules; GRAPH_QUERY_MAX_RESPONSE_CHARS in subgraph.ts
    id: "graph-bound-first",
    severity: "warn",
    text:
      "ALWAYS bound dexe_graph_query list fields with `first:` (gateway max 1000) and paginate with `skip:` — " +
      "responses over 120000 chars are rejected outright, so an unbounded query fails instead of streaming. " +
      "Entity ids are lowercased concatenated bytes (e.g. proposal id = poolAddress + uint32-LE(proposalId), no " +
      "separator); relation filters use the `_` suffix (pool_: {id: \"0x…\"}). Full entity/field reference: MCP " +
      "resource dexe://graph-schema.",
    applies: { tools: ["dexe_graph_query"] },
  },
  {
    // reference_bsc_testnet.md — no subgraph/backend on 97
    id: "subgraph-backend-mainnet-only",
    severity: "warn",
    text:
      "Subgraph and DeXe-backend data exist for BSC MAINNET (56) only. Every subgraph-backed tool takes `chainId` " +
      "and REFUSES a chain it has no endpoint for — it never answers from another chain, so a testnet call errors " +
      "loudly instead of handing back mainnet rows. The error names the chains that are indexed, the on-chain " +
      "alternatives, and the env var to set. Affected: dexe_graph_query, dexe_read_dao_list, dexe_read_dao_members, " +
      "dexe_read_delegation_map, dexe_read_dao_experts, dexe_read_validator_list, dexe_read_user_activity, " +
      "dexe_proposal_voters, dexe_user_inbox (auto-discovery only — pass `daos: [\"0x…\"]` to scan any chain), " +
      "dexe_proposal_forecast. Backend-only tools (dexe_read_token_holders, dexe_read_dao_stats, " +
      "dexe_read_protocol_stats, dexe_read_nfts) stay mainnet-only. For testnet DAOs read on-chain instead: " +
      "dexe_read_gov_state, dexe_read_settings, dexe_proposal_state, dexe_read_multicall (dexe_read_treasury falls " +
      "back to RPC automatically). Every subgraph response carries `indexedChainId` — the chain the rows came from. " +
      "To index another chain yourself set DEXE_SUBGRAPH_<KIND>_URL_<chainId> (e.g. DEXE_SUBGRAPH_POOLS_URL_97).",
    applies: {
      tools: [
        "dexe_graph_query",
        "dexe_read_dao_list",
        "dexe_read_dao_members",
        "dexe_read_delegation_map",
        "dexe_read_dao_experts",
        "dexe_read_validator_list",
        "dexe_read_user_activity",
        "dexe_read_token_holders",
        "dexe_read_dao_stats",
        "dexe_read_protocol_stats",
        "dexe_read_nfts",
        "dexe_proposal_voters",
      ],
    },
  },
  {
    // src/tools/read.ts registerReadMulticall input contract
    id: "multicall-signature-form",
    severity: "info",
    text:
      "dexe_read_multicall calls need the FULL function fragment as `signature` — " +
      "'function balanceOf(address) view returns (uint256)', not just a name or selector — plus `target`, `method`, " +
      "and `args`. Any contract address works (no allowlist); all calls in one request are batched into a single " +
      "RPC round-trip. Do not guess a DeXe fragment: dexe_list_gov_contract_types names each governance contract, " +
      "and dexe_decode_calldata shows the exact function a known calldata calls (`dev` toolset).",
    applies: { tools: ["dexe_read_multicall"] },
  },
] as const;

/** id → Gotcha map over the read corpus. */
export const READ_GOTCHA_BY_ID: ReadonlyMap<string, Gotcha> = new Map(READ_GOTCHAS.map((g) => [g.id, g]));
