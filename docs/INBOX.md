# Inbox + Forecast + OTC Discovery (v0.5.0)

Three subgraph-backed read tools shipped in v0.5.0. They share the GraphQL
plumbing in `src/lib/subgraph.ts`, and aim at the read-side of the DAO-ops
loop: "what needs my attention?", "will my proposal pass?", "what sales are
live?".

## Tools at a glance

| Tool | Role |
|------|------|
| `dexe_user_inbox` | Multi-DAO attention aggregator — unvoted proposals, claimable rewards, locked deposits |
| `dexe_proposal_forecast` | Predictive pass-rate from latest 10 proposals — projects quorum hit probability |
| `dexe_otc_list_sales_for_dao` | Tier discovery for a DAO's TokenSaleProposal — status (`upcoming` / `active` / `ended`) |

All three are read-only — never broadcast a tx.

## `dexe_user_inbox`

```jsonc
{
  "user": "0x…",
  "daos": ["0x…", "0x…"], // optional on mainnet; required on testnet
  "proposalScanLimit": 20  // default 20
}
```

Returns:

```jsonc
{
  "user": "0x…",
  "pendingItems": [
    { "dao": "0x…", "type": "unvotedProposal", "proposalId": "12", "deadline": "1750000000" },
    { "dao": "0x…", "type": "claimableRewards", "proposalIds": ["8","9"], "totalAmount": "12000000000000000000" },
    { "dao": "0x…", "type": "lockedDeposit", "amount": "5000000000000000000000", "govToken": "0x…" }
  ],
  "summary": { "totalDaos": 2, "daosWithItems": 2, "criticalCount": 1 }
}
```

- **`unvotedProposal`** — proposal in `Voting` / `ValidatorVoting` state where
  `getTotalVotes(user, PersonalVote).totalVoted == 0`.
- **`claimableRewards`** — non-zero pending rewards across the scanned proposal
  window (best-effort; older deployments without `getPendingRewards` quietly
  return zero).
- **`lockedDeposit`** — `UserKeeper.tokenBalance(user, PersonalVote).balance > 0`.
  These are tokens parked in the DAO that can be `withdraw(...)`-ed.

When `daos` is omitted on mainnet, the tool queries the pools subgraph for DAOs
the user has a `voterInPool` row in (limit 50). On testnet (chain 97) `daos[]`
is required because there is no subgraph.

## `dexe_proposal_forecast`

```jsonc
{
  "govPool": "0x…",
  "draft": { "actionsOnFor": [...], "voteAmount": "10000000000000000000000" },
  "forceRpcOnly": false
}
```

Returns:

```jsonc
{
  "govPool": "0x…",
  "chain": 56,
  "quorum": {
    "settingRaw": "50000000000000000000000000",
    "quorumPct": 5,
    "totalPower": "4000000000000000000000000",
    "requiredWeight": "200000000000000000000000",
    "required": "200000000000000000000000",
    "projectedFor": "150000000000000000000000",
    "projectedPct": 75.0,
    "hitProbability": 0.75,
    "basis": "GovUserKeeper.getTotalPower() x GovSettings.getDefaultSettings().quorum / 1e27 — …"
  },
  "quorumNote": null,
  "historicalPassRate": { "last10": 7, "passed": 7, "decided": 9, "pending": 1, "total": 10, "ratio": 0.777… },
  "historicalQuorumAttainmentPct": 132.4,
  "history": [{ "proposalId": "9", "state": "ExecutedFor", "outcome": "passedFor",
                "requiredQuorum": "200000000000000000000000", "quorumAttainmentPct": 141.2, … }],
  "risks": ["quorumGap", "complexityRisk"],
  "recommendation": "borderline"
}
```

- Reads the latest 10 proposals via `getProposals(latestProposalId - 10, 10)` + final states.
- **Quorum has two units and this payload carries both.** `settingRaw` /
  `quorumPct` are the 1e25-scaled percentage SETTING
  (`GovSettings.getDefaultSettings().quorum`; 5e26 = 50%).
  `requiredWeight` — and the back-compat alias `required` — is the **absolute
  vote weight** `GovUserKeeper.getTotalPower() × quorum ÷ 1e27`, identical to
  what `GovPool.getProposalRequiredQuorum(id)` returns. Compare `projectedFor`
  against the WEIGHT only; before 0.34.0 `required` held the raw setting and
  every verdict on a real DAO was off by `totalPower / 1e27`.
- `projectedFor` = `mean(votesFor across history) + draft.voteAmount`.
- `hitProbability` = `clamp(projectedFor / requiredWeight, 0, 1)` — an
  **attainment ratio**, not a statistical probability: 185% of target is
  reported as `1.0`.
- `recommendation` = `likelyPass` (>= 0.8) / `borderline` (>= 0.5) /
  `likelyFail` / `"unknown"`.
- **Nullable when total power is unknown.** If `GovUserKeeper.getTotalPower()`
  reverts, returns 0, or `getHelperContracts()` yields no userKeeper, then
  `required`, `requiredWeight`, `projectedPct` and `hitProbability` are `null`,
  `recommendation` is `"unknown"`, `risks` includes `"quorumUnknown"`, and
  `quorumNote` explains why. `getTotalPower` is the gov token's total supply
  plus NFT power — depositing does **not** change it.
- The quorum used is the DAO's **default** settings. Internal / validator /
  custom-executor proposals can carry a different quorum. On-chain, quorum is
  reached by `votesFor` **or** `votesAgainst`; this projection tracks the For
  side only.
- `historicalPassRate.ratio` = `passed / decided`. A proposal that is still
  `Voting` (or `Locked` / `ValidatorVoting` / `WaitingForVotingTransfer`) counts
  as `pending` and sits in neither side of that fraction — before 0.34.0 it was
  counted as a failure, which could fire a false `voterApathy` on a DAO where
  nothing had been decided yet. `last10` is retained for back-compat and is a
  count of passes, not a window size. An Against win is not a pass.
- Each `history` row carries its OWN `requiredQuorum` and `quorumAttainmentPct`
  (`null` when that row's target is 0), so the numbers stay comparable across a
  mid-history quorum change; `historicalQuorumAttainmentPct` is the mean over
  rows that have a target.
- `subgraphHistory` rows gain `quorumSettingRaw` / `quorumSettingPct`: the
  indexer's `Proposal.quorum` is the SETTING, and it sits next to token-wei
  `currentVotesFor`. The original `quorum` key is unchanged.

Mainnet only by default. Pass `forceRpcOnly: true` to run on testnet from
on-chain reads alone — useful when you have enough historical proposals on
chain 97 to get a meaningful sample.

## `dexe_otc_list_sales_for_dao`

```jsonc
{
  "govPool": "0x…",
  "tokenSaleProposal": "0x…"
}
```

Returns:

```jsonc
{
  "govPool": "0x…",
  "tokenSaleProposal": "0x…",
  "tiers": [
    {
      "tierId": "1",
      "name": "Tier-A",
      "saleStartTime": "1750000000",
      "saleEndTime": "1760000000",
      "saleToken": "0x…",
      "purchaseTokens": ["0x…"],
      "totalProvided": "1000000000000000000000",
      "totalSold": null,
      "status": "active"
    }
  ],
  "counts": { "upcoming": 0, "active": 1, "ended": 0 }
}
```

Reads `latestTierId()` then `getTierViews(0, latestTierId)`. `status` is
computed against `block.timestamp`:

- `now < saleStartTime` → `upcoming`
- `saleStartTime <= now <= saleEndTime` → `active`
- `now > saleEndTime` → `ended`

Works on chain 56 + chain 97 — no subgraph required.

`totalSold` is `null` in v1 — the value is not exposed via `getTierViews`.
A follow-up tool `dexe_otc_list_active_sales` (subgraph-backed cross-DAO
listing with sold-aggregation) is planned for v0.5.1.

## Discovery follow-ups (v0.5.1+)

- `dexe_otc_list_active_sales` — global "what sales are live right now?" query
  spanning every DAO with a TokenSaleProposal helper. Requires a subgraph
  entity that doesn't exist yet.
- Per-DAO helper-address discovery — automatic resolution of
  `tokenSaleProposal` from a DAO deployment receipt or registry, so callers
  don't need to thread it through.
