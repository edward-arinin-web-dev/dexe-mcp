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

**Current state: v0.28.0 — 165 tools / 19 groups.** All 33 catalog proposal
types wired; composite flows (`dexe_dao_create`, `dexe_proposal_create`,
`dexe_proposal_vote_and_execute`) are the primary interface; full-surface
frontend-parity audit green as of 2026-07-23 (`docs/PARITY-AUDIT-2026-07-23.md`).

## Reference projects

- **Contracts:** `D:/dev/DeXe-Protocol` (Hardhat)
- **Frontend (source of truth for every call shape):** `C:/dev/investing-dashboard`
- **Protocol-side blockers we cannot fix in MCP:** `docs/UPSTREAM-ISSUES.md`

---

## Backlog

### Features
- [ ] `documents` passthrough in `dexe_dao_create` → attach whitepaper/docs
      one-shot at deploy (exists in `dexe_ipfs_upload_dao_metadata` only).
- [ ] SIMPLE-mode `recipients[]` in `dexe_dao_create` — multi-recipient token
      distribution without dropping to ADVANCED params.
- [ ] `setCreditInfo` / validators-allocation builder (funds the credit line
      that `monthly_withdraw` draws against; today only reachable via
      `custom_abi`). Found in the 2026-07-23 parity audit.
- [ ] Per-chain subgraph URL map (pools/validators/interactions are env-bound to
      ONE chain; endpoints exist for BSC/ETH/Sepolia/Amoy — see
      `reference_subgraph_urls_per_chain` memory).

### Testing / verification
- [ ] Golden-file calldata fixtures vs frontend-captured payloads per proposal
      type (partially covered by builder round-trip tests + the parity audit;
      no committed hex fixtures yet).
- [ ] Swarm Stage B on mainnet (S22–S25 subgraph + S12/S14 backend scenarios) —
      contract scenarios are green on testnet; mainnet run needs
      `SWARM_DAOS_MAINNET` / `SWARM_RPC_URL_MAINNET` / `SWARM_TOKENS_MAINNET`.
- [ ] USE_CASES case 29 — full multi-agent swarm demo (3 DAOs from 3 keyring
      wallets) — blocked on loading 0.28.0 + `DEXE_AGENT_PK_*` into the session.

### Upstream (DeXe protocol team — tracked in docs/UPSTREAM-ISSUES.md)
- [ ] F15 `vestingWithdraw` SphereX-blocked in every shape (P1, funds-loss).
- [ ] F12 validator `cancelVote*` blocked, no workaround.
- [ ] F14 `executeInternalProposal(monthly_withdraw)` fails on fresh pools —
      root-cause trace owed.
- [ ] Bug #36 chain asymmetry: `addSettings` fixed on mainnet fresh pools but
      still blocked on testnet (older protocol deployment on 97) — ask the team
      to mirror the fix to the testnet factory.
- [ ] C-2 DEFAULT-routing validation bypass — real fix is a contract upgrade;
      MCP ships a harm-reduction denylist only.

### Ideas / product bets (unscoped)
- [ ] DAO extension marketplace — "plugins/skills for DAOs" (needs product scoping).
- [ ] Deeper Governor (OZ/Bravo) coverage parity with the DeXe surface.

## Testing strategy (unchanged)

Validate contract flows on BSC testnet (97) first — **except** staking and
addSettings-based proposals, which must be validated on mainnet: chain 97 runs an
older protocol deployment (no `stakingProposalAddress()` on fresh UserKeepers,
SphereX still blocks `addSettings`). Subgraph + backend flows are mainnet-only.
