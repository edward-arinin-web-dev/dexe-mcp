import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ── MCP tool annotations, in one place ─────────────────────────────────────
 *
 * Without `annotations` the MCP spec makes a host assume the WORST about every
 * tool: `readOnlyHint` defaults to false, `destructiveHint` to true,
 * `openWorldHint` to true. So a server that declares nothing tells a
 * conformant client that `dexe_read_treasury` is exactly as dangerous as
 * `dexe_tx_send`. This module is the single source of truth that says
 * otherwise, applied by one wrapper at registration time
 * (`applyToolAnnotations`, wired in src/tools/index.ts) so no register file
 * has to remember anything.
 *
 * ONLY SPEC-MEANINGFUL FIELDS ARE EMITTED. `destructiveHint` and
 * `idempotentHint` are defined as meaningful only when `readOnlyHint` is
 * false, and `openWorldHint` already defaults to true — so a read tool needs
 * exactly one key. That is not cosmetic: `tools/list` for the default profile
 * is budgeted (tests/tools/gate.test.ts) and the four-key form costs ~103 B
 * per tool where the one-key form costs 36 B.
 *
 * CLASSIFICATION IS EXHAUSTIVE, NOT DEFAULTED. There is no fall-through: a
 * name absent from `TOOL_CLASSES` gets NO annotations, which leaves the
 * conservative spec default in place instead of falsely claiming read-only,
 * and tests/tools/annotations.test.ts fails on it by name. Any new tool must
 * be classified here by a human.
 */

/** Reads chain / subgraph / backend / IPFS. Open world is the spec default. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

/** Pure compute over local artifacts, the bundled corpus, or the arguments. */
const LOCAL_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Signs and sends (or queues for co-signers). Moves funds or DAO state. */
const BROADCAST: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/** Writes to a remote service without destroying anything: pins, sessions, logins. */
const REMOTE_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

/** Writes local hardhat artifacts / cache under DEXE_PROTOCOL_PATH. */
const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/**
 * Every registered tool name → its class. Grouped by class so a reviewer can
 * read the dangerous half in one glance. Keep alphabetical within a group.
 *
 * ANY NEW TOOL THAT SIGNS, PINS, POSTS OR SHELLS OUT MUST BE ADDED HERE.
 * Leaving a tool out is caught by "every registered tool is explicitly
 * classified" in tests/tools/annotations.test.ts.
 */
const TOOL_CLASSES: Record<string, ToolAnnotations> = {
  // ── BROADCAST — signs a transaction and sends it, or queues one others execute.
  dexe_agents_fund: BROADCAST,
  dexe_dao_create: BROADCAST,
  dexe_otc_buyer_buy: BROADCAST,
  dexe_otc_buyer_claim_all: BROADCAST,
  dexe_otc_dao_open_sale: BROADCAST,
  dexe_proposal_create: BROADCAST,
  dexe_proposal_vote_and_execute: BROADCAST,
  // signs the safeTxHash with the configured key and POSTs a multisig tx the
  // owners then execute (src/tools/safe.ts) — dexe_tx_send with a delay, not a
  // session op.
  dexe_safe_propose_tx: BROADCAST,
  dexe_tx_send: BROADCAST,

  // ── REMOTE_WRITE — mutates something outside this machine, destroys nothing.
  // IPFS pins are content-addressed, so a re-run converges instead of clobbering.
  dexe_auth_login: REMOTE_WRITE, // signs a nonce and POSTs it to the DeXe backend
  dexe_dao_generate_avatar: REMOTE_WRITE, // renders a JPEG and pins it
  dexe_ipfs_update_dao_metadata: REMOTE_WRITE,
  dexe_ipfs_upload_avatar: REMOTE_WRITE,
  dexe_ipfs_upload_dao_metadata: REMOTE_WRITE,
  dexe_ipfs_upload_file: REMOTE_WRITE,
  dexe_ipfs_upload_proposal_metadata: REMOTE_WRITE,
  dexe_wc_connect: REMOTE_WRITE, // opens a wallet session; signs nothing by itself
  dexe_wc_disconnect: REMOTE_WRITE,

  // ── LOCAL_WRITE — runs hardhat in DEXE_PROTOCOL_PATH, writes artifacts/cache.
  dexe_compile: LOCAL_WRITE,
  dexe_coverage: LOCAL_WRITE,
  dexe_lint: LOCAL_WRITE,
  dexe_test: LOCAL_WRITE,

  // ── LOCAL_READ — no network at all: local artifacts, the bundled knowledge
  // corpus, static catalogs, or pure encode/decode/hash of the arguments.
  dexe_auth_login_request: LOCAL_READ, // returns an HTTP request; does not send it
  dexe_auth_request_nonce: LOCAL_READ, // same — only dexe_auth_login dispatches
  dexe_decode_calldata: LOCAL_READ,
  dexe_find_selector: LOCAL_READ,
  dexe_get_abi: LOCAL_READ,
  dexe_get_config: LOCAL_READ,
  dexe_get_methods: LOCAL_READ,
  dexe_get_natspec: LOCAL_READ,
  dexe_get_selectors: LOCAL_READ,
  dexe_get_source: LOCAL_READ,
  dexe_gov_decode_calldata: LOCAL_READ,
  dexe_gov_hash_description: LOCAL_READ,
  dexe_gov_hash_proposal: LOCAL_READ,
  dexe_graph_schema: LOCAL_READ, // static entity reference, not a subgraph call
  dexe_guide: LOCAL_READ,
  dexe_ipfs_cid_for_json: LOCAL_READ,
  dexe_ipfs_cid_info: LOCAL_READ,
  dexe_list_contracts: LOCAL_READ,
  dexe_list_gov_contract_types: LOCAL_READ,
  dexe_merkle_build: LOCAL_READ,
  dexe_merkle_proof: LOCAL_READ,
  dexe_proposal_catalog: LOCAL_READ,

  // ── READ_ONLY — reads chain / subgraph / backend / IPFS and returns.
  // Calldata builders live here too: they return an unsigned payload and never
  // send it, but several DO read the chain while building (blacklist checks,
  // prerequisite resolution), so openWorldHint stays at its true default.
  dexe_agents_ledger: READ_ONLY,
  dexe_agents_list: READ_ONLY,
  dexe_context: READ_ONLY,
  dexe_dao_build_deploy: READ_ONLY,
  dexe_dao_info: READ_ONLY,
  dexe_dao_predict_addresses: READ_ONLY,
  dexe_dao_registry_lookup: READ_ONLY,
  // writes a snapshot under the state dir as a diff baseline — an internal
  // cache, not user state; the tool has always described itself as read-only.
  dexe_dao_report: READ_ONLY,
  dexe_decode_proposal: READ_ONLY,
  dexe_doctor: READ_ONLY,
  dexe_gov_build_cancel: READ_ONLY,
  dexe_gov_build_delegate: READ_ONLY,
  dexe_gov_build_execute: READ_ONLY,
  dexe_gov_build_propose: READ_ONLY,
  dexe_gov_build_queue: READ_ONLY,
  dexe_gov_build_vote_cast: READ_ONLY,
  dexe_gov_get_proposal: READ_ONLY,
  dexe_gov_get_proposal_threshold: READ_ONLY,
  dexe_gov_get_quorum: READ_ONLY,
  dexe_gov_get_state: READ_ONLY,
  dexe_gov_get_voting_power: READ_ONLY,
  dexe_gov_has_voted: READ_ONLY,
  dexe_gov_list_governors: READ_ONLY,
  dexe_gov_simulate_proposal: READ_ONLY,
  dexe_gov_simulate_vote_impact: READ_ONLY,
  dexe_graph_query: READ_ONLY,
  dexe_ipfs_fetch: READ_ONLY,
  dexe_offchain_build_cancel_vote: READ_ONLY,
  dexe_offchain_build_vote: READ_ONLY,
  dexe_otc_buyer_status: READ_ONLY,
  dexe_otc_list_sales_for_dao: READ_ONLY,
  dexe_proposal_build_add_expert: READ_ONLY,
  dexe_proposal_build_apply_to_dao: READ_ONLY,
  dexe_proposal_build_blacklist: READ_ONLY,
  dexe_proposal_build_change_math_model: READ_ONLY,
  dexe_proposal_build_change_validator_balances: READ_ONLY,
  dexe_proposal_build_change_validator_settings: READ_ONLY,
  dexe_proposal_build_change_voting_settings: READ_ONLY,
  dexe_proposal_build_create_staking_tier: READ_ONLY,
  dexe_proposal_build_custom_abi: READ_ONLY,
  dexe_proposal_build_delegate_to_expert: READ_ONLY,
  dexe_proposal_build_external: READ_ONLY,
  dexe_proposal_build_internal: READ_ONLY,
  dexe_proposal_build_manage_validators: READ_ONLY,
  dexe_proposal_build_modify_dao_profile: READ_ONLY,
  dexe_proposal_build_monthly_withdraw: READ_ONLY,
  dexe_proposal_build_new_proposal_type: READ_ONLY,
  dexe_proposal_build_offchain: READ_ONLY,
  dexe_proposal_build_offchain_for_against: READ_ONLY,
  dexe_proposal_build_offchain_internal_proposal: READ_ONLY,
  dexe_proposal_build_offchain_multi_option: READ_ONLY,
  dexe_proposal_build_offchain_settings: READ_ONLY,
  dexe_proposal_build_offchain_single_option: READ_ONLY,
  dexe_proposal_build_remove_expert: READ_ONLY,
  dexe_proposal_build_revoke_from_expert: READ_ONLY,
  dexe_proposal_build_reward_multiplier: READ_ONLY,
  dexe_proposal_build_token_distribution: READ_ONLY,
  dexe_proposal_build_token_sale: READ_ONLY,
  dexe_proposal_build_token_sale_multi: READ_ONLY,
  dexe_proposal_build_token_sale_recover: READ_ONLY,
  dexe_proposal_build_token_sale_whitelist: READ_ONLY,
  dexe_proposal_build_token_transfer: READ_ONLY,
  dexe_proposal_build_withdraw_treasury: READ_ONLY,
  dexe_proposal_forecast: READ_ONLY,
  dexe_proposal_list: READ_ONLY,
  dexe_proposal_risk_assess: READ_ONLY,
  dexe_proposal_state: READ_ONLY,
  dexe_proposal_voters: READ_ONLY,
  dexe_read_dao_experts: READ_ONLY,
  dexe_read_dao_list: READ_ONLY,
  dexe_read_dao_members: READ_ONLY,
  dexe_read_dao_stats: READ_ONLY,
  dexe_read_delegation_map: READ_ONLY,
  dexe_read_distribution_status: READ_ONLY,
  dexe_read_expert_status: READ_ONLY,
  dexe_read_gov_state: READ_ONLY,
  dexe_read_multicall: READ_ONLY,
  dexe_read_nfts: READ_ONLY,
  dexe_read_privacy_policy_status: READ_ONLY,
  dexe_read_protocol_stats: READ_ONLY,
  dexe_read_settings: READ_ONLY,
  dexe_read_staking_info: READ_ONLY,
  dexe_read_token_holders: READ_ONLY,
  dexe_read_token_sale_tiers: READ_ONLY,
  dexe_read_token_sale_user: READ_ONLY,
  dexe_read_treasury: READ_ONLY,
  dexe_read_user_activity: READ_ONLY,
  dexe_read_validator_list: READ_ONLY,
  dexe_read_validators: READ_ONLY,
  dexe_safe_info: READ_ONLY,
  dexe_sim_buy: READ_ONLY,
  dexe_sim_calldata: READ_ONLY,
  dexe_sim_proposal: READ_ONLY,
  dexe_tx_status: READ_ONLY,
  dexe_user_inbox: READ_ONLY,
  dexe_vote_build_cancel_vote: READ_ONLY,
  dexe_vote_build_claim_micropool_rewards: READ_ONLY,
  dexe_vote_build_claim_rewards: READ_ONLY,
  dexe_vote_build_delegate: READ_ONLY,
  dexe_vote_build_deposit: READ_ONLY,
  dexe_vote_build_distribution_claim: READ_ONLY,
  dexe_vote_build_erc20_approve: READ_ONLY,
  dexe_vote_build_execute: READ_ONLY,
  dexe_vote_build_move_to_validators: READ_ONLY,
  dexe_vote_build_multicall: READ_ONLY,
  dexe_vote_build_nft_multiplier_lock: READ_ONLY,
  dexe_vote_build_nft_multiplier_unlock: READ_ONLY,
  dexe_vote_build_privacy_policy_agree: READ_ONLY,
  dexe_vote_build_privacy_policy_sign: READ_ONLY,
  dexe_vote_build_staking_claim: READ_ONLY,
  dexe_vote_build_staking_claim_all: READ_ONLY,
  dexe_vote_build_staking_reclaim: READ_ONLY,
  dexe_vote_build_staking_stake: READ_ONLY,
  dexe_vote_build_token_sale_buy: READ_ONLY,
  dexe_vote_build_token_sale_claim: READ_ONLY,
  dexe_vote_build_token_sale_vesting_withdraw: READ_ONLY,
  dexe_vote_build_undelegate: READ_ONLY,
  dexe_vote_build_validator_cancel_vote: READ_ONLY,
  dexe_vote_build_validator_vote: READ_ONLY,
  dexe_vote_build_vote: READ_ONLY,
  dexe_vote_build_withdraw: READ_ONLY,
  dexe_vote_get_votes: READ_ONLY,
  dexe_vote_user_power: READ_ONLY,
  dexe_wc_status: READ_ONLY,
};

/**
 * Titles for the tools registered through the deprecated
 * `server.tool(name, description, schema, cb)` overload, which has no title
 * slot. A host renders `title ?? name` in its approval dialog, so without
 * these the flagship composites — the calls where the user most needs to know
 * what they are approving — show up as raw snake_case.
 *
 * Short noun/verb phrase, sentence case, no trailing period: it is read inside
 * a confirm dialog, not in a docs table. Tools registered via `registerTool`
 * already carry a title and are never overridden here.
 */
const TITLES: Record<string, string> = {
  dexe_context: "Session context",
  dexe_dao_create: "Deploy a new DAO",
  dexe_doctor: "Diagnose env setup",
  dexe_get_config: "Resolved server config",
  dexe_guide: "Flow plans and pitfalls",
  dexe_otc_buyer_buy: "Buy from an OTC tier",
  dexe_otc_buyer_claim_all: "Claim all OTC purchases",
  dexe_otc_buyer_status: "OTC buyer position",
  dexe_otc_dao_open_sale: "Open an OTC token sale",
  dexe_proposal_create: "Create a proposal",
  dexe_proposal_vote_and_execute: "Vote on and execute a proposal",
  dexe_safe_info: "Safe multisig state",
  dexe_safe_propose_tx: "Queue a transaction in a Safe",
  dexe_sim_buy: "Simulate an OTC buy",
  dexe_sim_calldata: "Simulate raw calldata",
  dexe_sim_proposal: "Simulate proposal execution",
  dexe_tx_send: "Sign and broadcast a transaction",
  dexe_tx_status: "Transaction status",
  dexe_wc_connect: "Connect a wallet by QR",
  dexe_wc_disconnect: "Disconnect the wallet",
  dexe_wc_status: "WalletConnect session state",
};

/**
 * Annotations for `name`, or `undefined` when the tool is not classified.
 * Undefined is deliberate: an unannotated tool keeps the conservative spec
 * default (destructive, open world) instead of being wrongly advertised as a
 * read.
 */
export function annotationsFor(name: string): ToolAnnotations | undefined {
  return TOOL_CLASSES[name];
}

/** The title to publish for `name` when its registration supplied none. */
export function titleFor(name: string): string | undefined {
  return TITLES[name];
}

/** Every name this module classifies — the exhaustiveness test reads it. */
export function classifiedToolNames(): ReadonlySet<string> {
  return new Set(Object.keys(TOOL_CLASSES));
}

/** Every name this module supplies a fallback title for. */
export function titledToolNames(): ReadonlySet<string> {
  return new Set(Object.keys(TITLES));
}

/**
 * Fill in `annotations` (and a fallback `title`) on every registration,
 * whatever call shape the register file used, so no register file has to know
 * this module exists.
 *
 * Wrap OUTSIDE the toolset gate: `applyToolGate` returns the bare server for
 * `full` and `undefined` for a gated-out name, so this proxy must see the call
 * first and tolerate an undefined return.
 */
export function applyToolAnnotations(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" && prop !== "tool") {
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (typeof v !== "function") return v;
      const original = (v as (...a: unknown[]) => unknown).bind(target);
      return (name: unknown, ...rest: unknown[]) => {
        if (typeof name !== "string") return original(name, ...rest);
        const ann = annotationsFor(name);
        const title = titleFor(name);

        // registerTool(name, config, cb) — merge into the config object. An
        // explicit field in the registration always wins.
        if (prop === "registerTool" && rest[0] !== null && typeof rest[0] === "object") {
          const cfg = rest[0] as { annotations?: ToolAnnotations; title?: string };
          rest[0] = {
            ...cfg,
            ...(ann ? { annotations: { ...ann, ...cfg.annotations } } : {}),
            ...(cfg.title === undefined && title !== undefined ? { title } : {}),
          };
          return original(name, ...rest);
        }

        // The deprecated tool(...) overloads have no config object and no title
        // slot. `tools/list` reads `title` / `annotations` off the registered
        // tool at request time, so assigning after registration is enough — and
        // it avoids the listChanged notification `update()` would fire during
        // startup. The gate returns undefined for a dropped name.
        const reg = original(name, ...rest) as
          | { annotations?: ToolAnnotations; title?: string }
          | undefined;
        if (reg && typeof reg === "object") {
          if (ann && reg.annotations === undefined) reg.annotations = ann;
          if (title !== undefined && reg.title === undefined) reg.title = title;
        }
        return reg;
      };
    },
  }) as McpServer;
}
