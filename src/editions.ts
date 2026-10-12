/**
 * ── Edition manifest: which side of the read/write split every tool is on ──
 *
 * dexe-mcp is being split into two servers:
 *
 *   READ   reads chain / subgraph / backend / IPFS state and analyses it. No
 *          calldata builders, no signer, no uploads. Safe to run as a shared
 *          remote server.
 *   WRITE  everything that builds, signs, broadcasts, pins or shells out —
 *          plus the pre-checks that exist only to serve a write (simulators,
 *          hash previews, the builder catalog, the dev toolchain).
 *
 * Today ONE server still registers both lists (src/tools/index.ts). This file
 * only draws the line so it can be enforced while the code moves:
 *
 *   - tests/boundary/edition-manifest.test.ts: the two lists are disjoint and
 *     together are exactly the registered surface, and every READ tool is
 *     annotated `readOnlyHint: true`.
 *   - tests/boundary/import-boundary.test.ts: read-side modules do not import
 *     write-side ones beyond a shrinking allowlist.
 *
 * The MCP annotations cannot stand in for this list: every `*_build_*` builder
 * is honestly `readOnlyHint: true` (it returns an unsigned payload and sends
 * nothing), yet builders belong to the write edition.
 *
 * Names are the CURRENT tool names. A new tool must be added to exactly one
 * list — the manifest test fails on an unclassified name. A renamed tool's
 * old name goes in DEPRECATED_ALIASES (src/tools/aliases.ts, write side),
 * never in either list.
 */

/** 54 tools for the read edition. */
export const READ_TOOLS: readonly string[] = [
  // ── orientation / diagnostics
  // chains, env readiness, toolsets, recorded DAOs; the signer half is dexe_write_context
  "dexe_context",
  "dexe_guide",
  "dexe_doctor",
  // chains, subgraph coverage, backend, IPFS read gateways (D6)
  "dexe_get_config",

  // ── DAO / proposal / vote reads
  "dexe_dao_info",
  "dexe_dao_registry_lookup",
  // also the only way to find a DAO's TokenSaleProposal for the sale reads
  "dexe_dao_predict_addresses",
  "dexe_proposal_state",
  "dexe_proposal_list",
  "dexe_proposal_voters",
  "dexe_vote_user_power",
  "dexe_vote_get_votes",

  // ── on-chain reads (src/tools/read.ts)
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

  // ── subgraph reads (src/tools/subgraph.ts)
  "dexe_graph_query",
  "dexe_graph_schema",
  "dexe_read_dao_list",
  "dexe_read_dao_members",
  "dexe_read_dao_experts",
  "dexe_read_delegation_map",
  "dexe_read_user_activity",
  "dexe_read_validator_list",

  // ── token-sale reads (pure multicall + merkle proof, no signer). Named
  // dexe_otc_list_sales_for_dao / dexe_otc_buyer_status before 0.36.0 (D4);
  // the single server still answers to the old names (src/tools/aliases.ts).
  "dexe_read_token_sales",
  "dexe_read_token_sale_position",

  // ── reporting and analysis
  "dexe_dao_report",
  "dexe_user_inbox",
  "dexe_proposal_forecast",
  "dexe_proposal_risk_assess",

  // ── IPFS reads
  "dexe_ipfs_fetch",
  "dexe_ipfs_cid_info",

  // ── decoding / gov-contract reads
  "dexe_read_gov_state",
  "dexe_list_gov_contract_types",
  "dexe_decode_calldata",
  "dexe_decode_proposal",

  // ── external Governor reads
  "dexe_gov_list_governors",
  "dexe_gov_get_proposal",
  "dexe_gov_get_voting_power",
  "dexe_gov_get_quorum",
  "dexe_gov_get_proposal_threshold",
  "dexe_gov_get_state",
  "dexe_gov_has_voted",
  "dexe_gov_simulate_vote_impact",
];

/** 115 tools for the write edition. */
export const WRITE_TOOLS: readonly string[] = [
  // ── composites that sign and broadcast
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_dao_create",
  "dexe_otc_dao_open_sale",
  "dexe_otc_buyer_buy",
  "dexe_otc_buyer_claim_all",
  // the deploy calldata dexe_dao_create signs
  "dexe_dao_build_deploy",

  // ── signing, broadcast, wallets, personas
  // signer mode, keyring, Pinata/WalletConnect/Safe posture, the unfinished flow
  "dexe_write_context",
  "dexe_tx_send",
  // the write edition's resume rule depends on it, so it stays beside tx_send
  "dexe_tx_status",
  "dexe_wc_status",
  "dexe_wc_connect",
  "dexe_wc_disconnect",
  "dexe_agents_list",
  "dexe_agents_fund",
  "dexe_agents_ledger",
  // reports whether the configured signer is an owner
  "dexe_safe_info",
  "dexe_safe_propose_tx",

  // ── IPFS writes and the CID preview they share
  "dexe_ipfs_upload_proposal_metadata",
  "dexe_ipfs_upload_dao_metadata",
  "dexe_ipfs_upload_file",
  "dexe_ipfs_upload_avatar",
  "dexe_ipfs_update_dao_metadata",
  "dexe_dao_generate_avatar",
  "dexe_ipfs_cid_for_json",

  // ── vote / stake / claim calldata builders (src/tools/voteBuild.ts)
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

  // ── proposal builders and their catalog
  "dexe_proposal_catalog",
  "dexe_proposal_build_external",
  "dexe_proposal_build_internal",
  "dexe_proposal_build_custom_abi",
  "dexe_proposal_build_offchain",
  "dexe_proposal_build_token_transfer",
  "dexe_proposal_build_token_distribution",
  "dexe_proposal_build_token_sale",
  "dexe_proposal_build_token_sale_multi",
  "dexe_proposal_build_token_sale_whitelist",
  "dexe_proposal_build_token_sale_recover",
  "dexe_proposal_build_create_staking_tier",
  "dexe_proposal_build_change_math_model",
  "dexe_proposal_build_modify_dao_profile",
  "dexe_proposal_build_blacklist",
  "dexe_proposal_build_reward_multiplier",
  "dexe_proposal_build_apply_to_dao",
  "dexe_proposal_build_new_proposal_type",
  "dexe_proposal_build_change_voting_settings",
  "dexe_proposal_build_manage_validators",
  "dexe_proposal_build_add_expert",
  "dexe_proposal_build_remove_expert",
  "dexe_proposal_build_withdraw_treasury",
  "dexe_proposal_build_delegate_to_expert",
  "dexe_proposal_build_revoke_from_expert",
  "dexe_proposal_build_change_validator_balances",
  "dexe_proposal_build_change_validator_settings",
  "dexe_proposal_build_monthly_withdraw",
  "dexe_proposal_build_offchain_internal_proposal",

  // ── off-chain proposals and the backend auth they need
  "dexe_auth_request_nonce",
  "dexe_auth_login_request",
  "dexe_auth_login",
  "dexe_proposal_build_offchain_single_option",
  "dexe_proposal_build_offchain_multi_option",
  "dexe_proposal_build_offchain_for_against",
  "dexe_proposal_build_offchain_settings",
  "dexe_offchain_build_vote",
  "dexe_offchain_build_cancel_vote",

  // ── pre-checks that exist to serve a write
  "dexe_merkle_build",
  "dexe_merkle_proof",
  "dexe_sim_calldata",
  "dexe_sim_proposal",
  "dexe_sim_buy",

  // ── external Governor writes and their previews
  "dexe_gov_build_propose",
  "dexe_gov_build_vote_cast",
  "dexe_gov_build_queue",
  "dexe_gov_build_execute",
  "dexe_gov_build_delegate",
  "dexe_gov_build_cancel",
  "dexe_gov_simulate_proposal",
  "dexe_gov_decode_calldata",
  "dexe_gov_hash_description",
  "dexe_gov_hash_proposal",

  // ── dev toolchain: shells out to git / npm / hardhat, reads local artifacts
  "dexe_compile",
  "dexe_test",
  "dexe_coverage",
  "dexe_lint",
  "dexe_list_contracts",
  "dexe_get_abi",
  "dexe_get_methods",
  "dexe_get_selectors",
  "dexe_find_selector",
  "dexe_get_natspec",
  "dexe_get_source",
];
