# Governor MCP — OpenZeppelin Governor DAOs

`dexe-mcp` now ships a **Governor** tool group (`dexe_gov_*`) that targets
external OpenZeppelin Governor and Compound-Bravo DAOs (Uniswap, Compound,
Optimism). These tools are independent of the DeXe Protocol — no DeXe contract
needs to be deployed on the target chain.

Source: `research/06-execution-plan.md` (Option 1 — Governor MCP
generalization).

---

## What's in the box

| Group | Tools | What they do |
| --- | --- | --- |
| **Read** | `dexe_gov_list_governors`, `dexe_gov_get_proposal`, `dexe_gov_get_voting_power`, `dexe_gov_get_quorum`, `dexe_gov_get_proposal_threshold` | Resolve configured DAOs, fetch proposal state + tallies, voting power at a snapshot, current quorum, proposal threshold |
| **Build** | `dexe_gov_build_propose`, `dexe_gov_build_vote_cast`, `dexe_gov_build_queue`, `dexe_gov_build_execute`, `dexe_gov_build_delegate` | Family-aware calldata builders for propose / castVote / queue / execute / delegate |
| **Simulate** | `dexe_gov_simulate_proposal`, `dexe_gov_simulate_vote_impact` | Dry-run `execute()` via `eth_call`; project proposal outcome after a hypothetical vote |

---

## Supported DAOs (Tier-1)

| DAO | Chain | Governor | Voting token | Family |
| --- | --- | --- | --- | --- |
| **Uniswap** | 1 (Ethereum) | `0x408ED6354d4973f66138C91495F2f2FCbd8724C3` | UNI (`ERC20VotesComp`) | Bravo v3 |
| **Compound** | 1 (Ethereum) | `0xc0Da02939E1441F497fd74F78cE7Decb17B66529` | COMP (`ERC20VotesComp`) | Bravo v3 |
| **Optimism** | 10 (Optimism) | `0xcDF27F107725988f2261Ce2256bDfCdE8B382B10` | OP (`ERC20Votes`) | OZ v4 |

Each DAO is one JSON file under `src/governor/configs/`. Adding a new DAO is a
config-only change (drop a JSON, import in `loader.ts`).

---

## Family branching (read this once)

The two Governor families have different on-chain signatures. Tools branch
internally based on `governorVersion` in the config — callers do not need to
think about it.

| Surface | OZ v4 / v5 (`oz-v4`, `oz-v5`) | Compound Bravo (`bravo-v3`) |
| --- | --- | --- |
| **propose** | `propose(targets, values, calldatas, description)` | `propose(targets, values, signatures, calldatas, description)` |
| **queue** | `queue(targets, values, calldatas, descriptionHash)` | `queue(proposalId)` |
| **execute** | `execute(targets, values, calldatas, descriptionHash)` | `execute(proposalId)` |
| **quorum** | `quorum(blockNumber)` | `quorumVotes()` (fixed) |
| **snapshot / deadline** | `proposalSnapshot` / `proposalDeadline` | flattened in `proposals(uint256)` |
| **votes interface** | `IVotes.getVotes` / `getPastVotes` | `ERC20VotesComp.getCurrentVotes` / `getPriorVotes` |

Result shapes are normalized — `dexe_gov_get_proposal` always returns
`{state, snapshotBlock, deadlineBlock, votes: {against, for, abstain}}`, plus
`bravoExtra` when applicable.

---

## Quick examples

### Read the most recent Compound proposal

```jsonc
// dexe_gov_get_proposal
{
  "governor": "compound",
  "proposalId": "374"
}

// → {
//   "governor": "compound",
//   "governorVersion": "bravo-v3",
//   "state": { "index": 7, "name": "Executed" },
//   "snapshotBlock": "...",
//   "deadlineBlock": "...",
//   "votes": { "against": "0", "for": "650000...", "abstain": "0" },
//   "bravoExtra": { "proposer": "0x...", "eta": "0", "canceled": false, "executed": true }
// }
```

### Build a vote-cast against a Uniswap proposal (abstain)

```jsonc
// dexe_gov_build_vote_cast
{
  "governor": "uniswap",
  "proposalId": "75",
  "support": 2,
  "reason": "automated parity check — no economic impact"
}

// → {
//   "to": "0x408ED6354d4973f66138C91495F2f2FCbd8724C3",
//   "data": "0x7b3c71d3...",
//   "selector": "0x7b3c71d3",
//   "method": "castVoteWithReason",
//   "family": "bravo"
// }
```

The returned `{to, value, data}` plugs directly into `dexe_tx_send` or any
external signer.

### Project the outcome of a 100k-UNI For vote

```jsonc
// dexe_gov_simulate_vote_impact
{
  "governor": "uniswap",
  "proposalId": "75",
  "support": 1,
  "weight": "100000000000000000000000"
}

// → {
//   "currentTallies": { "against": "...", "for": "...", "abstain": "..." },
//   "projectedTallies": { "against": "...", "for": "...", "abstain": "..." },
//   "projection": { "quorumMet": true, "willPass": true }
// }
```

### Dry-run `execute()` via `eth_call`

```jsonc
// dexe_gov_simulate_proposal — Bravo (Uniswap / Compound)
{ "governor": "compound", "proposalId": "374" }

// dexe_gov_simulate_proposal — OZ (Optimism)
{
  "governor": "optimism",
  "targets": ["0x..."],
  "values": ["0"],
  "calldatas": ["0xdeadbeef"],
  "description": "Test execute"
}
```

This is a single-block dry-run, not a forked-state simulation. Proposals still
in Queued state with an unmet timelock ETA will return the corresponding
timelock revert. For full fork-and-time-warp execution, run against a hardhat
or anvil fork.

---

## Parity vs Tally

`tests/governor/parity.test.ts` pulls the 10 most-recent proposals per Tier-1
DAO from Tally's GraphQL API and asserts that the on-chain `state()` matches
the Tally-reported status (mapped onto the canonical OZ `ProposalState` enum).

```powershell
$env:TALLY_API_KEY  = "..."
$env:DEXE_RPC_URL_MAINNET  = "..."
$env:DEXE_RPC_URL_OPTIMISM = "..."
npx vitest run tests/governor/parity.test.ts
```

Target: 100% match across all 30 sampled proposals.

---

## Out of scope (per `research/06-execution-plan.md` §6)

- Aave dual-track executor
- Arbitrum `ProposalTypesConfigurator` per-type quorum
- Lido Aragon Agent semantics
- ve-token voting (Curve, GMX, Frax)
- MakerDAO Chief
- Snapshot → on-chain bridges
- Cross-chain proposal aggregation
- DeXe Protocol-specific proposal types (33 already covered by `dexe_proposal_*`)
- Web UI / hosted dashboard

Pre-built proposal-type DSL is intentionally absent — the surface stays generic
`(targets, values, calldatas, description)`.
