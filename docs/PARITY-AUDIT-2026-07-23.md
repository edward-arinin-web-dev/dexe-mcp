# Frontend-parity audit — 2026-07-23

Full-surface comparison of dexe-mcp builders against the DeXe frontend
(`investing-dashboard`, the source of truth) and the DeXe-Protocol contracts.
Four independent audit passes: (1) DAO-create + encoding layer, (2) external
proposal builders, (3) internal + off-chain builders, (4) vote/deposit/delegate +
OTC buyer paths. Every claim below was verified with file:line evidence on both
sides; the drift fixes shipped in the `fix/nightly-bug-batch` PR.

## Headline result

**Zero calldata / ABI / struct-order drifts across the entire tool surface.**
Every byte that reaches a contract — deploy structs, proposal actions, vote,
delegate, deposit, withdraw, OTC buy/claim/vesting, multicall wrapping policy,
enum values, votePower initData, polynomial coefficients — matches the frontend
and the contracts exactly. Previously fixed bugs (#19 changes wrapper, #24
categories, #25 tier field order, #27 off-chain quorum decimals, #33 TierView,
F4 multicall wrap, F8 validator enum) were all re-verified as still fixed.

## Drifts found (all metadata-level; fixed same night)

| # | Area | Drift | Severity | Status |
|---|------|-------|----------|--------|
| 1 | modify_dao_profile (standalone builder) | emitted `isMeta: true`; frontend profile-diff decodes a meta payload and blanks the "Proposed changes" UI (PR #17 rule). Composite path was already `false`. | P2 | FIXED |
| 2 | all standalone `dexe_proposal_build_*` tools | `proposalDescription` was `JSON.stringify(plainString)`; frontend stores a stringified **Slate array**. Composite path already used `markdownToSlate`. 24 sites, 4 files. | P3 | FIXED |
| 3 | internal builders (both paths) | category `offchainInternalProposal` — no such member in the frontend enum; correct value is `emptyTx`. | P3 | FIXED |
| 4 | internal builders (both paths) | carried the external-shape `changes:{proposed,current}` wrapper; the frontend internal IPFS shape is `{proposalName, proposalDescription, category}` only. | P3 | FIXED |

## Cosmetic deltas (documented, deliberately NOT changed)

- **Avatar URL host**: MCP writes `dweb.link`, frontend `4everland.io`. The
  frontend rebuilds `avatarUrl` from `avatarCID`+`avatarFileName` on read, so the
  stored host is ignored; `dweb.link` was chosen deliberately (4everland is slow
  to discover fresh CIDs).
- **Empty-description handling**: MCP stores `description: ""` when empty; the
  frontend pins an empty Slate doc and stores its `ipfs://` pointer. Non-empty
  legs match. Frontend tolerates `""`.
- **SIMPLE-mode default voteModel**: MCP defaults LINEAR, the frontend form
  pre-selects POLYNOMIAL. Both encode correctly; LINEAR is the safer programmatic
  default.
- Several builders attach a `changes` wrapper (or extra fields like
  `currentChanges.treasuryBalance`) where the frontend omits it — harmless extra
  metadata the UI ignores.
- token_transfer native path: metadata `tokenAddress` = zero address vs the
  frontend's native-sentinel. Calldata identical.

## Places MCP is deliberately MORE correct than the frontend

- **apply_to_dao decimals**: MCP reads the real token decimals; the frontend
  hardcodes `parseEther` (18) — wrong for non-18 tokens.
- **token_sale whitelist trigger**: the contract sets `isWhitelisted=true` only
  for participationType `Whitelist`; MCP appends `addToWhitelist` for exactly
  that type. The frontend keys the append off `MerkleWhitelist` — a dead path
  that would revert `"TSP: tier is not whitelisted"` on-chain. Recorded as a
  frontend anomaly (see `UPSTREAM-ISSUES.md`).
- **reward_multiplier units**: contract PRECISION is 1e25; MCP scales to 1e25.
  The frontend scales to 1e18 — a latent frontend bug that silently mints a
  multiplier the contract clamps to zero extra reward.

## Known intentional divergences

- **withdraw_treasury**: the frontend's `useGovPoolCreateWithdrawProposal` emits
  `GovPool.withdraw` (withdraws *deposited* funds). MCP deliberately emits
  external `ERC20.transfer` from the treasury instead (bug #30: the deposit-
  withdraw shape is the wrong operation for "pay out treasury holdings").
- **Off-chain proposal `attributes.type`**: MCP creates instances of the
  auto-provisioned `default_single_option_type` / `default_multiple_option_type`
  (the bug #27 remedy); the frontend registers a fresh type per proposal. Both
  are valid backend paths.
- **Vote flows are build-only**: the frontend auto-votes after creating
  off-chain proposals; MCP returns request objects and exposes the vote as a
  separate tool by design.

## Coverage gap noted (backlog)

- No dedicated builder for `GovPool.setCreditInfo` (the frontend's
  "validators allocation" external proposal that funds the credit which
  `monthly_withdraw` draws against). Achievable today via `custom_abi`;
  a dedicated builder would complete parity. A `monthly_withdraw` against an
  unfunded credit line reverts.

## Method

Each area compared three sides: MCP builder output (ABI fragment + arg
assembly + IPFS metadata), the frontend hook that produces the same action, and
the deployed contract interface in `DeXe-Protocol`. Claims of drift required
exact quoted lines from both sides; anything unverifiable was dropped.
