import type { Gotcha } from "./types.js";

/**
 * The protocol gotcha corpus — every non-obvious DeXe rule an agent must know
 * before acting. Sources: docs/PLAYBOOK.md, the mainnet verification campaigns
 * (2026-07), and the project memory (bug_*.md / reference_*.md). Each entry
 * cites its origin so a future correction can be traced.
 *
 * Severity: danger = money/deadlock at stake, warn = a step will revert or
 * misbehave, info = convention that prevents confusion.
 */
export const GOTCHAS: readonly Gotcha[] = [
  // ── DAO creation ──────────────────────────────────────────────────────────
  {
    // reference_dao_creation_rules.md
    id: "quorum-reachable",
    severity: "danger",
    text:
      "Quorum must be REACHABLE: quorum% × totalSupply must be ≤ the token amount actually distributed to voters. " +
      "Treasury/undistributed tokens cannot vote, so an unreachable quorum deadlocks the DAO forever — no proposal " +
      "will ever pass. dexe_dao_create verifies this and refuses incoherent configs before any transaction.",
    applies: { flows: ["create_dao"], tools: ["dexe_dao_create"] },
  },
  {
    // reference_dao_creation_rules.md, PLAYBOOK quorum-safety gate
    id: "quorum-floor",
    severity: "danger",
    text:
      "Quorum below ~50% opens treasury-drain territory: a small token holder group can pass proposals that move " +
      "the whole treasury. The safe floor is 50% (override via DEXE_MIN_SAFE_QUORUM_PCT); builds that lower quorum " +
      "below it return mode:\"blocked-risky\" and need an explicit confirmRisky:true re-run. Warn the user before " +
      "they choose a low quorum.",
    applies: { flows: ["create_dao"], proposalTypes: ["change_voting_settings", "new_proposal_type"] },
  },
  {
    // bug_deploy_cap_equals_minted.md (CORRECTED rule)
    id: "cap-rule",
    severity: "warn",
    text:
      "Token cap rule: cap ≥ mintedTotal > 0. cap:0 reverts 'ERC20Capped: cap is 0' (there is no uncapped mode); " +
      "cap < mintedTotal reverts; cap == mintedTotal is valid and means fixed supply (no future minting headroom).",
    applies: { flows: ["create_dao"], tools: ["dexe_dao_create", "dexe_dao_build_deploy"] },
  },
  {
    // bug_deploy_treasury_remainder_revert.md (CORRECTED), reference_dao_creation_rules.md
    id: "treasury-remainder",
    severity: "info",
    text:
      "The DAO treasury is the IMPLICIT REMAINDER of the initial distribution: sum(recipient amounts) < mintedTotal, " +
      "and the contract mints the difference to the DAO itself. Never list the govPool address as a distribution " +
      "recipient. To give the user's address list X% of supply, put those addresses+amounts in the deploy-time " +
      "distribution and leave the rest as treasury.",
    applies: { flows: ["create_dao", "launch_token_economy"], tools: ["dexe_dao_create"] },
  },
  {
    // reference_dexe_reward_commission_economics.md, PLAYBOOK
    id: "five-settings-ids",
    severity: "warn",
    text:
      "A fresh dexe_dao_create deploy auto-expands FIVE proposal-settings ids: 0 default, 1 internal, 2 validators, " +
      "3 distribution, 4 tokenSale. Any later rewards/settings change must edit EVERY id whose executor matters — " +
      "proposals routed through untouched executors keep the old values.",
    applies: { flows: ["create_dao"], proposalTypes: ["change_voting_settings"] },
  },
  {
    // PLAYBOOK deploy-revert table (name-taken)
    id: "name-taken",
    severity: "info",
    text:
      "The DAO deploy create2 salt is deployer+name: the same deployer reusing a daoName on the same chain reverts " +
      "'pool name is already taken'. Pick a fresh name; a different deployer can reuse it.",
    applies: { flows: ["create_dao"], tools: ["dexe_dao_create"] },
  },
  {
    // reference_dao_creation_rules.md (MEMORY-ONLY promotion)
    id: "delegated-voting-inverted",
    severity: "warn",
    text:
      "The settings flag `delegatedVotingAllowed` is INVERTED versus its name: false = delegation IS allowed " +
      "(the default), true = delegated votes are DISABLED for that proposal type. Do not \"enable delegation\" by " +
      "setting it to true.",
    applies: { flows: ["create_dao"], proposalTypes: ["change_voting_settings", "new_proposal_type"] },
  },
  {
    // reference_dao_creation_rules.md (MEMORY-ONLY promotion)
    id: "min-votes-coherence",
    severity: "warn",
    text:
      "minVotesForVoting and minVotesForCreating must be ≤ the largest single recipient's token allocation, or no " +
      "holder can ever create/vote. dexe_dao_create's synthesized configs keep this coherent; check it when the " +
      "user supplies explicit settings.",
    applies: { flows: ["create_dao"], tools: ["dexe_dao_create"] },
  },
  {
    // reference_votepower_initdata.md
    id: "votepower-init",
    severity: "info",
    text:
      "votePower initData is auto-encoded (LINEAR → __LinearPower_init selector 0x892aea1f, POLYNOMIAL → 3 coeffs). " +
      "Do not override it; empty initData reverts 'power init failed'. Only CUSTOM presets take hand-made initData.",
    applies: { flows: ["create_dao"], tools: ["dexe_dao_create", "dexe_dao_build_deploy"] },
  },
  {
    // reference_dexe_reward_commission_economics.md
    id: "reward-commission",
    severity: "danger",
    text:
      "Every EXECUTED proposal with rewards configured pays a ~30% DeXe protocol commission on the reward total " +
      "(voteAmount × voteRewardsCoefficient + fixed rewards) from the DAO treasury at execute time. If the treasury " +
      "can't cover it, the protocol MINTS new gov tokens (supply inflation — the quorum denominator grows). " +
      "claimRewards on an empty treasury succeeds but silently pays 0. Keep voteRewardsCoefficient ≤ 1e23 (×0.01) " +
      "or 0 unless the user explicitly budgets for it.",
    applies: { flows: ["create_dao"], proposalTypes: ["change_voting_settings"] },
  },

  // ── proposal lifecycle ────────────────────────────────────────────────────
  {
    // bug_approve_target_userkeeper.md
    id: "approve-userkeeper",
    severity: "danger",
    text:
      "When depositing gov tokens, ERC20.approve must target the DAO's UserKeeper, NEVER the GovPool. Approving the " +
      "GovPool burns gas and the deposit reverts. The composites (dexe_proposal_create, " +
      "dexe_proposal_vote_and_execute) sequence this correctly — do not hand-build the approve.",
    applies: { flows: ["create_proposal", "vote_execute"], tools: ["dexe_vote_build_erc20_approve"] },
  },
  {
    // feedback_proposal_flow_prerequisites.md
    id: "deposit-sequence",
    severity: "info",
    text:
      "Creating a proposal requires approve(UserKeeper) → deposit(GovPool) → createProposal, in that order. " +
      "dexe_proposal_create runs the whole sequence; on partial failure it returns the landed-steps ledger — fix " +
      "the cause and re-run the SAME call, completed steps are detected on-chain and skipped.",
    applies: { flows: ["create_proposal"], tools: ["dexe_proposal_create"] },
  },
  {
    // bug_state_names_enum.md
    id: "state-enum",
    severity: "warn",
    text:
      "Canonical ProposalState order: 0 Voting, 1 WaitingForVotingTransfer, 2 ValidatorVoting, 3 Defeated, " +
      "4 SucceededFor, 5 SucceededAgainst, 6 Locked, 7 ExecutedFor, 8 ExecutedAgainst, 9 Undefined. Execute is only " +
      "valid from SucceededFor/SucceededAgainst; use dexe_proposal_state to check, never guess from the number.",
    applies: { flows: ["vote_execute"], tools: ["dexe_proposal_state"] },
  },
  {
    // swarm validator runbook, S02/S07
    id: "validator-leg",
    severity: "warn",
    text:
      "DAOs with validators add a second voting chamber: Voting → (member quorum) WaitingForVotingTransfer → " +
      "moveProposalToValidators → ValidatorVoting → (validator quorum) SucceededFor → execute. Voting in the " +
      "validator chamber BEFORE the move reverts 'Validators: proposal does not exist'. " +
      "dexe_proposal_vote_and_execute auto-drives the whole validator round when the signer is a validator; pass " +
      "driveValidatorRound:false to stop after the member vote.",
    applies: { flows: ["vote_execute"], tools: ["dexe_proposal_vote_and_execute", "dexe_vote_build_move_to_validators"] },
  },
  {
    // bug_votingpower_locked_after_execute.md
    id: "vp-locked",
    severity: "warn",
    text:
      "Tokens you voted with stay LOCKED per-proposal even after the proposal executes, and votingPower() reads 0 " +
      "while locked (it shows available, not deposited, power). Between proposals run dexe_vote_build_withdraw to " +
      "unlock, or the next create/vote fails with 'No voting power available'.",
    applies: { flows: ["vote_execute", "create_proposal"], tools: ["dexe_vote_build_withdraw"] },
  },
  {
    // bug_bug35_unbundle_low_creating_power_race.md
    id: "low-creating-power-race",
    severity: "info",
    text:
      "The FIRST proposal on a freshly deployed DAO can revert 'low creating power' — the just-landed deposit isn't " +
      "credited at snapshot time. This is transient: re-run the SAME dexe_proposal_create call; the ledger resume " +
      "skips the landed deposit and the create succeeds.",
    applies: { flows: ["create_proposal", "launch_token_economy"], tools: ["dexe_proposal_create"] },
  },
  {
    // bug_spherex_multicall_pattern.md
    id: "spherex-create-pattern",
    severity: "warn",
    text:
      "Fresh (SphereX-guarded, deployed ≥ 2026-07) pools reject multicall([deposit, createProposalAndVote]) with " +
      "'SphereX error: disallowed tx pattern'. Deposit and create must be SEPARATE transactions — the composites " +
      "already send them separately; never re-bundle them.",
    applies: { flows: ["create_proposal"], tools: ["dexe_proposal_create", "dexe_vote_build_multicall"] },
  },
  {
    // bug_spherex_addsettings_execute.md
    id: "spherex-addsettings",
    severity: "danger",
    text:
      "On fresh (SphereX-era) pools, EXECUTING a proposal whose action is GovSettings.addSettings has been observed " +
      "reverting 'disallowed tx pattern' — deterministically, re-running never helps. This hits " +
      "change_voting_settings WITHOUT settingsIds, new_proposal_type, and enable_staking. (An enable_staking " +
      "execute SUCCEEDED on a fresh mainnet pool on 2026-07-22, so the upstream allowlist may have been fixed — " +
      "but do not assume it.) If execute reverts with that message: EDIT existing settings instead (pass " +
      "settingsIds) — editSettings is always allowed.",
    applies: { proposalTypes: ["change_voting_settings", "new_proposal_type", "enable_staking"] },
  },
  {
    // bug_spherex_addsettings_execute.md
    id: "settings-ids-semantics",
    severity: "warn",
    text:
      "settingsIds semantics: 0 = DEFAULT settings, 1 = INTERNAL settings (2 validators, 3 distribution, " +
      "4 tokenSale on fresh deploys). When editing, leave executorDescription blank to preserve the on-chain value " +
      "— it holds the settings-JSON IPFS ref the frontend reads; overwriting it blanks the DAO's settings UI.",
    applies: { proposalTypes: ["change_voting_settings"] },
  },
  {
    // bug_apply_to_dao_blacklist_check.md
    id: "blacklist-execute-trap",
    severity: "warn",
    text:
      "A token transfer to a blacklisted recipient passes the vote and then REVERTS at execute — the proposal is " +
      "stuck in SucceededFor forever (there is no cancel). Before proposing transfers of an ERC20Gov token, verify " +
      "the recipient isn't blacklisted.",
    applies: { proposalTypes: ["token_transfer", "apply_to_dao", "withdraw_treasury"] },
  },
  {
    // bug_withdraw_treasury_internal.md (MEMORY-ONLY promotion)
    id: "internal-executor-description",
    severity: "warn",
    text:
      "Internal (self-addressed, GovPool-executor) proposals require the internal settings' executorDescription to " +
      "carry a non-empty IPFS URL, or creation reverts 'Gov: invalid internal data'. Fresh dexe_dao_create deploys " +
      "set this up; hand-modified settings can break it.",
    applies: { proposalTypes: ["change_voting_settings"] },
  },
  {
    // bug_withdraw_treasury_builder_wrong.md
    id: "treasury-is-erc20",
    severity: "info",
    text:
      "The DAO treasury is a plain ERC20/NFT holding at the govPool address — it moves via governance proposals " +
      "(token_transfer / withdraw_treasury / apply_to_dao through dexe_proposal_create), NOT via the personal " +
      "deposit-withdraw function. GovPool.withdraw() only returns YOUR OWN deposited tokens.",
    applies: { proposalTypes: ["token_transfer", "withdraw_treasury"], tools: ["dexe_read_treasury"] },
  },
  {
    // bug_validator_internal_enum_inverted.md
    id: "validator-internal-enum",
    severity: "info",
    text:
      "Validator internal proposal types (GovValidators): 0 ChangeSettings, 1 ChangeBalances, 2 MonthlyWithdraw, " +
      "3 Offchain. Only a CURRENT validator can create them, and validators vote with their own validator balances " +
      "— no deposit involved.",
    applies: { proposalTypes: ["change_validator_settings", "change_validator_balances", "monthly_withdraw"] },
  },
  {
    // F14 root cause (2026-07-23): GovValidatorsExecute's low-level self-call
    // swallows "GPC: Current credit permission < amount to withdraw".
    id: "monthly-withdraw-credit",
    severity: "danger",
    text:
      "An internal monthly_withdraw draws from the validators' CREDIT LINE (GovPool.setCreditInfo), not directly " +
      "from the treasury. Unfunded/insufficient line → execute reverts 'Validators: failed to execute' (the real " +
      "cause is swallowed by a low-level call — this was mis-filed as SphereX finding F14). Fund it FIRST with an " +
      "external validators_allocation proposal ({credits:[{token, amount}]}); dexe_read_validators shows the current " +
      "lines and dexe_proposal_create refuses an uncovered monthly_withdraw up-front.",
    applies: { proposalTypes: ["monthly_withdraw", "validators_allocation"], tools: ["dexe_read_validators"] },
  },
  {
    // reference_spherex_allowlist_family.md
    id: "validator-cancel-blocked",
    severity: "warn",
    text:
      "On fresh (SphereX-era) pools a cast VALIDATOR vote cannot be cancelled — GovValidators has no multicall, and " +
      "raw cancelVote{Internal,External}Proposal is blocked in every shape. Top-up re-votes ARE allowed. Warn " +
      "validators before they vote.",
    applies: { flows: ["vote_execute"], tools: ["dexe_vote_build_validator_cancel_vote"] },
  },
  {
    // PLAYBOOK token_distribution note
    id: "distribution-full-duration",
    severity: "warn",
    text:
      "Distribution (airdrop-to-voters) proposals IGNORE earlyCompletion: voting always runs the FULL duration " +
      "because pro-rata shares depend on final vote totals. moveProposalToValidators/execute only work after " +
      "voteEnd — do not report them as stuck. The `proposalId` param is SELF-REFERENCING (the id this proposal " +
      "will get = latest + 1); dexe_proposal_create computes it.",
    applies: { flows: ["token_distribution"], proposalTypes: ["token_distribution"] },
  },
  {
    // canonical-story disambiguation — the #1 weak-model confusion
    id: "distribution-vs-transfer",
    severity: "danger",
    text:
      "Two different things both read as 'distribute tokens': (1) sending fixed amounts to a SPECIFIC ADDRESS LIST " +
      "— do that post-deploy via token_transfer proposals (one per recipient), or at deploy time via ADVANCED " +
      "params.tokenParams.users/amounts (SIMPLE mode allocates votable supply to the deployer only); " +
      "(2) proposalType token_distribution — a PRO-RATA AIRDROP split among " +
      "whoever VOTES on that proposal, NOT an address list. Picking token_distribution for an address list sends " +
      "funds to the wrong people. Ask the user which they mean.",
    applies: { flows: ["launch_token_economy", "token_distribution"], proposalTypes: ["token_distribution", "token_transfer"] },
  },

  // ── voting / delegation ───────────────────────────────────────────────────
  {
    // bug_spherex_vote_delegate_multicall.md
    id: "spherex-vote-multicall",
    severity: "warn",
    text:
      "Raw top-level vote()/delegate() calls REVERT on fresh (SphereX-era) pools — the frontend always wraps them " +
      "as GovPool.multicall([call]) even for a single call, and the dexe-mcp builders emit that shape since " +
      "v0.24.1. If you hand-craft calldata, wrap it. Raw deposit/withdraw/cancelVote/undelegate/" +
      "createProposal(AndVote) remain allowed.",
    applies: { flows: ["vote_execute"], tools: ["dexe_vote_build_vote", "dexe_vote_build_delegate"] },
  },
  {
    // swarm S01 (MEMORY-ONLY promotion)
    id: "delegation-one-level",
    severity: "info",
    text:
      "Delegation is ONE level: a delegator delegates only their OWN deposited balance; received delegations cannot " +
      "be re-delegated (hub-and-spoke, never chains). Effective voting power = own deposited + incoming " +
      "delegations — verify with dexe_vote_user_power (totalBalance).",
    applies: { flows: ["vote_execute"], tools: ["dexe_vote_build_delegate", "dexe_vote_user_power"] },
  },

  // ── OTC / token sale ──────────────────────────────────────────────────────
  {
    // bug_otc_alignment_audit_2026_07.md
    id: "otc-native-sentinel",
    severity: "warn",
    text:
      "Native BNB in sale tiers uses the sentinel address 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, NOT the zero " +
      "address (0x0 reverts 'TSP: incorrect token'). A native-currency buy must send msg.value equal to the buy " +
      "amount. The dexe_otc_* composites canonicalize this.",
    applies: { flows: ["otc_sale"], tools: ["dexe_otc_dao_open_sale", "dexe_otc_buyer_buy"] },
  },
  {
    // dexe-otc skill, PLAYBOOK
    id: "otc-rate-precision",
    severity: "warn",
    text:
      "Tier exchange rates are scaled ×1e25 (PRECISION) on-chain. Pass human units to the dexe_otc_* composites and " +
      "they scale for you; only ADVANCED raw structs need pre-scaled values. A hand-scaled rate off by 10^2 sells " +
      "the whole allocation for pennies.",
    applies: { flows: ["otc_sale"], tools: ["dexe_otc_dao_open_sale"] },
  },
  {
    // reference_spherex_allowlist_family.md (F15 — confirmed protocol bug)
    id: "otc-vesting-broken",
    severity: "danger",
    text:
      "TokenSaleProposal.vestingWithdraw is blocked ('SphereX error: disallowed tx pattern') in EVERY call shape on " +
      "fresh pools — the VESTED portion of a purchase CANNOT be withdrawn (confirmed protocol bug, escalated " +
      "upstream). Until fixed: open tiers with vestingPercentage:\"0\" on new DAOs. claim (the instant portion) " +
      "works fine.",
    applies: { flows: ["otc_sale"], tools: ["dexe_otc_dao_open_sale", "dexe_otc_buyer_claim_all"] },
  },
  {
    // bug_otc_alignment_audit_2026_07.md
    id: "otc-whitelist-merkle",
    severity: "info",
    text:
      "Whitelisted tiers use a merkle root; the tier's uri must point to IPFS JSON {\"list\":[lowercased addresses]} " +
      "so buyers can regenerate proofs — dexe_otc_dao_open_sale auto-uploads it when uri is empty (needs " +
      "DEXE_PINATA_JWT). Buyer-side reads need the proof BEFORE getUserViews or canParticipate reads false.",
    applies: { flows: ["otc_sale"], proposalTypes: ["token_sale_whitelist"] },
  },

  // ── staking ───────────────────────────────────────────────────────────────
  {
    // reference_staking_proposal_resolver.md
    id: "staking-resolver",
    severity: "info",
    text:
      "The StakingProposal contract address is NOT in the registry or predicted addresses. Resolve it the way the " +
      "frontend does: GovPool.getHelperContracts().userKeeper → GovUserKeeper.stakingProposalAddress(). Zero " +
      "address = not deployed yet → deploying it is ONE permissionless direct transaction " +
      "(GovUserKeeper.deployStakingProposal(), selector 0x82e97c92) sent via dexe_tx_send — NEVER a governance " +
      "proposal, never custom/custom_abi. dexe_proposal_create(create_staking_tier) auto-resolves when " +
      "stakingProposal is omitted and its error returns the exact paste-able TxPayload; then re-run the SAME call.",
    applies: { flows: ["staking_setup"], proposalTypes: ["create_staking_tier"] },
  },
  {
    // reference_staking_proposal_resolver.md (MEMORY-ONLY promotion)
    id: "staking-not-on-testnet",
    severity: "danger",
    text:
      "Staking DOES NOT EXIST on BSC testnet (chain 97): every testnet GovUserKeeper predates the staking " +
      "implementation and stakingProposalAddress() reverts. Do not attempt staking transactions on 97 — plan the " +
      "staking leg on mainnet (chain 56) and tell the user so.",
    applies: { flows: ["staking_setup", "launch_token_economy"], chains: [97] },
  },

  // ── off-chain voting ──────────────────────────────────────────────────────
  {
    // reference_offchain_for_against_unsupported.md
    id: "offchain-types",
    severity: "info",
    text:
      "Only TWO off-chain proposal types are creatable: single-option and multi-option. There is no for/against " +
      "creation path (the backend 400s) — for a binary vote use offchain_single_option with " +
      "voteOptions:[\"For\",\"Against\"]. Off-chain proposals are mainnet-DAO only and live on api.dexe.io, not " +
      "on-chain.",
    applies: { proposalTypes: ["offchain_single_option", "offchain_multi_option", "offchain_for_against"] },
  },
  {
    // bug_offchain_proposal_type_field.md (MEMORY-ONLY promotion)
    id: "offchain-decimal-quorum",
    severity: "info",
    text:
      "Off-chain (backend) quorum percentages are DECIMALS: 0.5 = 50%, not 50. The `type` field must be a " +
      "registered template name (e.g. default_single_option_type), never an arbitrary string.",
    applies: { proposalTypes: ["offchain_single_option", "offchain_multi_option"] },
  },

  // ── conventions ───────────────────────────────────────────────────────────
  {
    // eval-run finding 2026-07-23: Haiku guessed Jan-2024 timestamps in 2026 →
    // StakingProposal SILENTLY rejected the tier (execute status 1, no tier);
    // TSP creates a dead-on-arrival sale (only start<=end is validated on-chain).
    id: "timestamps-future",
    severity: "danger",
    text:
      "NEVER guess dates for sale/staking windows — compute Unix timestamps from the CURRENT time (ask the user " +
      "or read the latest block; your idea of 'now' may be a stale year). Windows must be in the future AT EXECUTE " +
      "TIME (add headroom for the voting period). A staking tier with a past deadline is SILENTLY rejected on-chain " +
      "(the execute succeeds, a StakingRejected event fires, NO tier exists, the reward bounces back); a sale tier " +
      "with a past window is created dead-on-arrival (every buy reverts 'TSP: token sale is over'). The builders " +
      "refuse past end-times before any transaction.",
    applies: { flows: ["otc_sale", "staking_setup", "launch_token_economy"], proposalTypes: ["token_sale", "create_staking_tier"] },
  },
  {
    // PLAYBOOK ground rules
    id: "amount-conventions",
    severity: "info",
    text:
      "Amount strings: digits-only = RAW smallest units (wei); a decimal point (\"12.5\") = human units scaled by " +
      "the token's REAL on-chain decimals (never assumed 18). Durations and delays are SECONDS (86400 = 1 day). " +
      "Composite quorum/percent params are plain percent numbers (51).",
    applies: { flows: ["create_dao", "create_proposal", "otc_sale", "staking_setup"] },
  },
  {
    // feedback_swarm_testnet_first.md, reference_bsc_gas_costs.md
    id: "testnet-first",
    severity: "info",
    text:
      "Chains: 56 = BSC mainnet, 97 = BSC testnet. Rehearse on 97 first (free faucet BNB) except for features that " +
      "don't exist there (staking, subgraph, off-chain backend). Mainnet gas is cents per tx (~0.1 gwei) — never " +
      "size budgets from Ethereum L1 intuition.",
    applies: { flows: ["create_dao", "launch_token_economy"] },
  },
] as const;

/** id → Gotcha map (validated unique in tests/knowledge/integrity.test.ts). */
export const GOTCHA_BY_ID: ReadonlyMap<string, Gotcha> = new Map(GOTCHAS.map((g) => [g.id, g]));
