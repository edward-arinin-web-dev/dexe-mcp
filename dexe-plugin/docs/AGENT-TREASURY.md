# Agent treasury — `dexe_agent_treasury_create`

A preset over `dexe_dao_create`. One call deploys a DAO whose treasury is run by
**n AI agents, k-of-n**, with **human validators seated at deploy as the veto**.

- **Profile:** `agents`. Set `DEXE_TOOLSETS=core,agents`. It is not in the default
  `core` profile, because that profile is already at its `tools/list` byte budget.
- **Posture:** the same as `dexe_dao_create`. The first call returns a preview.
  `confirm: true` broadcasts when a signer is configured. `dryRun: true` writes
  nothing, IPFS included. `signerKey` chooses a keyring persona. Every
  `dexe_dao_create` guard runs unchanged: the quorum rules, the eth_call preflight
  and the name-collision check.
- **Validate on BSC testnet (chain 97) first.** The deploy is permanent.

## What it builds

| Piece | What the preset sets |
| --- | --- |
| Gov token | `totalSupply` (default 1,000,000) minted at deploy. Each agent gets the **same share** (see below), and the remainder stays in the DAO treasury. |
| Member voting | LINEAR vote power. `quorumPercent` is the member quorum (default 50, never below the server's `DEXE_MIN_SAFE_QUORUM_PCT`). `agentVoteSeconds` sets the voting duration (default 3600). `executionDelaySeconds` defaults to 0. |
| Validator round | Every `humanValidators` address (1..5) is seated in `validatorsParams` with **1 validator token** (`<DAO name>-VT` / `<SYMBOL>-VT`). `durationValidators` = `validatorVoteSeconds` (default 86400) on every settings slot. `quorumValidators` = `validatorQuorumPercent` (default 50). The validators' own internal proposals use the same duration and quorum. |
| Metadata | The pinned DAO metadata JSON carries `preset`, `presetVersion` and `agents` (shape below). |

Every member proposal that reaches quorum then goes to the validator round. If the
validators vote it down, or do not vote, it does not execute.

## Share math

All of it is in `computeAgentShares` (`src/lib/agentTreasury.ts`): pure and
unit-tested. The member quorum is a fraction of the **whole supply**,
`GovPool.getProposalRequiredQuorum = totalPower × quorum`, and the treasury counts
toward that supply. So k-of-n is a statement about the per-agent share `s`.
Everything is computed in basis points:

```
k · s  ≥ q + 0.5 %     k agents voting FOR reach quorum on their own (50 bps margin)
(k−1) · s < q          k−1 agents voting FOR do not
n · s  ≤ 100 %         the shares fit in the supply
q ≤ n · s × 0.8        the turnout-margin rule every dexe_dao_create config passes
```

`s` starts at the lowest value that satisfies the first rule. If that value fails
the turnout rule, `s` is raised one bps at a time until the rule passes, but never
past the second rule's bound. When no `s` satisfies all four rules, the tool
refuses and says which rule could not be met. The default k is a strict majority,
`floor(n/2)+1`.

| Agents | k | Quorum | Share per agent | Treasury | Note |
| ---: | ---: | ---: | ---: | ---: | --- |
| 2 | 2 | 50 % | 31.25 % | 37.5 % | share raised for the turnout rule |
| 3 | 2 | 50 % | 25.5 % | 23.5 % | |
| 4 | 3 | 50 % | 17.17 % | 31.32 % | |
| 5 | 3 | 50 % | 17.17 % | 14.15 % | |
| 9 | 5 | 50 % | 10.5 % | 5.5 % | |
| 9 | 9 | 50 % | — | — | refused: the turnout rule needs ≥ 6.95 % each, while 8 agents must stay below 6.25 % each |
| 3 | 2 | 90 % | — | — | refused: 3 × 45.5 % exceeds 100 % |

## The quorum-formula caveat

The two GovPool versions in the field count quorum differently:

- **Protocol master** counts each side alone: `votesFor ≥ quorum` **or**
  `votesAgainst ≥ quorum`. The k / k−1 lines above hold exactly.
- **The GovPool deployed on BSC testnet 97** still counts turnout:
  `(for + against) / total ≥ quorum`. There, an AGAINST vote also counts toward
  quorum, and the majority then decides. So k−1 agents voting FOR, plus any
  AGAINST vote that brings turnout up to k agents' worth, reaches quorum. The
  proposal then passes if FOR outweighs AGAINST.

The human validator round applies under either formula. The preview spells this
out in `agentTreasury.guarantees`.

## Input

```jsonc
{
  "daoName": "Agent Fund",              // required
  "symbol": "AGF",                      // required
  "totalSupply": "1000000",             // whole tokens, default "1000000"
  "daoDescription": "…",                // optional
  "agents": [                           // 2..9, distinct, non-zero
    { "address": "0x…", "role": "researcher", "scope": "optional free text" }
  ],
  "approvalsNeeded": 2,                 // k, 2..n, default floor(n/2)+1
  "humanValidators": [{ "address": "0x…" }],  // 1..5, distinct, non-zero
  "quorumPercent": 50,                  // ≥ DEXE_MIN_SAFE_QUORUM_PCT
  "validatorQuorumPercent": 50,
  "agentVoteSeconds": 3600,
  "validatorVoteSeconds": 86400,
  "executionDelaySeconds": 0,
  "monthlyBudget": "1000",              // optional, whole gov tokens
  "chainId": 97, "deployer": "0x…",
  "confirm": false, "dryRun": false, "confirmRisky": false,
  "signerKey": "agent1", "flowContext": { }
}
```

## Pinned metadata

`dexe_dao_create`'s DAO metadata JSON, plus:

```json
{
  "preset": "agent-treasury",
  "presetVersion": 1,
  "agents": [{ "address": "0x…", "role": "researcher" }]
}
```

`scope` is shown in the preview but is not pinned.

## Output

The preview, and the deploy result, carry `agentTreasury` with these fields:

- `kOfN`
- `agents[]` (address, role, scope, `sharePercent`, `tokens`)
- `treasury`
- `quorum` (`kForPercent`, `kMinusOneForPercent`, `requiredTurnoutPercent`)
- `validators` (`seated`, `tokenEach`, `validatorQuorumPercent`, `validatorsNeededApprox`)
- `durations`
- `guarantees`
- `presetWarnings`, for example when a wallet is both an agent and a validator, or
  when the budget exceeds the treasury

`validatorsNeededApprox` is an estimate, `ceil(m × validatorQuorumPercent / 100)`,
not a protocol read.

## The monthly budget

When `monthlyBudget` is set, the tool returns a `dexe_proposal_create` recipe:

```json
{
  "tool": "dexe_proposal_create",
  "args": {
    "govPool": "<predicted govPool>",
    "chainId": 97,
    "proposalType": "validators_allocation",
    "title": "…",
    "params": { "credits": [{ "token": "<predicted gov token>", "amount": "<wei>" }] }
  }
}
```

`validators_allocation` encodes `GovPool.setCreditInfo`. It funds the credit line
that the validators' internal `monthly_withdraw` proposals draw against. In the
**preview**, `govPool` and `token` are placeholders, because the addresses are
predicted only when the deploy is built. The deploy result fills in the real
values and repeats the recipe as `next`.

## Run sequence

1. **Preview.** Call `dexe_agent_treasury_create` without `confirm`. Check the
   agents table, k-of-n, the validators and the guarantees.
2. **Deploy.** Re-call with the same arguments plus `confirm: true`.
3. **Agents deposit.** Each agent deposits its tokens into the DAO before it votes.
   Undeposited tokens carry no vote. `dexe_proposal_vote_and_execute` deposits
   automatically when power is short.
4. **Monthly budget.** Run the `budgetRecipe` with `dexe_proposal_create`. It is a
   member proposal like any other: k agents vote FOR, then the validator round
   runs.
5. **Spend.** Spend proposals follow the same path: member vote, validator round,
   execute. Use `dexe_proposal_vote_and_execute` per agent.
6. **Withdraw between proposals** if agents need their tokens back. Deposited
   tokens stay locked while a proposal they voted on is still live.

Nothing here has been run against a live chain by this tool's tests. The tests
cover the share math, the preview, the refusals, the exact deploy calldata and the
pinned metadata, all offline. A testnet run is the next step.
