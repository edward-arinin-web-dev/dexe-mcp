# Swarm scenario schema

Each `S*.json` follows the same shape. The orchestrator validates the `steps[]` half of it
on load (`validateStepExpectations` in `scripts/swarm/expect.ts`): an unknown step key, an
unknown `expect` op, a missing `value`, or an `expect` path rooted at something no step
captures aborts the whole run with the scenario and step named. An unvalidated field is a
field that rots — `successCriteria` was read by nothing for 62 scenarios.

```jsonc
{
  "id": "S01-delegation-chain-3hop",
  "title": "Three-wallet delegation chain + voter ratifies",
  "priority": 1,
  "dao": "{{firstAllowlistedDao}}",
  "dependsOn": [],
  "requiresBrowser": false,
  "agents": [
    { "alias": "A", "role": "Delegator", "wallet": "AGENT_PK_3" },
    { "alias": "B", "role": "Delegator", "wallet": "AGENT_PK_4" },
    { "alias": "C", "role": "Voter",     "wallet": "AGENT_PK_5" }
  ],
  "steps": [
    {
      "step": 1,
      "agent": "A",
      "tool": "dexe_vote_build_deposit",
      "args": { "govPool": "{{dao}}", "amount": "12000000000000000000000" },
      "broadcast": true,
      "captureAs": "depositA",
      "expect": [
        { "path": "depositA.txHash", "op": "present" }
      ]
    }
  ],
  "successCriteria": [
    { "id": "edges-present", "check": "delegation_map(A) outgoing includes B with 10000 token" }
  ]
}
```

Field rules:
- `id` — `S<NN>-<kebab>` matching the filename.
- `priority` — 1=multi-agent, 2=untested-types, 3=participation, 4=subgraph.
- `dao` — literal address (must be in `SWARM_DAOS_<chain>` allowlist) OR the
  template `"{{firstAllowlistedDao}}"` to auto-pick the first entry of the
  active chain's allowlist. The auto-pick form keeps the same scenario file
  reusable across testnet (97) and mainnet (56).
- `requiresChain` — optional array of chain ids the scenario can run on.
  Default = `[56, 97]`. Subgraph + DeXe-backend scenarios MUST set this to
  `[56]` because the indexer + API don't exist on testnet. A scenario that
  hardcodes `chainId` in its args must pin `requiresChain` to that one chain —
  otherwise a mainnet sweep selects it and builds a testnet payload.
- `dependsOn` — list of scenario `id`s that must complete (within the same run) before this one starts. Used for S22-S25 → S01 dependency.
- `requiresBrowser` — true if any step calls `mcp__chrome-devtools__*`. The orchestrator runs all `requiresBrowser:true` scenarios serially, after the chain-only batch, to avoid the single-browser deadlock.
- `agents[].alias` — short symbol used in `step.agent` and template variables.
  Single letter: the `{{agent:X:address}}` template matches one character only.
- `agents[].wallet` — env-var name (`AGENT_PK_<n>`); resolved to a wallet at runtime. Two scenarios in the same concurrent batch must not share a wallet — orchestrator enforces this with a mutex.
- `steps[].tool` — exact MCP tool name. The role prompts under `tests/swarm/prompts/`
  carry per-role tool allowlists, but those bind an LLM-driven agent that self-reports
  `forbidden`; the direct-dispatch orchestrator does **not** enforce them.
- `steps[].args` — templates (below) are resolved before dispatch.
- `steps[].broadcast` — `true` signs the returned single payload with the step's agent
  wallet, locally, in the orchestrator. It does NOT call `dexe_tx_send`. It also does not
  govern the composites: a `mode: "payloads"` result is always broadcast payload-by-payload
  regardless of this flag. `false` (or the global `--dry-run`) returns calldata only.
- `steps[].serverSign` — `true` makes the **MCP** sign the step as the keyring slot that
  owns this step's agent wallet (`AGENT_PK_3` → `signerKey: "agent3"`). This is the only
  way a scenario reaches the server's broadcast guards, nonce queue and agent ledger.
  Mutually exclusive with `broadcast:true`; refused on tools the orchestrator dispatches
  inline (MCP schemas strip unknown keys, so `signerKey` would vanish silently).
- `steps[].captureAs` — name under which the tool's return value is stored for later steps.
- `steps[].skipIf` — `<capturePath> ==|!= <literal>`; skips the step without failing it.
- `steps[].comment` — free text for the next reader. Not evaluated.
- `successCriteria[].check` — prose intent for a human reader. Machine-checked assertions
  live in `steps[].expect` / `steps[].expectError`. (There is no Reporter agent; the prompt
  at `tests/swarm/prompts/reporter.md` is not wired to anything.)

## Template vars

Resolved by the orchestrator before each step, in both whole-value and inline position:

| Template | Resolves to |
|---|---|
| `{{dao}}` | this scenario's DAO (after allowlist substitution) |
| `{{firstAllowlistedDao}}` / `{{secondAllowlistedDao}}` | `SWARM_DAOS_<tag>[0]` / `[1]` |
| `{{firstAllowlistedToken}}` | the token index-parallel to THIS scenario's DAO |
| `{{agent:<alias>:address}}` | a declared agent's address; alias is ONE letter |
| `{{dao.settings}}` `{{dao.userKeeper}}` `{{dao.validators}}` `{{dao.poolRegistry}}` `{{dao.votePower}}` | `GovPool.getHelperContracts()` |
| `{{dao.nftMultiplier}}` `{{dao.expertNft}}` `{{dao.dexeExpertNft}}` `{{dao.babt}}` | `GovPool.getNftContracts()` |
| `{{dao.tokenSale}}` `{{dao.distributionProposal}}` | `SWARM_TOKENSALE_<tag>` / `SWARM_DISTRIBUTION_<tag>`, index-parallel to the DAO list (no on-chain getter exists for either) |
| `{{now}}` `{{now+<seconds>}}` `{{now-<seconds>}}` | current unix time ± seconds, as a decimal STRING |
| `{{<captureAs>.<path>}}` | an earlier step's captured result; `.0` indexes arrays, `.length` works on arrays |

Rules:

- **No address literals for per-DAO contracts.** `govPool`, `tokenSaleProposal`,
  `distributionProposal`, `expertNftContract`, `nftMultiplierContract`,
  `newMultiplierAddress` and the helper addresses must be templates.
  `tests/swarm/scenario-hygiene.test.ts` fails the build otherwise, and separately refuses
  any address belonging to the dead 2026-04/05 fixtures. A hardcoded helper survives a
  DAO-allowlist swap and silently keeps targeting a de-registered pool.
- **No absolute timestamps.** Any arg whose key ends in `Time`, or is `deadline` /
  `startedAt`, must use a `{{now±N}}` template. A fixed epoch rots into the past, and the
  OTC builders then refuse the whole scenario. A malformed now-template (`{{now+abc}}`)
  fails the step loudly instead of resolving to `""` — `BigInt("")` is `0n`, which would
  surface as a nonsense "window is in the PAST" much further downstream.
- An unknown `{{dao.<key>}}` throws rather than resolving to `""`.

## `expect` / `expectError`

Optional per step. Evaluated **after** the tool result is captured, against a root of
`{ ...captures, result, self }` — so a step with no `captureAs` can still assert on its own
output via `result.*`. NOT evaluated on the cascade-skip, `skipIf` or `--dry-run` paths
(there is no result to assert on); under `--dry-run` the step log records how many
expectations went unevaluated.

```jsonc
"expect": [
  { "path": "created.proposalId", "op": "gte", "value": "1" },
  { "path": "state.state", "op": "in", "value": ["Voting", "SucceededFor", "ExecutedFor"] },
  { "path": "built.actions.0.executor", "op": "eq", "value": "{{firstAllowlistedToken}}" }
]
```

- Ops: `eq` `ne` `in` `notIn` `contains` `matches` `present` `absent` `gte` `lte`.
  `present`/`absent` take no `value`; every other op requires one.
- Expected values go through the same template expansion as `args`, so
  `{{firstAllowlistedToken}}` / `{{agent:B:address}}` / an earlier capture can be the
  expected value — chain-agnostic scenarios could not assert on any address otherwise.
- Comparison is normalized: two 20-byte addresses compare case-insensitively (builder
  output is checksummed, the allowlist env is arbitrary case); everything else compares as
  `String(a) === String(b)`, so JSON `7` matches a captured `"7"`.
- `gte`/`lte` compare as **BigInt** when both sides are integral strings. Wei amounts
  exceed 2^53 and a Number comparison would silently say two different amounts are equal.
- An unresolved path fails EVERY op except `absent` — including `ne` and `notIn`, which
  would otherwise pass trivially on a typo and assert nothing.
- `expectError` is a substring the step's error MUST contain: a matching error is a PASS, an
  unexpectedly successful call is a FAIL, and dependants cascade-skip rather than receiving
  `""` for every `{{capture.field}}`.

**Assert on returned fields, not on throws.** The 0.30–0.33 guards do not raise: the vote
leg spreads `voteAlreadyCast` onto a successful result, the duplicate guard returns
`mode: "already-created"`, the DANGER gate returns `mode: "blocked-risky"`. So
`{"path": "voted.voteAlreadyCast", "op": "present"}` fails exactly when the dedupe
regresses. Reserve `expectError` for genuine reverts and input-validation refusals.
