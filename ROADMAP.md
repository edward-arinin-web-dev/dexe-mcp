# dexe-mcp Roadmap

Living backlog. Rewritten 2026-07-23; editions section added 2026-10-12 (the previous version was frozen several
release cycles ago; per-release history now lives entirely in `CHANGELOG.md` and
`docs/MIGRATION.md` — this file only tracks what is NOT done yet).

## Vision

`dexe-mcp` = one professional MCP server covering the **full DeXe DAO lifecycle**
for AI agents — create DAOs, build/create every proposal type, vote/delegate/
execute (member + validator rounds), OTC token sales, staking, IPFS metadata,
subgraph + backend reads — plus a generic `dexe_gov_*` surface for external
OpenZeppelin/Compound Governors. Works zero-config for reads; signs via
WalletConnect, hot key, or the multi-agent keyring.

**Current state: see `package.json` for the version and `docs/TOOLS.md` for the
tool surface.** All 33 catalog proposal types are wired; the composite flows
(`dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`)
are the primary interface; the full-surface frontend-parity audit was green on
2026-07-23 (`internal/PARITY-AUDIT-2026-07-23.md`). Per-release detail lives in
`CHANGELOG.md` and `docs/MIGRATION.md` — this file only tracks what is NOT done
yet.

## Now — read and write editions

The server is being split into two packages that run side by side:

- **Read edition** — `@dexe-network/dexe-mcp`, in a new repository under
  `github.com/dexe-network`. Reads only: on-chain DAO state, proposals, votes,
  treasury, token sales, staking, subgraph and IPFS metadata. No calldata
  builders, no signer, no uploads. Runs over stdio or as a stateless remote
  (Streamable HTTP) server, and is the edition submitted to the Anthropic and
  OpenAI app directories, whose rules exclude software that executes crypto
  transactions.
- **Write edition** — `dexe-mcp` (this repository). Composites, builders,
  broadcasting, WalletConnect, Safe, the agent keyring and IPFS uploads. It
  depends on the read package as a library and pairs with the read server in
  the same client.

Progress (each step is its own PR; the single server keeps working throughout):

- [x] Edition manifest + ratcheting import-boundary test (`src/editions.ts`,
      `tests/boundary/`) — #92
- [x] Split mixed libraries and tool files — #94
- [x] Read/write config and env spec (`loadReadConfig` never parses keys) — #95
- [x] Knowledge, `dexe_guide`, `dexe_context`, `dexe_get_config` by edition;
      `dexe_write_context` — #96
- [x] Decode tools work without compiling the protocol (bundled ABI snapshot) — #91
- [x] Experimental remote mode `dexe-mcp serve-http` (not for public exposure
      yet — see `docs/REMOTE.md`) — #93
- [ ] Read tools safe to serve remotely (IPFS byte cap, array limits, response
      cap, output scrubbing)
- [ ] Per-edition gate, annotations and handshake; report snapshots off in the
      read edition
- [ ] Physical move to `src/read/**` and `src/write/**`
- [ ] Read entry point (`dexe-mcp-read`, stdio + HTTP) with its own server factory
- [ ] Extract the read edition into its new repository; this repository depends
      on the published package
- [ ] Write edition: WalletConnect as the default signer (the wallet confirms
      every transaction); hot keys opt-in with an encrypted keystore
- [ ] Hosted read server, MCP Registry entries for both editions, directory
      submissions

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
      workflows. Reuses the existing ERC-712 signing path.
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
- [x] Refresh the testnet swarm fixture DAO — **done 2026-09-24**: both old
      fixtures (Polaris `0x081f4b5C…`, Sentinel `0xF5F07490…`) had dropped out of
      the chain-97 PoolRegistry. Redeployed per the runbook: member DAO
      **Kestrel Research Guild** `0xb0Ca396b0441630A6506a1A2bA14dAbF0BD32145`
      (KRT `0x589065B4…4cbb`, 50k per agent, funder 250k) and validator DAO
      **Cobalt Maritime Cooperative** `0x417bb8eE8BF4D224b3C61b1c0D37FcAA07c4e189`
      (CMC `0x720661f8…1D09`, 5 % main / 51 % validator quorum, validators =
      AGENT_PK_6/7 with 1k CVT). The four `SWARM_*_TESTNET` lists point at them;
      `tests/swarm/allowlist-guard.ts` (0.34.0) fails the run if either drops
      out again.
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
- [x] **Open Dependabot alerts on GitHub** — 0 open as of 2026-10-12; the
      October update (#90) consolidated the pending Dependabot PRs.
- [ ] **F15 responsible disclosure** — `docs/UPSTREAM-ISSUES.md` documents an
      unfixed P1 funds-loss (vestingWithdraw) with repro in a PUBLIC repo. Send
      the private report to the DeXe security team before any announcement drives
      traffic; move the exploit detail behind the same "on request" treatment C-2 has.
- [ ] **Graph API key rotation** — a live gateway key (`b860428…`) is baked into
      `src/config.ts` and ships to npm as a shared default; rotate/proxy it.
      `serve-http` already refuses to start on the shared defaults (#93); the
      stdio default still carries the key.
- [x] **main branch protection** — six required status checks (build on
      Node 20/22, lockfile, CodeQL, dependency review), admins included. No
      required reviews (single maintainer).
- [x] **npm publish auth** — OIDC trusted publishing since 2026-10-01 (first
      used for 0.34.1); the `NPM_TOKEN` secret was removed.
- [ ] **Disclosure wording in `docs/UPSTREAM-ISSUES.md`** — the doc still tells
      the reader to treat the content as embargoed while shipping publicly on
      GitHub and npm. Either de-embargo it (and say so in `SECURITY.md`) or split
      the user-facing mitigations out and move the write-up off the shipped path.
- [ ] **`dexe_proposal_create` confirm gate (D15-2)** — the preview now reports
      the payer and the block it was taken at, but there is still no
      preview→confirm handshake on the create path itself. Scoped out of 0.34.0
      deliberately; decide whether it should exist before adding it.
- [ ] **Read-result token budget (D6-8)** — truncation is *reported* but rows are
      not sliced to a `maxTokens`. Needs a maintainer call on what the cap is.
- [ ] **`checkProposalHasActions` wiring (D11-4 part A)** — the guard exists and
      is grandfathered past the no-dead-guards test; wire it or drop it.

## Testing strategy (unchanged)

Validate contract flows on BSC testnet (97) first — **except** staking and
addSettings-based proposals, which must be validated on mainnet: chain 97 runs an
older protocol deployment (no `stakingProposalAddress()` on fresh UserKeepers,
SphereX still blocks `addSettings`). Subgraph + backend flows are mainnet-only.
