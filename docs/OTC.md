# OTC DAO — quick start

End-to-end recipe for an "OTC DAO" — a DAO whose mandate is selling its own
token over-the-counter via on-chain `TokenSaleProposal` tiers (multi-payment,
custom rate, lockup, vesting, optional whitelist). Every step is one MCP call;
calldata returned can be signed by any wallet (or auto-broadcast when
`DEXE_PRIVATE_KEY` is set).

## Tools at a glance

| Tool | Role |
|------|------|
| `dexe_dao_predict_addresses` | predicts `govPool` / `govToken` / `govTokenSale` before deploy — feed `govPool` into `tokenParams.users[]` to seed treasury at deploy time |
| `dexe_dao_build_deploy` | deploys DAO + all helper proxies in one tx |
| `dexe_otc_dao_open_sale` | composite — multi-tier `createTiers` envelope + IPFS metadata + deposit + `createProposalAndVote`. `buildOnly: true` skips the proposal flow and just returns the envelope |
| `dexe_proposal_state` | poll `state` until index `4` (`SucceededFor`) — newly-passed proposals briefly land in `Locked` (idx 6) for finality before transitioning |
| `dexe_vote_build_execute` | build the final `execute(proposalId)` payload |
| `dexe_otc_buyer_status` | render-ready buyer view: per-tier prices + claimable + vesting + auto-merkle proof |
| `dexe_otc_buyer_buy` | preflights balance/allowance + builds approve + buy(); native sentinel `0x0` skips approve and uses `value` |
| `dexe_otc_buyer_claim_all` | reads `getUserViews`, picks tiers with `canClaim && !isClaimed` → `claim(...)`, tiers with `amountToWithdraw > 0` → `vestingWithdraw(...)`. `mode: "noop"` when nothing pending |
| `dexe_proposal_build_token_sale_whitelist` | extend an existing tier's whitelist post-launch |
| `dexe_merkle_build` / `dexe_merkle_proof` | OZ `StandardMerkleTree`-compatible utility (sorted-pair commutative keccak, double-hash leaf) |

## Tier metadata schema

```jsonc
{
  "name": "Tier display name (string, on-chain)",
  "description": "Tier description (on-chain)",
  "totalTokenProvided": "<wei>",
  "saleStartTime": "<unix sec>",
  "saleEndTime":   "<unix sec>",
  "claimLockDuration": "<sec>",
  "saleTokenAddress": "0x…",
  "purchaseTokenAddresses": ["0x… (use 0x0…0 for native BNB)"],
  "exchangeRates": ["<wei>"],
  "minAllocationPerUser": "<wei>",
  "maxAllocationPerUser": "<wei>",
  "vestingSettings": {
    "vestingPercentage": "<wei>",
    "vestingDuration": "<sec>",
    "cliffPeriod": "<sec>",
    "unlockStep": "<sec>"
  },
  "participation": [
    { "type": "DAOVotes",        "requiredVotes": "<wei>" },
    { "type": "Whitelist",       "users": ["0x…"], "uri": "ipfs://…" },
    { "type": "BABT" },
    { "type": "TokenLock",       "token": "0x…", "amount": "<wei>" },
    { "type": "NftLock",         "nft": "0x…",   "amount": "<wei>" },
    { "type": "MerkleWhitelist", "users": ["0x…"], "uri": "ipfs://…" }
  ]
}
```

`participation` is an AND-list — all entries must pass. Empty = open tier.

## Critical gotchas

| Issue | What to do |
|-------|------------|
| **Exchange rate uses 1e25 PRECISION**, not 1e18 | `exchangeRate = 10000000000000000000000000` for 1:1 |
| **`canClaim` requires `block.timestamp >= saleEndTime + claimLockDuration`** | Buyers must wait for sale window to close before `claim()` even with `claimLockDuration: 0` |
| **`maxAllocationPerUser == 0` means unlimited**, not "zero" | Set explicitly to a real cap |
| **Newly-passed proposal lands in `Locked` first** | Poll `dexe_proposal_state` until `state === "SucceededFor"` (index 4) before calling `execute` |
| **Treasury must hold sale token before sale opens** | Mint to govPool address at deploy time via `tokenParams.users[]` (call `dexe_dao_predict_addresses` first) |
| **`runProposalCreate` defaults `voteAmount` to all wallet+deposit** | Pin `voteAmount` to existing deposit if you need to keep wallet funds for the buyer side |
| **`dexe_proposal_vote_and_execute` only handles state 4/5/6** | If proposal lands in `Locked`, polling for `SucceededFor` then calling `dexe_vote_build_execute` is the safe path |
| **Merkle leaf format** | OZ `StandardMerkleTree` double-hash `keccak256(keccak256(abi.encode(addr)))`. The `dexe_merkle_*` utility produces matching roots |

## Project-owner flow (full lifecycle)

```ts
// 1. Predict addresses (so we can pre-seed treasury)
const predicted = await call("dexe_dao_predict_addresses", {
  deployer: deployer.address,
  poolName: "MyOTCDao",
});

// 2. Deploy. Mint 1M to deployer + 100 to predicted govPool (treasury seed).
await call("dexe_dao_build_deploy", {
  deployer: deployer.address,
  params: {
    name: "MyOTCDao",
    descriptionURL: "ipfs://Qm…",
    onlyBABTHolders: false,
    settingsParams: { proposalSettings: [DEFAULT_SETTINGS] },
    userKeeperParams: { tokenAddress: ZeroAddress, nftAddress: ZeroAddress, individualPower: "0", nftsTotalSupply: "0" },
    tokenParams: {
      name: "MyOTCDao Token",
      symbol: "MOT",
      cap: "2000000000000000000000000",
      mintedTotal: "1000100000000000000000000",
      users: [deployer.address, predicted.govPool],
      amounts: ["1000000000000000000000000", "100000000000000000000"],
    },
    votePowerParams: { voteType: "LINEAR_VOTES" },
  },
});

// 3. Deposit voting power (deployer has 1M wallet balance now)
//    approve UserKeeper, then GovPool.deposit — see scripts/lifecycle-otc.mjs

// 4. Open the sale.
const open = await call("dexe_otc_dao_open_sale", {
  govPool: predicted.govPool,
  tokenSaleProposal: predicted.govTokenSale,
  latestTierId: "0",
  tiers: [{
    name: "Public Tier 1",
    totalTokenProvided: "100000000000000000000",
    saleStartTime: String(Math.floor(Date.now() / 1000)),
    saleEndTime:   String(Math.floor(Date.now() / 1000) + 60 * 60 * 24),
    saleTokenAddress: predicted.govToken,
    purchaseTokenAddresses: [predicted.govToken],
    exchangeRates: ["10000000000000000000000000"], // 1:1 with PRECISION 1e25
    minAllocationPerUser: "0",
    maxAllocationPerUser: "100000000000000000000",
    vestingSettings: { vestingPercentage: "0", vestingDuration: "0", cliffPeriod: "0", unlockStep: "0" },
    claimLockDuration: "0",
  }],
  proposalName: "Open Public Tier 1",
  voteAmount: "<deposited wei>",
});

// 5. Poll until SucceededFor, then execute.
let state;
do {
  state = await call("dexe_proposal_state", { govPool: predicted.govPool, proposalId: 1 });
  if (state.stateIndex < 4) await new Promise(r => setTimeout(r, 3000));
} while (state.stateIndex !== 4);
const exec = await call("dexe_vote_build_execute", { govPool: predicted.govPool, proposalId: "1" });
// → broadcast exec.payload
```

## Buyer flow

```ts
// Check status (auto-derives merkle proof if whitelist supplied)
const status = await call("dexe_otc_buyer_status", {
  tokenSaleProposal: "0x…",
  tierIds: ["1"],
  user: buyer.address,
  whitelists: [{ tierId: "1", users: ["0x…"] }],
});

// Buy. ERC20 path (with auto-merkle): tool prepends approve + buy.
await call("dexe_otc_buyer_buy", {
  tokenSaleProposal: "0x…",
  tierId: "1",
  tokenToBuyWith: "0x…",
  amount: "1000000000000000000",
  whitelistUsers: ["0x…"], // optional — derives proof
});

// After saleEndTime + claimLockDuration elapsed, claim.
await call("dexe_otc_buyer_claim_all", {
  tokenSaleProposal: "0x…",
  tierIds: ["1"],
});
```

## Native-coin (BNB) buy

Pass `tokenToBuyWith: "0x0000000000000000000000000000000000000000"` and the tool will:
- skip ERC20 balance/allowance preflight
- skip the approve payload
- set `value = amount` on the buy tx

## Whitelist extension post-launch

```ts
await call("dexe_proposal_build_token_sale_whitelist", {
  tokenSaleProposal: "0x…",
  requests: [{ tierId: "1", users: ["0x…", "0x…"], uri: "ipfs://Qm…" }],
  proposalName: "Add buyers to Tier-1 whitelist",
});
// Returns the envelope. Pass `actions` to dexe_proposal_create.
```

## Reference implementation

`scripts/lifecycle-otc.mjs` — runnable end-to-end proof on BSC testnet (chain
97). Single command: `node scripts/lifecycle-otc.mjs`. Deploys a fresh DAO,
opens a 1-tier sale, votes+executes, buys, claims, verifies balance delta.
