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

Call **`dexe_context`** first — it returns the signer, active chain, and the
DAOs/proposals from prior sessions (so you already have the `govPool` to target).

**Do not hand-sequence** approve/deposit/create, and do not hand-build the IPFS
metadata — the composite does both correctly. **Do not guess ABIs/selectors**;
the wired builders encode canonical calldata. Only reach for `dexe_get_methods`
when composing a truly custom call.

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
| `modify_dao_profile` | top-level `newDaoName/newDaoDescription/newAvatarCID/newWebsiteUrl/newSocialLinks` |
| `custom` | top-level `actionsOnFor:[{executor,value,data}]` (+ optional `category`) |

Any other catalog type → the tool errors and names the dedicated
`dexe_proposal_build_*` tool. Discover all 33 types with `dexe_proposal_catalog`.

## Example: transfer treasury tokens

```jsonc
dexe_proposal_create({
  govPool: "0x…",
  chainId: 97,
  proposalType: "token_transfer",
  title: "Pay contributor grant",
  description: "Q3 grant to @alice.",
  params: { token: "0xGovToken", recipient: "0xAlice", amount: "1000000000000000000" }
})
```

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

## No signer? Preview first

Pass `dryRun: true` to get the ordered `TxPayload`s without broadcasting (also
the default behavior when no signer is configured). Then broadcast via
`dexe_tx_send` or a connected wallet.

Next step after it passes: [[dexe-vote-execute]].
