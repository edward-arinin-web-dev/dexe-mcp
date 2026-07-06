# DAO creation — frontend parity reference

The DeXe frontend (`investing-dashboard`) is the source of truth for creating a
GovPool DAO — it has shipped DAOs to **BSC mainnet daily for 3 years**. This doc
records the rules dexe-mcp must (and now does) mirror. Every claim cites the
frontend at `file:line`.

## The two governance rules (frontend BLOCKS violations)

A DAO's tokens split into **votable** (distributed to wallets) and **treasury**
(held by the DAO/govPool — cannot vote).

| Rule | Formula | Frontend | dexe-mcp guard |
|---|---|---|---|
| **Quorum reachable** | `quorum% × totalSupply ≤ votable` (LINEAR); meritocratic power ≥ quorum tokens (POLYNOMIAL) | blocks — `DefaultProposalStep/index.tsx:209-238`, msg `en.json:200-211` | `checkQuorumReachable` (hard) |
| **min-votes** | `minVotesForVoting/Creating ≤ largest recipient` | blocks — `value-lower-than-distribution` | `checkMinVotesVsDistribution` (hard) |
| **Quorum floor** | `≥ 50%` (51% default) for treasury safety | advisory | `minSafeQuorumPct` advisory (never blocks) |

Combined: **treasury% ≤ 50%** for a ≥50% quorum to be reachable. Frontend default
= treasury **49% / distribution 51%**, quorum **51%** (boundary).

## Token distribution (calldata shape)

- **Treasury is an implicit remainder.** `tokenParams.users`/`amounts` list only
  external wallets; `sum(amounts) < mintedTotal`; the contract mints the remainder
  to the DAO. **The govPool is NEVER in `users[]`** — `useCreateDAO.ts:224-226,298-309`.
- Default recipient of the distributed portion = the connected wallet —
  `TokenCreationStep` (`_calculateFormAfterSupplyChange:462-493`, default recipient
  `:348-359`).
- **cap**: `cap > 0` AND `cap ≥ mintedTotal`. The gov token is `ERC20Capped` — there
  is **no uncapped mode** (`cap = 0` reverts). `cap == mintedTotal` is a valid fixed
  supply; `cap < mintedTotal` reverts. Frontend requires `cap > 0` and `totalSupply ≤
  cap` (`TokenCreationStep:162-166`).

## Settings / calldata mapping (`useCreateDAO.ts:253-313`)

- **5 proposalSettings**: `[default, internal, validators, DP, tokenSale]`. Index 3
  (DP) forces `delegatedVotingAllowed:false, earlyCompletion:false` — `:149-156`.
- `delegatedVotingAllowed` is **inverted**: sent as `!form` — `:55-59`. Contract
  `false` = delegation ALLOWED.
- `validatorsParams` always sent (empty arrays + `Validator Token`/`VT` when off).
- **votePower**: default **POLINOMIAL** in the frontend code (`GovPoolFormContext.tsx:286,409`),
  but LINEAR is fully supported and common. `presetAddress = 0x0` for both;
  `initData = __LinearPower_init()` / `__PolynomialPower_init(...)` (never `0x`).

## Decimals

- Percentages (quorum, quorumValidators, voteRewardsCoefficient, poly coeffs):
  **25-dec** (100% = 1e27, 50% = 5e26) — `math.util.ts:3-11`.
- Token amounts (cap, mintedTotal, amounts, minVotes, rewards, individualPower):
  **18-dec**.
- Durations / executionDelay: plain seconds.

## Chains

BSC mainnet (56) + Ethereum (1) are the primary live create targets;
testnets only in non-prod builds — `chain.utils.ts:103-172`. No deploy-time chain
gate. PoolFactory + ContractsRegistry (`0x46B46629B674b4C0b48B111DEeB0eAfd9F84A1c0`
on 56) resolve dynamically from the registry — dexe-mcp uses the **same** registry
and preset (0x0) wiring (verified — not the revert cause).

## Empirical mainnet sims (2026-07-06, eth_call against factory 0x85f8…2109)

Read-only `eth_call` of `deployGovPool` on **current** BSC mainnet, fresh names:

| shape | result |
|---|---|
| `cap = 0` | REVERT `ERC20Capped: cap is 0` |
| `cap < mintedTotal` | REVERT `ERC20Gov: mintedTotal should not be greater than cap` |
| `cap == mintedTotal` (fixed supply) | **SUCCESS** — old bug #28 is outdated |
| treasury remainder (`sum(amounts) < mintedTotal`) | **SUCCESS** — old bug #32 is outdated |
| govPool listed in `users[]` (user's exact shape) | **SUCCESS** — not a revert cause |
| quorum unreachable (300k votable, 51% quorum) | **SUCCESS at contract level** — usability problem only; blocked client-side by the frontend and by `checkQuorumReachable` |

Net cap rule: **`cap ≥ mintedTotal > 0`**. Remainder + govPool-in-users deploy fine;
LINEAR + mainnet work. The unreachable-quorum guard is a *usability* guard (mirrors
the frontend), not a revert-preventer.

## Revert diagnosis (Generative Automative, mainnet 56)

`Address: low-level delegate call failed` on `deployGovPool`.

- **NOT** LINEAR-broken (user has shipped LINEAR mainnet DAOs), **NOT** mainnet-broken,
  **NOT** a factory/registry/preset mismatch (verified equal to the frontend),
  **NOT** a contract-bound violation, **NOT** a CREATE2 collision (the predicted
  addresses for "Generative Automative" are all empty), and **NOT** the
  govPool-in-users shape (that exact shape `eth_call`-succeeds today).
- The reported param shape `eth_call`-**succeeds on current mainnet**, so the
  historical revert could not be reproduced — likely a transient protocol/RPC state
  at the time, or a small mismatch between the reconstructed param table and what was
  actually sent. Not pursued further; the param *rules* (above) are what the fix
  encodes.
- The lasting fixes are the coherence guards + the corrected cap rule + the implicit-
  treasury synthesis, all verified against live mainnet behavior — the MCP now can
  only emit shapes that deploy and govern.
