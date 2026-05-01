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
    "required": "200000000000000000000000",
    "projectedFor": "150000000000000000000000",
    "projectedPct": 75.0,
    "hitProbability": 0.75
  },
  "historicalPassRate": { "last10": 7, "total": 10, "ratio": 0.7 },
  "history": [...],
  "risks": ["quorumGap", "complexityRisk"],
  "recommendation": "borderline"
}
```

- Reads latest 10 proposals via `getProposals(0, 10)` + final states.
- `required` = `GovSettings.getDefaultSettings().quorum`.
- `projectedFor` = `mean(votesFor across history) + draft.voteAmount`.
- `hitProbability` = `clamp(projectedFor / required, 0, 1)`.
- `recommendation` = `likelyPass` (>= 0.8) / `borderline` (>= 0.5) / `likelyFail`.

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
