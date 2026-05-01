# Frontend OTC calldata fixture capture

This file documents how to (re)generate the `tests/compat/fixtures/otc-frontend-*.json`
fixtures consumed by `tests/compat/diff-otc.mjs` (`npm run test:compat`).

There are **two** supported capture methods. Method A (synthesizer) is what the
fixtures currently ship with; Method B (live WalletConnect intercept) is the
ground-truth check to run when the synthesizer has to be updated.

---

## Quick: regenerate from the synthesizer

```sh
npm run build               # ensures dist/ is current
node tests/compat/gen-otc-fixtures.mjs
npm run test:compat
```

The generator runs an independent encoder (mirroring the frontend hook) **and**
the MCP helper, asserts they produce byte-identical calldata, then writes the
fixture using the helper output. If they diverge, no fixture is written and
exit code is 1.

---

## Method A — synthesized fixture (default)

**When to use:** any change to the MCP helper, schema, or default values. Also
fine for new tier shapes.

**What to check before trusting the regen:** open
`C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateTokenSaleProposal.ts`
and verify that the synthesizer in `tests/compat/gen-otc-fixtures.mjs` still
mirrors the frontend pipeline:

| Frontend step (lines 33-130) | Synthesizer counterpart |
|---|---|
| `getLatestTierId()` → `latestTierId` | input `latestTierId` field |
| `whitelistingRequests = tiers.filter(...)` keeping plain `Whitelist` only with `whitelistAddresses.length > 0`, tierId `= latestTierId + 1 + index` | `frontendSynthesize` loop building `wlReqs` |
| `encodeAbiMethod(TokenSaleProposalABI, "createTiers", [tiers])` | `tspIface.encodeFunctionData("createTiers", [tierTuples])` |
| `encodeAbiMethod(TokenSaleProposalABI, "addToWhitelist", [whitelistingRequests])` (only when any) | `tspIface.encodeFunctionData("addToWhitelist", [wlReqs])` |
| `saleTokensMap = tiers.reduce(...)` keyed by `saleTokenAddress.toLowerCase()`, summing `totalTokenProvided` | `totals = new Map()` keyed by lowercase address |
| `encodedApproves = Object.values(saleTokensMap).map(amount => approve(tokenSaleProposal, amount))` | `approves = [...]` per-key |
| Action ordering: `[...approves, createTiers, addToWhitelist?]` | identical |

The canonical TokenSaleProposal ABI (`TSP_SIG`) in the synthesizer matches
`TOKEN_SALE_PROPOSAL_ABI` in `src/tools/proposalBuildComplex.ts:29-33`.
Both regenerate from `contracts/interfaces/gov/proposals/ITokenSaleProposal.sol`
(the protocol Solidity source). Verified canonical 2026-05-01 via
`dexe_get_methods TokenSaleProposal` after Bug #25 fix.

If you change a tier-tuple field order in the helper, you **must** also change
it in the synthesizer — the test will still pass (because both produce the same
wrong output), but on-chain decoding will silently shift fields. Run Method B
periodically to catch this.

---

## Method B — live WalletConnect intercept (ground-truth re-cert)

**When to use:** after a frontend major version bump, after any change to the
`TokenSaleProposal` contract, or whenever you suspect the synthesizer has
drifted from the live frontend.

This requires the Chrome DevTools MCP and a running DeXe frontend on
`https://app.dexe.io` (or local `pnpm dev` against the same chain). Procedure
is the same as for the existing DAO/proposal compat tests in
`feedback_walletconnect_intercept.md` and `.claude/skills/test-mcp-compat/`.

### Form-field → TierSpec mapping (frontend OTC create-proposal form)

| Frontend form field | Path | TierSpec field |
|---|---|---|
| Tier name | "Tier Name" | `tiers[i].name` |
| Description | "Description" | `tiers[i].description` |
| Total tokens for sale | "Total tokens" | `tiers[i].totalTokenProvided` (wei) |
| Sale start | "Start" | `tiers[i].saleStartTime` (unix s) |
| Sale end | "End" | `tiers[i].saleEndTime` (unix s) |
| Sale token | "Sale token" address | `tiers[i].saleTokenAddress` |
| Purchase tokens | "Accepted tokens" multi | `tiers[i].purchaseTokenAddresses[]` |
| Exchange rates | per-purchase-token rate | `tiers[i].exchangeRates[]` (parallel array, wei) |
| Min/max per user | "Min/Max allocation" | `tiers[i].minAllocationPerUser`, `maxAllocationPerUser` |
| Claim lock | "Claim lock duration" | `tiers[i].claimLockDuration` (seconds) |
| Vesting | "Vesting" panel | `tiers[i].vestingSettings.{vestingPercentage,vestingDuration,cliffPeriod,unlockStep}` |
| Participation type dropdown | "Participation" | `tiers[i].participation[].type` (`DAOVotes` \| `Whitelist` \| `BABT` \| `TokenLock` \| `NftLock` \| `MerkleWhitelist`) |
| Whitelist addresses textarea | for `Whitelist` / `MerkleWhitelist` | `tiers[i].participation[].users[]` |

`vestingPercentage` uses 27-decimal PRECISION (e.g. 25% → `250000000000000000000000000`).
`claimLockDuration` is plain seconds; participation-type encodings are documented
in `_setParticipationInfo` in `TokenSaleProposalCreate.sol`.

### Capture flow

1. Open the frontend with Chrome DevTools MCP attached.
2. Connect via WalletConnect (in-browser). Per
   `feedback_walletconnect_mcp_browser.md`: there is no MetaMask in the MCP
   browser, so use the WalletConnect QR path with an external wallet pointed at
   testnet (chain 97).
3. Navigate to the DAO and start a Token Sale proposal.
4. Fill the form per the table above.
5. In the Network tab, capture the `eth_estimateGas` request that fires when
   the user clicks "Create Proposal" (per
   `feedback_walletconnect_intercept.md` — `window.ethereum` doesn't exist
   under WalletConnect, so don't try to hook `request`; the gas estimate
   carries the full calldata).
6. The `params[0]` of that JSON-RPC call has:
   - `to` — the GovPool (or executor)
   - `data` — the `createProposal(descriptionURL, actionsOnFor, ...)` calldata
7. ABI-decode that data with the GovPool interface to extract `actionsOnFor`.
8. The actions array maps 1:1 to the fixture's `expected.actions[]`. Save it
   along with the input you typed and bump `captureMethod` to `wc-intercept`.

### Sanity check after re-capture

Run `node tests/compat/diff-otc.mjs`. If all three fixtures stay green, the
synthesizer is in sync with reality. If any fail, the helper has drifted from
the contract and must be fixed before merging.

---

## Coverage today

| Fixture | Tiers | Whitelist mode | Approves |
|---|---|---|---|
| `otc-frontend-1tier-open.json` | 1 | none (open) | 1 |
| `otc-frontend-2tier-merkle.json` | 2 (open + merkle) | `MerkleWhitelist` (no addToWhitelist) | 1 (deduped per sale token) |
| `otc-frontend-2tier-plain-whitelist.json` | 2 (open + plain) | `Whitelist` (auto-appended `addToWhitelist`) | 1 (deduped per sale token) |

Add new fixtures by appending to `cases` in `tests/compat/gen-otc-fixtures.mjs`.
