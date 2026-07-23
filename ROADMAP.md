# dexe-mcp Roadmap

Living backlog. Rewritten 2026-07-23 (the previous version was frozen at the
v0.3.0 era; per-release history now lives entirely in `CHANGELOG.md` and
`docs/MIGRATION.md` — this file only tracks what is NOT done yet).

## Vision

`dexe-mcp` = one professional MCP server covering the **full DeXe DAO lifecycle**
for AI agents — create DAOs, build/create every proposal type, vote/delegate/
execute (member + validator rounds), OTC token sales, staking, IPFS metadata,
subgraph + backend reads — plus a generic `dexe_gov_*` surface for external
OpenZeppelin/Compound Governors. Works zero-config for reads; signs via
WalletConnect, hot key, or the multi-agent keyring.

**Current state: v0.29.0 — 165 tools / 19 groups.** All 33 catalog proposal
types wired; composite flows (`dexe_dao_create`, `dexe_proposal_create`,
`dexe_proposal_vote_and_execute`) are the primary interface; full-surface
frontend-parity audit green as of 2026-07-23 (`docs/PARITY-AUDIT-2026-07-23.md`).
0.29.0 shipped SIMPLE-mode `recipients[]`, the real `validators_allocation`
(`setCreditInfo`) builder, keyring env-naming aliases, golden-hex calldata
fixtures for all 31 builder keys, and root-caused F14 (unfunded credit line).

## Reference projects

- **Contracts:** `D:/dev/DeXe-Protocol` (Hardhat)
- **Frontend (source of truth for every call shape):** `C:/dev/investing-dashboard`
- **Protocol-side blockers we cannot fix in MCP:** `docs/UPSTREAM-ISSUES.md`

---

## Backlog

### Features
- [ ] **Vote-by-Sig builders for the generic Governor surface**
      (`castVoteBySig` / `castVoteWithReasonAndBySig`) — the single biggest
      external-Governor gap; Bravo and OZ both support it natively and it
      unblocks Uniswap / Compound / Optimism / Gitcoin / Arbitrum delegate
      workflows. Reuses the existing ERC-712 signing path. (0.30.0 candidate.)
- [ ] Per-chain subgraph URL map (pools/validators/interactions are env-bound to
      ONE chain; endpoints exist for BSC/ETH/Sepolia/Amoy — see
      `reference_subgraph_urls_per_chain` memory).

### Testing / verification
- [ ] Frontend-captured golden calldata fixtures (byte-for-byte from
      `C:/dev/investing-dashboard` via the compat harness) to complement the
      committed builder-side golden hex shipped in 0.29.0 (#56).
- [ ] Weak-model reliability proof — run the composites (`dexe_dao_create`,
      `dexe_proposal_create`, `dexe_proposal_vote_and_execute`) under a
      Haiku-class model on BSC testnet and publish the pass rate + the
      landed-steps-ledger resume story (subscription-billed / in-session only —
      never API credits).
- [ ] Refresh the testnet swarm fixture DAO — the allowlisted Polaris govPool
      `0x081f4b5C…` no longer reads as a registered GovPool on chain 97 (a
      2026-07-23 broadcast sweep passed 41/59; the 18 failures were all this
      dead-fixture + hardcoded past timestamps, not tool defects). Deploy a
      fresh 97 DAO, refresh `SWARM_DAOS_TESTNET`, and fix the S44/S58 fixtures.
- [ ] Swarm Stage B on mainnet (subgraph + backend scenarios) — needs the
      scenarios re-authored under current IDs (the S22–S25/S12/S14 numbers in
      the docs no longer map to those intents) plus
      `SWARM_DAOS_MAINNET` / `SWARM_RPC_URL_MAINNET` / `SWARM_TOKENS_MAINNET`.

### Upstream (DeXe protocol team — tracked in docs/UPSTREAM-ISSUES.md)
- [ ] F15 `vestingWithdraw` SphereX-blocked in every shape (P1, funds-loss).
- [ ] F12 validator `cancelVote*` blocked, no workaround.
- [x] F14 `executeInternalProposal(monthly_withdraw)` — **root-caused in 0.29.0**:
      not SphereX, an unfunded credit line whose revert is swallowed by a
      low-level self-call. `monthly_withdraw` now preflights it. Remaining ask:
      the protocol should bubble up the inner revert (P3).
- [ ] Bug #36 chain asymmetry: `addSettings` fixed on mainnet fresh pools but
      still blocked on testnet (older protocol deployment on 97) — ask the team
      to mirror the fix to the testnet factory.
- [ ] C-2 DEFAULT-routing validation bypass — real fix is a contract upgrade;
      MCP ships a harm-reduction denylist only.

### Ideas / product bets (unscoped)
- [ ] DAO extension marketplace — "governance skill packs" distributed on the
      existing plugin/skills channel before building new infra (needs scoping).
- [ ] Deeper Governor (OZ/Bravo) coverage parity with the DeXe surface —
      start with Vote-by-Sig (above), then Safe-executor DAOs (Aave/dYdX,
      different queue/execute calldata) and batch queue/execute.
- [ ] Autonomous delegate / watchdog agent template — convert the advisory
      treasury guard into enforceable circuit-breakers (spend caps, DAO/recipient
      allowlists, simulate-before-vote). Substrate exists (v0.28 keyring,
      `dexe_user_inbox`, simulator).
- [ ] Discovery: list dexe-mcp in the `awesome-crypto-mcp-servers` /
      `awesome-blockchain-mcps` registries (pure visibility, no code).

### Owed / user-decision-gated (not autonomous — need a maintainer action)

These live only in session memory today; tracked here so they survive rotation.

- [ ] **Vuln-disclosure exposure close-out** — `npm view dexe-mcp@0.9.0
      deprecated` is empty; the C-2/Q-1 advisory recipes remain reachable in git
      history (`git show 6afdc36:docs/ESCALATION-DEXE.md`) and in merged public
      PR #36. Needs `npm deprecate` (OTP) + a history-rewrite/force-push decision.
- [ ] **18 open Dependabot alerts on GitHub** — the lockfile fix landed
      (`npm audit` = 0) but the alerts were never dismissed (Dependabot security
      updates are disabled). Dismiss them or enable auto-updates before the
      announcement raises the repo's profile.
- [ ] **F15 responsible disclosure** — `docs/UPSTREAM-ISSUES.md` documents an
      unfixed P1 funds-loss (vestingWithdraw) with repro in a PUBLIC repo. Send
      the private report to the DeXe security team before any announcement drives
      traffic; move the exploit detail behind the same "on request" treatment C-2 has.
- [ ] **Graph API key rotation** — a live gateway key (`b860428…`) is baked into
      `src/config.ts` and ships to npm as a shared default; rotate/proxy it.
- [ ] **main branch protection** is non-enforcing (0 required reviews, no
      required status checks, admins bypass) — require CI/CodeQL before merge.

## Testing strategy (unchanged)

Validate contract flows on BSC testnet (97) first — **except** staking and
addSettings-based proposals, which must be validated on mainnet: chain 97 runs an
older protocol deployment (no `stakingProposalAddress()` on fresh UserKeepers,
SphereX still blocks `addSettings`). Subgraph + backend flows are mainnet-only.
