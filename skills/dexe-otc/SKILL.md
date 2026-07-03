---
name: dexe-otc
description: |
  Run a DeXe OTC token sale end-to-end — open a multi-tier TokenSaleProposal,
  vote+execute it, then buyers check status / buy / claim. Covers the five
  dexe_otc_* composites plus the PRECISION-1e25 rate, native-BNB sentinel, and
  claim-timing gotchas. Use when the user mentions "OTC", "token sale", "sell DAO
  tokens", "buy from a tier", "claim vested tokens".
---

# dexe-otc

An OTC DAO sells its own token via on-chain `TokenSaleProposal` tiers. Each step
is one MCP call; calldata auto-broadcasts when `DEXE_PRIVATE_KEY` is set.
Validate on **BSC testnet (chain 97)** first. Full recipe + runnable proof:
`docs/OTC.md` and `scripts/lifecycle-otc.mjs`.

## The five composites

| Tool | Role |
|---|---|
| `dexe_otc_dao_open_sale` | multi-tier `createTiers` envelope + IPFS metadata + deposit + `createProposalAndVote`. `buildOnly:true` returns just the envelope. |
| `dexe_otc_list_sales_for_dao` | list a DAO's tiers (prices, `totalSold`, `isOff`, UTC times). |
| `dexe_otc_buyer_status` | render-ready buyer view: prices, claimable, vesting, auto-merkle proof. |
| `dexe_otc_buyer_buy` | preflight balance/allowance + approve + `buy()`; native path uses the sentinel + `value`. |
| `dexe_otc_buyer_claim_all` | claims tiers with `canClaim && !isClaimed`, withdraws vested; `noop` when nothing pending. |

## Owner flow

1. `dexe_dao_predict_addresses` → get `govPool` / `govToken` / `govTokenSale`.
2. Deploy with treasury pre-seeded (mint to the predicted `govPool` via
   `tokenParams.users[]`) — see [[dexe-create-dao]].
3. `dexe_otc_dao_open_sale` with tiers (schema below).
4. Poll `dexe_proposal_state` until `SucceededFor` (index 4; it briefly sits in
   `Locked`=6), then `dexe_vote_build_execute` → broadcast.

## Buyer flow

`dexe_otc_buyer_status` → `dexe_otc_buyer_buy` → (after the sale window closes)
`dexe_otc_buyer_claim_all`.

## Critical gotchas

- **Exchange rate is PRECISION 1e25**, not 1e18. 1:1 = `"10000000000000000000000000"`.
- **Native BNB = `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`** (ETHEREUM_ADDRESS),
  never `0x0…0` — a zero-address purchase token makes the tier unbuyable. Buy
  tools accept `0x0` as an alias but emit the sentinel.
- **`canClaim` needs `block.timestamp ≥ saleEndTime + claimLockDuration`** — buyers
  wait for the window to close even when `claimLockDuration:0`.
- **`maxAllocationPerUser == 0` means unlimited**, not zero — set a real cap.
- **Treasury must hold the sale token before the sale opens** — pre-seed at deploy.
- **`vestingPercentage` is a human percent 0–100** (auto-scaled by 1e25).
- **Merkle tiers** need the whitelist JSON on IPFS; `open_sale` auto-uploads when
  `uri` is empty (needs `DEXE_PINATA_JWT`). Roots via `dexe_merkle_build`.

## Tier schema (abridged)

```jsonc
{
  "name": "Public Tier 1", "description": "",
  "totalTokenProvided": "<wei>",
  "saleStartTime": "<unix sec>", "saleEndTime": "<unix sec>", "claimLockDuration": "0",
  "saleTokenAddress": "0x…",
  "purchaseTokenAddresses": ["0xEeee…EEeE"],   // native, or ERC20 addresses
  "exchangeRates": ["10000000000000000000000000"],
  "minAllocationPerUser": "0", "maxAllocationPerUser": "<wei, non-zero>",
  "vestingSettings": { "vestingPercentage": "0", "vestingDuration": "0", "cliffPeriod": "0", "unlockStep": "0" },
  "participation": []   // AND-list; empty = open tier
}
```

Do not modify OTC tool behavior lightly — the v0.11.x OTC surface is validated
E2E on mainnet. See `docs/OTC.md` for the exhaustive reference.
