# dexe-mcp — Usage Guide

Worked examples for end users integrating **dexe-mcp** into an AI agent, Claude Code, or
any custom MCP client.

## What this is

`dexe-mcp` is a Model Context Protocol server that gives an AI agent the ability to
operate **DeXe Protocol** DAOs end-to-end:

- Deploy a new DAO (full `PoolFactory.deployGovPool` flow).
- Build any of the 33 supported proposal types (token transfers, voting-settings changes,
  validators, off-chain, etc.).
- Vote, delegate, escalate to validators, and execute proposals.
- Read DAO/proposal state, decode calldata, and pin metadata to IPFS.

### Two execution modes

Almost every tool returns calldata in the canonical `TxPayload` shape:

```json
{
  "to":          "0x...",
  "data":        "0x...",
  "value":       "0",
  "chainId":     56,
  "description": "GovPool.vote(#13, FOR, 1000000000000000000 wei, 0 NFTs)"
}
```

The agent hands this to the user's wallet (frontend, hardware signer, etc.) for signature.

A few **composite** tools — `dexe_proposal_create`, `dexe_proposal_vote_and_execute`,
`dexe_tx_send` — additionally **sign and broadcast** when `DEXE_PRIVATE_KEY` is set in
the MCP server env. This unlocks one-shot flows for autonomous agents.

### Common environment variables

| Var | Required for | Notes |
|-----|--------------|-------|
| `DEXE_RPC_URL` | every read & every send | BSC mainnet or testnet RPC |
| `DEXE_CHAIN_ID` | calldata builders (sets `chainId` field) | `56` mainnet, `97` testnet |
| `DEXE_PINATA_JWT` | every IPFS upload tool, every wrapper that auto-uploads | Pinata JWT |
| `DEXE_IPFS_GATEWAY` | `dexe_ipfs_fetch`, `dexe_ipfs_cid_info` | Dedicated gateway, e.g. `https://<sub>.mypinata.cloud` |
| `DEXE_PRIVATE_KEY` | signed-mode composite tools, `dexe_tx_send` | Hex private key — only set when you want the server to sign |
| `DEXE_BACKEND_API_URL` | off-chain proposal tools (S38–S40) | DeXe backend, mainnet only |
| `DEXE_SUBGRAPH_URL` | subgraph readers (`dexe_proposal_voters`, `dexe_read_user_activity`) | Per-chain endpoint |

> Composite tools fall back to "build only" (return ordered `TxPayload[]`) when
> `DEXE_PRIVATE_KEY` is unset — pass `user` so the tool knows whose prerequisites to
> resolve.

---

## 1. Deploy a new DAO

End-to-end DAO creation: predict addresses, pin metadata, then build the `deployGovPool`
calldata. Mirrors the frontend wizard at `app.dexe.network/create-dao`.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID, DEXE_PINATA_JWT
```

**Step 1 — predict CREATE2 addresses**

```json
{
  "tool": "dexe_dao_predict_addresses",
  "args": {
    "deployer": "0xYourDeployerEOA",
    "poolName": "Glacier Cooperative"
  }
}
```

Output:

```json
{
  "govPool":              "0xGOVPOOL...",
  "govTokenSale":         "0xSALE...",
  "govToken":             "0xTOKEN...",
  "distributionProposal": "0xDP...",
  "expertNft":            "0xEXPERT...",
  "nftMultiplier":        "0xMULT..."
}
```

**Step 2 — upload DAO metadata to IPFS**

```json
{
  "tool": "dexe_ipfs_upload_dao_metadata",
  "args": {
    "daoName": "Glacier Cooperative",
    "description": "# Glacier\n\nResearch funding co-op. *Markdown supported.*",
    "websiteUrl": "https://glacier.example",
    "socialLinks": [["twitter", "https://x.com/glacier"]]
  }
}
```

Output (abbreviated):

```json
{
  "cid": "Qm...outerCID",
  "descriptionCid": "Qm...descCID",
  "descriptionURL": "Qm...outerCID"
}
```

**Step 3 — build the deploy calldata**

```json
{
  "tool": "dexe_dao_build_deploy",
  "args": {
    "deployer": "0xYourDeployerEOA",
    "params": {
      "name": "Glacier Cooperative",
      "descriptionURL": "Qm...outerCID",
      "settingsParams": {
        "proposalSettings": [{
          "earlyCompletion":         true,
          "delegatedVotingAllowed":  false,
          "validatorsVote":          true,
          "duration":                "86400",
          "durationValidators":      "43200",
          "executionDelay":          "0",
          "quorum":                  "500000000000000000000000000",
          "quorumValidators":        "510000000000000000000000000",
          "minVotesForVoting":       "1000000000000000000",
          "minVotesForCreating":     "10000000000000000000",
          "rewardsInfo": {
            "rewardToken":            "0x0000000000000000000000000000000000000000",
            "creationReward":         "0",
            "executionReward":        "0",
            "voteRewardsCoefficient": "0"
          },
          "executorDescription": ""
        }]
      },
      "validatorsParams": {
        "name": "Glacier Validators",
        "symbol": "GVAL",
        "proposalSettings": {
          "duration": "43200",
          "executionDelay": "0",
          "quorum": "510000000000000000000000000"
        },
        "validators": ["0xValidator1", "0xValidator2"],
        "balances":   ["1000000000000000000000", "1000000000000000000000"]
      },
      "userKeeperParams": {
        "tokenAddress":   "0x0000000000000000000000000000000000000000",
        "nftAddress":     "0x0000000000000000000000000000000000000000",
        "individualPower":"0",
        "nftsTotalSupply":"0"
      },
      "tokenParams": {
        "name":        "Glacier Token",
        "symbol":      "GLC",
        "users":       ["0xRecipient1", "0xRecipient2"],
        "cap":         "1000000000000000000000000",
        "mintedTotal": "100000000000000000000000",
        "amounts":     ["50000000000000000000000", "50000000000000000000000"]
      },
      "votePowerParams": {
        "voteType": "LINEAR_VOTES"
      },
      "verifier":       "0x0000000000000000000000000000000000000000",
      "onlyBABTHolders": false
    }
  }
}
```

Output (abbreviated):

```json
{
  "payload": {
    "to":          "0xPoolFactory",
    "data":        "0x6f5a3da7...",
    "value":       "0",
    "chainId":     56,
    "description": "PoolFactory.deployGovPool(...)"
  },
  "predictedGovPool": "0xGOVPOOL..."
}
```

**Notes / gotchas**

- Pass **1** `proposalSettings` entry → the tool auto-expands to **5** (default,
  internal, validators, distributionProposal, tokenSale). Pass exactly 5 to override.
- `delegatedVotingAllowed` is **inverted** at the contract: `true` DISABLES delegation,
  `false` ALLOWS it. The schema docstring matches the frontend.
- Decimal conventions: `quorum` is **25-decimal wei** (50% =
  `500000000000000000000000000`). Token amounts are **18-decimal wei**. Durations are
  plain seconds.
- The tool auto-wires the predicted `govToken` into `userKeeperParams.tokenAddress` when
  creating a new token — you can leave that field as the zero address.
- For `LINEAR_VOTES` you **must not** pass `initData` — it is auto-encoded as
  `__LinearPower_init()`. Pass `polynomialCoefficients` for `POLYNOMIAL_VOTES`. Only
  `CUSTOM_VOTES` accepts raw `initData`.

---

## 2. Create a Token Transfer proposal (build-only flow)

Three-step external proposal: build the action body, pin metadata, build the
`createProposalAndVote` tx.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID, DEXE_PINATA_JWT
```

**Step 1 — build the action**

```json
{
  "tool": "dexe_proposal_build_token_transfer",
  "args": {
    "govPool":             "0xGovPool",
    "token":               "0xERC20",
    "recipient":           "0xRecipient",
    "amount":              "1000000000000000000",
    "proposalName":        "Treasury grant: Q3 research",
    "proposalDescription": "# Q3 grant\n\nFund the research workgroup with 1 token."
  }
}
```

Output:

```json
{
  "metadata": {
    "proposalName": "Treasury grant: Q3 research",
    "proposalDescription": "[{...slate nodes...}]",
    "category": "Token Transfer",
    "isMeta": false,
    "changes": { "proposedChanges": "...", "currentChanges": "..." }
  },
  "actions": [{
    "executor": "0xERC20",
    "value":    "0",
    "data":     "0xa9059cbb..."
  }],
  "instructions": "1) dexe_ipfs_upload_proposal_metadata ... 2) dexe_proposal_build_external ..."
}
```

**Step 2 — pin metadata to IPFS**

```json
{
  "tool": "dexe_ipfs_upload_proposal_metadata",
  "args": {
    "title":       "Treasury grant: Q3 research",
    "description": "# Q3 grant\n\nFund the research workgroup with 1 token.",
    "extra": {
      "category": "Token Transfer",
      "isMeta": false,
      "changes": { "proposedChanges": "...", "currentChanges": "..." }
    }
  }
}
```

Output:

```json
{ "cid": "QmProp...", "descriptionURL": "QmProp..." }
```

**Step 3 — build createProposalAndVote calldata**

```json
{
  "tool": "dexe_proposal_build_external",
  "args": {
    "govPool":        "0xGovPool",
    "descriptionURL": "QmProp...",
    "actionsOnFor":   [{ "executor": "0xERC20", "value": "0", "data": "0xa9059cbb..." }],
    "andVote":        true,
    "voteAmount":     "100000000000000000000"
  }
}
```

Output:

```json
{
  "payload": {
    "to":          "0xGovPool",
    "data":        "0xda1c6cfa...",
    "value":       "0",
    "chainId":     56,
    "description": "GovPool.createProposalAndVote (1 for / 0 against)"
  }
}
```

**Notes**

- The user must already have `voteAmount` deposited (or use the composite tool below).
- `descriptionURL` accepts either the bare CID or `ipfs://<cid>`.
- Set `andVote: false` to use `createProposal` (no auto-vote).

---

## 3. One-shot composite create (signed mode)

Collapse the entire prereq + approve + deposit + IPFS + create chain into a single call.
Requires a private key in the server env.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID, DEXE_PINATA_JWT, DEXE_PRIVATE_KEY
```

```json
{
  "tool": "dexe_proposal_create",
  "args": {
    "govPool":            "0xGovPool",
    "proposalType":       "modify_dao_profile",
    "title":              "Update DAO description",
    "description":        "Refresh the public-facing copy.",
    "newDaoDescription":  "Glacier — funding cold-region research, year 2 mandate.",
    "category":           "DAO Profile"
  }
}
```

Output (signed mode):

```json
{
  "mode":        "signed",
  "proposalId":  "13",
  "txHash":      "0xabc...",
  "steps":       [
    { "label": "GovPool.createProposalAndVote", "txHash": "0xabc..." }
  ]
}
```

**Build-only mode** (omit `DEXE_PRIVATE_KEY`, pass `user`):

```json
{
  "tool": "dexe_proposal_create",
  "args": {
    "govPool":           "0xGovPool",
    "proposalType":      "custom",
    "title":             "Treasury grant",
    "description":       "Fund team alpha.",
    "user":              "0xUserEOA",
    "actionsOnFor":      [{ "executor": "0xERC20", "value": "0", "data": "0xa9059cbb..." }],
    "category":          "Token Transfer",
    "proposalMetadataExtra": {
      "isMeta":  false,
      "changes": { "proposedChanges": "...", "currentChanges": "..." }
    },
    "voteAmount":        "100000000000000000000"
  }
}
```

Output (build-only):

```json
{
  "mode": "build",
  "steps": [
    { "label": "ERC20.approve",                  "payload": { "to":"0xToken","data":"0x095ea7b3..." } },
    { "label": "GovPool.deposit",                "payload": { "to":"0xGovPool","data":"0x47e7ef24..." } },
    { "label": "GovPool.createProposalAndVote", "payload": { "to":"0xGovPool","data":"0xda1c6cfa..." } }
  ]
}
```

**Notes**

- `proposalType` is `'modify_dao_profile' | 'custom'`. For other named types, build the
  action with `dexe_proposal_build_*`, then pass it through `actionsOnFor` +
  `proposalMetadataExtra` here.
- Approval / deposit steps are skipped automatically when the user already has enough
  deposited power.

---

## 4. Vote on a proposal (build-only)

Three independent calldata builds. The wallet sends them in order.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID
```

**Step 1 — approve token spend (skip for native-coin DAOs)**

```json
{
  "tool": "dexe_vote_build_erc20_approve",
  "args": {
    "token":   "0xGovToken",
    "spender": "0xUserKeeper",
    "amount":  "100000000000000000000"
  }
}
```

> Spender is the **UserKeeper** address (read it from `dexe_dao_info → helpers.userKeeper`).

**Step 2 — deposit into the DAO**

```json
{
  "tool": "dexe_vote_build_deposit",
  "args": {
    "govPool": "0xGovPool",
    "amount":  "100000000000000000000",
    "nftIds":  []
  }
}
```

**Step 3 — vote**

```json
{
  "tool": "dexe_vote_build_vote",
  "args": {
    "govPool":    "0xGovPool",
    "proposalId": "13",
    "isVoteFor":  true,
    "amount":     "100000000000000000000",
    "nftIds":     []
  }
}
```

Each output is a `TxPayload`. Send in this order: **approve → deposit → vote**.

**Notes / gotchas**

- For native-coin DAOs (BNB/ETH), skip step 1 and pass `value` to the deposit call.
- The user's voting power becomes "locked" while a vote is active — to vote on the next
  proposal you may need to `dexe_vote_build_withdraw` first.
- Deposit can be combined with delegate + claim using `dexe_vote_build_multicall` —
  see example 10.

---

## 5. Validator chamber lifecycle

After a proposal hits main-quorum, push it to the validators tier and finish it there.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID
```

**Step 1 — escalate**

```json
{
  "tool": "dexe_vote_build_move_to_validators",
  "args": { "govPool": "0xGovPool", "proposalId": "13" }
}
```

**Step 2 — each validator votes** (note `govValidators` and `scope: "external"`)

```json
{
  "tool": "dexe_vote_build_validator_vote",
  "args": {
    "govValidators": "0xGovValidators",
    "scope":         "external",
    "proposalId":    "13",
    "amount":        "1000000000000000000000",
    "isVoteFor":     true
  }
}
```

> `govValidators` is the validators-helper contract — read it via
> `dexe_dao_info → helpers.validators`.

**Step 3 — execute**

```json
{
  "tool": "dexe_vote_build_execute",
  "args": { "govPool": "0xGovPool", "proposalId": "13" }
}
```

**Notes**

- Validator-vote arg order is `(proposalId, amount, isVoteFor)` — **different** from
  `GovPool.vote`'s `(proposalId, isVoteFor, amount, nftIds)`.
- `scope: "internal"` selects validator-internal proposals (DAO-config changes inside the
  validators contract). External proposals coming from the main pool always use
  `"external"`.
- When `executionDelay > 0`, expect state `Locked` between `SucceededFor` and
  `ExecutedFor` — wait the delay before calling execute.

---

## 6. Delegation chain

Two users delegate to the same expert; read aggregate power on the expert.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID
```

**A → C**

```json
{
  "tool": "dexe_vote_build_delegate",
  "args": {
    "govPool":   "0xGovPool",
    "delegatee": "0xExpertC",
    "amount":    "10000000000000000000000",
    "nftIds":    []
  }
}
```

**B → C**

```json
{
  "tool": "dexe_vote_build_delegate",
  "args": {
    "govPool":   "0xGovPool",
    "delegatee": "0xExpertC",
    "amount":    "8000000000000000000000",
    "nftIds":    []
  }
}
```

**Read C's aggregate power**

```json
{
  "tool": "dexe_vote_user_power",
  "args": { "govPool": "0xGovPool", "user": "0xExpertC" }
}
```

Output:

```json
{
  "govPool":    "0xGovPool",
  "user":       "0xExpertC",
  "userKeeper": "0xUserKeeper",
  "power": {
    "PersonalVote":  { "tokenBalance": "0",                    "tokenOwned": "0",  "nftBalance":"0", "nftOwned":"0" },
    "MicropoolVote": { "tokenBalance": "18000000000000000000000", "tokenOwned": "0", "nftBalance":"0", "nftOwned":"0" },
    "DelegatedVote": { "tokenBalance": "0", "tokenOwned": "0", "nftBalance":"0", "nftOwned":"0" },
    "TreasuryVote":  { "tokenBalance": "0", "tokenOwned": "0", "nftBalance":"0", "nftOwned":"0" }
  }
}
```

**Notes**

- `MicropoolVote` is what arriving delegations from other users add up to; A and B's
  10k + 8k = 18k tokens land here.
- A and B keep the tokens **deposited but locked** until they undelegate — they cannot
  vote with the same tokens themselves while delegated.
- Use `dexe_vote_build_undelegate` to reverse.

---

## 7. Read DAO state

Three read-only tools — useful for an agent walking active proposals.

**Required env**

```
DEXE_RPC_URL
```

**DAO overview**

```json
{
  "tool": "dexe_dao_info",
  "args": { "govPool": "0xGovPool" }
}
```

Output (abbreviated):

```json
{
  "govPool": "0xGovPool",
  "descriptionURL": "ipfs://Qm...",
  "helpers": {
    "settings":     "0xSettings",
    "userKeeper":   "0xUserKeeper",
    "validators":   "0xGovValidators",
    "poolRegistry": "0xPoolRegistry",
    "votePower":    "0xVotePower"
  },
  "nftContracts": {
    "nftMultiplier":  "0xMult",
    "expertNft":      "0xExpert",
    "dexeExpertNft":  "0xDexeExpert",
    "babt":           "0xBABT"
  },
  "validatorsCount": "3"
}
```

**Single proposal state**

```json
{
  "tool": "dexe_proposal_state",
  "args": { "govPool": "0xGovPool", "proposalId": "13" }
}
```

Output:

```json
{
  "govPool":         "0xGovPool",
  "proposalId":      "13",
  "state":           "Voting",
  "stateIndex":      0,
  "requiredQuorum":  "500000000000000000000000000"
}
```

State enum order: `Voting, WaitingForVotingTransfer, ValidatorVoting, Defeated,
SucceededFor, SucceededAgainst, Locked, ExecutedFor, ExecutedAgainst, Undefined`.

**Paged list**

```json
{
  "tool": "dexe_proposal_list",
  "args": { "govPool": "0xGovPool", "offset": 0, "limit": 20 }
}
```

Output (abbreviated):

```json
{
  "proposals": [
    {
      "proposalId":     "1",
      "descriptionURL": "ipfs://Qm...",
      "state":          "ExecutedFor",
      "stateIndex":     7,
      "votesFor":       "5000000000000000000000",
      "votesAgainst":   "0",
      "voteEnd":        "1745596800",
      "executed":       true,
      "requiredQuorum": "500000000000000000000000000"
    }
  ]
}
```

**Walking active proposals (pseudocode)**

```text
list = dexe_proposal_list(govPool, offset=0, limit=100)
for p in list.proposals:
  if p.state in ("Voting", "WaitingForVotingTransfer", "ValidatorVoting"):
    # take action
```

---

## 8. Decode arbitrary calldata

Useful when reviewing on-chain proposals or transactions you didn't build yourself.

**Required env**

_(none — works on local artifacts)_

```json
{
  "tool": "dexe_decode_calldata",
  "args": {
    "contract": "GovPool",
    "data":     "0xfe0d94c1000000000000000000000000000000000000000000000000000000000000000d"
  }
}
```

Output:

```json
{
  "contract":     "GovPool",
  "selector":     "0xfe0d94c1",
  "functionName": "execute",
  "args":         ["13"]
}
```

**Companion tools**

- `dexe_find_selector` — reverse-lookup a 4-byte selector across all DeXe contracts.
- `dexe_get_methods` / `dexe_get_selectors` — list read/write methods for any contract.
- `dexe_decode_proposal` — fetch + decode a proposal body from the chain.

> Run `dexe_compile` once per session before any introspection tool — they read from
> Hardhat artifacts.

---

## 9. Off-chain proposal (mainnet only)

Off-chain proposals POST to the DeXe backend (`/integrations/voting/proposals`). Two-step
auth, then submit. Backend exists for **chain 56 only**.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID=56, DEXE_BACKEND_API_URL
```

**Step 1 — request a nonce**

```json
{
  "tool": "dexe_auth_request_nonce",
  "args": { "address": "0xUserEOA" }
}
```

Returns the HTTP request descriptor; agent fires it, gets back `{ message: "..." }`.

**Step 2 — sign the message** (in the user's wallet) and trade for an `access_token`

```json
{
  "tool": "dexe_auth_login_request",
  "args": {
    "address":       "0xUserEOA",
    "signedMessage": "0xSignedMessageFromWallet"
  }
}
```

Backend response: `{ access_token: { id: "..." }, refresh_token: { id: "..." } }`.
Use `access_token.id` as a `Bearer` header for the proposal POST.

**Step 3 — build the proposal**

```json
{
  "tool": "dexe_proposal_build_offchain_for_against",
  "args": {
    "poolAddress":          "0xGovPool",
    "chainId":              56,
    "title":                "Should we adopt the Q3 roadmap?",
    "votingDurationSeconds":"86400",
    "voteOptions":          ["For", "Against"],
    "useDelegated":         true,
    "forPercent":           50,
    "againstPercent":       50
  }
}
```

The output is an HTTP request descriptor (`method`, `url`, `headers`, `body`); the agent
fires the POST with `Authorization: Bearer <access_token.id>`.

**Notes**

- Companion off-chain builders: `dexe_proposal_build_offchain_single_option`,
  `dexe_proposal_build_offchain_multi_option`, `dexe_proposal_build_offchain_settings`,
  `dexe_proposal_build_offchain_internal_proposal`.
- The MCP `dexe_offchain_build_vote` / `dexe_offchain_build_cancel_vote` tools build
  the corresponding vote requests.

---

## 10. Multi-tx batch (atomic multicall)

Bundle multiple GovPool writes into a single tx. Common pattern: `execute + claimRewards`
or `deposit + delegate`.

**Required env**

```
DEXE_RPC_URL, DEXE_CHAIN_ID
```

**Step 1 — build each inner call**, then strip out just the `data` fields.

```json
{
  "tool": "dexe_vote_build_execute",
  "args": { "govPool": "0xGovPool", "proposalId": "13" }
}
```
→ `payload.data = "0xfe0d94c1...0d"`

```json
{
  "tool": "dexe_vote_build_claim_rewards",
  "args": {
    "govPool":     "0xGovPool",
    "proposalIds": ["13"],
    "user":        "0xUserEOA"
  }
}
```
→ `payload.data = "0x76b8f6dc..."`

**Step 2 — wrap in multicall**

```json
{
  "tool": "dexe_vote_build_multicall",
  "args": {
    "govPool": "0xGovPool",
    "calls": [
      "0xfe0d94c1...0d",
      "0x76b8f6dc..."
    ],
    "value":   "0"
  }
}
```

Output:

```json
{
  "payload": {
    "to":          "0xGovPool",
    "data":        "0xac9650d8...",
    "value":       "0",
    "chainId":     56,
    "description": "GovPool.multicall(2 calls)"
  }
}
```

**Notes**

- `multicall` only works for inner calls **targeting the same GovPool** — you can't mix
  in ERC20 approves or external-contract calls.
- For atomic `approve+deposit` you'll typically do two separate txs; the approve target
  is a different contract.
- All inner calldatas must be `0x`-prefixed hex strings.

---

## Tool index by use case

| Need | Tool |
|------|------|
| Predict DAO addresses | `dexe_dao_predict_addresses` |
| Build deploy tx | `dexe_dao_build_deploy` |
| Pin DAO metadata | `dexe_ipfs_upload_dao_metadata` |
| Pin proposal metadata | `dexe_ipfs_upload_proposal_metadata` |
| Pin raw bytes (avatar) | `dexe_ipfs_upload_file` |
| Build any of the 33 proposal types | `dexe_proposal_build_*` |
| Raw create-proposal primitive | `dexe_proposal_build_external`, `dexe_proposal_build_internal` |
| Composite create (signed/build) | `dexe_proposal_create` |
| Composite vote+execute | `dexe_proposal_vote_and_execute` |
| Approve / deposit / withdraw | `dexe_vote_build_erc20_approve`, `dexe_vote_build_deposit`, `dexe_vote_build_withdraw` |
| Vote / cancel-vote | `dexe_vote_build_vote`, `dexe_vote_build_cancel_vote` |
| Delegate / undelegate | `dexe_vote_build_delegate`, `dexe_vote_build_undelegate` |
| Validators chamber | `dexe_vote_build_move_to_validators`, `dexe_vote_build_validator_vote` |
| Execute, claim rewards | `dexe_vote_build_execute`, `dexe_vote_build_claim_rewards` |
| Atomic batch | `dexe_vote_build_multicall` |
| Read DAO/proposal state | `dexe_dao_info`, `dexe_proposal_state`, `dexe_proposal_list`, `dexe_vote_user_power` |
| Decode/introspect | `dexe_decode_calldata`, `dexe_decode_proposal`, `dexe_get_methods`, `dexe_find_selector` |
| Off-chain auth + propose | `dexe_auth_request_nonce`, `dexe_auth_login_request`, `dexe_proposal_build_offchain_*` |
| Sign + broadcast | `dexe_tx_send`, `dexe_tx_status` |

For the full per-tool schema (98 tools total), browse `src/tools/*.ts` or call the
tool — every input/output is a Zod schema MCP exposes via `tools/list`.
