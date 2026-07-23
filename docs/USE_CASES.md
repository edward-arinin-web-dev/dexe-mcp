# Use cases — what you can actually do with dexe-mcp

Short, verified scenarios that show what an AI agent wired to dexe-mcp can do for you.
Each case: what you say → what happens → which tools fire. ✅ = verified live (date,
chain, evidence). For exact call recipes see [PLAYBOOK.md](PLAYBOOK.md); for worked
JSON examples see [USAGE.md](USAGE.md); for the full 165-tool catalog see [TOOLS.md](TOOLS.md).

Reads need ZERO configuration. Writes need a signer (WalletConnect or a hot key —
see [SETUP.md](SETUP.md)). Amounts accept raw wei or human units ("12.5").

---

## A. Basics — your first DAO

### 1. Create a DAO with its own token
> "Create a DAO called Riverstone Collective with a 10M RVS token, 20% to my wallet, rest to treasury."

One `dexe_dao_create` call: deploys GovPool + token + all helpers, uploads profile
(avatar via `avatarPath`, description, socials) to IPFS, previews the resolved config
with a governance-safety proof (quorum reachable ≤ votable, floor ≥50%) before
broadcasting. ✅ 20+ DAOs deployed this way (BSC 56 + 97, 2026-07); latest campaign
2026-07-22.

### 2. First proposal → vote → execute
> "Propose sending 1,000 RVS to 0xABC…, vote for it with all my power, execute when passed."

`dexe_proposal_create` (any of 33 catalog types; handles approve→deposit→create→vote
in one call) then `dexe_proposal_vote_and_execute` (auto-deposits when power is short,
drives the validator round if the DAO has one). ✅ 2026-07-23 chain 97 (Bramble Hill #5)
+ 10/10 mainnet flows in the 2026-07-22 campaign.

### 3. Join someone else's DAO
> "What's my status in DAO X? Deposit 500 tokens, vote on the open proposal, claim anything claimable."

`dexe_vote_user_power` → `dexe_vote_build_deposit` → `dexe_vote_build_vote` →
`dexe_vote_build_claim_rewards`. The inbox (case 15) tells you what needs attention
first. ⚠ Tokens stay locked while a voted proposal is live — withdraw between
proposals, not during.

---

## B. Ask questions — contracts, The Graph, backend

Natural-language Q&A over three data sources: on-chain contracts (any configured
chain), the DeXe subgraphs (BSC mainnet), the DeXe backend (mainnets).

### 4. "Does DAO X have validators, and how many?"
`dexe_read_validators` (on-chain count + isValidator check) cross-checked by
`dexe_read_validator_list` (subgraph, balance-ordered). ✅ 2026-07-23 chain 56:
Silverpine — on-chain count 3 == subgraph 3, balances 400/200/100.

### 5. "Which DAOs are the biggest / find DAO by name?"
`dexe_read_dao_list` — voter-count-ordered, name search. ✅ 2026-07-23: BOXY DAO
(104 voters), DeXe Protocol (66 voters, 28 proposals), CHOW, Carib DAO…

### 6. "Who are the whales of this token?"
`dexe_read_token_holders` — full holder→balance map, sorted, same source as
app.dexe.io. ✅ 2026-07-23 chain 56 (SLPH: 8 holders, treasury visible).

### 7. "Show this DAO's TVL and activity for the last month."
`dexe_read_dao_stats` — the exact time series behind the app.dexe.io profile chart
(tvl_usd, members, proposals). Downsampled to `maxPoints` (default 30) so a month of
hourly data doesn't flood the conversation. ✅ 2026-07-23 chain 56: DeXe Protocol —
TVL $410.9M, 47,217 members. ⚠ Freshly created DAOs take a while to appear in the
tracker (day-old DAO returned 0 points).

### 8. "What did wallet X do across all DAOs?"
`dexe_read_user_activity` — cross-DAO feed with decoded labels
(DAO_POOL_PROPOSAL_CREATED, …VOTED, …DEPOSITED, …). ✅ 2026-07-23.

### 9. "Who delegated to whom, and how much?"
`dexe_read_delegation_map` (pass plain wallet addresses) + `dexe_read_dao_experts`.
✅ 2026-07-23 chain 56: found a live 500k cross-DAO delegation.

### 10. "Who voted on proposal N and which way?"
`dexe_proposal_voters` — voter, amount, VOTE_FOR / VOTE_AGAINST / VOTE_CANCEL label,
tx hash. ✅ 2026-07-23 chain 56 (Silverpine #16: 2 voters, one of them another DAO).

### 11. "Is this address even a DeXe DAO?" / "Show members."
`dexe_dao_registry_lookup` (PoolRegistry.isGovPool) + `dexe_read_dao_members`
(APR, delegations, rewards, expert status per member). ✅ 2026-07-23.

### 12. "Which DAOs were most active in the last N days?"
> "Show me the most active DAOs over the last month."

`dexe_graph_query` — free-form GraphQL over the three DeXe subgraphs (entity
reference: [GRAPH.md](GRAPH.md)). The agent writes the query itself, e.g.
`daoProposalCreates(where: { transaction_: { timestamp_gt: $since } })` grouped
by pool. ✅ 2026-07-23: 33 proposals / 8 DAOs in 30d, top DAO identified.
⚠ pools `Proposal` has no creation timestamp — time-windowed activity comes from
the interactions subgraph.

### 13. "How big is DeXe governance overall?"
> "Total TVL across all DAOs? How many DAOs and proposals exist?"

`dexe_read_protocol_stats` — the app.dexe.io landing numbers: protocol TVL
(server-aggregated over chains 1+56), total proposals, DAO count, voting-locked
value, TVL time series, top-N DAOs by TVL. ✅ 2026-07-23: $817.5M TVL across
239 DAOs, 710 proposals, top-10 leaderboard.

---

## C. Automation — pair the MCP with your agent's scheduler

dexe-mcp tools are stateless and cheap (reads are free RPC/subgraph calls), which
makes them ideal loop bodies for Claude Code's `/loop` (in-session recurring runs)
and `/schedule` (cloud cron). The diffing memory lives in the conversation — the
agent remembers the last-seen state between iterations.

### 14. Proposal watchdog
> `/loop 2h — Check DAOs 0xAAA…, 0xBBB… for proposals newer than the last id you reported. For each new one: dexe_decode_proposal + dexe_proposal_risk_assess, then give me a one-line verdict each.`

Loop body: `dexe_proposal_list` (compare `proposalId` against last seen) →
`dexe_decode_proposal` → `dexe_proposal_risk_assess`. ✅ mechanics verified
2026-07-23 (list → decode → risk on live mainnet proposals; SAFE verdict with
treasury-at-risk readout).

### 15. Personal governance inbox / daily digest
> `/schedule daily 9am — Run dexe_user_inbox for 0xME…; summarize unvoted proposals (with deadlines), claimable rewards, and locked deposits. Message me only if something needs action.`

`dexe_user_inbox` auto-discovers your DAOs (mainnet) and returns unvoted proposals,
claimable rewards (static + voting + off-chain, per-proposal ids), locked deposits.
✅ 2026-07-23 chain 56: 7 DAOs discovered, 785k tokens of claimable rewards surfaced.
⚠ It's a point-in-time snapshot — pair with /loop//schedule for monitoring.

### 16. Quorum tracker
> `/loop 30m — dexe_proposal_state for DAO X proposal N. Tell me when votesFor crosses requiredQuorum or voteEnd is <6h away and I haven't voted (dexe_gov_has_voted / dexe_user_inbox).`

### 17. Treasury monitor
> `/loop 6h — dexe_read_treasury for DAO X. Compare with the balances you saw last time; alert me on any change >1%.`

Auto-discovers every token with USD prices. ✅ 2026-07-23 chain 56.

### 18. Policy-based auto-voter (handle with care)
> `/loop 4h — For new proposals in DAO X: dexe_proposal_risk_assess + dexe_decode_proposal. If verdict SAFE and it's a profile/metadata change, vote FOR with dexe_proposal_vote_and_execute. If it touches the treasury or settings, do NOT vote — send me the readout instead.`

The risk tools are built for exactly this split: `treasuryTouching`, `quorumPct`,
per-action decode. ⚠ Keep treasury- and settings-touching proposals on the
human-approval side of your policy. Advisories (`treasuryRisk`) fire automatically
on execute paths.

### 19. Token-sale monitor
> `/loop 12h — dexe_otc_list_sales_for_dao for DAO X; alert me when a new tier opens or one I follow crosses 80% sold.`

---

## D. Proposal analysis & due diligence

### 20. "Is this proposal safe? Who profits?"
> "Analyze proposal 16 in DAO X — anything suspicious?"

`dexe_decode_proposal` (every action decoded against known ABIs, `privileged` flag)
+ `dexe_proposal_risk_assess` (quorum % vs safe floor, treasury tokens the actions
can move, share of supply needed to force it through, whether controlling holders
already voted) + `dexe_sim_proposal` (will execute revert?). ✅ 2026-07-23 chain 56:
transfer decoded to recipient+amount, verdict SAFE, treasury-at-risk listed.

### 21. DAO due diligence before you join or buy
> "I'm considering buying into DAO X — check its governance safety."

Composite: `dexe_read_settings` (labeled fields + derived `quorumPct` — is quorum
≥50%? is `earlyCompletion` on?) + `dexe_read_token_holders` (can one whale hit
quorum alone?) + `dexe_read_validators` (is there a validator chamber?) +
`dexe_read_dao_stats` (is it alive?). The quorum-attack math: quorumPct × supply vs
what's buyable on market. ✅ components verified 2026-07-23.

### 22. Rehearse before you broadcast
`dexe_sim_calldata` / `dexe_sim_proposal` / `dexe_sim_buy` — eth_call preflight with
revert-reason decode; `dryRun: true` on every composite returns the ordered
TxPayloads without broadcasting.

---

## E. Advanced operations

### 23. Call ANY smart contract through your DAO
> "Make the DAO approve 12,345 tokens allowance to our ops lead."

`dexe_proposal_create` with `proposalType: "custom_abi"` — `{target, signature
("function approve(address,uint256)"), method, args}`. The DAO itself executes the
call on the external contract. ✅ 2026-07-23 chain 97 E2E: proposal #5 created →
voted → executed → on-chain `allowance(dao, ops)` read back **exactly 12,345e18**.
⚠ signature must be a full fragment starting with `function `; privileged
accounting selectors are refused by the selector guard.

### 24. OTC token sale, end to end
Open a multi-tier sale, buyers check status / buy / claim vesting — five
`dexe_otc_*` composites. Full recipe: [OTC.md](OTC.md). ✅ mainnet lifecycle
2026-07-03 (Solstice Guild) + campaign 2026-07-22.

### 25. Cross-DAO delegation — one DAO votes in another
A DAO's treasury delegates voting power to another DAO (or any address), which then
votes with it. Recipe: `dexe_vote_build_delegate` from the treasury via proposal,
delegatee votes normally. ✅ live on mainnet: Silverpine #16 was voted by the
Driftwood DAO with 500k delegated tokens (2026-07-22).

### 26. Beyond DeXe: Uniswap / Compound / Optimism governance
The 18 `dexe_gov_*` tools speak OpenZeppelin Governor + Compound Bravo: read
proposals/quorum/state, build vote/queue/execute payloads, simulate.
See [GOVERNOR.md](GOVERNOR.md).

### 27. Safe{Wallet} multisig ops
Queue any built payload to a Safe instead of broadcasting from a hot key —
`dexe_safe_propose_tx` / `dexe_safe_info`. See [SAFE.md](SAFE.md).

### 28. Staking programs, validators, experts, blacklists…
Every one of the 33 catalog proposal types is a one-call `dexe_proposal_create`
away: `create_staking_tier` + `enable_staking`, `manage_validators` (verified to
actually change validator balances — read back with `dexe_read_validator_list`),
`add_expert`, `blacklist`, `reward_multiplier`, `change_voting_settings` (guarded:
lowering quorum into drain territory requires `confirmRisky`). Recipes: PLAYBOOK.

---

## F. Agent swarm / bot factory (v0.28)

### 29. Multi-persona DAO activity from one MCP
> "Create 3 DAOs from 3 different wallets, have them vote from distinct personas, and report the activity."

The opt-in **agent keyring**: set `DEXE_AGENT_PK_1..16` — or the swarm-harness
naming `AGENT_PK_1..16` + `AGENT_FUNDER_PK` (→ signerKey `funder`), accepted as
aliases since 0.29 — in `.env` (one throwaway
hot key per persona), then every broadcast surface takes `signerKey: "agent<n>"` —
`dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`,
`dexe_proposal_vote_and_execute`, and the OTC buyer composites. Ops tools:
`dexe_agents_list` (roster + balances) and `dexe_agents_fund` (gas top-ups from
the primary signer — recipients hard-restricted to keyring addresses, per-agent
cap `DEXE_AGENT_FUND_MAX_WEI`). Per-signer nonce queues let agents broadcast
concurrently. Enable the `vote` toolset to see the agents tools.

Recipe: Claude subagents (the Agent tool) as personas — each subagent gets its
`signerKey` in the prompt and drives its own deposits/votes/delegations; the
main session plays orchestrator with `dexe_agents_list` + the read tools as the
scoreboard. ⚠ Hot keys in plaintext — throwaway wallets only, testnet-first.

### 30. Distributed voting with independent stances
> "agent1 votes FOR with 100k, agent2 votes AGAINST with 50k, I abstain — then show the tally."

Same keyring, one proposal: `dexe_proposal_vote_and_execute` per agent with
`isVoteFor` per persona, then `dexe_proposal_voters` / `dexe_vote_get_votes` as
the read-back.

---

## Gotchas the cases above surfaced

| Gotcha | Detail |
|---|---|
| Subgraph = BSC mainnet only | `dao_list/members/experts/validator_list/user_activity/proposal_voters` read the env-bound mainnet subgraphs regardless of `chainId`; testnet has no subgraph. |
| Young DAOs invisible in stats | The tracker behind `dexe_read_dao_stats` onboards new DAOs with a lag (day-old DAO → 0 points). On-chain + subgraph reads see them immediately. |
| Two different proposal counts | Subgraph `proposalCount` counts on-chain proposals (e.g. 28); the tracker's `total_proposals_count` includes off-chain ones (e.g. 48). |
| `custom_abi` signature format | Must be a full fragment: `"function transfer(address,uint256)"` — bare `"transfer(address,uint256)"` fails with `unknown function`. |
| Tokens locked after voting | Deposited tokens stay locked while a proposal you voted on is live; withdraw between proposals. |
| Inbox is a snapshot | `dexe_user_inbox` keeps no state — diffing across time belongs to your /loop//schedule agent. |
| Fresh pools & SphereX | New GovPools reject some bundled multicall patterns; the composites already sequence around this. |
