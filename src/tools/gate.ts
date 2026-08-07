import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";

/**
 * Toolset gating (Phase 2 / v0.13.0). Registering every tool unconditionally
 * costs ~62K tokens (~255 KB) of `tools/list` per session. `DEXE_TOOLSETS`
 * selects named profiles so a default session loads a slim subset.
 *
 * `TOOLSETS` maps a profile name → the exact tool names it enables. Sets may
 * overlap; the active allowlist is their union. `full` is special — it bypasses
 * filtering entirely (registers everything). The union of all named sets equals
 * the full surface (asserted in tests/tools/gate.test.ts), so every tool is
 * reachable under at least one non-`full` profile.
 *
 * Applied as a one-line wrap in `registerAll()` — the wrapped server proxies
 * `registerTool`/`tool`, dropping any name not in the active allowlist. The 30+
 * register files are unchanged.
 */

/**
 * ── core: the default profile (v0.31.0) ────────────────────────────────────
 *
 * Two jobs, and nothing else:
 *
 *   1. REPORT. Every read a fresh install can actually perform with the shipped
 *      defaults — no API key, no RPC of your own. Before 0.31.0 the subgraph and
 *      analytics reads sat in the `read` set, so "reads work zero-config" was
 *      false for everything except plain on-chain calls, while the README and
 *      the dexe://graph-schema resource advertised exactly those tools. A DAO
 *      health report was unbuildable out of the box.
 *   2. DRIVE THE COMPOSITES. `dexe_proposal_create` takes proposalType + params
 *      and covers every on-chain catalog type, so the ~30 single-purpose
 *      `dexe_proposal_build_*` tools it subsumes are NOT here — they cost ~45 KB
 *      of `tools/list` to duplicate a capability core already has. They live in
 *      `proposals` (DEXE_TOOLSETS=core,proposals restores the pre-0.31 default)
 *      and stay documented in docs/TOOLS.md. `dexe_proposal_catalog` +
 *      `dexe_guide` are in core precisely so an agent can still DISCOVER every
 *      type without loading the builders.
 *
 * tests/tools/default-profile-capability.test.ts pins both halves: the read
 * surface must be here, and every catalog proposal type must remain reachable
 * from this profile through `dexe_proposal_create`.
 */
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
  // on-chain reads + proposal-type discovery for dexe_proposal_create
  "dexe_read_treasury",
  "dexe_read_settings",
  "dexe_proposal_state",
  "dexe_proposal_list",
  "dexe_proposal_catalog",
  "dexe_dao_info",
  "dexe_dao_registry_lookup",
  "dexe_dao_predict_addresses",
  // reporting surface — subgraph + backend analytics, all key-free. These are
  // what "pull a report about a DAO: activity, members, who voted, statistics"
  // resolves to; dexe_dao_report is the one-call composite over them.
  "dexe_dao_report",
  "dexe_graph_query",
  // The recovery path for the most common failure of a tool that IS in core.
  // A bad field name in dexe_graph_query answers with "[recover] … call
  // dexe_graph_schema" (src/tools/subgraph.ts withSchemaRecoveryHint); if the
  // session cannot see that tool, the documented recovery is a 404 and the
  // caller's only remaining move is to guess another field name. Pinned by
  // tests/tools/default-profile-references.test.ts, which fails on ANY tool
  // named from a default description that the default profile does not have.
  "dexe_graph_schema",
  "dexe_read_dao_list",
  "dexe_read_dao_stats",
  "dexe_read_dao_members",
  "dexe_read_token_holders",
  "dexe_read_delegation_map",
  // reports resolve IPFS metadata pointers (DAO profile, proposal descriptions)
  "dexe_ipfs_fetch",
];

/**
 * ── proposals: every single-purpose builder + the offchain/auth surface ─────
 *
 * NOT in the default profile since v0.31.0. `dexe_proposal_create` (core) covers
 * every on-chain catalog type via proposalType + params, so loading these by
 * default paid ~45 KB of `tools/list` for a second way to do the same thing.
 * Opt in with DEXE_TOOLSETS=core,proposals when you want the raw calldata
 * builders — e.g. to inspect actions before creating, to hand-assemble a
 * multi-action proposal, or for the off-chain (backend API) types, which the
 * composite deliberately refuses and signposts here.
 */
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

/**
 * ── read: chain + subgraph reads, inbox/forecast/risk, IPFS reads ───────────
 *
 * The zero-config reporting subset of this list is ALSO in `core` (sets may
 * overlap) — `read` remains the "give me every read tool" profile, including the
 * long-tail ones a report doesn't need.
 */
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
  // Also in `core` (sets overlap) — it is the recovery path for a core tool's
  // most common failure, so it cannot be gated behind an env var. The static
  // dexe://graph-schema resource covers the same ground for anyone reading
  // rather than calling, but a resource cannot be reached from an error string
  // the model is acting on.
  "dexe_graph_schema",
  "dexe_dao_report",
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
  // agent keyring (multi-persona/swarm signing surface)
  "dexe_agents_list",
  "dexe_agents_fund",
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

/**
 * Default profiles when `DEXE_TOOLSETS` is unset.
 *
 * v0.13.0 made this `core,proposals`; v0.31.0 narrows it to `core` alone. The
 * `proposals` half was ~45 KB of `tools/list` spent on builders that
 * `dexe_proposal_create` already subsumes, which left no room for the reads a
 * report needs. Nothing is lost: `DEXE_TOOLSETS=core,proposals` restores the
 * previous default exactly, and every demoted builder stays documented in
 * docs/TOOLS.md.
 */
export const DEFAULT_TOOLSETS = ["core"] as const;

/**
 * The tool names a session sees when `DEXE_TOOLSETS` is unset. Callers that need
 * to answer "is this tool visible by default?" (knowledge annotations, doctor,
 * `dexe_context`) must use this instead of hardcoding the profile names, so the
 * answer can never drift from `DEFAULT_TOOLSETS`.
 */
export function defaultProfileToolNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const set of DEFAULT_TOOLSETS) for (const n of TOOLSETS[set]!) names.add(n);
  return names;
}

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
 * Resolve the requested profiles into a concrete allowlist. Only an explicit
 * `full` bypasses filtering. Unknown set names are DROPPED (loudly, by the
 * caller) and the recognized ones still apply — a typo in one entry must not
 * dump the entire surface (~62K tokens) plus the dev/write sets the user never
 * asked for. When nothing recognizable remains, fall back to the
 * defaults rather than registering nothing. Pure — no side effects.
 */
export function resolveToolsets(requested: readonly string[]): ResolvedToolsets {
  const req = requested.length > 0 ? [...requested] : [...DEFAULT_TOOLSETS];
  const unknown = req.filter((s) => s !== "full" && !(s in TOOLSETS));
  if (req.includes("full")) {
    return { names: null, unknown, full: true, requested: req };
  }
  const known = req.filter((s) => s in TOOLSETS);
  const effective = known.length > 0 ? known : [...DEFAULT_TOOLSETS];
  const names = new Set<string>();
  for (const s of effective) for (const n of TOOLSETS[s]!) names.add(n);
  return { names, unknown, full: false, requested: effective };
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
      `[dexe-mcp] unknown DEXE_TOOLSETS: [${resolved.unknown.join(", ")}] — ignored. ` +
        `Active: [${resolved.full ? "full" : resolved.requested.join(", ")}]. ` +
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
