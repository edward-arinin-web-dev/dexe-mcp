# dexe-mcp — Usage Guide

Long-form usage guide for integrating **dexe-mcp** into an AI agent, Claude Code,
or any custom MCP client.

> **Quick map first.** [`PLAYBOOK.md`](./PLAYBOOK.md) — also served as the MCP
> resource `dexe://playbook` — is the one-page intent → call table. This document
> is the narrative version: the same journeys with full inputs/outputs, plus the
> deep-dive material (signing modes, tx layer, toolsets, off-chain flow).

## What this is

`dexe-mcp` is a Model Context Protocol server that operates **DeXe Protocol**
DAOs end-to-end — **160 tools** across 19 groups
(catalog: [`TOOLS.md`](./TOOLS.md)):

- Deploy a DAO with one call (`dexe_dao_create`).
- Create **any of the 33 catalog proposal types** with one call
  (`dexe_proposal_create`).
- Vote + execute with one call (`dexe_proposal_vote_and_execute`).
- Run an OTC token sale end-to-end (the `dexe_otc_*` composites).
- Read DAO/proposal state, decode calldata, pin metadata to IPFS.

**Composite-first.** The composite tools handle the approve→deposit→create
ordering, the exact IPFS metadata shape, prerequisite detection, and the known
revert traps server-side. Hand-sequencing the low-level `*_build_*` tools is
only for custom wallets and pipelines — see [§10](#10-build-only-primitives).

### Two execution modes

Every write tool produces transactions in the canonical `TxPayload` shape:

```json
{
  "to":          "0x...",
  "data":        "0x...",
  "value":       "0",
  "chainId":     56,
  "description": "GovPool.vote(#13, FOR, 1000000000000000000 wei, 0 NFTs)"
}
```

- **No signer configured** → composites return `mode: "build"` with the ordered
  `TxPayload[]` **plus a WalletConnect pairing QR** (scan, approve on the phone,
  re-run). Nothing is lost.
- **Signer configured** (WalletConnect session or `DEXE_PRIVATE_KEY`) →
  composites sign and broadcast end-to-end and return the tx hashes per step.

### Environment in 30 seconds

Reads and WalletConnect signing work with **zero config** (baked public
defaults). Startup **schema-validates every `DEXE_*` var** — an invalid value
is a clear fatal at boot that names the offending var, instead of a confusing
mid-session failure (`dexe_doctor` flags the same problems).

| Var | Why set it |
|-----|------------|
| `DEXE_RPC_URL_MAINNET` / `DEXE_RPC_URL_TESTNET` | Your own BSC RPC for chain 56 / 97. Both accept a **comma-separated URL list** — the first is primary, the rest rotate automatically on transport failures. The zero-config public fallback already ships multiple endpoints per chain. |
| `DEXE_RPC_URL_<chainId>` | Any other chain by numeric id (e.g. `DEXE_RPC_URL_1` for the Governor tools). Comma lists work here too. |
| `DEXE_DEFAULT_CHAIN_ID` | Which configured chain is used when a call omits `chainId`. |
| `DEXE_PINATA_JWT` | **The only hard blocker for the create flows** — DAO/proposal metadata pins to IPFS. A missing key now errors with a numbered 3-step guide (get key → `.env` → restart). |
| `DEXE_PRIVATE_KEY` | Opt-in hot key (**NOT SAFE** — plaintext on disk). WalletConnect is the recommended signer — see [§6](#6-walletconnect-signing). |
| `DEXE_TX_WAIT_TIMEOUT_MS` | Per-broadcast mining-wait budget (default `180000` = 3 min). On timeout you get a check-`dexe_tx_status` error, never a hang. |
| `DEXE_TOOLSETS` | Tool gating. Default `core,proposals` = 72 tools — see [§11](#11-toolsets). |

Full reference — including `DEXE_MAX_DESCRIPTION_LEN`, `DEXE_PROTOCOL_REF`,
subgraph/IPFS/signer-guard vars — in [`ENVIRONMENT.md`](./ENVIRONMENT.md).
Env edits go in `.env` (never `.claude.json`); restart Claude Code afterwards;
`dexe_doctor` diagnoses anything env-shaped.

### Amount conventions (apply everywhere)

- **Digits-only string** (`"1000000000000000000"`) = **raw** smallest units (wei).
- **String with a decimal point** (`"12.5"`) = **human** units, scaled by the
  token's **real on-chain decimals** (read live — never assumed to be 18).

Both forms work everywhere an amount is accepted: proposal `params` amounts,
`voteAmount`, OTC buys. Durations/delays are plain **seconds**; quorum/percent
params on composites are plain percent numbers (`51`).

---

## 1. Deploy a new DAO — `dexe_dao_create`

One call replaces the old three-step predict → upload-metadata → build-deploy
chain. SIMPLE mode takes high-level fields and synthesizes a coherent,
frontend-equivalent config.

**Required env:** `DEXE_PINATA_JWT` (+ a signer to broadcast).

**Step 1 — preview** (no broadcast):

```json
{
  "tool": "dexe_dao_create",
  "args": {
    "chainId": 97,
    "daoName": "Glacier Cooperative",
    "symbol": "GLC",
    "totalSupply": "1000000",
    "daoDescription": "Research funding co-op.",
    "treasuryPercent": 49,
    "quorumPercent": 51,
    "durationSeconds": 86400
  }
}
```

Returns `mode: "preview"` with the **resolved config** (who holds what) and a
**safety proof** (votable %, quorum reachable?, floor ≥ 50%?). Show it to the
user.

**Step 2 — confirm:** re-call with the same args plus `confirm: true` →
broadcasts and returns `predictedGovPool`.

**One-call path:** when the user has *already* approved the deploy (they told
you exactly what to launch and to go ahead), pass `confirm: true` on the
**first** call — preview and broadcast collapse into one call.

**What you get out of the box.** DAOs deployed by `dexe_dao_create` have had
the **TokenSale + Distribution executors and all 5 settings groups auto-wired
since v0.19** — the OTC journey ([§4](#4-otc-token-sales)) works immediately
after a deploy, no extra settings proposal needed.

**Guards** (mirror the frontend's blocking validation, enforced in both SIMPLE
and ADVANCED mode):

- Quorum must be **reachable**: `quorum% × supply ≤ votable tokens` — treasury
  tokens can't vote. Hard block.
- `minVotesForVoting/Creating` ≤ the largest single recipient. Hard block.
- Token cap rule: `cap ≥ mintedTotal > 0` (no uncapped mode; `cap == minted`
  is a valid fixed supply).
- Treasury is an **implicit remainder** — `sum(amounts) < mintedTotal` is
  correct; the predicted govPool must never appear in `tokenParams.users[]`.
- For `LINEAR_VOTES` never pass `initData` — auto-encoded as
  `__LinearPower_init()`.

**ADVANCED mode:** pass a full `params` struct (same shape as
`dexe_dao_build_deploy`, which remains available in the `dev` toolset). Pass
**1** `proposalSettings` entry → auto-expands to 5. `delegatedVotingAllowed`
is inverted at the contract (`true` DISABLES delegation).

Validate on **testnet (chain 97) first** — mainnet (56) works but spends real
BNB and always requires `confirm: true`.

---

## 2. Create a proposal — `dexe_proposal_create`

One call for **all 33 catalog proposal types**: it checks balances, approves
the **UserKeeper** (never GovPool), deposits, uploads correctly-shaped IPFS
metadata, and calls `createProposalAndVote`.

```json
{
  "tool": "dexe_proposal_create",
  "args": {
    "govPool":      "0xGovPool",
    "chainId":      97,
    "proposalType": "token_transfer",
    "title":        "Treasury grant: Q3 research",
    "description":  "# Q3 grant\n\nFund the research workgroup.",
    "params": { "token": "0xERC20", "recipient": "0xAlice", "amount": "1000.0" }
  }
}
```

Note `"amount": "1000.0"` — the decimal point makes it a human-unit amount,
scaled by the token's real decimals. `"1000000000000000000000"` (digits only)
would be the raw-wei equivalent for an 18-dec token.

`proposalType` is a **strict enum** — an unknown string is rejected at
validation time with the list of valid types (previously it errored mid-flow).
Discover every type + params with `dexe_proposal_catalog` or the
[`PLAYBOOK.md`](./PLAYBOOK.md) type reference.

### The type catalog (params go in `params` unless noted)

**Treasury / tokens** — `token_transfer`, `withdraw_treasury`, `apply_to_dao`
(grant; mints shortfall when the treasury is short), `token_distribution`
(pro-rata airdrop to a proposal's voters).

**Governance config** — `change_voting_settings`, `new_proposal_type`,
`enable_staking`, `change_math_model` (swap LINEAR/POLYNOMIAL/custom power
contract), `manage_validators` / `validators_allocation` (`changes:[{user,
balance}]`; balance 0 removes).

**Experts / delegation** — `add_expert` / `remove_expert`
(`scope:"local"|"global"`; catalog aliases `add_local_expert`,
`add_global_expert`, `remove_local_expert`, `remove_global_expert` skip the
scope param), `delegate_to_expert` / `revoke_from_expert` (aliases
`delegate_tokens_to_expert` / `revoke_tokens_from_expert`).

**Token sale / staking** — `token_sale` (prefer `dexe_otc_dao_open_sale`,
[§4](#4-otc-token-sales)), `token_sale_whitelist` (extend a live tier's
whitelist), `token_sale_recover` (recover unsold tokens),
`create_staking_tier`.

**Token controls** — `blacklist` (`erc20Gov`, add/remove address lists),
`reward_multiplier` (`mode:"set_address"|"mint"|"change_token"|"set_token_uri"`).

**Profile / raw** — `modify_dao_profile` (top-level `newDaoName` /
`newDaoDescription` / `newWebsiteUrl` / `newSocialLinks` / `newAvatarPath` —
partial updates merge with current metadata), `custom` (your own
`actionsOnFor:[{executor, value?, data}]`), `custom_abi` (one encoded call from
`target` + `signature`).

**Internal (validators-only)** — `change_validator_balances`,
`change_validator_settings`, `monthly_withdraw`, `offchain_internal_proposal`.
These **auto-route to `GovValidators.createInternalProposal`** — no deposit, no
UserKeeper approve. Only a **current validator** can create them; validators
vote with their own balances.

**Off-chain (backend)** — `offchain_single_option`, `offchain_multi_option`,
`offchain_for_against` live on the DeXe backend, not on-chain.
`dexe_proposal_create` **rejects them with exact instructions** for the backend
flow: `dexe_proposal_build_offchain_*` → auth ([§9](#9-off-chain-proposals-mainnet-only))
→ authorized POST.

### One-call avatar update

```json
{
  "tool": "dexe_proposal_create",
  "args": {
    "govPool": "0xGovPool",
    "proposalType": "modify_dao_profile",
    "title": "New DAO avatar",
    "newAvatarPath": "C:/Users/me/Pictures/logo.png"
  }
}
```

The server reads the image from disk, magic-byte-validates it (SVG/HTML are
rejected — they never render on app.dexe.io), pins it, rebuilds the metadata,
and creates the proposal. Do not upload the avatar separately and do not read
the file into the conversation.

### Build-only preview

Pass `dryRun: true` (or run with no signer) to get the ordered `TxPayload`s —
`ERC20.approve` → `GovPool.deposit` → `GovPool.createProposalAndVote` — without
broadcasting. Steps the chain shows as already satisfied are omitted.

---

## 3. Vote and execute — `dexe_proposal_vote_and_execute`

```json
{
  "tool": "dexe_proposal_vote_and_execute",
  "args": {
    "govPool":    "0xGovPool",
    "chainId":    97,
    "proposalId": 13,
    "isVoteFor":  true
  }
}
```

Reads the proposal state, deposits if needed, votes, and (with `autoExecute`,
the default) executes once the proposal succeeds.

**`depositFirst` is `boolean | 'auto'`, default `'auto'`.** When your deposited
power is short of `voteAmount`, the tool deposits **exactly the missing amount**
from your wallet (approve UserKeeper → deposit → vote) automatically. Pass
`depositFirst: false` to restore never-deposit behavior (the pre-0.22 default),
or `true` to force a deposit.

- `voteAmount` defaults to all available power; accepts human units (`"250.5"`).
- Already past voting (`SucceededFor` / `SucceededAgainst` / `Locked`) → the
  vote is skipped and the tool goes straight to execute.
- Voting on a proposal in any other non-`Voting` state errors with a
  **per-state remedy** (execute it / wait out the delay / create a new
  proposal) instead of a bare revert.

**Canonical `ProposalState` order** (never hardcode a different one):

```
0 Voting  1 WaitingForVotingTransfer  2 ValidatorVoting  3 Defeated
4 SucceededFor  5 SucceededAgainst  6 Locked  7 ExecutedFor  8 ExecutedAgainst  9 Undefined
```

Executable states: **4, 5, 6** (when `executionDelay > 0` a proposal sits in
`Locked` until the delay passes).

**The locked-tokens trap.** After you vote/execute, your deposited tokens stay
**locked** for that proposal. Available power for the *next* proposal reads 0
until you withdraw: `dexe_vote_build_withdraw` between proposals, then let
`depositFirst: 'auto'` re-deposit.

---

## 4. OTC token sales

Five composites cover the whole journey (deep dive: [`OTC.md`](./OTC.md)):

| Tool | Role |
|------|------|
| `dexe_otc_dao_open_sale` | multi-tier `createTiers` envelope + IPFS metadata + deposit + `createProposalAndVote` |
| `dexe_otc_list_sales_for_dao` | list a DAO's tiers (prices, `totalSold`, `isOff`, UTC times) |
| `dexe_otc_buyer_status` | render-ready buyer view: prices, claimable, vesting, auto-merkle proof |
| `dexe_otc_buyer_buy` | preflight balance/allowance + approve + `buy()` |
| `dexe_otc_buyer_claim_all` | claims every tier with `canClaim && !isClaimed` |

Owner flow: `dexe_dao_create` (executors pre-wired since v0.19) →
`dexe_otc_dao_open_sale` → `dexe_proposal_vote_and_execute` → sale is live.

Buyer flow: `dexe_otc_buyer_status` → `dexe_otc_buyer_buy` → (after the sale
window closes) `dexe_otc_buyer_claim_all`.

**Buyer amounts are decimals-safe.** `dexe_otc_buyer_buy` accepts human units
(`"50.0"`), and converts the 18-dec-normalized buy amount to the **payment
token's native decimals** for the balance check and the exact `approve` — no
silent under-pay on <18-dec payment tokens (e.g. USDT/USDC variants).

Gotchas: exchange rates are PRECISION **1e25** (1:1 =
`"10000000000000000000000000"`); native BNB is the sentinel
`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (never the zero address);
`maxAllocationPerUser == 0` means *unlimited*; claiming needs
`block.timestamp ≥ saleEndTime + claimLockDuration`.

---

## 5. Reliability and failure semantics

What happens when things go wrong — and what your integration should check.

- **Transport-level RPC retry + failover.** Every RPC call retries transient
  failures and rotates across the configured fallback URLs
  (`DEXE_RPC_URL_MAINNET/_TESTNET/_<id>` accept comma-separated lists; the
  zero-config public fallback ships multiple endpoints). `429 / SERVER_ERROR`
  in a result means the rotation was already exhausted — re-run, or set your
  own RPC list.
- **Mining wait timeout.** A broadcast that doesn't mine within
  `DEXE_TX_WAIT_TIMEOUT_MS` (default 180 s) returns an error telling you to
  check `dexe_tx_status {txHash}` — the MCP request never hangs. Re-broadcast
  only if status is `not_found`.
- **Reverted ≠ success.** A mined-but-reverted tx (`receipt.status === 0`) is
  reported as a **failure everywhere**, including `dexe_tx_send`
  (`isError: true` + `reverted: true`). Scripts that treated any mined receipt
  as success must check these fields.
- **Composite failure ledger.** When a step of a composite flow fails, the
  result is `mode: "failed"` with a `failure` object:
  - `failedStep` — which step broke;
  - `error` — the actionable cause;
  - `landedSteps` — the txs that **did** land (gas already spent);
  - `resume` — how to continue.

  Fix the cause and **re-run the same call** — completed steps (approve,
  deposit) are detected on-chain and skipped, so you never double-pay them.

---

## 6. WalletConnect signing

The recommended signer: keys never touch the machine running the MCP server.
Deep dive: [`WALLETCONNECT.md`](./WALLETCONNECT.md).

- **Zero config** — a shared WalletConnect project id is baked in (set
  `DEXE_WALLETCONNECT_PROJECT_ID` for your own).
- `dexe_wc_connect` renders a **scannable QR** — terminal ASCII *and* an
  `image/png` MCP content block — scan with a mobile wallet (MetaMask, Trust,
  SafePal) and approve each tx on the phone.
- **Auto-print on writes.** `dexe_tx_send` with no session starts pairing and
  prints the QR instead of erroring; the composite flows attach the pairing QR
  to their build-mode response as real content blocks.
- Per-tx phone approval has a timeout (`DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS`,
  default 120 s) — an unanswered prompt returns `{status:'timeout'}` rather
  than hanging.
- `dexe_wc_status` reports the live session; `dexe_wc_disconnect` ends it.
  Sessions are in-memory — re-scan after an MCP server restart.
- Precedence: a configured `DEXE_PRIVATE_KEY` wins over a WalletConnect
  session until removed.

**Hot key mode** (`DEXE_PRIVATE_KEY` in `.env`) is opt-in and flagged
**NOT SAFE** throughout: the key lives in plaintext on disk and in process
memory. Use a throwaway wallet, never a treasury key.

---

## 7. The tx layer — `dexe_tx_send` / `dexe_tx_status`

`dexe_tx_send` broadcasts any `TxPayload` (from a composite's build mode or a
low-level builder) through the active signer. `dexe_tx_status {txHash}` reports
`pending / mined / reverted / not_found` keylessly.

In signer mode four guards run before anything is broadcast — each a no-op
unless its env var is set (see [`ENVIRONMENT.md` §4](./ENVIRONMENT.md)):

| Guard | Env var | Effect |
|-------|---------|--------|
| B6 destination allowlist | `DEXE_SIGNER_ALLOWLIST` | Rejects any `to` not listed. **List the GovPool _and_ the gov token** — deposit flows broadcast an `ERC20.approve` whose `to` is the token. |
| B7 value cap | `DEXE_SIGNER_MAX_VALUE_WEI` | Rejects `value` above the cap. |
| B9 auto-simulation | *(always on)* | `eth_call` preflight; aborts with the decoded revert reason instead of paying gas for a doomed tx. |
| B10 rate limit | `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | Caps broadcasts per rolling 60 s. |

Results honor the reliability contract from [§5](#5-reliability-and-failure-semantics):
mined-but-reverted returns `isError` + `reverted: true`; a slow tx returns the
check-`dexe_tx_status` timeout error instead of hanging.

---

## 8. Reading state

Start every session with **`dexe_context`** — it returns the signer, active
chain, env readiness, the DAOs/proposals recorded in prior sessions, and the
toolset report (`{enabled, hidden: [{set, unlocks}], enableHint}` — so an agent
can see which gated tools exist and how to enable them).

**Every relevant read tool takes an optional `chainId`** — the same session can
read testnet and mainnet without a restart. This covers `dexe_proposal_state` /
`_list` / `_voters`, `dexe_vote_user_power` / `_get_votes`, the `dexe_read_*`
family (validators, settings, expert status, token-sale tiers/user,
distribution, staking, privacy policy, gov state), `dexe_decode_proposal`,
`dexe_user_inbox`, `dexe_otc_buyer_status` / `dexe_otc_list_sales_for_dao`,
`dexe_dao_info` / `_registry_lookup` / `_predict_addresses`, and
`dexe_proposal_forecast`.

```json
{ "tool": "dexe_dao_info",       "args": { "govPool": "0xGovPool", "chainId": 97 } }
{ "tool": "dexe_proposal_state", "args": { "govPool": "0xGovPool", "proposalId": "13" } }
{ "tool": "dexe_proposal_list",  "args": { "govPool": "0xGovPool", "offset": 0, "limit": 20 } }
```

`dexe_dao_info` returns the helper addresses (`settings`, `userKeeper`,
`validators`, `votePower`) the low-level tools need. `dexe_proposal_list`
returns per-proposal `state` / `votesFor` / `votesAgainst` / `voteEnd` /
`requiredQuorum` — walk it and act on anything in `Voting`,
`WaitingForVotingTransfer`, or `ValidatorVoting`.

Treasury and holders come backend-first via `dexe_read_treasury`,
`dexe_read_token_holders`, `dexe_read_dao_stats` (mainnet backend), with
on-chain fallbacks.

---

## 9. Off-chain proposals (mainnet only)

Off-chain proposal types POST to the DeXe backend — they are **not** on-chain
transactions, which is why `dexe_proposal_create` rejects them with these
instructions. Backend exists for **chain 56 only**.

**Step 1 — build** the request descriptor:

```json
{
  "tool": "dexe_proposal_build_offchain_for_against",
  "args": {
    "poolAddress": "0xGovPool",
    "chainId": 56,
    "title": "Adopt the Q3 roadmap?",
    "votingDurationSeconds": "86400",
    "voteOptions": ["For", "Against"],
    "forPercent": 50,
    "againstPercent": 50
  }
}
```

**Step 2 — authenticate:** `dexe_auth_request_nonce {address}` → sign the
returned message in the user's wallet → `dexe_auth_login_request {address,
signedMessage}` → backend returns `access_token.id`.

**Step 3 — send** the HTTP request from step 1 with
`Authorization: Bearer <access_token.id>`.

Companions: `dexe_proposal_build_offchain_single_option` / `_multi_option` /
`_settings` / `_internal_proposal`, and `dexe_offchain_build_vote` /
`_cancel_vote` for voting on them.

---

## 10. Build-only primitives

For custom wallets/pipelines that sign externally, every step of the composite
flows exists as a standalone builder returning one `TxPayload`:

- **Proposal actions:** `dexe_proposal_build_<type>` for every catalog type,
  plus the raw `dexe_proposal_build_external` / `_internal` / `_custom_abi`
  primitives and `dexe_ipfs_upload_proposal_metadata` for the metadata pin.
- **Vote lifecycle:** `dexe_vote_build_erc20_approve` (spender is the
  **UserKeeper**, from `dexe_dao_info → helpers.userKeeper`) →
  `dexe_vote_build_deposit` → `dexe_vote_build_vote`; later
  `dexe_vote_build_execute` and `dexe_vote_build_withdraw`.
- **Validator chamber** (`vote` toolset): `dexe_vote_build_move_to_validators`,
  then `dexe_vote_build_validator_vote` — note its arg order is
  `(proposalId, amount, isVoteFor)`, different from `GovPool.vote`.
- **Delegation** (`vote` toolset): `dexe_vote_build_delegate` /
  `_undelegate`; delegated tokens land in the delegatee's `MicropoolVote`
  bucket (read with `dexe_vote_user_power`) and stay locked for the delegator
  until undelegated.
- **Atomic batches** (`vote` toolset): `dexe_vote_build_multicall` wraps
  multiple GovPool calldatas (e.g. `execute` + `claimRewards`) into one tx —
  inner calls must all target the same GovPool.
- **Raw DAO deploy** (`dev` toolset): `dexe_dao_predict_addresses` +
  `dexe_ipfs_upload_dao_metadata` + `dexe_dao_build_deploy` — the manual path
  `dexe_dao_create` automates. The same coherence guards run.

Decode/introspection (`dev` toolset): `dexe_decode_calldata`,
`dexe_decode_proposal`, `dexe_find_selector`, `dexe_get_methods` — run
`dexe_compile` once per session first.

---

## 11. Toolsets

The registered surface is gated by `DEXE_TOOLSETS` (default `core,proposals` =
**73 tools** of the 160):

| Set | Unlocks |
|-----|---------|
| `core` (default) | context, doctor, dao_create, dao_info, treasury/settings reads, tx_send/status, WalletConnect, OTC composites, IPFS uploads |
| `proposals` (default) | proposal_create (all types), every proposal_build_*, vote_and_execute, proposal state/list, vote-power reads |
| `read` | subgraph reads (members, delegation map, validators), forecast, risk assess, inbox |
| `vote` | delegate/undelegate, claims, staking, NFT multiplier, validator votes, multicall |
| `governor` | `dexe_gov_*` for external OZ/Compound Governor DAOs |
| `dev` | compile + ABI introspection, raw deploy, simulate/decode, merkle, Safe |

`DEXE_TOOLSETS=full` loads everything. A tool-not-found error usually means a
gated set: `dexe_context` lists the hidden sets and the exact `enableHint`.
Changes require a Claude Code restart.

---

## Tool index by use case

| Need | Tool |
|------|------|
| Orient (signer, chain, DAOs, toolsets) | `dexe_context` |
| Diagnose env problems | `dexe_doctor` |
| Deploy a DAO (preview → confirm) | `dexe_dao_create` |
| Create any of the 33 proposal types | `dexe_proposal_create` |
| Vote + execute (auto-deposit) | `dexe_proposal_vote_and_execute` |
| Open / inspect / buy / claim an OTC sale | `dexe_otc_dao_open_sale`, `dexe_otc_list_sales_for_dao`, `dexe_otc_buyer_status`, `dexe_otc_buyer_buy`, `dexe_otc_buyer_claim_all` |
| Read DAO/proposal state | `dexe_dao_info`, `dexe_proposal_state`, `dexe_proposal_list`, `dexe_vote_user_power` |
| Pin metadata / avatars | `dexe_ipfs_upload_proposal_metadata`, `dexe_ipfs_upload_dao_metadata`, `dexe_ipfs_upload_avatar` (or just pass `newAvatarPath` / `avatarPath`) |
| Build one action / one tx | `dexe_proposal_build_*`, `dexe_vote_build_*` |
| Sign + broadcast / check a tx | `dexe_tx_send`, `dexe_tx_status` |
| WalletConnect pairing | `dexe_wc_connect`, `dexe_wc_status`, `dexe_wc_disconnect` |
| Off-chain (backend) proposals | `dexe_proposal_build_offchain_*`, `dexe_auth_request_nonce`, `dexe_auth_login_request` |
| Decode / introspect | `dexe_decode_calldata`, `dexe_decode_proposal`, `dexe_find_selector` |
| External Governor DAOs | `dexe_gov_*` (`governor` toolset) |

For the full per-tool schema (**160 tools** across 19 groups) see
[`TOOLS.md`](./TOOLS.md) — every input/output is a Zod schema exposed via MCP
`tools/list`.
