---
name: dexe-vote-execute
description: |
  Vote on and execute a DeXe proposal with `dexe_proposal_vote_and_execute`.
  Covers deposit-first, the canonical ProposalState ordering, and the
  "tokens locked after execute — withdraw between proposals" trap. Use when the
  user says "vote on proposal N", "execute proposal N", "pass this proposal".
---

# dexe-vote-execute

`dexe_proposal_vote_and_execute` reads proposal state, optionally deposits,
votes, and (when `autoExecute`) executes once the proposal succeeds. With
`DEXE_PRIVATE_KEY` it broadcasts; otherwise it returns ordered `TxPayload`s.

## Recipe

Call **`dexe_context`** first for the signer, active chain, recent proposals,
and your deposited power in the most recent DAO.

```jsonc
dexe_proposal_vote_and_execute({
  govPool: "0x…",
  chainId: 97,
  proposalId: 1,            // 1-indexed
  isVoteFor: true,
  depositFirst: false,      // set true to deposit wallet tokens before voting
  autoExecute: true         // execute automatically once it passes
})
```

- Already past voting (state `SucceededFor` / `SucceededAgainst` / `Locked`) →
  the tool skips the vote and goes straight to execute.
- `voteAmount` defaults to all available deposited power. Pass it to vote with less.

## Canonical ProposalState ordering (failure mode 9)

Never hardcode a different order — `Locked` comes **after** `SucceededFor`:

```
0 Voting  1 WaitingForVotingTransfer  2 ValidatorVoting  3 Defeated
4 SucceededFor  5 SucceededAgainst  6 Locked  7 ExecutedFor  8 ExecutedAgainst  9 Undefined
```

Executable states: **4, 5, 6**.

## Tokens locked after vote/execute (failure mode 5)

After you vote/execute, your deposited tokens stay **locked** until you withdraw
them. If you try to create or vote on the *next* proposal while locked, available
power reads 0 and the action under-counts. Between proposals:

```jsonc
dexe_vote_build_withdraw({ govPool: "0x…", amount: "…" })   // then broadcast
```

Then deposit again for the next proposal (or let `dexe_proposal_create` /
`depositFirst` re-deposit).

## Preview without broadcasting

Pass `dryRun: true` (or run with no signer) to get the ordered `TxPayload`s.

Prerequisite: [[dexe-create-proposal]].
