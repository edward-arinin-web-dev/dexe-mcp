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
  "fastLane": {                         // optional, TESTNET ONLY — see "The fast lane"
    "perPaymentCap": "50", "windowCap": "500",   // whole gov tokens
    "allowlist": ["0x…"], "floatPercent": 1, "voteSeconds": 600,
    "existingLane": "0x…"               // optional: resume with a lane already deployed
  },
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

## The fast lane (TESTNET ONLY)

> `contracts/AgentFastLane.sol` is **unaudited** and ships for **BSC testnet
> (chain 97) only**. `fastLane` refuses every other chain. Do not point a mainnet
> treasury at it.

Without it, every payment — a 5-token API bill included — needs the agents'
vote **and** the human validator round, because a DAO's settings can only differ
per *executor*, never per amount. `fastLane` adds an executor whose whole job
is to be small: the **AgentFastLane**.

### How the protocol picks the settings

`GovPoolCreate._validateProposal` takes the executor of the proposal's **last**
action, looks up `executorToSettings[executor]` (unmapped → DEFAULT), and
`staticcall`s that executor's `validate(actions)` with **30 000 gas**; a revert or
out-of-gas counts as *allowed* (`require(!ok || data.length == 0 || decode(bool))`).
Two more rules matter:

- an earlier action targeting an executor with a *different* settings id forces
  DEFAULT — **unless** its selector is `approve` / `setApprovalForAll` (with no
  value). So `[token.approve(attacker, ∞), lane.pay(…)]` would run on the lane's
  fast settings if the lane let it through;
- on chain 97 **SphereX blocks `changeExecutors` / `addSettings`** ("disallowed
  tx pattern"), so an executor can be bound to a settings slot **only at
  deploy**: `deployGovPool(settingsParams.additionalProposalExecutors[i])` →
  slot `i + 3`. The lane is the third additional executor → **slot 5**.

### What the lane does

| | |
| --- | --- |
| Holds | a **float** of the gov token (`floatPercent` of the supply, default 1 %, taken out of the treasury). It pays from the float only — no allowance on the GovPool, nothing to grief, and a top-up is an ordinary validator-round treasury proposal: one human decision per refill. |
| Pays | `pay(to, amount)`: GovPool only, `to` on the **allowlist**, `0 < amount ≤ perPaymentCap`, and `amount + spent in the rolling 30 days ≤ windowCap`. Re-entrancy locked; the token transfer accepts `true` or no return value. |
| Validates | `validate(actions)` returns **false** (never reverts) for: 0 or > 3 actions (checked first — 1000 actions cost ~600 gas), any action whose executor is not the lane (`approve` included), any value, data that is not exactly `pay(address,uint256)` with 68 bytes, a dirty address word, a non-allowlisted recipient, a zero amount, an amount over the cap, a sum over what the window still allows. Worst case measured cold: **22 980 gas** (3 actions + 3 expired day-buckets to settle), 23 % under the budget. |
| Settings (slot 5) | the default slot's quorum / min-votes / rewards, `duration = voteSeconds` (default 600), `earlyCompletion = true`, **`validatorsVote = false`**. |
| Admin | `lane.admin()` is a child contract at **another address**: `setAllowed`, `setAllowedBatch`, `recall(amount)`, GovPool only. A proposal to it has no settings of its own → DEFAULT → validator round. A proposal to the lane with any selector other than `pay` fails `validate`. |
| Window | 30 daily buckets + a 30-bit occupancy mask in one slot. `pay` settles exactly; `validate` reads at most 3 expired non-empty buckets and is otherwise **conservative** (may refuse what `pay` would accept, never the reverse). Any `pay` re-settles exactly. |

Caveats to read before using it:

- **The float is "votable" to the guards.** The lane never votes, but the
  coherence guards count every non-treasury balance as votable power, so the
  required-turnout figure is slightly optimistic by `floatPercent`. Keep the
  float small.
- **The caps are in the gov token.** The lane pays one ERC20, the DAO's own token.
  Paying an external stablecoin needs a second lane (not provided).
- **`validate` cannot see the float.** A payment larger than the float is
  creatable and fails at execution; `dexe_agent_fast_lane_build_pay` warns.
- **Bundles.** `[lane.pay, token.transfer]` (lane not last) runs under DEFAULT with
  the validator round. `[anything, lane.pay]` is refused by the lane. Up to 3
  `pay` actions in one proposal are fine, within the caps.

### Deploy order

1. `predictGovAddresses(deployer, daoName)` → govPool, govToken (create2, nonce-free).
2. A **dry run** of the full DAO deploy with the lane's predicted CREATE address
   (every guard, no pin, no broadcast).
3. **Deploy the lane** (`new AgentFastLane(govPool, govToken, caps, allowlist)`)
   with the hot key. Its address becomes the float recipient and executor 6.
4. **Deploy the DAO** (`confirm: true` path of `dexe_dao_create`).

The lane goes first because its address is baked into the deploy: if step 4
fails, the lane is reusable — re-run the same call with
`fastLane.existingLane: "<address>"` (the tool checks `govPool()`, `token()`,
the caps and the allowlist). The other order would leave a DAO pointing at an
address nothing can occupy. A lane needs a hot key (`DEXE_SIGNER_MODE=unattended`
on 97): there is no calldata-only path for a contract creation.

### Paying through it

```jsonc
// dexe_agent_fast_lane_build_pay — read-only; runs the lane's validate() first
{ "lane": "0x…", "to": "0x…", "amount": "25", "chainId": 97 }
// → verdict ok | refused | creatable-but-unexecutable, reasons, and:
{ "tool": "dexe_proposal_create",
  "args": { "govPool": "0x…", "chainId": 97, "proposalType": "custom_abi",
            "title": "Fast lane: pay 25.0 to 0x…",
            "params": { "target": "<lane>", "signature": "function pay(address to, uint256 amount)",
                        "method": "pay", "args": ["0x…", "25000000000000000000"], "value": "0" } } }
```

One agent creates (it votes FOR in the same tx); the other k−1 vote with
`dexe_proposal_vote_and_execute`. With early completion the proposal is
`SucceededFor` as soon as k agents have voted and executes at once: **create,
vote, execute** — no validator round. A payment over the cap, to a stranger, or
bundled with anything else is refused at creation (`Gov: validation failed`).

The metadata pin carries `fastLane: {address, token, perPaymentCapWei,
windowCapWei, windowDays, allowlist, voteSeconds, contract, sourceSha256,
testnetOnly: true}`.

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

The tool's tests cover the share math, the preview, the refusals, the exact
deploy calldata, the pinned metadata and the lane's EVM behaviour, all offline;
nothing in the test suite runs against a live chain. The fast lane was proven
once on BSC testnet 97 (2026-11-05), below.

### Proof on BSC testnet 97 (2026-11-05)

DAO "Fast Lane Proof 0511": GovPool `0x0Bd01A0AeF1b321639995C14eB5610F0D4bCD4d8`,
gov token `0x8F5E9C71A739E735F8DfeC82CE25Bcf788bd31fd`, lane
`0x5E6f818313ef93675Eb385eAA80306cfE90BA401` (admin
`0xa3db4c33943b81D3E095f25977E49073D8b72f30`), 3 agents 2-of-3, 1 human
validator, caps 50 / 60 FLP, float 1 %, lane slot 5 (`validatorsVote=false`,
240 s). Lane deploy tx `0x67d0417b…d58d09`, DAO deploy tx `0xeee08768…31b26`.

| Run | Result |
| --- | --- |
| A1 — 25 FLP to the allowlisted vendor (proposal 1) | `ExecutedFor` in 28 s, validator round never opened (`validatorProposal.voteEnd = 0`). Create: approve + deposit + `createProposalAndVote` (first use of agent 1). After creation: 3 txs — agent 2's approve, `multicall([deposit, vote])`, `execute`. |
| A1b — 10 FLP (proposal 2), agents already deposited | `ExecutedFor` in 17 s. Create: 1 tx. After creation: **2 txs** — `vote`, `execute`. |
| Control — 1000 FLP treasury `transfer` (proposal 3) | DEFAULT slot: `ValidatorVoting` after 2 agents, `ExecutedFor` only after the human validator voted. |

Every bypass below returned `validate() = false`, reverted `Gov: validation
failed` at simulation, and failed on-chain (status 0) when broadcast with a
manual gas limit; `latestProposalId` did not move:

| Bypass | Reverted tx |
| --- | --- |
| amount over the per-payment cap (51) | `0x0c141d19…dd76fd` |
| recipient not allowlisted | `0x9c27dd67…91bd40` |
| `[token.transfer(attacker, 200 000), lane.pay]` | `0xc9633fc1…89026a` |
| `[token.approve(attacker, ∞), lane.pay]` (the approve exemption) | `0xb9f39129…c06415` |
| 4 actions | `0xa9c6728e…9c22a2` |
| 50 with 25 left in the 30-day window | `0x4967c303…e4356` |
| `pay` with `value = 1 wei` | `0x26b897d7…7935ad` |
| a lane selector other than `pay` | `0xe11b3b64…8e64ab` |
