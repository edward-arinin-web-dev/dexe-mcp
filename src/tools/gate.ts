import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";

/**
 * Toolset gating (Phase 2 / v0.13.0). Registering all 160 tools unconditionally
 * costs ~50K tokens (~206 KB) of `tools/list` per session. `DEXE_TOOLSETS`
 * selects named profiles so a default session loads a slim subset.
 *
 * `TOOLSETS` maps a profile name → the exact tool names it enables. Sets may
 * overlap; the active allowlist is their union. `full` is special — it bypasses
 * filtering entirely (registers everything). The union of all named sets equals
 * the full 159-tool surface (asserted in tests/tools/gate.test.ts), so every
 * tool is reachable under at least one non-`full` profile.
 *
 * Applied as a one-line wrap in `registerAll()` — the wrapped server proxies
 * `registerTool`/`tool`, dropping any name not in the active allowlist. The 30+
 * register files are unchanged.
 */

// ── core: the everyday flow surface (~one session's worth) ──────────────────
const CORE = [
  "dexe_context",
  "dexe_guide",
  "dexe_doctor",
  "dexe_get_config",
  // composite signing flows
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_dao_create",
  // OTC composites
  "dexe_otc_dao_open_sale",
  "dexe_otc_buyer_status",
  "dexe_otc_buyer_buy",
  "dexe_otc_buyer_claim_all",
  "dexe_otc_list_sales_for_dao",
  // broadcast + walletconnect
  "dexe_tx_send",
  "dexe_tx_status",
  "dexe_wc_status",
  "dexe_wc_connect",
  "dexe_wc_disconnect",
  // key vote builders (deposit/withdraw/vote/execute/approve) + power read
  "dexe_vote_build_deposit",
  "dexe_vote_build_withdraw",
  "dexe_vote_build_vote",
  "dexe_vote_build_execute",
  "dexe_vote_build_erc20_approve",
  "dexe_vote_user_power",
  // IPFS upload essentials + avatar
  "dexe_ipfs_upload_file",
  "dexe_ipfs_upload_avatar",
  "dexe_ipfs_upload_proposal_metadata",
  "dexe_dao_generate_avatar",
  // common reads
  "dexe_read_treasury",
  "dexe_read_settings",
  "dexe_proposal_state",
  "dexe_proposal_list",
  "dexe_proposal_catalog",
  "dexe_dao_info",
  "dexe_dao_registry_lookup",
  "dexe_dao_predict_addresses",
];

// ── proposals: every builder + the offchain/auth surface + proposal IPFS ────
const PROPOSALS = [
  // proposalBuild.ts
  "dexe_proposal_catalog",
  "dexe_proposal_build_external",
  "dexe_proposal_build_internal",
  "dexe_proposal_build_custom_abi",
  "dexe_proposal_build_offchain",
  "dexe_proposal_build_token_transfer",
  // proposalBuildComplex.ts
  "dexe_proposal_build_token_distribution",
  "dexe_proposal_build_token_sale_multi",
  "dexe_proposal_build_token_sale",
  "dexe_proposal_build_token_sale_whitelist",
  "dexe_proposal_build_token_sale_recover",
  "dexe_proposal_build_create_staking_tier",
  "dexe_proposal_build_change_math_model",
  "dexe_proposal_build_modify_dao_profile",
  "dexe_proposal_build_blacklist",
  "dexe_proposal_build_reward_multiplier",
  "dexe_proposal_build_apply_to_dao",
  "dexe_proposal_build_new_proposal_type",
  // proposalBuildInternal.ts
  "dexe_proposal_build_change_validator_balances",
  "dexe_proposal_build_change_validator_settings",
  "dexe_proposal_build_monthly_withdraw",
  "dexe_proposal_build_offchain_internal_proposal",
  // proposalBuildMore.ts
  "dexe_proposal_build_change_voting_settings",
  "dexe_proposal_build_manage_validators",
  "dexe_proposal_build_add_expert",
  "dexe_proposal_build_remove_expert",
  "dexe_proposal_build_withdraw_treasury",
  "dexe_proposal_build_delegate_to_expert",
  "dexe_proposal_build_revoke_from_expert",
  // proposalBuildOffchain.ts (+ backend auth)
  "dexe_auth_request_nonce",
  "dexe_auth_login_request",
  "dexe_auth_login",
  "dexe_proposal_build_offchain_single_option",
  "dexe_proposal_build_offchain_multi_option",
  "dexe_proposal_build_offchain_for_against",
  "dexe_proposal_build_offchain_settings",
  "dexe_offchain_build_vote",
  "dexe_offchain_build_cancel_vote",
  // IPFS writes proposals need
  "dexe_ipfs_upload_proposal_metadata",
  "dexe_ipfs_upload_dao_metadata",
  "dexe_ipfs_upload_file",
  "dexe_ipfs_update_dao_metadata",
];

// ── read: chain + subgraph reads, inbox/forecast/risk, IPFS reads ───────────
const READ = [
  // read.ts
  "dexe_read_multicall",
  "dexe_read_treasury",
  "dexe_read_token_holders",
  "dexe_read_dao_stats",
  "dexe_read_nfts",
  "dexe_read_validators",
  "dexe_read_settings",
  "dexe_read_protocol_stats",
  "dexe_read_expert_status",
  "dexe_read_token_sale_tiers",
  "dexe_read_token_sale_user",
  "dexe_read_distribution_status",
  "dexe_read_staking_info",
  "dexe_read_privacy_policy_status",
  // subgraph.ts
  "dexe_read_dao_list",
  "dexe_read_dao_members",
  "dexe_read_delegation_map",
  "dexe_read_validator_list",
  "dexe_read_user_activity",
  "dexe_read_dao_experts",
  "dexe_otc_list_sales_for_dao",
  "dexe_graph_query",
  // proposal.ts
  "dexe_proposal_state",
  "dexe_proposal_list",
  "dexe_proposal_voters",
  // inbox / predict / risk
  "dexe_user_inbox",
  "dexe_proposal_forecast",
  "dexe_proposal_risk_assess",
  // dao.ts
  "dexe_dao_info",
  "dexe_dao_registry_lookup",
  "dexe_dao_predict_addresses",
  // IPFS reads
  "dexe_ipfs_fetch",
  "dexe_ipfs_cid_info",
  "dexe_ipfs_cid_for_json",
];

// ── vote: every direct vote/stake/delegate/execute/claim builder ────────────
const VOTE = [
  "dexe_vote_build_erc20_approve",
  "dexe_vote_build_deposit",
  "dexe_vote_build_withdraw",
  "dexe_vote_build_delegate",
  "dexe_vote_build_undelegate",
  "dexe_vote_build_vote",
  "dexe_vote_build_cancel_vote",
  "dexe_vote_build_validator_vote",
  "dexe_vote_build_validator_cancel_vote",
  "dexe_vote_build_move_to_validators",
  "dexe_vote_build_execute",
  "dexe_vote_build_claim_rewards",
  "dexe_vote_build_claim_micropool_rewards",
  "dexe_vote_build_nft_multiplier_lock",
  "dexe_vote_build_nft_multiplier_unlock",
  "dexe_vote_build_token_sale_buy",
  "dexe_vote_build_token_sale_claim",
  "dexe_vote_build_token_sale_vesting_withdraw",
  "dexe_vote_build_distribution_claim",
  "dexe_vote_build_staking_stake",
  "dexe_vote_build_staking_claim",
  "dexe_vote_build_staking_claim_all",
  "dexe_vote_build_staking_reclaim",
  "dexe_vote_build_privacy_policy_sign",
  "dexe_vote_build_privacy_policy_agree",
  "dexe_vote_build_multicall",
  "dexe_vote_user_power",
  "dexe_vote_get_votes",
];

// ── governor: external OpenZeppelin/Bravo Governor surface ───────────────────
const GOVERNOR = [
  "dexe_gov_build_propose",
  "dexe_gov_build_vote_cast",
  "dexe_gov_build_queue",
  "dexe_gov_build_execute",
  "dexe_gov_build_delegate",
  "dexe_gov_get_state",
  "dexe_gov_has_voted",
  "dexe_gov_build_cancel",
  "dexe_gov_decode_calldata",
  "dexe_gov_hash_description",
  "dexe_gov_hash_proposal",
  "dexe_gov_list_governors",
  "dexe_gov_get_proposal",
  "dexe_gov_get_voting_power",
  "dexe_gov_get_quorum",
  "dexe_gov_get_proposal_threshold",
  "dexe_gov_simulate_proposal",
  "dexe_gov_simulate_vote_impact",
];

// ── dev: Solidity dev tooling, introspection, decode, sim, merkle, safe, deploy
const DEV = [
  // build.ts
  "dexe_compile",
  "dexe_test",
  "dexe_coverage",
  "dexe_lint",
  // introspect.ts
  "dexe_list_contracts",
  "dexe_get_abi",
  "dexe_get_methods",
  "dexe_get_selectors",
  "dexe_find_selector",
  "dexe_get_natspec",
  "dexe_get_source",
  // gov.ts (decode + gov-state read + introspection)
  "dexe_decode_calldata",
  "dexe_decode_proposal",
  "dexe_read_gov_state",
  "dexe_list_gov_contract_types",
  // simulate.ts
  "dexe_sim_calldata",
  "dexe_sim_proposal",
  "dexe_sim_buy",
  // merkle.ts
  "dexe_merkle_build",
  "dexe_merkle_proof",
  // safe.ts
  "dexe_safe_info",
  "dexe_safe_propose_tx",
  // low-level deploy (dexe_dao_create is the recommended composite in `core`)
  "dexe_dao_build_deploy",
];

export const TOOLSETS: Record<string, Set<string>> = {
  core: new Set(CORE),
  proposals: new Set(PROPOSALS),
  read: new Set(READ),
  vote: new Set(VOTE),
  governor: new Set(GOVERNOR),
  dev: new Set(DEV),
};

/** Default profiles when `DEXE_TOOLSETS` is unset (breaking change in v0.13.0). */
export const DEFAULT_TOOLSETS = ["core", "proposals"] as const;

export interface ResolvedToolsets {
  /** Active allowlist, or null when everything should register (`full`). */
  names: Set<string> | null;
  /** Set names that weren't recognized. */
  unknown: string[];
  /** True when filtering is bypassed (explicit `full` or unknown-name fallback). */
  full: boolean;
  /** The requested profiles (post-default). */
  requested: string[];
}

/**
 * Resolve the requested profiles into a concrete allowlist. An explicit `full`
 * OR any unknown set name → `full` (register everything) so a typo never
 * silently strips the toolset. Pure — no side effects.
 */
export function resolveToolsets(requested: readonly string[]): ResolvedToolsets {
  const req = requested.length > 0 ? [...requested] : [...DEFAULT_TOOLSETS];
  const unknown = req.filter((s) => s !== "full" && !(s in TOOLSETS));
  if (req.includes("full") || unknown.length > 0) {
    return { names: null, unknown, full: true, requested: req };
  }
  const names = new Set<string>();
  for (const s of req) for (const n of TOOLSETS[s]!) names.add(n);
  return { names, unknown, full: false, requested: req };
}

/**
 * Wrap `server` so tool registrations for names outside the active allowlist
 * are dropped. Returns the original server unchanged when the active profile is
 * `full`. Emits a one-line stderr banner. Call once in `registerAll`.
 */
export function applyToolGate(server: McpServer, config: DexeConfig): McpServer {
  const resolved = resolveToolsets(config.toolsets ?? [...DEFAULT_TOOLSETS]);

  if (resolved.unknown.length > 0) {
    process.stderr.write(
      `[dexe-mcp] unknown DEXE_TOOLSETS: [${resolved.unknown.join(", ")}] — loading all tools (full). ` +
        `Valid sets: ${Object.keys(TOOLSETS).join(", ")}, full.\n`,
    );
  }
  if (resolved.full) {
    process.stderr.write(`[dexe-mcp] toolsets: full — all tools loaded.\n`);
    return server;
  }

  const allow = resolved.names!;
  process.stderr.write(
    `[dexe-mcp] toolsets: [${resolved.requested.join(", ")}] → ${allow.size} tools loaded ` +
      `(set DEXE_TOOLSETS=full to load all, or add sets: ${Object.keys(TOOLSETS).join(", ")}).\n`,
  );

  const wrap = (fn: (...a: unknown[]) => unknown) =>
    (name: unknown, ...rest: unknown[]) => {
      if (typeof name === "string" && !allow.has(name)) return undefined;
      return fn(name, ...rest);
    };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool" || prop === "tool") {
        const original = Reflect.get(target, prop, receiver) as
          | ((...a: unknown[]) => unknown)
          | undefined;
        if (typeof original !== "function") return original;
        return wrap(original.bind(target));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as McpServer;
}
