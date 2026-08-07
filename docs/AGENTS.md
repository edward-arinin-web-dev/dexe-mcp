# Agent teams — multi-persona DAO runs

Run several wallets as *personas* against one DAO: a proposer creates, voters
take opposite sides, a delegator hands its power to a hub, a validator closes the
round. Each persona is one hot key in the **agent keyring**, selected per call
with `signerKey`.

Ask for it in words and the guide will hand you the plan:

```
dexe_guide { intent: "run agents that vote against each other on my dao" }
dexe_guide { flow: "agent_team" }
```

Everything below is what that flow assumes you already understand.

---

## Read this first: the safety model

**An autonomous persona holding a hot key is a loaded gun.** The keyring makes
that real, so bound it before you use it.

- **The keys sit in plaintext on disk.** `DEXE_AGENT_PK_1..16` (and the
  `AGENT_PK_*` alias) live in `.env`, unencrypted, readable by anything that can
  read your home directory. There is no passphrase and no keychain.
- **They sign without asking.** Any tool call carrying `signerKey: "agent3"`
  broadcasts from agent3. There is no per-transaction prompt, and an orchestrating
  model can issue those calls in a loop.
- **Use burner wallets only.** Generate fresh keys for the fleet; never paste in a
  wallet that holds anything you would miss. One line:
  ```bash
  node -e "const{Wallet}=require('ethers');for(let i=1;i<=8;i++){const w=Wallet.createRandom();console.log('DEXE_AGENT_PK_'+i+'='+w.privateKey,' #',w.address)}"
  ```
- **Validate on BSC testnet (chain 97) first.** Faucet BNB is free
  (<https://www.bnbchain.org/en/testnet-faucet>), the DAOs are disposable, and a
  scripted mistake costs nothing. Move to mainnet (56) only once the same
  scenario is green on 97.
- **Point the fleet at a DAO you can afford to lose.** Personas with enough
  power can create *and pass* real proposals; nothing asks a human first.

### What enforces, and what only advises

| Control | Env | Enforces or advises |
|---|---|---|
| Keyring recipients (`dexe_agents_fund`) | — | **Enforces.** Funding can only reach keyring addresses. Not configurable. |
| Preview before broadcast | — | **Enforces.** `dexe_agents_fund` previews the plan; nothing moves until a second call carries `confirm: true`. |
| Per-agent funding cap | `DEXE_AGENT_FUND_MAX_WEI` | **Enforces.** Default 0.1 native, rescaled into the token's own units for ERC20 transfers. A token whose `decimals()` cannot be read is **refused** — unbounded is never the safe default. |
| Daily fleet spend budget | `SWARM_DAILY_BNB_BUDGET` | **Enforces (0.32.0).** Rolling 24 h of ledger spend (native value **+** gas), re-checked before *every* transfer, so a batch stops at the boundary instead of blowing through it. Documentation-only before 0.32.0. |
| B6 destination allowlist | `DEXE_SIGNER_ALLOWLIST` | **Enforces when set.** Unset = every destination allowed. Applies to persona broadcasts too. |
| B7 value cap | `DEXE_SIGNER_MAX_VALUE_WEI` | **Enforces when set.** Unset = no cap. |
| B9 pre-broadcast simulation | (always, single sends) | **Enforces.** `eth_call` preflight; a call that would revert is not sent. |
| B10 rate limit | `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | **Enforces when set**, per process. A fleet is exactly the workload this exists for. |
| Governance-safety advisories (quorum, treasury drain, zero delay) | `DEXE_TREASURY_GUARD`, `DEXE_MIN_SAFE_QUORUM_PCT` | **Advises.** Printed in the preview; they do not stop a broadcast. The two exceptions that *do* refuse: `dexe_dao_create` on an incoherent config, and builds that need `confirmRisky: true`. |

Three honest limits:

- Guards are about **destinations, value and rate — not governance outcomes**.
  Nothing here notices that your personas just passed a treasury transfer.
- An unset opt-in guard is not a lenient guard, it is **no guard**. Run
  `dexe_doctor` and read which ones are actually configured; do not assume.
- **The daily budget is not armed by default on a faucet testnet** (chain 97 and
  friends) — the coin has no value, so an unset `SWARM_DAILY_BNB_BUDGET` leaves
  it off there and applies the 0.05 default only on value-bearing chains. Set it
  explicitly if you want a cap on 97 as well. `off` / `none` / `unlimited`
  disables it deliberately; a value the server *cannot parse* refuses funding
  outright rather than proceeding unguarded.

Until 0.32.0, `dexe_agents_fund` — the one tool whose job is moving value to
autonomous hot keys — broadcast with **none** of B6/B7/B9/B10 applied, while
`docs/SECURITY.md` published a table saying they applied to every broadcast.
They apply now.

---

## 1. Configure the keyring

In `.env` at the repo root (never in `.claude.json` — the host `env` block
silently shadows `.env`), then **restart** the MCP server:

```bash
DEXE_AGENT_PK_1=0x<burner-key>
DEXE_AGENT_PK_2=0x<burner-key>
DEXE_AGENT_PK_3=0x<burner-key>
DEXE_AGENT_FUNDER_PK=0x<burner-key>     # slot "funder" — the gas source

DEXE_AGENT_FUND_MAX_WEI=100000000000000000   # 0.1 native, per transfer
SWARM_DAILY_BNB_BUDGET=0.05                  # rolling 24 h ceiling
DEXE_TOOLSETS=core,agents                    # the fleet surface — see below
```

The keyring tools are **not** in the default profile. `DEXE_TOOLSETS=core,agents`
gives you `dexe_agents_list`, `dexe_agents_fund` and `dexe_agents_ledger`; add
`vote` when the scenario needs the raw builders (`core,agents,vote`), which is
most delegation and validator work. `vote` also still carries `list`/`fund` on
its own, so an existing `core,vote` session keeps what it had.

Aliases: `AGENT_PK_1..16` and `AGENT_FUNDER_PK` (the swarm-harness naming) are
read as fallbacks; the `DEXE_`-prefixed name wins when both are set.

`signerKey` values are `"agent1"`…`"agent16"`, `"funder"`, or the wallet address.
Omit it and the primary `DEXE_PRIVATE_KEY` signs — agent keys are **never** used
implicitly.

> `.env` traps: trailing newline required, no spaces around `=`, no BOM.
> `process.loadEnvFile()` runs once at startup — mid-session edits do nothing.

---

## 2. Roster and roles

```
dexe_agents_list { chainId: 97, token: "0x<govToken>" }
```

Returns `signerKey → address → native balance → token balance` for every
configured slot. **Assign roles only to slots this returns** — an empty roster
means the keyring never loaded, and the whole run stops there.

| Role | What it does | How it acts |
|---|---|---|
| Proposer | creates the proposal (auto-votes FOR with its own power) | `dexe_proposal_create { signerKey }` |
| Voter | votes FOR or AGAINST, deposits if short | `dexe_proposal_vote_and_execute { signerKey, isVoteFor }` |
| Delegator | deposits its own tokens, delegates to a hub | build → `dexe_tx_send { signerKey }` |
| Validator | votes in the second chamber, executes | `dexe_proposal_vote_and_execute { signerKey, driveValidatorRound: true }` — address must be a registered validator |
| Expert | receives DAO-level delegation | `dexe_proposal_create { proposalType: "add_expert" }`, then `delegate_to_expert` |

---

## 3. Fund inside the budget

```
dexe_agents_fund { amount: "0.01", agents: ["agent1","agent2","agent3"], chainId: 97 }                  → preview
dexe_agents_fund { amount: "0.01", agents: ["agent1","agent2","agent3"], chainId: 97, confirm: true }   → broadcast
dexe_agents_fund { amount: "5000", token: "0x<govToken>", agents: ["agent2","agent3"], chainId: 97, confirm: true }
```

- **Previews first.** The first call returns who would be funded, how much each,
  and the budget impact. Nothing moves without `confirm: true`. (`dryRun: true`
  never broadcasts, even with `confirm`.)
- Funds **from** the primary signer; `source: "funder"` sends from the `funder`
  slot instead.
- **Top-up semantics**: only the shortfall is sent, agents already at the target
  are skipped — re-running after a partial failure is safe.
- Recipients can only be keyring addresses. Not configurable, not bypassable.
- The per-transfer cap is rescaled into the funded token's own decimals, so
  `DEXE_AGENT_FUND_MAX_WEI` means the same size whether you send BNB or a
  6-decimal ERC20. A token whose `decimals()` cannot be read is refused.
- A refusal here — cap or budget — is the guard doing its job. Raise the env var
  deliberately and restart; never work around it by splitting the transfer.

---

## 4. The sequence that actually works on-chain

Mined from the swarm scenarios (`tests/swarm/scenarios/`) that have run against
live pools — S01 (delegation), S02 (validator chamber), S07 (full lifecycle).

```
1. approve(UserKeeper) + deposit          per delegator      build → dexe_tx_send { signerKey }
2. delegate(hub, amount)                  per delegator      dexe_vote_build_delegate → dexe_tx_send { signerKey }
3. create proposal                        proposer           dexe_proposal_create { signerKey }
4. vote FOR / AGAINST                     each voter         dexe_proposal_vote_and_execute { signerKey, isVoteFor, autoExecute: false }
5. move to validators + validator votes   validators         dexe_proposal_vote_and_execute { signerKey, driveValidatorRound: true }
6. execute                                last persona       dexe_proposal_vote_and_execute { signerKey, autoExecute: true }
7. withdraw (unlock)                      every voter        dexe_vote_build_withdraw → dexe_tx_send { signerKey }
```

Order matters, in both directions:

- **Delegations land before the hub votes.** A delegation after the vote does not
  retro-weight it.
- **Deposits land before delegation.** A persona can only delegate its *own
  deposited* balance.
- **`autoExecute: false` for every voter but the last.** Otherwise the first
  persona that pushes quorum executes the proposal and the rest have nothing to
  vote on — a contested-vote scenario that silently becomes a one-vote scenario.

### Which tools take `signerKey`

| Takes `signerKey` | Does not — build, then `dexe_tx_send { signerKey }` |
|---|---|
| `dexe_tx_send`, `dexe_dao_create`, `dexe_proposal_create`, `dexe_proposal_vote_and_execute`, `dexe_otc_dao_open_sale`, `dexe_otc_buyer_buy`, `dexe_agents_fund` (as `source`) | every `dexe_vote_build_*` and `dexe_proposal_build_*` builder — they return an unsigned `TxPayload` and never broadcast |

Send builder payloads **verbatim**. Raw top-level `vote()` / `delegate()` revert
on fresh (SphereX-era) pools; the builders already emit the
`GovPool.multicall([call])` wrapper the protocol requires.

`signerKey` is a **hot-key-only** selector. In WalletConnect mode the phone owns
the only key and the call is rejected — pick one mode per session.

---

## 5. Reconcile the run

Two independent records, and you want both.

**On-chain — who voted and with what weight:**

```
dexe_dao_report { govPool: "0x…", chainId: 56, sections: ["proposals","turnout","activity"] }
```

Turnout, membership, delegation and activity are subgraph-backed and exist for
**BSC mainnet (56) only**. On chain 97 those sections come back
`available:false` with a reason — use `dexe_proposal_state` per proposal plus the
ledger instead. A report that silently dropped half its sections is how a DAO
gets declared healthy while nobody is voting.

**Locally — which persona did what, and what it cost:**

```
dexe_agents_ledger { chainId: 97, windowHours: 24, limit: 50 }
dexe_agents_ledger { signerKey: "agent3" }              // one persona
dexe_agents_ledger { tool: "dexe_agents_fund" }         // one activity
```

Every broadcast is attributed to the signer that made it, with per-agent and
total spend and the remaining daily budget. It is read-only and local — no RPC —
so it still answers on a chain you can no longer reach. The store behind it:

```
~/.dexe-mcp/agent-ledger.json          (or DEXE_AGENT_LEDGER_PATH)
```

| Field | Meaning |
|---|---|
| `signerKey` / `address` | the persona, and the EOA it resolved to |
| `chainId`, `tool`, `action` | where, which MCP tool, what it was doing |
| `txHash`, `outcome` | `broadcast` (in flight) / `confirmed` / `reverted` / `failed` (never sent) |
| `valueWei`, `gasWei` | native moved, and gas — estimated while pending, actual once mined |
| `at` | ISO-8601 timestamp |

Spend accounting is deliberately conservative: in-flight counts value + the gas
*estimate*, a revert counts gas only, a refused send counts nothing. That is what
`SWARM_DAILY_BNB_BUDGET` is compared against.

Retention: newest 500 entries (`DEXE_AGENT_LEDGER_MAX`, max 5000).
`DEXE_AGENT_LEDGER=off` disables recording entirely — and with it any per-persona
attribution and the budget's ability to see spend.

**No key material ever reaches the file.** Only slot labels and 20-byte addresses
are stored, and the writer masks 32-byte hex tokens plus anything matching a
configured key's digest — a private key pasted into a description or a tx-hash
field is dropped, not written.

---

## Gotchas

- **Locked tokens between rounds.** Tokens a persona voted with stay locked
  per-proposal even after execution, and `votingPower()` reads 0 while locked.
  One `dexe_vote_build_withdraw` per persona before the next round, or the next
  vote fails with "No voting power available".
- **Delegation is one level.** A persona delegates only its own deposited
  balance; received delegations cannot be re-delegated. It is hub-and-spoke, never
  a chain — a "3-hop delegation" scenario is really A→C and B→C.
- **Approve the UserKeeper, never the GovPool.** Approving the pool burns gas and
  the deposit reverts. The composites sequence this correctly; hand-built approves
  are where this goes wrong.
- **First proposal on a fresh DAO can revert "low creating power".** The deposit
  is not credited at snapshot time. Transient — re-run the *same*
  `dexe_proposal_create`; the ledger resume skips the landed deposit.
- **Validator personas must be registered validators.** `driveValidatorRound`
  from a non-validator does nothing useful, and voting in the validator chamber
  before `moveProposalToValidators` reverts "Validators: proposal does not exist".
- **A cast validator vote cannot be cancelled** on fresh pools. Top-up re-votes
  are allowed; cancellation is not. Warn before the persona votes.
- **`dexe_agents_*` are not in the default profile.** Without
  `DEXE_TOOLSETS=core,agents` (then restart) they are simply not there; add
  `vote` for the raw builders a delegation or validator leg needs.
- **Concurrency.** Broadcasts are serialized per signer, so distinct personas can
  send in parallel while one persona's transactions stay ordered. Do not try to
  parallelize a single persona.

---

## Env reference

| Var | Purpose |
|---|---|
| `DEXE_AGENT_PK_1..16` (alias `AGENT_PK_*`) | persona hot keys → `signerKey: "agent<n>"` |
| `DEXE_AGENT_FUNDER_PK` (alias `AGENT_FUNDER_PK`) | gas funder → `signerKey: "funder"`, `source: "funder"` |
| `DEXE_AGENT_FUND_MAX_WEI` | per-transfer funding cap (default 0.1 native) |
| `SWARM_DAILY_BNB_BUDGET` | rolling 24 h fleet spend ceiling (BNB) |
| `DEXE_AGENT_LEDGER` | `off`/`0`/`false` disables ledger recording |
| `DEXE_AGENT_LEDGER_PATH` | ledger file location (default: beside the state file) |
| `DEXE_AGENT_LEDGER_MAX` | retained entries (default 500, max 5000) |
| `DEXE_SIGNER_ALLOWLIST` / `DEXE_SIGNER_MAX_VALUE_WEI` / `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN` | broadcast guards B6 / B7 / B10 |
| `DEXE_TOOLSETS` | must include `agents` for the keyring tools (`core,agents`; add `vote` for the builders) |

## See also

- `dexe_guide { flow: "agent_team" }` — the machine-readable plan
- [SECURITY.md](./SECURITY.md) — the full guard posture
- [ENVIRONMENT.md](./ENVIRONMENT.md) — every env var
- [PLAYBOOK.md](./PLAYBOOK.md) — intent → call recipes, error → remedy
- `tests/swarm/` — the dev harness whose scenarios these sequences come from
