---
name: dexe-create-proposal
description: |
  Create any DeXe governance proposal with the one-call `dexe_proposal_create`
  composite — it runs approve→deposit→createProposalAndVote and uploads correct
  IPFS metadata for you. Covers every wired proposalType + params recipe and the
  metadata/ABI/blacklist failure modes. Use when the user says "create a proposal",
  "transfer treasury", "add an expert", "change voting settings", "start a token sale".
---

# dexe-create-proposal

`dexe_proposal_create` builds a governance proposal in **one call**: it checks
token balance, approves the **UserKeeper** (not GovPool), deposits, uploads IPFS
metadata with the correct `{proposalName, proposalDescription, category, isMeta,
changes}` shape, and calls `createProposalAndVote`. With `DEXE_PRIVATE_KEY` it
signs+broadcasts; otherwise it returns ordered `TxPayload`s.

If you don't already know the target `govPool`/chain, call **`dexe_context`** —
it returns the signer, active chain, and the DAOs/proposals from prior sessions.
When the user already told you the DAO and what to do, go straight to
`dexe_proposal_create`.

**Do not hand-sequence** approve/deposit/create, and do not hand-build the IPFS
metadata — the composite does both correctly. **Do not guess ABIs/selectors**;
the wired builders encode canonical calldata. For a truly custom call use the
`custom_abi` type; `dexe_proposal_catalog` (or the playbook — MCP resource
`dexe://playbook`, `docs/PLAYBOOK.md`) lists every type and its params.

**Amounts:** a digits-only string is raw wei; a string with a decimal point
(`"1000.0"`) is human units, scaled by the token's **real on-chain decimals**
(never assumed 18). Both forms work in every `params` amount and `voteAmount`.

## Pick a proposalType

Pass `proposalType` + the type's inputs in `params`:

| proposalType | params |
|---|---|
| `token_transfer` | `{ token, recipient, amount, isNative? }` |
| `withdraw_treasury` | `{ receiver, token?, amount?, nftAddress?, nftIds? }` (emits external `token.transfer`) |
| `change_voting_settings` | `{ govSettings, settings:[…], settingsIds? }` (empty ids ⇒ addSettings) |
| `add_expert` | `{ expertNftContract, scope:"local"\|"global", nominatedUser, uri? }` |
| `remove_expert` | `{ expertNftContract, scope, nominatedUser }` |
| `token_distribution` | `{ distributionProposal, proposalId, token, amount, isNative? }` |
| `token_sale` | `{ tokenSaleProposal, tiers:[…], latestTierId? }` |
| `custom_abi` | `{ target, signature, method, args?, value? }` |
| `modify_dao_profile` | top-level `newDaoName/newDaoDescription/newWebsiteUrl/newSocialLinks`; avatar via `newAvatarPath` (local image path — the server uploads + validates it; do NOT read the file yourself) or `newAvatarCID` |
| `custom` | top-level `actionsOnFor:[{executor,value,data}]` (+ optional `category`) |

**All 33 catalog types are wired** — `proposalType` is a strict enum; an
unknown string is rejected at validation with the list of valid types. Beyond
the table above: treasury/tokens (`apply_to_dao`, `token_sale_recover`,
`token_sale_whitelist`), governance config (`new_proposal_type`,
`enable_staking`, `change_math_model`, `manage_validators` /
`validators_allocation`), experts/delegation (`delegate_to_expert` /
`revoke_from_expert`, plus catalog-style aliases like
`delegate_tokens_to_expert` and `add_local_expert` / `add_global_expert`),
token controls (`blacklist`, `reward_multiplier`), and staking
(`create_staking_tier`).

Internal validator types (`change_validator_balances`,
`change_validator_settings`, `monthly_withdraw`, `offchain_internal_proposal`)
**auto-route to `GovValidators.createInternalProposal`** — validators only, no
deposit or UserKeeper approve. Off-chain types are on the DeXe backend, not
on-chain: build with `dexe_proposal_build_offchain_*`, then **`dexe_auth_login`**
(one call — signs the nonce internally when a signer is set; never write code
that extracts the private key to sign), then POST with the Bearer token. Only
**single-option and multi-option** off-chain voting exist in the DeXe product —
**`offchain_for_against` is NOT creatable** (the app has no for/against creation
path); for a binary vote use `offchain_single_option` with `["For","Against"]`.
Discover every type + params with `dexe_proposal_catalog`.

## Example: transfer treasury tokens

```jsonc
dexe_proposal_create({
  govPool: "0x…",
  chainId: 97,
  proposalType: "token_transfer",
  title: "Pay contributor grant",
  description: "Q3 grant to @alice.",
  params: { token: "0xGovToken", recipient: "0xAlice", amount: "1000.0" }  // human units
})
```

## Example: update the DAO avatar (ONE call — no upload step, no file reading)

```jsonc
dexe_proposal_create({
  govPool: "0x…",
  proposalType: "modify_dao_profile",
  title: "New DAO avatar",
  newAvatarPath: "C:/Users/me/Pictures/logo.png"   // server reads, validates, pins
})
```

The server reads the image from disk, rejects non-raster bytes (SVG never
renders on app.dexe.io), pins it, rebuilds the metadata, and creates the
proposal. Do not call `dexe_ipfs_upload_avatar` first and do not read the
image file into the conversation.

## Failure modes this guards against

1. **Sequence** — the composite runs approve→deposit→create; never do it by hand.
2. **Metadata shape** — auto-built + preflight-validated (`{proposalName,
   proposalDescription, category, isMeta:false, changes:{proposedChanges,
   currentChanges}}`). Wrong shape breaks the frontend indexer/diff.
3. **ABI/selector guessing** — wired builders use canonical signatures; tuple
   field order is easy to get wrong by hand.
4. **votingPower vs tokenBalance** — deposited power is
   `tokenBalance(user,0).balance − ownedBalance`, not `votingPower()` (which is 0
   without a deposit). The composite computes it.
6. **Approve target** — the composite approves the **UserKeeper** (which does
   `transferFrom`), never GovPool.
8. **withdraw_treasury** emits an external `token.transfer`, never
   `GovPool.withdraw` ("Gov: invalid internal data").
10. **Blacklisted recipient** — token transfers to a blacklisted address are
    refused up front (they'd stick the proposal in `SucceededFor` forever).
11. **Quorum-danger gate (`confirmRisky`)** — a `change_voting_settings` /
    `new_proposal_type` build that lowers quorum below the safe floor (into
    treasury-drain territory) is refused **before any transaction** with
    `mode: "blocked-risky"` + `governanceAdvisories`. If the lowering is
    intentional, re-run the SAME call with `confirmRisky: true`. CAUTION-level
    advisories (no-timelock, unreachable validator quorum) attach to the result
    without blocking.

## Cross-DAO delegation (partner DAO votes with delegated power)

A holder can delegate deposited power to another DAO's GovPool, and that DAO
then votes in the first DAO with the delegated (micropool) power:

1. `dexe_vote_build_delegate({ govPool: A, delegatee: <DAO_B govPool>, amount })`
   → broadcast. (First make every proposal you voted on in A **terminal**, or
   this reverts `GovUK: overdelegation` — see [[dexe-vote-execute]].)
2. In DAO B, create a `custom` proposal whose action calls A's vote:
   `actionsOnFor: [{ executor: A, data: <A.multicall([vote(pid, true, 0, [])])> }]`
   (build the inner calldata with `dexe_vote_build_vote({ govPool: A, proposalId, amount: "0" })`).
3. Pass + execute the DAO-B proposal → on execute, B calls `A.vote()` and its
   micropool power is counted (verify with
   `dexe_vote_get_votes(A, pid, voter: B, voteType: "MicropoolVote")`).
   Works when A has `delegatedVotingAllowed=false` (micropool voting).

## No signer? Preview first

Pass `dryRun: true` to get the ordered `TxPayload`s without broadcasting (also
the default behavior when no signer is configured). Then broadcast via
`dexe_tx_send` or a connected wallet.

Next step after it passes: [[dexe-vote-execute]].
