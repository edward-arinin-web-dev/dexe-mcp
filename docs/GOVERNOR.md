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
| **Extras** | `dexe_gov_get_state`, `dexe_gov_has_voted`, `dexe_gov_build_cancel`, `dexe_gov_decode_calldata`, `dexe_gov_hash_description`, `dexe_gov_hash_proposal` | Single-call state lookup; per-account vote check (OZ `hasVoted` / Bravo `getReceipt().hasVoted`, reports `method`); family-aware cancel encoder; decode any Governor write calldata; keccak256 description hash; OZ-only `hashProposal` proposalId preview (errors on Bravo) |

**18 tools total** — 5 read · 5 build · 2 simulate · 6 extras.

---

## Runtime RPC setup (chains 1 & 10)

The Tier-1 DAOs live on **Ethereum (chain 1)** and **Optimism (chain 10)**, not
on BSC. DeXe's own `DEXE_RPC_URL_MAINNET` / `_TESTNET` are BSC chains 56 / 97 and
do **not** cover them.

**Reads work with no configuration.** When a governor chain has no RPC of its
own, the `dexe_gov_*` tools fall back to a shared public endpoint for that chain
and add an `rpc` note to the result saying so. The fallback goes through the same
provider factory as a configured chain — bounded timeout, retry, URL rotation,
error redaction.

Set your own endpoint for anything beyond a quick look. Any
`DEXE_RPC_URL_<chainId>` is registered automatically:

```
DEXE_RPC_URL_1=https://eth.drpc.org            # Uniswap, Compound
DEXE_RPC_URL_10=https://optimism.drpc.org      # Optimism
```

Use an **archive** endpoint. Governor reads are historical by construction —
`dexe_gov_get_voting_power` at a snapshot block, `dexe_gov_get_quorum` at a
snapshot block, and `dexe_gov_simulate_vote_impact`, which always reads quorum at
the proposal's snapshot. The free public endpoints answer latest-block reads and
refuse historical ones (`403 -32602 "Archive requests require a personal
token"`); the tools map that refusal to this advice rather than relaying the
vendor string.

`DEXE_DISABLE_PUBLIC_RPC=1` turns the fallback off — the tools then return a
hard error naming `DEXE_RPC_URL_<chainId>` instead of dialing a shared endpoint.
Use it on egress-restricted or air-gapped machines.

These coexist with the BSC vars (`DEXE_RPC_URL_TESTNET` / `_MAINNET`) and with
the legacy single-chain `DEXE_RPC_URL` + `DEXE_CHAIN_ID`. Each Governor tool
resolves the RPC from the `chainId` in its config, so no per-call chain argument
is needed. **Build/encode tools (`dexe_gov_build_*`, `dexe_gov_decode_calldata`,
`dexe_gov_hash_description`) need no RPC at all** — they are pure calldata.

---

## Supported DAOs (Tier-1)

| DAO | Chain | Governor | Voting token | Family | Executor (timelock) |
| --- | --- | --- | --- | --- | --- |
| **Uniswap** | 1 (Ethereum) | `0x408ED6354d4973f66138C91495F2f2FCbd8724C3` | UNI (`ERC20VotesComp`) | Bravo v3 | `0x1a9C8182C09F50C8318d769245beA52c32BE35BC` (2d) |
| **Compound** | 1 (Ethereum) | `0x309a862bbC1A00e45506cB8A802D1ff10004c8C0` | COMP (`ERC20VotesComp`) | OZ v5 | `0x6d903f6003cca6255D85CcA4D3B5E5146dC33925` (2d) |
| **Optimism** | 10 (Optimism) | `0xcDF27F107725988f2261Ce2256bDfCdE8B382B10` | OP (`ERC20Votes`) | OZ v4 | `0x0eDd4B2cCCf41453D8B5443FBB96cc577d1d06bF` (3d) |

Each DAO is one JSON file under `src/governor/configs/`. Adding a new DAO is a
config-only change (drop a JSON, import in `loader.ts`).

`votingDelay` / `votingPeriod` in the configs are **block counts** for all three
DAOs (none of them exposes an ERC-6372 `clock()` in seconds), and every value —
addresses, params, timelocks — is re-read from chain before a release. See
[Keeping fixtures honest](#keeping-fixtures-honest).

The configs are a **static snapshot**: a DAO can change its own parameters by
proposal. For a live number call `dexe_gov_get_proposal_threshold` or
`dexe_gov_get_quorum`; both echo the configured value under `configured`, and the
threshold tool also returns `configuredMatchesChain`.

### Compound governance migration (2025)

Compound moved from **GovernorBravo `0xc0Da02939E1441F497fd74F78cE7Decb17B66529`**
to **CompoundGovernor `0x309a862bbC1A00e45506cB8A802D1ff10004c8C0`** (an OZ v5
governor with `GovernorCountingFractional`), and moved the Timelock admin with
it. The retired contract can no longer execute anything.

What this means in practice:

- **Proposal ids `<= 393`** live on the retired Bravo contract and are **not
  readable** on the current governor — it answers them with an unnamed custom
  error. Query the legacy address directly. `dexe_gov_get_proposal`,
  `dexe_gov_get_state` and `dexe_gov_has_voted` append a hint naming it when a
  lookup for such an id fails.
- **Proposal ids `>= 394`** are on the current governor. dexe-mcp's `compound`
  fixture targets that one.
- `queue` / `execute` / `cancel` now take the **OZ 4-arg** form
  `(targets, values, calldatas, descriptionHash)`, not a `proposalId`. The
  implementation also retains the Bravo-shaped 1-arg overloads, but dexe-mcp
  deliberately does not encode them — two same-named fragments in one ABI would
  make every OZ `execute` encode ambiguous.
- Quorum counts **For votes only** (`COUNTING_MODE` = `quorum=for`), which is not
  the OZ-stock fractional default. The fixture says so explicitly via
  `quorumCounting`.
- `dexe_gov_hash_proposal` now works for `compound` (it is OZ-only and used to
  refuse), and `dexe_gov_has_voted` reads `hasVoted()` instead of
  `getReceipt().hasVoted`.

---

## Family branching (read this once)

The two Governor families have different on-chain signatures. Tools branch
internally based on `governorVersion` in the config — callers do not need to
think about it.

| Surface | OZ v4 / v5 — Compound, Optimism | Compound Bravo (`bravo-v3`) — Uniswap |
| --- | --- | --- |
| **propose** | `propose(targets, values, calldatas, description)` | `propose(targets, values, signatures, calldatas, description)` |
| **queue** | `queue(targets, values, calldatas, descriptionHash)` | `queue(proposalId)` |
| **execute** | `execute(targets, values, calldatas, descriptionHash)` | `execute(proposalId)` |
| **quorum** | `quorum(blockNumber)` | `quorumVotes()` (fixed) |
| **snapshot / deadline** | `proposalSnapshot` / `proposalDeadline` | flattened in `proposals(uint256)` |
| **has voted** | `hasVoted(proposalId, account)` | `getReceipt(proposalId, voter).hasVoted` |
| **votes interface** | `IVotes.getVotes` / `getPastVotes` | `ERC20VotesComp.getCurrentVotes` / `getPriorVotes` |

The voting-token interface is a **separate axis** from the governor family:
Compound is an OZ v5 governor whose token (COMP) still exposes the Compound-style
`getPriorVotes`. The config carries both independently.

So is **quorum counting**. The rule comes from the governor's own
`COUNTING_MODE()` (`quorumCounting` in the config), never from the ABI family:

| DAO | `COUNTING_MODE()` quorum clause | Counts toward quorum |
| --- | --- | --- |
| Uniswap | (Bravo — no `COUNTING_MODE`) | For |
| Compound | `quorum=for` | For |
| Optimism | `quorum=against,for,abstain` | For + Against + Abstain |

`dexe_gov_simulate_vote_impact` reports which rule it applied under
`quorum.counting`.

Result shapes are normalized — `dexe_gov_get_proposal` always returns
`{state, snapshotBlock, deadlineBlock, votes: {against, for, abstain}}`, plus
`bravoExtra` when applicable.

---

## Quick examples

### Read a recent Compound proposal (OZ v5)

```jsonc
// dexe_gov_get_proposal
{
  "governor": "compound",
  "proposalId": "605"
}

// → {
//   "governor": "compound",
//   "governorAddress": "0x309a862bbC1A00e45506cB8A802D1ff10004c8C0",
//   "chainId": 1,
//   "governorVersion": "oz-v5",
//   "proposalId": "605",
//   "state": { "index": 7, "name": "Executed" },
//   "snapshotBlock": "25918595",
//   "deadlineBlock": "25938594",
//   "votes": { "against": "0", "for": "687014600890789742662900", "abstain": "0" }
//   // no `bravoExtra` — that field is Bravo-only
// }
```

Ids `<= 393` are on the retired Bravo contract and will fail here; see
[Compound governance migration](#compound-governance-migration-2025).

### Read a Bravo proposal (Uniswap), with `bravoExtra`

```jsonc
// dexe_gov_get_proposal
{
  "governor": "uniswap",
  "proposalId": "100"
}

// → {
//   "governorVersion": "bravo-v3",
//   "state": { "index": 7, "name": "Executed" },
//   "votes": { "against": "...", "for": "...", "abstain": "..." },
//   "bravoExtra": { "proposer": "0x...", "eta": "...", "canceled": false, "executed": true }
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
//   "quorum": { "required": "40000000000000000000000000", "method": "quorumVotes()", "counting": "for" },
//   "currentTallies": { "against": "...", "for": "...", "abstain": "..." },
//   "projectedTallies": { "against": "...", "for": "...", "abstain": "..." },
//   "projection": { "quorumMet": true, "willPass": true }
// }
```

`quorum.counting` names the rule that was applied. On Optimism the response also
carries a `caveats` array: `willPass` models quorum + (`for > against`) only, and
OP layers a per-proposal-type `approvalThreshold` (5100 bps default, 7600 bps
supermajority) plus voting modules on top of that, none of which is modelled
here.

### Dry-run `execute()` via `eth_call`

```jsonc
// dexe_gov_simulate_proposal — Bravo (Uniswap): proposalId is enough
{ "governor": "uniswap", "proposalId": "100" }

// dexe_gov_simulate_proposal — OZ (Compound, Optimism): the full tuple
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
$env:TALLY_API_KEY   = "..."
$env:DEXE_RPC_URL_1  = "https://eth.drpc.org"
$env:DEXE_RPC_URL_10 = "https://optimism.drpc.org"
npx vitest run tests/governor/parity.test.ts
```

Target: 100% match across all 30 sampled proposals.

Use `DEXE_RPC_URL_<chainId>`, not `DEXE_RPC_URL_MAINNET` — in this project that
name means **BSC chain 56**, so it would point an Ethereum governor read at a BSC
node. (`DEXE_RPC_URL_OPTIMISM` was never a recognized variable at all.)

---

## Keeping fixtures honest

A Governor fixture is a static snapshot of mutable on-chain state, and governors
are upgradeable — Compound replaced its governor outright, Optimism upgraded its
proxy implementation. Offline shape tests cannot see that, so
`tests/governor/fixtures-live.test.ts` re-reads every fixture off-chain:

- the governor address holds a live contract and answers `name()`
- `governorVersion` matches the deployed ABI family (Bravo exposes
  `quorumVotes()` and no `proposalSnapshot`; OZ the reverse) — this is what
  catches a fixture pointed at the wrong contract, and it needs no proposal id
- `timelock()` equals the configured timelock, which itself holds code
- `votingDelay` / `votingPeriod` / `proposalThreshold` equal the live getters
- the voting token's `symbol`, `decimals` and votes interface match
  `votingToken.type` (`getPriorVotes` vs `getPastVotes`)
- quorum resolves non-zero through the configured `quorumSource`

It is **skipped by default** — a fresh clone, an offline machine and default CI
make zero network calls. Run it locally with archive endpoints:

```powershell
$env:DEXE_RPC_URL_1  = "https://eth.drpc.org"
$env:DEXE_RPC_URL_10 = "https://optimism.drpc.org"
npx vitest run tests/governor/fixtures-live.test.ts
```

**Run it before any release that touches `src/governor/configs/`.** The offline
pins in `tests/governor/config-loader.test.ts` and
`tests/governor/tier1-fixtures.test.ts` back it up: they fail with no network if
a fixture value is edited without re-verification, and they assert every shipped
address is in canonical EIP-55 form (the loader itself stays lenient, so a user's
lowercase config still loads).

---

## Out of scope (per `research/06-execution-plan.md` §6)

- Aave dual-track executor
- Per-proposal-type quorum / approval thresholds from a
  `ProposalTypesConfigurator` (Arbitrum, and Optimism's own — the OP fixture
  approximates quorum as `votableSupply * 30/100` and `dexe_gov_simulate_vote_impact`
  returns a `caveats` entry saying so)
- Lido Aragon Agent semantics
- ve-token voting (Curve, GMX, Frax)
- MakerDAO Chief
- Snapshot → on-chain bridges
- Cross-chain proposal aggregation
- DeXe Protocol-specific proposal types (33 already covered by `dexe_proposal_*`)
- Web UI / hosted dashboard

Pre-built proposal-type DSL is intentionally absent — the surface stays generic
`(targets, values, calldatas, description)`.
