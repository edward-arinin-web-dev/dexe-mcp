---
name: dexe-create-dao
description: |
  Deploy a new DeXe DAO with the one-call `dexe_dao_create` composite. Use SIMPLE
  mode (symbol + totalSupply) and let the tool synthesize a coherent, governance-
  safe config — it previews the resolved config + a safety proof and only
  broadcasts on confirm. Covers the two quorum rules (reachable ≤ votable, floor
  ≥50%), the implicit-treasury pattern, and the deploy gotchas. Use when the user
  says "create/deploy a DAO".
---

# dexe-create-dao

Deploy a DeXe governance DAO in **one tool call**. `dexe_dao_create` handles
avatar → DAO IPFS metadata → `PoolFactory.deployGovPool` (predicted-address
wiring, 1→5 settings auto-expand, executorDescription upload) → broadcast.

**Do NOT hand-fabricate token splits or quorum numbers.** That is exactly how you
ship a broken DAO. Use SIMPLE mode and let the tool synthesize + verify a coherent
config, or read the two rules below and satisfy them.

## The two rules that make a DAO usable (the tool enforces both)

A DeXe DAO holds two kinds of tokens: **votable** (distributed to real wallets)
and **treasury** (held by the DAO/govPool — these **cannot vote**).

1. **Quorum must be REACHABLE:** `quorum% × totalSupply ≤ votable tokens`.
   Equivalently `quorum% ≤ (100 − treasury%)`. If quorum is higher than the
   votable share, **no proposal can ever pass** — the tool hard-blocks this
   (mirrors the frontend's blocking check).
2. **Quorum floor ≥ 50%** (51% recommended). Below 50%, a small group can pass
   proposals and even drain the treasury. Advisory, surfaced in the preview.

Together these mean **treasury% ≤ 50%** (so a ≥50% quorum can still be reached).
The default (treasury 49% / quorum 51%) sits right at the boundary.

## Golden rule: validate on testnet first

Deploy to **BSC testnet (chain 97)** first (`chainId: 97`) — free faucet BNB.
**Mainnet (chain 56) works** (the frontend ships there daily) and is supported,
but it spends real BNB, so `dexe_dao_create` requires `confirm: true` for any
mainnet broadcast. Never confirm a mainnet deploy without the user explicitly
asking.

## Recipe — SIMPLE mode (recommended)

0. **Orient:** `dexe_context` — shows signer, active chain, env readiness, and
   DAOs you already deployed.
1. **Env:** ensure the target chain is 97 and `DEXE_PINATA_JWT` is set (metadata).
2. **(Optional) avatar:** `dexe_dao_generate_avatar` / `dexe_ipfs_upload_avatar`
   → pass the `cid` as `avatarCID`. Since v0.20.0 both enforce real raster
   bytes (generate renders a true JPEG; upload rejects SVG/HTML by magic-byte
   check), so any CID they return is safe to use.
3. **Preview:** call `dexe_dao_create` with just the essentials:

```jsonc
dexe_dao_create({
  chainId: 97,
  daoName: "Aurora Collective",
  symbol: "AUR",
  totalSupply: "1000000",     // whole tokens
  // optional (these are the defaults):
  treasuryPercent: 49,        // implicit remainder held by the DAO (can't vote)
  quorumPercent: 51,          // must be ≥50 AND ≤ (100 − treasuryPercent)
  voteModel: "LINEAR",        // 1 token = 1 vote (default); or "POLYNOMIAL"
  durationSeconds: 86400,     // 1 day
  daoDescription: "A community treasury DAO.",
  avatarCID: "bafy…"          // optional
})
```

This returns `mode: "preview"` with the **resolved config** (who holds what) and a
**safety proof** (votable %, quorum %, reachable?, floor OK?). Show it to the user.

4. **Confirm:** re-call with the **same arguments plus `confirm: true`** to broadcast.
   The deployer holds the entire distributed portion; the treasury is an **implicit
   remainder** (the govPool address is never a token recipient).

## Recipe — ADVANCED mode (full control)

Pass a full `params` struct (same shape as `dexe_dao_build_deploy`) instead of the
SIMPLE fields. The coherence guards still run. Key rules for hand-built params:

- **Treasury is an implicit remainder.** `tokenParams.users`/`amounts` list only
  external wallets; `sum(amounts)` is **less than** `mintedTotal` (the contract
  mints the remainder to the DAO). **Never** put the predicted govPool in `users[]`.
- Pass **one** `proposalSettings` entry → auto-expands to 5.
- `votePowerParams.voteType: "LINEAR_VOTES"` — `initData` is auto-encoded; don't pass it.

## Deploy gotchas (the tool pre-flights these — heed the errors)

1. **Unreachable quorum** — `quorum% × supply > votable`. Lower quorum, distribute
   more to voters, or shrink the treasury. (hard block)
2. **min-votes above every holder** — `minVotesForVoting/Creating` must be ≤ the
   largest single recipient. (hard block)
3. **cap** — must be `> 0` AND `≥ mintedTotal`. There is **no uncapped mode**
   (`cap = 0` reverts `ERC20Capped: cap is 0`); `cap == mintedTotal` is a valid
   fixed supply; `cap < mintedTotal` reverts. SIMPLE mode sets `cap = totalSupply`. (hard block)
4. **LINEAR initData** — auto-encoded (`__LinearPower_init()` = `0x892aea1f`). Never
   pass `initData` for LINEAR/POLYNOMIAL; only CUSTOM_VOTES takes a manual one.
5. **Non-zero governance asset** — if not creating a token, set
   `userKeeperParams.tokenAddress` or `.nftAddress`.
6. **Over-distribution** — `sum(amounts)` must be ≤ `mintedTotal`. (An implicit
   treasury remainder is correct and expected — do NOT force them equal.)

## Decimal conventions (must match the frontend)

- `quorum`, `quorumValidators`, `voteRewardsCoefficient`: **25-dec** wei (50% = `5e26`, 100% = `1e27`).
- `minVotes*`, `cap`, `mintedTotal`, `amounts`, `individualPower`, rewards: **18-dec** wei.
- `duration*`, `executionDelay`: plain **seconds** as string.
- `delegatedVotingAllowed` is **inverted**: `true` DISABLES delegation, `false` ALLOWS it.

## Pre-submit self-check (before `confirm: true`)

- [ ] `quorumPercent ≤ 100 − treasuryPercent` (reachable) and `≥ 50` (floor)?
- [ ] treasury is an implicit remainder — govPool NOT in `users[]`?
- [ ] `sum(amounts) ≤ mintedTotal`, and `cap ≥ mintedTotal > 0` (never cap=0)?
- [ ] validating on testnet (97) first, or the user explicitly asked for mainnet?

## After deploy

The result includes `predictedGovPool` — the DAO's GovPool address once the tx
confirms. Use it for `dexe_proposal_create` / `dexe_proposal_vote_and_execute`.

Related: [[dexe-create-proposal]], [[dexe-vote-execute]].
