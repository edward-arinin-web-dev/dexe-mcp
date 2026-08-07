# dexe-mcp Playbook — intent → exact call

The one-page map from "what the user wants" to "the tool call that does it".
Written for AI assistants: every common journey is ONE composite call — do not
hand-sequence approve/deposit/create calldata, and do not read this repo's
source to figure out parameters. Also served as the MCP resource `dexe://playbook`.

**Ground rules**

- Amounts: digits-only string = RAW smallest units (wei); string with a decimal
  point (`"12.5"`) = human units, scaled by the token's REAL decimals (read
  on-chain — never assumed 18). Both forms work everywhere an amount is accepted.
- Durations/delays: SECONDS (`86400` = 1 day). Quorum/percent params on
  composites: plain percent numbers (`51`). Raw protocol units only in ADVANCED
  structs (quorum 25-dec ×1e25, sale rates ×1e25, multipliers ×1e25).
- Chains: 56 = BSC mainnet, 97 = BSC testnet. Validate on 97 first; every read
  tool takes an optional `chainId`.
- No signer configured? Every write returns ordered unsigned `TxPayload`s + a
  WalletConnect QR — scan, approve on the phone, re-run. Nothing is lost.
- Partial failure? Composites return `mode:"failed"` with `failure.landedSteps`
  (txs that DID land), the actionable error, and `resume` guidance. Fix the
  cause and re-run the SAME call — completed steps (approve/deposit) are
  detected on-chain and skipped.

## Intent → call

| User says | Call | Minimal params |
|---|---|---|
| "Who am I / what's set up / which DAOs do I have?" | `dexe_context` | `{}` |
| "Something's failing / set this up" | `dexe_doctor` → `/dexe-setup` | `{}` |
| "Create a DAO" | `dexe_dao_create` | `{daoName, symbol, totalSupply:"1000000", chainId:97}` — preview first; add `confirm:true` when the user already approved |
| "Show DAO info / treasury / settings" | `dexe_dao_info` / `dexe_read_treasury` / `dexe_read_settings` | `{govPool}` (+ `chainId`) |
| "Create a proposal to …" (ANY type) | `dexe_proposal_create` | `{govPool, title, proposalType, params:{…}}` (see type table) |
| "Send/transfer treasury tokens to X" | `dexe_proposal_create` | `proposalType:"token_transfer"`, `params:{token, recipient, amount:"1000.0"}` |
| "Change voting settings/quorum/duration" | `dexe_proposal_create` | `proposalType:"change_voting_settings"`, `params:{govSettings, settings:[…], settingsIds:["0"]}` — id 0 = default settings, 1 = internal |
| "Add/remove an expert" | `dexe_proposal_create` | `proposalType:"add_expert"/"remove_expert"`, `params:{expertNftContract, scope, nominatedUser}` |
| "Delegate treasury to an expert" | `dexe_proposal_create` | `proposalType:"delegate_to_expert"`, `params:{expert, amount}` |
| "Vote on / pass / execute proposal N" | `dexe_proposal_vote_and_execute` | `{govPool, proposalId}` — auto-deposits, auto-drives the validator round (move→validator-vote→execute when signer is a validator), auto-executes; `driveValidatorRound:false` to stop after member vote |
| "Log me in to off-chain voting" | `dexe_auth_login` | `{}` — signs the nonce internally when a signer is set, returns the Bearer `accessToken` (never write key-parsing code for this) |
| "What state is proposal N in?" | `dexe_proposal_state` / `dexe_proposal_list` | `{govPool, proposalId}` |
| "Run an OTC / token sale" | `dexe_otc_dao_open_sale` | `{govPool, tokenSaleProposal, tiers:[…]}` then vote_and_execute |
| "Buy from the sale / claim my tokens" | `dexe_otc_buyer_buy` / `dexe_otc_buyer_claim_all` | `{tokenSaleProposal, tierId, tokenToBuyWith, amount}` |
| "What sales does this DAO have?" | `dexe_otc_list_sales_for_dao` / `dexe_otc_buyer_status` | `{govPool}` / `{tokenSaleProposal, tierIds, user}` |
| "Update the DAO profile/avatar" | `dexe_proposal_create` | `proposalType:"modify_dao_profile"`, pass only the fields to change; avatar via LOCAL `newAvatarPath` |
| "Send this transaction" | `dexe_tx_send` | the TxPayload fields; check with `dexe_tx_status` |
| "Vote on Uniswap/Compound/OP governance" | `dexe_gov_*` surface | needs `DEXE_TOOLSETS=core,governor` |
| "Run agents / a swarm — several wallets voting against each other" | `dexe_guide {flow:"agent_team"}`, then `dexe_agents_list` → `dexe_agents_fund` → act per persona with `signerKey` → `dexe_agents_ledger` | needs `DEXE_TOOLSETS=core,agents` (add `vote` for the raw builders). Burner keys only — the full safety model is `docs/AGENTS.md` |

## proposalType reference (`dexe_proposal_create`)

Pass type-specific inputs in `params`. Wired types (all 33 catalog entries):

**Treasury / tokens**
- `token_transfer` `{token, recipient, amount, isNative?}` — treasury → recipient.
- `withdraw_treasury` `{receiver, token?, amount?, nftAddress?, nftIds?}` — ERC20 and/or NFTs.
- `apply_to_dao` `{token, receiver, amount, treasuryBalance?}` — grant; transfer-first, mints only the shortfall. Omit `treasuryBalance` to auto-read the live GovPool balance (needs RPC).
- `token_distribution` `{distributionProposal, proposalId, token, amount, isNative?}` — pro-rata airdrop to voters. `distributionProposal` comes from `dexe_dao_predict_addresses`; `proposalId` is SELF-REFERENCING = the id this proposal will get (latest + 1). ⚠ Distribution proposals ignore `earlyCompletion` — voting always runs the FULL duration (pro-rata shares depend on final totals), so `moveProposalToValidators`/execute only work after `voteEnd`.

**Governance config**
- `change_voting_settings` `{govSettings, settings:[fullSettingsStruct], settingsIds?}` — edit (with ids: 0 = default, 1 = internal) or add. ⚠ **Quorum-safety gate**: if a settings/new-type build lowers quorum below the safe floor (`DEXE_MIN_SAFE_QUORUM_PCT`, default 50%) into treasury-drain territory, `dexe_proposal_create` REFUSES before any tx and returns `mode:"blocked-risky"`; re-run the SAME call with `confirmRisky:true` if intentional. ⚠ Editing with `settingsIds` preserves each entry's on-chain `executorDescription` when you leave it blank (don't re-pass it) — it holds the settings-JSON IPFS ref the frontend UI reads. ⚠ On fresh (SphereX-guarded) pools, executing an ADD (`addSettings`, no ids) reverts "SphereX error: disallowed tx pattern" — pass `settingsIds` to EDIT instead; `new_proposal_type`/`enable_staking` hit the same wall. ⚠ A fresh `dexe_dao_create` deploy auto-expands FIVE settings ids (0 default, 1 internal, 2 validators, 3 distribution, 4 tokenSale) — a rewards/settings change must cover EVERY id whose executor you care about, or proposals routed via the untouched executors keep the old values.
- `new_proposal_type` / `enable_staking` `{govSettings, settings, executors, newSettingId}` — newSettingId = current settings length (`dexe_read_settings`).
- `change_math_model` `{newVotePower}` — swap LINEAR/POLYNOMIAL/custom power contract.
- `manage_validators` / `validators_allocation` `{govValidators, changes:[{user, balance}]}` — balance 0 removes.

**Experts / delegation**
- `add_expert` / `remove_expert` `{expertNftContract, scope:"local"|"global", nominatedUser, uri?}`
  (aliases: `add_local_expert`, `add_global_expert`, `remove_local_expert`, `remove_global_expert` — no scope needed).
- `delegate_to_expert` / `revoke_from_expert` `{expert, amount, nftIds?}` (aliases `delegate_tokens_to_expert` / `revoke_tokens_from_expert`).

**Token sale / staking**
- `token_sale` `{tokenSaleProposal, tiers:[tierSpec], latestTierId?}` — prefer `dexe_otc_dao_open_sale` for the full journey.
- `token_sale_whitelist` `{tokenSaleProposal, requests:[{tierId, users, uri?}]}` — extend a live tier's whitelist.
- `token_sale_recover` `{tokenSaleProposal, tierIds}` — recover unsold tokens.
- `create_staking_tier` `{stakingProposal?, rewardToken, rewardAmount, startedAt, deadline, stakingMetadataUrl, isNative?}`. `stakingProposal` may be OMITTED — the composite auto-resolves it the way the frontend does: `GovPool.getHelperContracts().userKeeper` → `GovUserKeeper.stakingProposalAddress()`. Zero address means the contract isn't deployed yet; the error tells you to send `GovUserKeeper.deployStakingProposal()` (via dexe_tx_send) first, then re-run.
- ⚠ OTC vesting on fresh (SphereX-era) pools: `TokenSaleProposal.vestingWithdraw` reverts "SphereX error: disallowed tx pattern" in every known call shape — the vested portion of a purchase CANNOT be withdrawn. Until resolved, open tiers with `vestingPercentage: "0"` on new DAOs; `claim` (the instant portion) works fine.

**Token controls**
- `blacklist` `{erc20Gov, addAddresses?, removeAddresses?}`.
- `reward_multiplier` `{mode:"set_address"|"mint"|"change_token"|"set_token_uri", …}` — multiplier ×1e25 (1.5x = 1.5e25), rewardPeriod seconds.

**Profile / raw**
- `modify_dao_profile` — top-level fields (`newDaoName`, `newDaoDescription`, `newWebsiteUrl`, `newSocialLinks`, `newAvatarPath`), NOT in `params`. Partial updates merge with current metadata.
- `custom` — your own `actionsOnFor:[{executor, value?, data}]`.
- `custom_abi` `{target, signature, method, args?, value?}` — one encoded call.

**Internal (validators-only — auto-routed to GovValidators, no deposit)**
- `change_validator_balances` `{changes:[{user, balance}]}` (contract type 1)
- `change_validator_settings` `{duration, executionDelay, quorum}` (quorum 10^27 scale; contract type 0)
- `monthly_withdraw` `{withdrawals:[{token, amount}], destination}` (type 2)
- `offchain_internal_proposal` `{}` (type 3)
Only a CURRENT validator can create these; validators vote with their own balances.
⚠ SphereX on fresh pools: validator `cancelVote{Internal,External}Proposal` is blocked in every shape (GovValidators has no multicall) — a cast validator vote cannot be cancelled; top-up re-votes ARE allowed. `executeInternalProposal` for monthly_withdraw has also been seen failing "Validators: failed to execute" on fresh pools even in Succeeded state — likely the same guard on the inner call.

**Off-chain (backend — rejected with instructions)**
`offchain_single_option` / `offchain_multi_option` live on api.dexe.io, not on-chain:
build with `dexe_proposal_build_offchain_*`, authenticate via `dexe_auth_request_nonce`
→ wallet-sign → `dexe_auth_login_request`, then send the returned HTTP request with the
Bearer token. Mainnet DAOs only. ⚠ Only **two** off-chain voting types are creatable
(single-option and multi-option) — the DeXe product has no for_against creation path, so
`offchain_for_against` (`dexe_proposal_build_offchain_for_against`) returns a not-supported
error; for a binary vote use `offchain_single_option` with `voteOptions:["For","Against"]`.

## Guided flows (dexe_guide)

For any multi-step journey, call `dexe_guide` first — it serves these flows as
structured plans (interview questions with risk notes, exact step order, and
the gotcha corpus below) plus session context (known DAOs, active chain).
This section is GENERATED from `src/knowledge/flows.ts` — edit there, then run
`npm run gen:knowledge`.

<!-- BEGIN GENERATED: flows -->
### Create (deploy) a DAO (`create_dao`)

Deploy a new DeXe governance DAO with its gov token in one composite call (preview → confirm → broadcast).
- **chain 56:** MAINNET — the deploy spends real BNB (cents, ~0.1 gwei). Confirm the user accepts mainnet before broadcasting.
- **chain 97:** Testnet rehearsal: free faucet BNB (https://www.bnbchain.org/en/testnet-faucet). Staking, subgraph reads and off-chain proposals do NOT exist on 97.

**Ask the user:**
- `daoName` — What should the DAO be called? (public, permanent; also the on-chain pool name) · constraint: Non-empty; this deployer must not have used the same name on this chain before.
- `symbol` — Gov token symbol? (e.g. 'GENA')
- `totalSupply` — Total token supply, in whole tokens? (e.g. '1000000') · constraint: > 0. Cap is set equal to minted supply (fixed supply) unless ADVANCED params say otherwise.
- `treasuryPercent` (optional) — What % of supply should the DAO treasury hold? (the rest goes to your deployer wallet as votable supply) · default `49` · ⚠ Treasury tokens CANNOT vote. Treasury > 49% shrinks votable supply below quorum reach — the deploy is refused as governance-dead. Treasury 0% means proposals have nothing to spend.
- `quorumPercent` (optional) — Quorum % required to pass proposals? · default `51` · constraint: 50 ≤ quorum ≤ 100 − treasuryPercent · ⚠ Below 50% a small holder group can drain the treasury (blocked-risky without confirmRisky). Above 100−treasuryPercent the quorum is unreachable and the DAO is dead — the tool refuses.
- `durationSeconds` (optional) — Voting duration per proposal, in seconds? (86400 = 1 day) · default `86400` · ⚠ Very short durations can end voting before holders react; very long ones stall governance.
- `chainId` (optional) — Which chain — 97 (BSC testnet rehearsal, free) or 56 (BSC mainnet, real BNB)? · default `97`
- `daoDescription` (optional) — One-paragraph DAO description for the public profile? (markdown ok; optional)

**Steps:**
1. `dexe_dao_create` — Preview the resolved config + safety proof (quorum reachability, treasury floor). No broadcast.
2. `dexe_dao_create` — Broadcast the deploy (same arguments + confirm:true). Signs via hot key or WalletConnect QR.

### Create a governance proposal (any type) (`create_proposal`)

Create ANY of the 33 catalog proposal types with one dexe_proposal_create call — it handles approve → deposit → create + IPFS metadata.

**Ask the user:**
- `govPool` — Which DAO (govPool address)? If we just created one this session, confirm reusing it.
- `proposalType` — What should the proposal DO? (map the user's intent to a proposalType via dexe_proposal_catalog — e.g. token_transfer, change_voting_settings, add_expert)
- `title` — Proposal title (public)?
- `description` (optional) — Short proposal description for voters? (optional but recommended)

**Steps:**
1. `dexe_proposal_catalog` — Only when unsure which proposalType matches the intent: list all 33 types with their target + effect. The per-type params shapes are in dexe_proposal_create's description and docs/PLAYBOOK.md. _(skip when: the proposalType is already obvious from the user's request)_
2. `dexe_proposal_create` — Approve → deposit → createProposalAndVote in one call, with correct IPFS metadata.

### Vote on / pass / execute a proposal (`vote_execute`)

Vote and execute in one dexe_proposal_vote_and_execute call — auto-deposits when power is short and auto-drives the validator round.

**Ask the user:**
- `govPool` — Which DAO (govPool address)?
- `proposalId` — Which proposal id?
- `support` (optional) — Vote FOR or AGAINST? · default `for`

**Steps:**
1. `dexe_proposal_state` — Read the current ProposalState first — the valid action depends on it.
2. `dexe_proposal_vote_and_execute` — Vote with full available power (auto-deposit if needed), then — when quorum passes — move to validators, drive the validator round (if the signer is a validator), and execute.
3. `dexe_vote_build_withdraw` — After execution, withdraw the voted tokens so they're free for the next proposal. _(skip when: the user will create/vote more proposals right away — otherwise skippable)_

### Airdrop to voters (pro-rata distribution) (`token_distribution`)

A distribution proposal splits a token amount pro-rata among whoever VOTES on it — this is NOT a payout to a fixed address list.

**Ask the user:**
- `govPool` — Which DAO (govPool address)?
- `token` — Which token to distribute (address), and is it native BNB?
- `amount` — Total amount to distribute among voters? · ⚠ The whole amount leaves the treasury at execute; shares depend on final vote weights.

**Steps:**
1. `dexe_proposal_catalog` — SANITY GATE: confirm the user wants a pro-rata airdrop to VOTERS. If they named specific recipient addresses, STOP — use token_transfer proposals (or deploy-time distribution) instead. _(skip when: the user explicitly said 'pro-rata to voters')_
2. `dexe_dao_predict_addresses` — Fetch the DAO's DistributionProposal executor address.
3. `dexe_proposal_create` — Create the distribution proposal (proposalId self-computes to latest+1).

### Open an OTC / token sale (`otc_sale`)

Open a multi-tier token sale (proposal → vote → execute → live), then buyers check status / buy / claim via the dexe_otc_* composites.

**Ask the user:**
- `govPool` — Which DAO (govPool address)?
- `saleTokenAmount` — How many DAO tokens to sell in this tier? · ⚠ This amount moves from the treasury into the sale at execute.
- `price` — Price per DAO token, and in which purchase token (address, or native BNB)? · ⚠ Rates are stored ×1e25 on-chain — always pass human units and let the composite scale; a mis-scaled hand-made rate can sell the allocation for pennies.
- `saleWindow` — Sale start and end times? (ask in the user's words — e.g. 'starts tomorrow, runs 7 days' — then compute Unix seconds from the CURRENT time; never guess the date) · ⚠ The window must be in the future at EXECUTE time (add voting-period headroom). A past window creates a dead tier — every buy reverts.
- `vesting` (optional) — Vesting? (RECOMMEND 0 on newly deployed DAOs — vested funds are currently unrecoverable there) · default `0` · ⚠ vestingWithdraw is blocked by SphereX on fresh pools — a non-zero vestingPercentage strands the vested portion (confirmed protocol bug).
- `whitelist` (optional) — Open to everyone, or a whitelist of addresses?

**Steps:**
1. `dexe_otc_dao_open_sale` — Build + create the TokenSaleProposal tiers proposal (auto-uploads merkle whitelist JSON if given).
2. `dexe_proposal_vote_and_execute` — Vote + execute the sale proposal — the tier goes live at execute.
3. `dexe_otc_list_sales_for_dao` — Confirm the tier is live and show its parameters (times are UTC).

### Set up staking (reward tier) (`staking_setup`)

Create a staking reward tier: resolve/deploy the StakingProposal contract, pass a create_staking_tier proposal, then holders stake and claim.
- **chain 97:** STAKING DOES NOT EXIST ON TESTNET (97) — every testnet GovUserKeeper predates it and stakingProposalAddress() reverts. Do NOT attempt staking transactions on 97; run this flow on mainnet (chain 56) and tell the user why.

**Ask the user:**
- `govPool` — Which DAO (govPool address)?
- `rewardToken` — Which token funds the staking rewards (address, or native BNB)?
- `rewardAmount` — Total reward pool for this tier? · ⚠ The reward amount must actually be available — an unfunded tier pays nothing.
- `window` — Staking start (startedAt) and deadline? (ask in the user's words, then compute Unix seconds from the CURRENT time; never guess the date) · ⚠ A deadline in the past is SILENTLY rejected on-chain: the execute succeeds but NO tier is created and the reward returns to the treasury. Deadline must be in the future at EXECUTE time (add voting-period headroom).

**Steps:**
1. `dexe_proposal_create` — Create the staking tier proposal. Omit stakingProposal — the composite resolves it via GovUserKeeper.stakingProposalAddress(); if the contract isn't deployed yet the error returns the EXACT dexe_tx_send payload for the one-off permissionless deployStakingProposal() transaction (it is NOT a governance proposal — never wrap it in custom/custom_abi). Send it, then re-run this SAME call.
2. `dexe_proposal_vote_and_execute` — Vote + execute — the staking tier goes live.
3. `dexe_read_staking_info` — Read the live tier back (reward pool, window) and show it to the user.

### Launch a full token economy (DAO → distribute → OTC → staking) (`launch_token_economy`)

The end-to-end journey: deploy a DAO + token, put tokens in specific hands, open an OTC sale, set up staking. Composed of the create_dao, create_proposal, otc_sale and staking_setup flows.
- **chain 56:** Full run spends real BNB (cents per tx). Get explicit user confirmation before the first mainnet broadcast.
- **chain 97:** Rehearse the DAO + distribution + OTC legs on 97. The STAKING leg cannot run on testnet (no StakingProposal there) — plan it for mainnet (56) and say so explicitly.

**Ask the user:**
- `distributionList` — Which addresses should receive tokens, and what share of supply (e.g. 20%) split how? · ⚠ A fixed address list is served by token_transfer proposals from the treasury (one per recipient) — NOT by proposalType token_distribution (that's a pro-rata airdrop to voters). Size treasuryPercent to cover the list share plus ongoing treasury needs.
- `chainId` (optional) — Rehearse on testnet 97 first (recommended), or go straight to mainnet 56? · default `97`

**Steps:**
1. `dexe_guide` — LEG 1 — deploy the DAO. Fetch flow 'create_dao' and run its interview + steps. Set treasuryPercent so the treasury covers the distribution list share (e.g. list needs 20% → treasury ≥ 20% + reserve, and quorumPercent ≤ 100 − treasuryPercent must still hold ≥ 50).
2. `dexe_proposal_create` — LEG 2 — distribute to the address list: ONE token_transfer proposal PER recipient (proposalType:'token_transfer', params:{token: govToken, recipient, amount}). Each auto-votes your power; execute each via dexe_proposal_vote_and_execute. Withdraw (unlock) tokens between proposals.
3. `dexe_guide` — LEG 3 — open the OTC sale. Fetch flow 'otc_sale' and run its interview + steps.
4. `dexe_guide` — LEG 4 — set up staking. Fetch flow 'staking_setup'. On chain 97 this leg MUST be deferred to mainnet — relay the chain note instead of attempting it.

### Run an agent team (multi-persona DAO simulation) (`agent_team`)

Drive several keyring personas (proposer / voter / validator / delegator) through one DAO: configure the keyring, fund inside a budget, run the sequence that works on-chain, reconcile per-persona from the agent ledger.
- **chain 56:** MAINNET — every persona holds a plaintext hot key that signs without asking, and the fleet spends real BNB unattended. Only after the same scenario is green on 97, with throwaway wallets and a budget you can afford to lose. Relay this and get an explicit go-ahead first.
- **chain 97:** Testnet (97) is where an agent team belongs: free faucet BNB, throwaway DAOs, nothing real at stake — rehearse here first. Subgraph reconciliation (turnout / who-voted) does NOT exist on 97; use dexe_proposal_state plus the local ledger.

**Ask the user:**
- `scenario` — What should the team exercise? (contested vote, delegation hub, validator round) · constraint: One on-chain outcome you can check afterwards.
- `govPool` — Which DAO do the personas act on? · ⚠ Hot keys on a real treasury can create AND pass real proposals unprompted.
- `chainId` (optional) — Chain — 97 (testnet rehearsal, free) or 56 (mainnet, real BNB)? · default `97` · ⚠ On 56 every persona spends real BNB unattended.
- `roles` — Which signerKey plays which role? (agent1 proposer, agent2 FOR, agent3 AGAINST, agent4 delegates) · constraint: Only slots dexe_agents_list reports; a validator role needs a registered validator.
- `gasPerAgent` (optional) — Native gas target per persona (BNB)? · default `0.01` · ⚠ Capped per transfer by DEXE_AGENT_FUND_MAX_WEI. A refusal is the cap working — raise it deliberately.
- `powerPerAgent` — How many gov tokens per voting persona? · ⚠ Below minVotesForVoting a persona cannot vote; below minVotesForCreating it cannot propose.
- `dailyBudget` (optional) — Daily spend ceiling, BNB (SWARM_DAILY_BNB_BUDGET)? · default `0.05` · ⚠ Checked against the ledger's rolling 24h spend (value + gas); a crossing broadcast is refused. Unset on faucet testnets it is NOT armed.

**Steps:**
1. `dexe_agents_list` — Discover the personas this session HAS: signerKey ('agent1'…'agent16', 'funder'), address, native balance, and — with `token` — gov-token balance. Assign roles only to slots you can see. Tool not found = the PROFILE, not the keyring: DEXE_TOOLSETS=core,agents unlocks dexe_agents_list, dexe_agents_fund and dexe_agents_ledger (add `vote` for the raw builders), then restart. Tool there but roster empty = keyring unset (DEXE_AGENT_PK_1..16). Either way the flow stops here.
2. `dexe_agents_fund` — Top the personas up from the primary signer (or source:'funder'). PREVIEWS FIRST: the call returns who would be funded plus the budget impact, and broadcasts only on a second call with confirm:true. Run again with `token: <govToken>` to give voters power. Recipients can ONLY be keyring addresses; amounts are top-up-to-target, so re-running is safe.
3. `dexe_vote_build_delegate` — Delegation leg in the order that works on-chain (swarm S01): the delegator first approves the UserKeeper and deposits its OWN tokens (dexe_vote_build_erc20_approve → dexe_vote_build_deposit), then delegates to the hub. Build each payload here; the next step signs it. _(skip when: the scenario has no delegation leg)_
4. `dexe_tx_send` — Broadcast a built payload AS one persona: its to/data/value plus signerKey:'agent<n>'. The pattern for every per-persona action the composites don't cover (deposit, delegate, validator vote, claims, withdraw). Send it VERBATIM — raw vote()/delegate() revert on fresh SphereX-era pools and the builders already emit the multicall([call]) wrapper. signerKey is hot-key only; WalletConnect rejects it. _(skip when: no per-persona raw action is needed)_
5. `dexe_proposal_create` — The PROPOSER persona creates the proposal: signerKey picks its wallet and the one call runs approve → deposit → createProposalAndVote, auto-voting that persona's power FOR. Proposal content follows the create_proposal flow (sub-flow).
6. `dexe_proposal_vote_and_execute` — ONE call per voting persona: signerKey picks the wallet, isVoteFor picks the side (this is how personas vote against each other), depositFirst:'auto' deposits the missing power. Keep autoExecute:false for every persona but the last, or the round executes mid-way and the rest have nothing to vote on. Only a validator persona drives the validator round (flow vote_execute).
7. `dexe_agents_ledger` — Who did what, and what it cost: every broadcast attributed to the persona that made it (tool, action, tx hash, outcome broadcast/confirmed/reverted/failed), per-agent and total spend, and the remaining daily budget. Read-only and local — no RPC needed.
8. `dexe_dao_report` — Did the governance outcome actually land? The turnout section shows who voted and with what weight (subgraph-backed: mainnet only — on 97 use dexe_proposal_state per proposal and say the section is missing).
<!-- END GENERATED: flows -->

## Reading DAO data (reference topics)

Non-journey knowledge: how to query the subgraph, the backend API, and
arbitrary contract state. GENERATED from `src/knowledge/topics.ts` — edit
there, then run `npm run gen:knowledge`. Also served in-band via
`dexe_guide {flow:"read_dao_data"}` and the `dexe://graph-schema` resource.

<!-- BEGIN GENERATED: topics -->
### Read / query DAO data (subgraph, backend API, on-chain) (`read_dao_data`)

Reference for the whole read surface: free-form subgraph queries via dexe_graph_query, anonymous backend REST reads (stats/holders/NFTs), and free-form on-chain reads via dexe_read_multicall — with bounds, chain coverage, and toolset gating.

#### Pick the right source

Prefer the structured dexe_read_* tools first (dexe_read_dao_members, dexe_read_treasury, dexe_read_user_activity, dexe_proposal_voters, …) — they return shaped, documented payloads. Reach for dexe_graph_query when no structured tool covers the question (custom filters, joins, historical slices). Use dexe_read_multicall for arbitrary on-chain contract state, and dexe_sim_calldata to dry-run calldata without broadcasting. ALL reads are anonymous: no signer, no private key, no API key required.

#### Subgraph querying (dexe_graph_query)

Free-form read-only GraphQL against three subgraphs. subgraph='pools': DaoPool, Proposal, Voter, VoterInPool, VoterInPoolPair, ProposalInteraction, TokenSaleTier, ExpertNft, DelegationHistory. subgraph='interactions': Transaction feed by type plus per-event entities (DaoPoolCreate, DaoPoolDelegate, DaoPoolExecute, DaoPoolVest, DaoProposalCreate, …). subgraph='validators': ValidatorInPool, Proposal, ValidatorInProposal. Bound every list with first: (max 1000) and paginate with skip:; responses over 120000 chars are rejected. Data covers BSC MAINNET ONLY. The full entity/field reference (id conventions, enums, worked queries) is the MCP resource dexe://graph-schema (docs/GRAPH.md in the package).

#### Backend REST reads (anonymous, mainnet)

Fixed wrappers over the DeXe backend — no auth needed: dexe_read_treasury (every token a wallet/DAO holds with USD values; falls back to on-chain RPC on testnet or when the backend is down), dexe_read_token_holders (top ERC20 holders, balance-desc), dexe_read_dao_stats (per-DAO TVL/member/proposal time series by period), dexe_read_protocol_stats (protocol-wide TVL/DAO/proposal totals, chains 1+56, top DAOs), dexe_read_nfts (NFTs held by an address). There is no free-form backend endpoint tool by design. Backend-only tools fail or return empty on testnet 97.

#### Free-form contract reads

dexe_read_multicall reads ANY contract: each call is {target, signature, method, args} where signature is the full fragment 'function balanceOf(address) view returns (uint256)'; all calls batch into one RPC round-trip. dexe_sim_calldata (dev toolset) eth_call-simulates arbitrary {to, data, value} and decodes revert reasons. To discover DeXe contract methods: dexe_compile once per session, then dexe_get_methods / dexe_get_abi / dexe_find_selector (`dev` toolset).

#### Toolset gating

The default DEXE_TOOLSETS profile ('core') carries the reporting reads with no configuration at all: dexe_dao_report, dexe_graph_query, dexe_read_dao_list, dexe_read_dao_stats, dexe_read_dao_members, dexe_read_token_holders, dexe_read_delegation_map, dexe_read_treasury, dexe_read_settings, dexe_proposal_list, dexe_proposal_state, dexe_dao_info, dexe_ipfs_fetch. The long-tail reads (dexe_read_multicall, dexe_read_validators, dexe_read_user_activity, dexe_proposal_voters, dexe_user_inbox, dexe_read_staking_info, dexe_read_token_sale_*, …) need the 'read' set; dexe_sim_calldata needs 'dev'. If a read tool 404s, tell the user to set DEXE_TOOLSETS (e.g. 'core,read' or 'full') and restart — dexe_context reports which sets are off and what they unlock.

#### Want a whole report, not one field?

If the question is 'how is this DAO doing' rather than 'what is this one value', do NOT hand-assemble it from these tools — call dexe_dao_report, which gathers identity, settings, treasury, membership, delegation, experts, validators, proposals, turnout (who voted, all proposals at once), activity and deadlines in ONE call, and can report only what changed since the previous run. Fetch the guide topic 'report_dao_activity' (dexe_guide flow:"report_dao_activity") for the reporting recipe, including scheduled/recurring runs.

**Pitfalls (danger first):**
- ⚠ ALWAYS bound dexe_graph_query list fields with `first:` (gateway max 1000) and paginate with `skip:` — responses over 120000 chars are rejected outright, so an unbounded query fails instead of streaming. Entity ids are lowercased concatenated bytes (e.g. proposal id = poolAddress + uint32-LE(proposalId), no separator); relation filters use the `_` suffix (pool_: {id: "0x…"}). Full entity/field reference: MCP resource dexe://graph-schema.
- ⚠ Subgraph and DeXe-backend data exist for BSC MAINNET (56) only. Every subgraph-backed tool takes `chainId` and REFUSES a chain it has no endpoint for — it never answers from another chain, so a testnet call errors loudly instead of handing back mainnet rows. The error names the chains that are indexed, the on-chain alternatives, and the env var to set. Affected: dexe_graph_query, dexe_read_dao_list, dexe_read_dao_members, dexe_read_delegation_map, dexe_read_dao_experts, dexe_read_validator_list, dexe_read_user_activity, dexe_proposal_voters, dexe_user_inbox (auto-discovery only — pass `daos: ["0x…"]` to scan any chain), dexe_proposal_forecast. Backend-only tools (dexe_read_token_holders, dexe_read_dao_stats, dexe_read_protocol_stats, dexe_read_nfts) stay mainnet-only. For testnet DAOs read on-chain instead: dexe_read_gov_state, dexe_read_settings, dexe_proposal_state, dexe_read_multicall (dexe_read_treasury falls back to RPC automatically). Every subgraph response carries `indexedChainId` — the chain the rows came from. To index another chain yourself set DEXE_SUBGRAPH_<KIND>_URL_<chainId> (e.g. DEXE_SUBGRAPH_POOLS_URL_97).
- ℹ dexe_read_multicall calls need the FULL function fragment as `signature` — 'function balanceOf(address) view returns (uint256)', not just a name or selector — plus `target`, `method`, and `args`. Any contract address works (no allowlist); all calls in one request are batched into a single RPC round-trip. To discover signatures on DeXe contracts, run dexe_compile once then dexe_get_methods / dexe_get_abi (`dev` toolset).

### Report on a DAO — activity, members, who voted, statistics (one call, schedulable) (`report_dao_activity`)

Pull a complete DAO report — identity, settings, treasury, membership, delegation, experts, validators, proposals, turnout, activity, deadlines — with ONE dexe_dao_report call, show only what moved via `since`, and run it on a schedule (/schedule cron, /loop interval).

#### One call, not fifteen

dexe_dao_report { govPool: "0x…", chainId: 56 } returns the whole picture in a single call — eleven sections: identity, settings, treasury, membership, delegation (who delegated to whom, no address list needed), experts, validators, proposals, turnout (every proposal at once, not one call each), activity, deadlines. Do NOT rebuild it by hand from dexe_read_dao_members + dexe_read_treasury + dexe_proposal_list + one dexe_proposal_voters per proposal — that is 12-18 calls plus one per proposal, and it is exactly what dexe_dao_report replaces. Narrow the work with sections: ["proposals", "turnout"]; pass user: "0x…" to add that wallet's unvoted proposals and claimable rewards to deadlines; tune proposalLimit (default 30) / memberLimit (default 50). Reach for the individual dexe_read_* tools only for a field the report does not carry. The response is typed (outputSchema + structuredContent), so render it however the user asked — markdown table, bullet digest, one-line health verdict.

#### Only what changed: the `since` diff

A recurring report is only useful if it says what MOVED. Pass since: "last" and the report fills in `changes` against this DAO's previous run — new proposals, proposals that changed state, members joined, delegation shifts, treasury deltas — with no bookkeeping on your side: every run persists a per-DAO snapshot (persist: false opts out). An explicit anchor also works: ISO-8601 ("2026-08-01T00:00:00Z"), Unix seconds, or "block:62000000". FIRST RUN: since: "last" ERRORS when no snapshot exists yet — re-run without `since` to lay the baseline down, then use "last" from then on (say this in any scheduled prompt). Without `since` every run is a full snapshot and the user has to spot the deltas themselves — on a schedule that is the difference between a digest and a wall of text.

#### Chain coverage — say which sections you got

Subgraph- and backend-backed sections (membership, delegation, turnout, activity, experts) exist for BSC MAINNET (56) only. On any other chain each section degrades INDEPENDENTLY: it comes back available:false with a reason and a followUp naming the tool to use instead, and is listed in `unavailable[]` — never as zero rows. The on-chain sections (identity, settings, proposals, treasury via RPC fallback, validators, deadlines) still render. When you relay a report from an unindexed chain, say which sections are missing and why; a scheduled run that silently drops half the report is how a DAO gets declared healthy while nobody is voting.

#### Recurring runs (/schedule and /loop)

`since: "last"` is what makes this schedulable. In Claude Code, `/loop 1h call dexe_dao_report {govPool:"0x…", chainId:56, since:"last"} and report only what changed` repeats in THIS session at a local interval. `/schedule` creates a CLOUD routine (cron, minimum interval 1 hour, expressions in UTC) — it runs in a fresh sandbox with NO access to the local machine, so the dexe MCP server must be attached to the routine with its own env, and the prompt must be self-contained (spell out govPool, chainId, since, and the output format). A cloud sandbox does not share the local snapshot store, so tell the routine to fall back to a full report when since: "last" reports no baseline. Full paste-able recipes — daily digest, hourly 'needs my vote' watch: docs/REPORTING.md (shipped in the package) and the dexe-report skill.

#### Questions the report does not answer

For anything custom — a filter, a join, a historical slice, a leaderboard the report does not cut — go to dexe_graph_query (default-visible; see topic 'read_dao_data'). NEVER guess an entity or field name: read the MCP resource dexe://graph-schema, or call dexe_graph_schema for live introspection — that tool is in the 'read' set, so under the default profile the resource is the schema reference. For 'what needs MY attention across all my DAOs' use dexe_user_inbox ('read' toolset) rather than one report per DAO.

**Pitfalls (danger first):**
- ⚠ ALWAYS bound dexe_graph_query list fields with `first:` (gateway max 1000) and paginate with `skip:` — responses over 120000 chars are rejected outright, so an unbounded query fails instead of streaming. Entity ids are lowercased concatenated bytes (e.g. proposal id = poolAddress + uint32-LE(proposalId), no separator); relation filters use the `_` suffix (pool_: {id: "0x…"}). Full entity/field reference: MCP resource dexe://graph-schema.
- ⚠ Subgraph and DeXe-backend data exist for BSC MAINNET (56) only. Every subgraph-backed tool takes `chainId` and REFUSES a chain it has no endpoint for — it never answers from another chain, so a testnet call errors loudly instead of handing back mainnet rows. The error names the chains that are indexed, the on-chain alternatives, and the env var to set. Affected: dexe_graph_query, dexe_read_dao_list, dexe_read_dao_members, dexe_read_delegation_map, dexe_read_dao_experts, dexe_read_validator_list, dexe_read_user_activity, dexe_proposal_voters, dexe_user_inbox (auto-discovery only — pass `daos: ["0x…"]` to scan any chain), dexe_proposal_forecast. Backend-only tools (dexe_read_token_holders, dexe_read_dao_stats, dexe_read_protocol_stats, dexe_read_nfts) stay mainnet-only. For testnet DAOs read on-chain instead: dexe_read_gov_state, dexe_read_settings, dexe_proposal_state, dexe_read_multicall (dexe_read_treasury falls back to RPC automatically). Every subgraph response carries `indexedChainId` — the chain the rows came from. To index another chain yourself set DEXE_SUBGRAPH_<KIND>_URL_<chainId> (e.g. DEXE_SUBGRAPH_POOLS_URL_97).
<!-- END GENERATED: topics -->

## Protocol gotchas (the rule corpus)

Every non-obvious DeXe rule, danger-first. GENERATED from
`src/knowledge/gotchas.ts` — edit there, then run `npm run gen:knowledge`.

<!-- BEGIN GENERATED: gotchas -->
- 🔴 **quorum-reachable** — Quorum must be REACHABLE: quorum% × totalSupply must be ≤ the token amount actually distributed to voters. Treasury/undistributed tokens cannot vote, so an unreachable quorum deadlocks the DAO forever — no proposal will ever pass. dexe_dao_create verifies this and refuses incoherent configs before any transaction.
- 🔴 **quorum-floor** — Quorum below ~50% opens treasury-drain territory: a small token holder group can pass proposals that move the whole treasury. The safe floor is 50% (override via DEXE_MIN_SAFE_QUORUM_PCT); builds that lower quorum below it return mode:"blocked-risky" and need an explicit confirmRisky:true re-run. Warn the user before they choose a low quorum.
- 🔴 **reward-commission** — Every EXECUTED proposal with rewards configured pays a ~30% DeXe protocol commission on the reward total (voteAmount × voteRewardsCoefficient + fixed rewards) from the DAO treasury at execute time. If the treasury can't cover it, the protocol MINTS new gov tokens (supply inflation — the quorum denominator grows). claimRewards on an empty treasury succeeds but silently pays 0. Keep voteRewardsCoefficient ≤ 1e23 (×0.01) or 0 unless the user explicitly budgets for it.
- 🔴 **approve-userkeeper** — When depositing gov tokens, ERC20.approve must target the DAO's UserKeeper, NEVER the GovPool. Approving the GovPool burns gas and the deposit reverts. The composites (dexe_proposal_create, dexe_proposal_vote_and_execute) sequence this correctly — do not hand-build the approve.
- 🔴 **spherex-addsettings** — CHAIN-ASYMMETRIC (verified 2026-07-23): on fresh TESTNET (97) pools, EXECUTING a proposal whose action is GovSettings.addSettings reverts 'disallowed tx pattern' — deterministically, re-running never helps. This hits change_voting_settings WITHOUT settingsIds, new_proposal_type, and enable_staking. On current MAINNET (56) fresh pools addSettings EXECUTES fine (proven 2026-07-22) — testnet runs an older protocol deployment. On 97: EDIT existing settings instead (pass settingsIds) — editSettings is always allowed — and do NOT use testnet to validate addSettings-based flows.
- 🔴 **monthly-withdraw-credit** — An internal monthly_withdraw draws from the validators' CREDIT LINE (GovPool.setCreditInfo), not directly from the treasury. Unfunded/insufficient line → execute reverts 'Validators: failed to execute' (the real cause is swallowed by a low-level call — this was mis-filed as SphereX finding F14). Fund it FIRST with an external validators_allocation proposal ({credits:[{token, amount}]}); dexe_read_validators shows the current lines and dexe_proposal_create refuses an uncovered monthly_withdraw up-front.
- 🔴 **distribution-vs-transfer** — Two different things both read as 'distribute tokens': (1) sending fixed amounts to a SPECIFIC ADDRESS LIST — do that post-deploy via token_transfer proposals (one per recipient), or at deploy time via ADVANCED params.tokenParams.users/amounts (SIMPLE mode allocates votable supply to the deployer only); (2) proposalType token_distribution — a PRO-RATA AIRDROP split among whoever VOTES on that proposal, NOT an address list. Picking token_distribution for an address list sends funds to the wrong people. Ask the user which they mean.
- 🔴 **otc-vesting-broken** — TokenSaleProposal.vestingWithdraw is blocked ('SphereX error: disallowed tx pattern') in EVERY call shape on fresh pools — the VESTED portion of a purchase CANNOT be withdrawn (confirmed protocol bug, escalated upstream). Until fixed: open tiers with vestingPercentage:"0" on new DAOs. claim (the instant portion) works fine.
- 🔴 **staking-not-on-testnet** — Staking DOES NOT EXIST on BSC testnet (chain 97): every testnet GovUserKeeper predates the staking implementation and stakingProposalAddress() reverts. Do not attempt staking transactions on 97 — plan the staking leg on mainnet (chain 56) and tell the user so.
- 🔴 **timestamps-future** — NEVER guess dates for sale/staking windows — compute Unix timestamps from the CURRENT time (ask the user or read the latest block; your idea of 'now' may be a stale year). Windows must be in the future AT EXECUTE TIME (add headroom for the voting period). A staking tier with a past deadline is SILENTLY rejected on-chain (the execute succeeds, a StakingRejected event fires, NO tier exists, the reward bounces back); a sale tier with a past window is created dead-on-arrival (every buy reverts 'TSP: token sale is over'). The builders refuse past end-times before any transaction.
- ⚠ **cap-rule** — Token cap rule: cap ≥ mintedTotal > 0. cap:0 reverts 'ERC20Capped: cap is 0' (there is no uncapped mode); cap < mintedTotal reverts; cap == mintedTotal is valid and means fixed supply (no future minting headroom).
- ⚠ **five-settings-ids** — A fresh dexe_dao_create deploy auto-expands FIVE proposal-settings ids: 0 default, 1 internal, 2 validators, 3 distribution, 4 tokenSale. Any later rewards/settings change must edit EVERY id whose executor matters — proposals routed through untouched executors keep the old values.
- ⚠ **delegated-voting-inverted** — The settings flag `delegatedVotingAllowed` is INVERTED versus its name: false = delegation IS allowed (the default), true = delegated votes are DISABLED for that proposal type. Do not "enable delegation" by setting it to true.
- ⚠ **min-votes-coherence** — minVotesForVoting and minVotesForCreating must be ≤ the largest single recipient's token allocation, or no holder can ever create/vote. dexe_dao_create's synthesized configs keep this coherent; check it when the user supplies explicit settings.
- ⚠ **state-enum** — Canonical ProposalState order: 0 Voting, 1 WaitingForVotingTransfer, 2 ValidatorVoting, 3 Defeated, 4 SucceededFor, 5 SucceededAgainst, 6 Locked, 7 ExecutedFor, 8 ExecutedAgainst, 9 Undefined. Execute is only valid from SucceededFor/SucceededAgainst; use dexe_proposal_state to check, never guess from the number.
- ⚠ **validator-leg** — DAOs with validators add a second voting chamber: Voting → (member quorum) WaitingForVotingTransfer → moveProposalToValidators → ValidatorVoting → (validator quorum) SucceededFor → execute. Voting in the validator chamber BEFORE the move reverts 'Validators: proposal does not exist'. dexe_proposal_vote_and_execute auto-drives the whole validator round when the signer is a validator; pass driveValidatorRound:false to stop after the member vote.
- ⚠ **vp-locked** — Tokens you voted with stay LOCKED per-proposal even after the proposal executes, and votingPower() reads 0 while locked (it shows available, not deposited, power). Between proposals run dexe_vote_build_withdraw to unlock, or the next create/vote fails with 'No voting power available'.
- ⚠ **spherex-create-pattern** — Fresh (SphereX-guarded, deployed ≥ 2026-07) pools reject multicall([deposit, createProposalAndVote]) with 'SphereX error: disallowed tx pattern'. Deposit and create must be SEPARATE transactions — the composites already send them separately; never re-bundle them.
- ⚠ **settings-ids-semantics** — settingsIds semantics: 0 = DEFAULT settings, 1 = INTERNAL settings (2 validators, 3 distribution, 4 tokenSale on fresh deploys). When editing, leave executorDescription blank to preserve the on-chain value — it holds the settings-JSON IPFS ref the frontend reads; overwriting it blanks the DAO's settings UI.
- ⚠ **blacklist-execute-trap** — A token transfer to a blacklisted recipient passes the vote and then REVERTS at execute — the proposal is stuck in SucceededFor forever (there is no cancel). Before proposing transfers of an ERC20Gov token, verify the recipient isn't blacklisted.
- ⚠ **internal-executor-description** — Internal (self-addressed, GovPool-executor) proposals require the internal settings' executorDescription to carry a non-empty IPFS URL, or creation reverts 'Gov: invalid internal data'. Fresh dexe_dao_create deploys set this up; hand-modified settings can break it.
- ⚠ **validator-cancel-blocked** — On fresh (SphereX-era) pools a cast VALIDATOR vote cannot be cancelled — GovValidators has no multicall, and raw cancelVote{Internal,External}Proposal is blocked in every shape. Top-up re-votes ARE allowed. Warn validators before they vote.
- ⚠ **distribution-full-duration** — Distribution (airdrop-to-voters) proposals IGNORE earlyCompletion: voting always runs the FULL duration because pro-rata shares depend on final vote totals. moveProposalToValidators/execute only work after voteEnd — do not report them as stuck. The `proposalId` param is SELF-REFERENCING (the id this proposal will get = latest + 1); dexe_proposal_create computes it.
- ⚠ **spherex-vote-multicall** — Raw top-level vote()/delegate() calls REVERT on fresh (SphereX-era) pools — the frontend always wraps them as GovPool.multicall([call]) even for a single call, and the dexe-mcp builders emit that shape since v0.24.1. If you hand-craft calldata, wrap it. Raw deposit/withdraw/cancelVote/undelegate/createProposal(AndVote) remain allowed.
- ⚠ **otc-native-sentinel** — Native BNB in sale tiers uses the sentinel address 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, NOT the zero address (0x0 reverts 'TSP: incorrect token'). A native-currency buy must send msg.value equal to the buy amount. The dexe_otc_* composites canonicalize this.
- ⚠ **otc-rate-precision** — Tier exchange rates are scaled ×1e25 (PRECISION) on-chain. Pass human units to the dexe_otc_* composites and they scale for you; only ADVANCED raw structs need pre-scaled values. A hand-scaled rate off by 10^2 sells the whole allocation for pennies.
- ⚠ **graph-bound-first** — ALWAYS bound dexe_graph_query list fields with `first:` (gateway max 1000) and paginate with `skip:` — responses over 120000 chars are rejected outright, so an unbounded query fails instead of streaming. Entity ids are lowercased concatenated bytes (e.g. proposal id = poolAddress + uint32-LE(proposalId), no separator); relation filters use the `_` suffix (pool_: {id: "0x…"}). Full entity/field reference: MCP resource dexe://graph-schema.
- ⚠ **subgraph-backend-mainnet-only** — Subgraph and DeXe-backend data exist for BSC MAINNET (56) only. Every subgraph-backed tool takes `chainId` and REFUSES a chain it has no endpoint for — it never answers from another chain, so a testnet call errors loudly instead of handing back mainnet rows. The error names the chains that are indexed, the on-chain alternatives, and the env var to set. Affected: dexe_graph_query, dexe_read_dao_list, dexe_read_dao_members, dexe_read_delegation_map, dexe_read_dao_experts, dexe_read_validator_list, dexe_read_user_activity, dexe_proposal_voters, dexe_user_inbox (auto-discovery only — pass `daos: ["0x…"]` to scan any chain), dexe_proposal_forecast. Backend-only tools (dexe_read_token_holders, dexe_read_dao_stats, dexe_read_protocol_stats, dexe_read_nfts) stay mainnet-only. For testnet DAOs read on-chain instead: dexe_read_gov_state, dexe_read_settings, dexe_proposal_state, dexe_read_multicall (dexe_read_treasury falls back to RPC automatically). Every subgraph response carries `indexedChainId` — the chain the rows came from. To index another chain yourself set DEXE_SUBGRAPH_<KIND>_URL_<chainId> (e.g. DEXE_SUBGRAPH_POOLS_URL_97).
- ℹ **treasury-remainder** — The DAO treasury is the IMPLICIT REMAINDER of the initial distribution: sum(recipient amounts) < mintedTotal, and the contract mints the difference to the DAO itself. Never list the govPool address as a distribution recipient. To give the user's address list X% of supply, put those addresses+amounts in the deploy-time distribution and leave the rest as treasury.
- ℹ **name-taken** — The DAO deploy create2 salt is deployer+name: the same deployer reusing a daoName on the same chain reverts 'pool name is already taken'. Pick a fresh name; a different deployer can reuse it.
- ℹ **votepower-init** — votePower initData is auto-encoded (LINEAR → __LinearPower_init selector 0x892aea1f, POLYNOMIAL → 3 coeffs). Do not override it; empty initData reverts 'power init failed'. Only CUSTOM presets take hand-made initData.
- ℹ **deposit-sequence** — Creating a proposal requires approve(UserKeeper) → deposit(GovPool) → createProposal, in that order. dexe_proposal_create runs the whole sequence; on partial failure it returns the landed-steps ledger — fix the cause and re-run the SAME call, completed steps are detected on-chain and skipped.
- ℹ **low-creating-power-race** — The FIRST proposal on a freshly deployed DAO can revert 'low creating power' — the just-landed deposit isn't credited at snapshot time. This is transient: re-run the SAME dexe_proposal_create call; the ledger resume skips the landed deposit and the create succeeds.
- ℹ **treasury-is-erc20** — The DAO treasury is a plain ERC20/NFT holding at the govPool address — it moves via governance proposals (token_transfer / withdraw_treasury / apply_to_dao through dexe_proposal_create), NOT via the personal deposit-withdraw function. GovPool.withdraw() only returns YOUR OWN deposited tokens.
- ℹ **validator-internal-enum** — Validator internal proposal types (GovValidators): 0 ChangeSettings, 1 ChangeBalances, 2 MonthlyWithdraw, 3 Offchain. Only a CURRENT validator can create them, and validators vote with their own validator balances — no deposit involved.
- ℹ **delegation-one-level** — Delegation is ONE level: a delegator delegates only their OWN deposited balance; received delegations cannot be re-delegated (hub-and-spoke, never chains). Effective voting power = own deposited + incoming delegations — verify with dexe_vote_user_power (totalBalance).
- ℹ **otc-whitelist-merkle** — Whitelisted tiers use a merkle root; the tier's uri must point to IPFS JSON {"list":[lowercased addresses]} so buyers can regenerate proofs — dexe_otc_dao_open_sale auto-uploads it when uri is empty (needs DEXE_PINATA_JWT). Buyer-side reads need the proof BEFORE getUserViews or canParticipate reads false.
- ℹ **staking-resolver** — The StakingProposal contract address is NOT in the registry or predicted addresses. Resolve it the way the frontend does: GovPool.getHelperContracts().userKeeper → GovUserKeeper.stakingProposalAddress(). Zero address = not deployed yet → deploying it is ONE permissionless direct transaction (GovUserKeeper.deployStakingProposal(), selector 0x82e97c92) sent via dexe_tx_send — NEVER a governance proposal, never custom/custom_abi. dexe_proposal_create(create_staking_tier) auto-resolves when stakingProposal is omitted and its error returns the exact paste-able TxPayload; then re-run the SAME call.
- ℹ **offchain-types** — Only TWO off-chain proposal types are creatable: single-option and multi-option. There is no for/against creation path (the backend 400s) — for a binary vote use offchain_single_option with voteOptions:["For","Against"]. Off-chain proposals are mainnet-DAO only and live on api.dexe.io, not on-chain.
- ℹ **offchain-decimal-quorum** — Off-chain (backend) quorum percentages are DECIMALS: 0.5 = 50%, not 50. The `type` field must be a registered template name (e.g. default_single_option_type), never an arbitrary string.
- ℹ **amount-conventions** — Amount strings: digits-only = RAW smallest units (wei); a decimal point ("12.5") = human units scaled by the token's REAL on-chain decimals (never assumed 18). Durations and delays are SECONDS (86400 = 1 day). Composite quorum/percent params are plain percent numbers (51).
- ℹ **testnet-first** — Chains: 56 = BSC mainnet, 97 = BSC testnet. Rehearse on 97 first (free faucet BNB) except for features that don't exist there (staking, subgraph, off-chain backend). Mainnet gas is cents per tx (~0.1 gwei) — never size budgets from Ethereum L1 intuition.
- ℹ **multicall-signature-form** — dexe_read_multicall calls need the FULL function fragment as `signature` — 'function balanceOf(address) view returns (uint256)', not just a name or selector — plus `target`, `method`, and `args`. Any contract address works (no allowlist); all calls in one request are batched into a single RPC round-trip. To discover signatures on DeXe contracts, run dexe_compile once then dexe_get_methods / dexe_get_abi (`dev` toolset).
<!-- END GENERATED: gotchas -->

## Error → remedy

| Error contains | What it means | Do this |
|---|---|---|
| `DEXE_PINATA_JWT is required` | Uploads need a Pinata key | Free key at app.pinata.cloud (pinJSONToIPFS + pinFileToIPFS) → `.env` → RESTART Claude Code. `/dexe-setup` walks through it |
| `insufficient funds for gas` | Signer has no BNB | Fund it; testnet 97: https://www.bnbchain.org/en/testnet-faucet |
| `not mined within …s` | Tx stuck/slow | `dexe_tx_status {txHash}`; re-run only if `not_found`. Never blind-resend |
| `REVERTED on-chain (status 0)` | Mined but failed; state unchanged | Read the revert reason; common: wrong proposal state, tokens locked, blacklisted recipient. Fix, re-run same call |
| `No voting power available` | 0 tokens deposited AND in wallet | Acquire the DAO's gov token; `vote_and_execute` auto-deposits wallet tokens by default |
| `voting is only possible in "Voting"` | Proposal past/pre voting | The error names the remedy per state (execute / wait / new proposal) |
| `is not a registered DeXe GovPool` | Wrong/fake govPool address | Re-check the address with `dexe_dao_registry_lookup` |
| `rate-limit / 429 / SERVER_ERROR` | Public RPC flaked (already retried) | Re-run; set own RPC in `.env` (`DEXE_RPC_URL_MAINNET/_TESTNET`, comma-list = auto-failover) |
| `tokens locked` after an execute | Voted tokens stay locked per proposal | `dexe_vote_build_withdraw` between proposals, then proceed |
| tool not found (`dexe_…`) | Toolset gated off | `dexe_context` lists hidden sets; set `DEXE_TOOLSETS` in `.env` + restart |

Composite failures also carry a stable `slug` (GENERATED from
`src/lib/errors.ts` KNOWN_FAILURES — the classifier the composites actually run):

<!-- BEGIN GENERATED: error-slugs -->
| Failure | What it means | Do this |
|---|---|---|
| `no-gas` | The signer wallet has no BNB to pay gas. | Fund the signer address with BNB on the target chain (testnet 97: use a faucet, e.g. https://www.bnbchain.org/en/testnet-faucet), then re-run. |
| `nonce-conflict` | A transaction with this nonce is already pending or mined. | A previous broadcast is still settling. Wait ~15s, check it with dexe_tx_status, then re-run — the flow re-checks completed steps and skips them. |
| `wallet-rejected` | The transaction was rejected in the wallet. | Re-run the call and approve the request on the phone/wallet when it appears. |
| `pinata-missing` | IPFS uploads need a Pinata JWT and none is configured. | 1) Create a free API key at https://app.pinata.cloud/developers/api-keys with pinJSONToIPFS + pinFileToIPFS permissions. 2) Add DEXE_PINATA_JWT=<jwt> to the .env at the dexe-mcp root (never .claude.json). 3) Restart Claude Code (the .env is read once at startup). Or run /dexe-setup for a guided walkthrough. |
| `pinata-failed` | Pinata (the IPFS pinning service) rejected or never answered the upload, so the metadata was NOT pinned. | HTTP 401/403 means the DEXE_PINATA_JWT is wrong, revoked, or lacks the pinJSONToIPFS/pinFileToIPFS scopes — mint a fresh key at https://app.pinata.cloud/developers/api-keys, put it in .env, and restart. A 429 or a timeout is transient (check status.pinata.cloud): wait ~30s and re-run the SAME call — the flow ledger skips the steps that already landed, so nothing is paid for twice. |
| `subgraph-failed` | The subgraph (indexer) failed, so this read returned NO data — that is NOT the same as 'the DAO has none'. Do not report an empty result. | Re-run once (429/5xx/timeouts are usually transient). If it persists, read the same facts on-chain instead — dexe_proposal_list / dexe_read_settings / dexe_dao_info need no indexer and are in the default profile; dexe_read_gov_state (needs DEXE_TOOLSETS=core,dev) and dexe_read_multicall (needs DEXE_TOOLSETS=core,read) cover the rest. A 401/403/429 on the shipped default endpoint means you are sharing the packaged Graph key: get a free one at thegraph.com/studio, set DEXE_SUBGRAPH_POOLS_URL / _VALIDATORS_URL / _INTERACTIONS_URL in .env, and restart. Entity/field names for a hand-written query: call dexe_graph_schema (live introspection, default profile) or read the dexe://graph-schema resource. |
| `backend-failed` | The DeXe backend API (api.dexe.io) failed or timed out — the enriched answer (USD prices, token discovery, off-chain proposals) is unavailable. | For reads, re-run: tools that can fall back serve the same call on-chain and report `degraded: true` (no token auto-discovery, no USD). For off-chain proposals/votes there is no on-chain fallback — the backend is the system of record, so wait and retry. A 401 means the Bearer token expired: re-run dexe_auth_login (needs DEXE_TOOLSETS=core,proposals) to mint a new one. Point DEXE_BACKEND_API_URL at another host only if you run your own. |
| `rpc-timeout` | The endpoint accepted the connection and then went silent until the deadline fired. The call was abandoned, not answered. | No state was changed by a timed-out READ — re-run it. If a WRITE timed out while waiting for a receipt, do NOT re-send blindly: check it with dexe_tx_status first, it may still land. A public endpoint that keeps stalling will not improve: set your own DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET (Alchemy/QuickNode/Ankr) in .env and restart. The receipt-wait budget is tunable via DEXE_TX_WAIT_TIMEOUT_MS. |
| `rpc-flaky` | The RPC endpoint failed or rate-limited mid-call (retries were already attempted). | Re-run the call — completed steps are skipped. For reliability set a private endpoint in .env (DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET, e.g. Alchemy/QuickNode/Ankr) and restart. |
| `onchain-revert` | The transaction reverted on-chain (state was NOT changed by this step). | Read the revert reason above if present. Common causes: proposal not in the required state (check dexe_proposal_state), tokens locked in an active proposal (withdraw between proposals), or a blacklisted recipient. Fix the cause and re-run — earlier landed steps are skipped. |
<!-- END GENERATED: error-slugs -->

## DAO deploy reverts → fix (v0.24: the pre-sign simulation catches these BEFORE gas is spent)

`dexe_dao_create` simulates the exact deploy calldata (eth_call from the deployer)
before signing. A provable revert is refused with one of these classified causes —
apply the fix verbatim. Mirrors `src/lib/deployRevertMap.ts` (single source).

| Revert contains | Slug | Fix |
|---|---|---|
| `pool name cannot be empty` | name-empty | Pass a non-empty daoName; if it WAS non-empty, run `dexe_compile` (ABI drift — the round-trip self-check pinpoints the field) |
| `pool name is already taken` | name-taken | This deployer already used this name on this chain (create2 salt = deployer+name). Pick a different daoName |
| `unexpected pool address` | predicted-address-drift | Protocol upgraded between predict and deploy — re-run; if persistent, `dexe_compile` |
| `power init failed` | vote-power-init | Don't override votePower initData (auto-encoded for LINEAR/POLYNOMIAL); for CUSTOM verify presetAddress + initData |
| `can't initialize token` | token-init-failed | Inner token-init revert (reason swallowed): check cap > 0, cap ≥ mintedTotal, users/amounts parity, sum(amounts) ≤ mintedTotal |
| `ERC20Capped: cap is 0` | cap-zero | Set cap ≥ mintedTotal (cap == mintedTotal = fixed supply; no uncapped mode) |
| `mintedTotal should not be greater than cap` | cap-lt-minted | Raise cap or lower mintedTotal |
| `ERC20Gov: overminting` | over-distribution | sum(amounts) must be ≤ mintedTotal (treasury = remainder) |
| `users and amounts lengths mismatch` | users-amounts-mismatch | One amount per recipient |
| `GovSettings: invalid …` | settings-bounds | duration/durationValidators > 0; 0 < quorum ≤ 1e27 (1% = 1e25) |
| `GovUK: zero addresses` | userkeeper-asset | Set a gov token, an NFT, or tokenParams.name (new token) |
| `Validators: …` | validators-init | duration > 0, 0 < quorum ≤ 1e27, no zero addresses, balances parity |
| `SphereX error` / `disallowed tx pattern` | spherex-pattern | On deploy/create: send plain single txs (dexe_dao_create already does); re-run once if it persists. On `execute`: the proposal's ACTION pattern is blocked — known case: `GovSettings.addSettings` on fresh pools (change_voting_settings without settingsIds, new_proposal_type, enable_staking). Deterministic — re-running won't help; use editSettings (settingsIds) or run on an older pool. On `vote`/`delegate`: raw top-level calls are blocked on SphereX-era pools (deployed ≥ 2026-07) — the frontend always sends `multicall([...])`, and since v0.24.1 the builders/composites emit that shape automatically; if you hand-craft calldata, wrap it in `GovPool.multicall([call])`. Raw deposit/withdraw/cancelVote/undelegate/createProposal(AndVote) remain allowed. Also blocked with NO workaround on fresh pools: `GovValidators.cancelVote*Proposal` (no multicall on that contract) and `TokenSaleProposal.vestingWithdraw` (avoid vesting tiers on new DAOs) |
| (no reason string) | opaque | Likely: settings bounds, name taken, cap conflict, validator params — re-run through dexe_dao_create's preflights; `dexe_compile` if ABI may be stale |

## Reward economics (read BEFORE configuring rewardsInfo)

Every EXECUTED proposal with rewards configured pays a **~30% DeXe protocol
commission on the reward total** (voteAmount × voteRewardsCoefficient + fixed
creation/execution rewards) from the DAO treasury to the DeXe protocol treasury
— at execute time, before anyone claims. Proven costs: `voteRewardsCoefficient
= 1e25` (×1.0) with a 6M-token vote cost the treasury **1.8M tokens** on a
single execute. When the treasury can't cover the commission the protocol
**mints new gov tokens** to pay it (supply inflation — the quorum denominator
grows too). `claimRewards` on an empty treasury succeeds but silently pays 0.

`dexe_dao_create` / `dexe_dao_build_deploy` now surface this automatically: any
non-zero `rewardsInfo` in the deploy config adds a `[reward-economics advisory]`
to the preview/build note (advisory-only — never blocks).

Rules of thumb: keep `voteRewardsCoefficient` tiny (≤ 1e23 = ×0.01) or 0;
budget commission ≈ 0.3 × expectedVote × coefficient per executed proposal; a
rewards change must edit ALL FIVE settings ids (see change_voting_settings
note) or untouched executors keep paying.

## Toolsets (DEXE_TOOLSETS, default `core`)

| Set | Unlocks |
|---|---|
| core (default) | `DEXE_TOOLSETS=core` — context, doctor, guide, dao_create, proposal_create (all 33 types), vote_and_execute, all OTC composites, tx_send/status, WalletConnect, IPFS uploads, plus the zero-config reporting reads (dao_report, graph_query/graph_schema, dao_info, treasury/settings, dao_list/stats/members, token_holders, delegation_map, proposal_state/list) |
| proposals | `DEXE_TOOLSETS=core,proposals` — every single-purpose `dexe_proposal_build_*` builder, the off-chain (backend) proposal types and `dexe_auth_login`. This is the pre-0.31.0 default, restored verbatim |
| read | `DEXE_TOOLSETS=core,read` — the long-tail reads core leaves out: read_multicall, nfts, validators, protocol_stats, expert_status, staking/token-sale/distribution reads, user_activity, proposal_voters, user_inbox, proposal_forecast, risk_assess |
| vote | `DEXE_TOOLSETS=core,vote` — delegate/undelegate, claim_rewards, staking, NFT multiplier, cancel_vote, validator votes, and the raw `dexe_vote_build_*` payloads the composites don't cover (also carries agents_list/agents_fund, unchanged since 0.28.0) |
| agents | `DEXE_TOOLSETS=core,agents` — the fleet surface: `dexe_agents_list` (keyring roster + balances), `dexe_agents_fund` (preview → `confirm:true` top-ups, bounded by `DEXE_AGENT_FUND_MAX_WEI` and the rolling-24h `SWARM_DAILY_BNB_BUDGET`), `dexe_agents_ledger` (per-persona actions, spend, remaining budget). Add `vote` (`core,agents,vote`) when a delegation or validator leg needs the raw builders. Safety model: `docs/AGENTS.md` |
| governor | `DEXE_TOOLSETS=core,governor` — dexe_gov_* for external OZ/Compound Governor DAOs |
| dev | `DEXE_TOOLSETS=core,dev` — compile + ABI introspection, dao_build_deploy (raw), simulate/decode, merkle, safe |

`DEXE_TOOLSETS=full` loads everything. Change requires a Claude Code restart.
Sets are additive and may overlap; `dexe_context` reports which are off and what they unlock.

## Signer bootstrap (first write)

1. **WalletConnect (recommended)** — zero config: any write (or `dexe_wc_connect`)
   prints a QR; scan with a mobile wallet (MetaMask/Trust/SafePal), approve each tx
   on the phone. Keys never touch this machine.
2. **Hot key (NOT SAFE — throwaway wallets only)** — `DEXE_PRIVATE_KEY=0x…` in `.env`
   + restart. Plaintext on disk; never a treasury or personal key.
3. **Gas**: the signer needs BNB on the target chain. Testnet 97 faucet:
   https://www.bnbchain.org/en/testnet-faucet (alt: https://faucet.quicknode.com/binance-smart-chain/bnb-testnet).
   Mainnet fees are cents (~0.1 gwei), not Ethereum-scale.

## The golden path (fresh investor, testnet rehearsal → mainnet)

```
dexe_dao_create {daoName:"…", symbol:"…", totalSupply:"1000000", chainId:97}   → preview
dexe_dao_create {…same…, confirm:true}                                          → deployed (predictedGovPool)
dexe_proposal_create {govPool, title:"…", proposalType:"token_transfer",
                      params:{token, recipient, amount:"100.0"}}                → proposal #1 (auto-votes your power)
dexe_proposal_vote_and_execute {govPool, proposalId:1}                          → executed
dexe_otc_dao_open_sale {govPool, tokenSaleProposal, tiers:[…]}                  → sale proposal → vote_and_execute → live
dexe_otc_buyer_buy {tokenSaleProposal, tierId:"1", tokenToBuyWith, amount:"50.0"}
```
Repeat on `chainId:56` when green. DAOs deployed by `dexe_dao_create` already have the
TokenSale + Distribution executors wired — OTC works immediately after deploy.
