# Execution Plan: Governor MCP Generalization

Derived from `research/05-decision.md` recommendation. Solo dev, 6-week cap.

---

## 0. Confidence Statement

- **Source of recommendation:** synthesized (not forced). `05-decision.md` commits to Option 1 with confidence **H**; three reports converge (`01§4.1`, `02§Phase 1`, `03§P1+P10`).
- **Key assumption being bet on:** vanilla OZ Governor + ERC20Votes + Timelock is stable enough across the 11 Tier-1 DAOs that a single config schema + single adapter ships for all of them with zero per-DAO code branches.
- **What would invalidate it:** the first non-Uniswap Tier-1 DAO (Compound or Optimism) requires per-DAO code overrides — the config-only premise collapses and effort doubles.

---

## 1. Objective

By end of week 6, any non-DeXe-team developer can install `dexe@gov` and successfully invoke at least one `dexe_gov_*` tool against a live OpenZeppelin Governor on Uniswap, Compound, or Optimism mainnet — verified by tx hash, GitHub issue, or download analytics.

---

## 2. Success Metrics

| Name | Target | Measurement | Deadline |
|---|---|---|---|
| Tier-1 coverage | 3 DAOs (Uniswap, Compound, Optimism) | each config-file entry passes integration suite | W4 |
| Tool count | ≥18 `dexe_gov_*` tools shipped | `dexe_list_contracts`-style enumeration of `src/governor/tools/` exports | W5 |
| State-enum parity | 100% match vs Tally for 30 sampled live proposals (10/DAO) | scripted comparison harness in `tests/governor/parity.test.ts` | W4 |
| External invocation | ≥1 confirmed non-team `dexe_gov_*` invocation against mainnet | GitHub issue link, Discord screenshot, or npm download attribution | W6 |
| Mainnet vote-cast broadcast | 1 signed-offline + broadcast vote-cast tx on a live Tier-1 proposal | Etherscan tx hash, VoteCast event emitted | W6 |

---

## 3. Acceptance Criteria

- [ ] Config schema (`src/governor/config.schema.json`) parses Uniswap, Compound, and Optimism entries without raising
- [ ] Governor adapter resolves any OZ Governor v4.x+ ABI from chain via Etherscan/Sourcify lookup
- [ ] `dexe_gov_get_proposal(governor, proposalId)` returns identical `ProposalState` enum vs Tally for 10 sampled live proposals on each Tier-1 DAO
- [ ] `dexe_gov_get_voting_power(governor, account, blockNumber)` matches `IVotes.getPastVotes` direct call to the byte
- [ ] `dexe_gov_build_propose` produces calldata that decodes back to identical `(targets, values, calldatas, description)`
- [ ] `dexe_gov_build_vote_cast` calldata broadcasts successfully against a forked mainnet and emits `VoteCast` event
- [ ] `dexe_gov_simulate_proposal` runs `execute()` against a forked mainnet and returns `{success, revertReason, treasuryDelta}`
- [ ] `README.md` + `docs/TOOLS.md` + `docs/GOVERNOR.md` published; npm package `dexe` ships with `gov` dist-tag
- [ ] ≥1 external user has invoked a `dexe_gov_*` tool against mainnet, evidenced by GitHub issue, Discord post, or download analytics
- [ ] No `dexe_gov_*` tool depends on any DeXe Protocol contract being deployed on the target chain

---

## 4. Test Plan

### 4.1 Unit / mechanical tests (CI)

- `test_governor_config_parser_accepts_uniswap_compound_optimism`
- `test_governor_config_rejects_missing_required_fields`
- `test_governor_abi_resolver_handles_oz_v4_and_v5`
- `test_proposal_state_enum_matches_oz_canonical_order`
- `test_build_propose_calldata_selector_matches_0x7d5e81e2`
- `test_build_vote_cast_decode_roundtrip`
- `test_voting_power_query_invokes_getPastVotes_not_balanceOf`
- `test_no_governor_tool_imports_dexe_protocol_contracts`

### 4.2 Integration tests (forked mainnet via Hardhat/anvil)

- `it_resolve_uniswap_proposal_X_state_matches_tally`
- `it_resolve_compound_proposal_X_state_matches_tally`
- `it_resolve_optimism_proposal_X_state_matches_tally`
- `it_build_vote_cast_on_uniswap_fork_emits_VoteCast`
- `it_simulate_compound_proposal_executes_without_revert`
- `it_voting_power_at_proposal_snapshot_block_matches_chain`
- `it_optimism_partial_delegation_does_not_break_read_path`
- `it_propose_against_compound_fork_returns_pending_state`

### 4.3 Real-world validation (manual)

- `live_uniswap_vote_cast_broadcast` — sign + broadcast a zero-impact `abstain` vote on a real live proposal; record Etherscan link
- `tally_or_independent_dev_invokes_one_tool` — DM Tally / Karpatkey / Boardroom / one external dev, confirm at least one tool call
- `demo_video_30s_published` — Loom or YouTube unlisted; linked in README

---

## 5. Milestones

**W1: Config schema + Uniswap read path**
- Ship `src/governor/config.schema.json`, `configs/uniswap.json`, `adapter.ts` (ABI resolver + state mapper), and 4 read tools: `get_proposal`, `get_voting_power`, `get_quorum`, `get_proposal_threshold`
- AC met: 1, 2, 3 (Uniswap only), 4
- Risk if slips: no buffer for W6 external-validation window; consider pulling Optimism to V2 stretch

**W2: Build tools (Uniswap)**
- Ship `build_propose`, `build_vote_cast`, `build_queue`, `build_execute`, `build_delegate`
- AC met: 5, 6
- Risk if slips: simulator (W3) starts late; W4 parity harness compressed

**W3: Simulator + Compound + Optimism configs**
- Ship `simulate_proposal`, `simulate_vote_impact`, `configs/compound.json`, `configs/optimism.json`; replay integration suite for all 3
- AC met: 7, 3 (full), 1 (full)
- Risk if slips: external-validation window in W6 shortened; demo video slips

**W4: Parity harness vs Tally + bug fixes**
- Ship `tests/governor/parity.test.ts` — scripted Tally API comparison for 30 sampled proposals; fix any state-enum or quorum mismatches found
- AC met: state-parity metric, all read-path criteria
- Risk if slips: metric #3 deadline missed; flag for narrowing scope

**W5: Docs + npm release**
- Update `README.md` (+gov tool count, group catalog table), `docs/TOOLS.md`, write `docs/GOVERNOR.md` with paste-able examples, publish `dexe` w/ `gov` dist-tag
- AC met: 8
- Risk if slips: external user has nothing to try; metric #4 at risk

**W6: Outreach + live broadcast + metric collection**
- Email/DM Tally, Karpatkey, Boardroom, 5 independent governance devs; record demo video; broadcast one zero-impact abstain vote on a live Tier-1 proposal
- AC met: 9, 10
- Risk if slips: trigger kill criterion review per `05-decision.md`

---

## 6. Out of Scope

- ❌ Aave v2/v3 dual short/long executor routing
- ❌ Arbitrum `ProposalTypesConfigurator` and per-type quorum
- ❌ Lido Aragon Agent executor semantics
- ❌ Vote-escrow (ve) voting — GMX, Frax, Curve out
- ❌ MakerDAO Chief and any non-ERC20Votes vote token
- ❌ Snapshot off-chain → on-chain execution bridge
- ❌ Multichain proposal aggregation (Optimism Superchain, Uniswap multi-chain quorum splits)
- ❌ Delegate scorecard / voting-history analytics surface
- ❌ IPFS multi-pin durability orchestrator (separate option #4 in `05-decision.md`)
- ❌ Pre-built proposal type DSL — Governor surface stays generic `(targets, values, calldatas, description)`
- ❌ Web UI / hosted SaaS dashboard
- ❌ Safe ↔ Governor execution bridge (separate option #5)
- ❌ Cross-chain governance relay (separate option #7)
- ❌ Wallet integrations beyond ethers v6 + existing `dexe_tx_send`
- ❌ Gas-sponsorship / meta-tx flows
- ❌ Governor v3 (Compound Bravo pre-OZ) — addressed as stretch only if Compound's Governor turns out to be Bravo-v3 era

---

## 7. Risks and Mitigations

**R1 — Tier-1 quirk breaks config-only premise** (likelihood M, impact H)
- Early warning signal (W1-W2): building Compound or Optimism reveals an ABI shape that diverges from Uniswap baseline (different `state()` enum, different `castVote` signature, ProposalCreated event drift)
- Mitigation: defer Compound and Optimism to W3; if quirks appear, pin scope to Uniswap-pattern only and demote Optimism to V2 follow-up
- Kill criterion: if 2 of 3 Tier-1 DAOs need bespoke per-DAO code (not config-only), abandon Option 1 → return to `05-decision.md` Option 2 (Pre-vote simulator) as the next pull

**R2 — Zero external user invocations by W6 deadline** (likelihood M, impact H)
- Early warning signal (W3-W4): outreach DMs to Tally / Karpatkey / Boardroom return zero replies; npm download attribution shows only self
- Mitigation: pre-seed outreach in W1 (not W6); ship demo video in W3 (not W6); offer ≥3 independent governance devs a free 30-min pairing session to try it
- Kill criterion: 30 days post-W5 npm publish with zero non-team invocations → revert positioning per `05-decision.md` final kill clause

**R3 — OZ Governor version drift (v3 Bravo vs v4 vs v5)** (likelihood L, impact M)
- Early warning signal (W1): Etherscan ABI fetch for Compound returns Bravo-v3 signatures (no `castVoteWithReason` overload, different `state()` enum)
- Mitigation: detect Governor version at adapter init; ship v4+ baseline first, mark v3-Bravo as stretch in W3 only if quick win
- Kill criterion: not a fatal risk — narrow to 2 DAOs (drop the v3 outlier), keep moving; document the limitation in `docs/GOVERNOR.md`

---

## 8. First Action

Branch `governor-adapter` from `main`. Create two files: `src/governor/config.schema.json` (JSON Schema lifted from `02§Code Artifact`) and `src/governor/configs/uniswap.json` (governorAddress `0x408ED6354d4973f66138C91495F2f2FCbd8724C3`, UNI token `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984`, timelock `0x1a9C8182C09F50355CeA8fFF4b7E1649A535498a`, votingDelay 1, votingPeriod 50400, quorumNumerator 4). Commit: `feat(gov): scaffold Governor config schema + Uniswap fixture`.
