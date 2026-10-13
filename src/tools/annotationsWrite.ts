import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_READ, READ_ANNOTATIONS, READ_ONLY, type AnnotationTable } from "@dexe-network/dexe-mcp/core";

/**
 * ── MCP tool annotations: the write edition, and the single server ─────────
 *
 * The write tools' classes and fallback titles, in the same shape as the read
 * edition's (./annotations.ts, which also holds the wrapper and the rules).
 * `SINGLE_SERVER_ANNOTATIONS` merges both for the server this repo ships
 * today.
 *
 * ANY NEW TOOL THAT SIGNS, PINS, POSTS OR SHELLS OUT MUST BE ADDED HERE.
 * Leaving a tool out is caught by "every registered tool is explicitly
 * classified" in tests/tools/annotations.test.ts.
 */

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
 * Every write-edition tool name → its class. Grouped by class so a reviewer can
 * read the dangerous half in one glance. Keep alphabetical within a group.
 */
const WRITE_CLASSES: Record<string, ToolAnnotations> = {
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
  dexe_find_selector: LOCAL_READ,
  dexe_get_abi: LOCAL_READ,
  dexe_get_methods: LOCAL_READ,
  dexe_get_natspec: LOCAL_READ,
  dexe_get_selectors: LOCAL_READ,
  dexe_get_source: LOCAL_READ,
  dexe_gov_decode_calldata: LOCAL_READ,
  dexe_gov_hash_description: LOCAL_READ,
  dexe_gov_hash_proposal: LOCAL_READ,
  dexe_ipfs_cid_for_json: LOCAL_READ,
  dexe_list_contracts: LOCAL_READ,
  dexe_merkle_build: LOCAL_READ,
  dexe_merkle_proof: LOCAL_READ,
  dexe_proposal_catalog: LOCAL_READ,
  // reads the in-memory approval store; cannot approve or decline anything
  dexe_tx_approval_status: LOCAL_READ,

  // ── READ_ONLY — reads chain / subgraph / backend / IPFS and returns.
  // Calldata builders live here too: they return an unsigned payload and never
  // send it, but several DO read the chain while building (blacklist checks,
  // prerequisite resolution), so openWorldHint stays at its true default.
  dexe_agents_ledger: READ_ONLY,
  dexe_agents_list: READ_ONLY,
  dexe_dao_build_deploy: READ_ONLY,
  dexe_gov_build_cancel: READ_ONLY,
  dexe_gov_build_delegate: READ_ONLY,
  dexe_gov_build_execute: READ_ONLY,
  dexe_gov_build_propose: READ_ONLY,
  dexe_gov_build_queue: READ_ONLY,
  dexe_gov_build_vote_cast: READ_ONLY,
  dexe_gov_simulate_proposal: READ_ONLY,
  dexe_offchain_build_cancel_vote: READ_ONLY,
  dexe_offchain_build_vote: READ_ONLY,
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
  dexe_safe_info: READ_ONLY,
  dexe_sim_buy: READ_ONLY,
  dexe_sim_calldata: READ_ONLY,
  dexe_sim_proposal: READ_ONLY,
  dexe_tx_status: READ_ONLY,
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
  dexe_wc_status: READ_ONLY,
  // signer posture + keyring; probes each persona's balance over RPC, so open world
  dexe_write_context: READ_ONLY,
};

/**
 * Fallback titles for the write tools registered through the positional
 * `tool()` overload. Without these the flagship composites — the calls where
 * the user most needs to know what they are approving — show up as raw
 * snake_case in a host's approval dialog.
 */
const WRITE_TITLES: Record<string, string> = {
  dexe_dao_create: "Deploy a new DAO",
  dexe_otc_buyer_buy: "Buy from an OTC tier",
  dexe_otc_buyer_claim_all: "Claim all OTC purchases",
  dexe_otc_dao_open_sale: "Open an OTC token sale",
  dexe_proposal_create: "Create a proposal",
  dexe_proposal_vote_and_execute: "Vote on and execute a proposal",
  dexe_safe_info: "Safe multisig state",
  dexe_safe_propose_tx: "Queue a transaction in a Safe",
  dexe_sim_buy: "Simulate an OTC buy",
  dexe_sim_calldata: "Simulate raw calldata",
  dexe_sim_proposal: "Simulate proposal execution",
  dexe_tx_approval_status: "Keystore approval status",
  dexe_tx_send: "Sign and broadcast a transaction",
  dexe_tx_status: "Transaction status",
  dexe_wc_connect: "Connect a wallet by QR",
  dexe_wc_disconnect: "Disconnect the wallet",
  dexe_wc_status: "WalletConnect session state",
  dexe_write_context: "Signer and write posture",
};

/** The write edition's annotation table. Nothing is always-loaded yet. */
export const WRITE_ANNOTATIONS: AnnotationTable = {
  classes: WRITE_CLASSES,
  titles: WRITE_TITLES,
  alwaysLoaded: new Set<string>(),
};

/**
 * The single server's table: both editions' classes and titles, and the read
 * edition's always-loaded pair (`dexe_context`, `dexe_guide`) — the two tools
 * its handshake sends every session to first. Its `dexe_guide` serves the write
 * flows next to the read topics, so it keeps the flow-plan title.
 */
export const SINGLE_SERVER_ANNOTATIONS: AnnotationTable = {
  classes: { ...READ_ANNOTATIONS.classes, ...WRITE_ANNOTATIONS.classes },
  titles: { ...READ_ANNOTATIONS.titles, ...WRITE_ANNOTATIONS.titles, dexe_guide: "Flow plans and pitfalls" },
  alwaysLoaded: READ_ANNOTATIONS.alwaysLoaded,
};
