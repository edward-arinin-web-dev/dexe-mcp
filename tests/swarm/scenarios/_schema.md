# Swarm scenario schema

Each `S*.json` follows the same shape. The orchestrator validates this on load.

```jsonc
{
  "id": "S01-delegation-chain-3hop",
  "title": "Three-wallet delegation chain + voter ratifies",
  "priority": 1,
  "dao": "0x3E224749a18dBF46FdAE027ba152B1d1D5B4568F",
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
      "captureAs": "depositA"
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
  `[56]` because the indexer + API don't exist on testnet.
- `dependsOn` — list of scenario `id`s that must complete (within the same run) before this one starts. Used for S22-S25 → S01 dependency.
- `requiresBrowser` — true if any step calls `mcp__chrome-devtools__*`. The orchestrator runs all `requiresBrowser:true` scenarios serially, after the chain-only batch, to avoid the single-browser deadlock.
- Template vars resolved by the orchestrator before each step: `{{dao}}`,
  `{{firstAllowlistedDao}}`, `{{firstAllowlistedToken}}`,
  `{{agent:<alias>:address}}`, `{{<captureAs>.<field>}}`.
- `agents[].alias` — short symbol used in `step.agent` and template variables.
- `agents[].wallet` — env-var name (`AGENT_PK_<n>`); resolved to a wallet at runtime. Two scenarios in the same concurrent batch must not share a wallet — orchestrator enforces this with a mutex.
- `steps[].tool` — exact MCP tool name. The Proposer / Voter / Validator / Delegator / Expert role prompts each carry their own allowlist; the orchestrator rejects a step whose tool is not in the assigned role's allowlist.
- `steps[].args` — Mustache templates resolve `{{dao}}`, `{{<captureAs>.<field>}}`, `{{agent:<alias>:address}}`.
- `steps[].broadcast` — `true` calls `dexe_tx_send` with the wallet PK. `false` (or `--dry-run` global) returns calldata only.
- `steps[].captureAs` — name under which the tool's return value is stored for later steps.
- `successCriteria[].check` — human-readable assertion. The Reporter agent evaluates these by re-querying chain state at run end.
