# Swarm Testing Harness — Setup Guide

Multi-agent DAO testing for `dexe-mcp`. **Two-stage strategy:**

1. **Stage A (BSC testnet, chain 97)** — runs all contract-level scenarios (S00–S21).
   Free testnet BNB from the faucet, no real money at risk. Subgraph and DeXe backend
   don't exist here, so those scenarios skip automatically.
2. **Stage B (BSC mainnet, chain 56)** — runs only the scenarios that need the live
   indexer or API (S22–S25 subgraph reads, S12 off-chain internal proposal, S14 privacy
   policy via DeXe backend) plus a single S01 smoke. Total mainnet cost ≈ $0.50 / pass.

Same wallet pool is reused across both chains — keys are chain-agnostic, only the
allowlists + RPC switch. Switch by setting `SWARM_CHAIN_ID=97` (testnet) or `=56`
(mainnet) in `.env`.

The full design lives at `C:\Users\edwar\.claude\plans\rosy-wishing-lobster.md`.

## What's in Phase 0 (already shipped)

- `.env.example` — every env var the swarm needs, with comments.
- `scripts/swarm/preflight.ts` — wallet readiness check + allowlist enforcement.
- `scripts/swarm/fund-pool.ts` — top-up funder with hard token / recipient allowlists.
- `scripts/swarm/orchestrator.ts` — scenario loader + dry-run executor + report writer.
- `tests/swarm/scenarios/S00-reset.json` + `S01-delegation-chain-3hop.json` + `_schema.md`.
- `tests/swarm/prompts/{proposer,voter,delegator,reporter,triage}.md` + `_shared.md`.
- `tests/swarm/fixtures/dao-personas.json` — 12 realistic DAO identities.
- `.claude/skills/swarm-test/SKILL.md` — `/swarm-test` slash-command.
- `package.json` scripts: `swarm:preflight`, `swarm:fund`, `swarm:run`, `swarm:smoke`.

> The orchestrator spawns **two** MCP children, both with `DEXE_TOOLSETS=full`:
> a keyless one (`DEXE_PRIVATE_KEY=""`) that answers `mode: "payloads"` for the
> orchestrator to sign per agent, and — only when a scenario has a `serverSign`
> step — a keyed one (`DEXE_PRIVATE_KEY`, else `AGENT_FUNDER_PK`) in keyring mode,
> because a keyless server is in WalletConnect mode and refuses `signerKey`.
>
> The orchestrator spawns its MCP server with `DEXE_TOOLSETS=full` — scenario
> steps touch read/vote/dev tools that the slim default surface hides (without
> this, those steps 404 as "unknown tool").

What is **not** in Phase 0:
- Real broadcast dispatch. Orchestrator currently emits `would-call` log entries instead of
  calling MCP tools. Phase 1 wires real dispatch.
- Validator / Expert role prompts (only Proposer / Voter / Delegator / Reporter / Triage are written).
- Triage and Fixer agents (Phase 4).
- Cron schedule (Phase 5).

### What 0.34.0 added

- **Machine-checked assertions.** `steps[].expect` / `steps[].expectError` are evaluated by
  the orchestrator; `successCriteria` stays prose for a human reader. Before this, a
  scenario "passed" whenever nothing threw — every 0.30–0.33 guard is a *returned field*,
  not an exception, so a regression would still have reported ✅. The run report's new
  `Asserts` column shows `ok/total` per scenario, and `—` where a scenario is still
  unverified.
- **Load-time scenario validation.** `_schema.md` claimed the orchestrator validated on
  load; now it does. An unknown step key, an unknown `expect` op, or an `expect` path that
  no step captures aborts the run with the file and step named.
- **`serverSign`.** Routes a single step through the MCP's own signer so the server-side
  broadcast guards, nonce queue and agent ledger are exercised. See *Server-signed steps*.
- **Fixture registration + freshness guards.** Preflight refuses a de-registered fixture DAO
  and a stale `dist/`. See *Fixture DAOs must be registered* and *Build before you run*.
- **Seven new scenarios, S63–S69**, covering the 0.30–0.33 write paths (see *Scenario
  inventory additions*).

---

## Workflow at a glance

```
┌─ Stage A: testnet (chain 97) ───────────────────────────────────┐
│ 1. Generate 9 keys (once)                                       │
│ 2. Get free testnet BNB from faucet                             │
│ 3. Deploy fresh testnet DAO via dexe_dao_build_deploy           │
│ 4. Append testnet DAO + token to SWARM_*_TESTNET                │
│ 5. SWARM_CHAIN_ID=97; preflight + fund + smoke                  │
│ 6. Run S00–S21. Iterate until green.                            │
└─────────────────────────────────────────────────────────────────┘
                               ↓ verified
┌─ Stage B: mainnet (chain 56) ───────────────────────────────────┐
│ 7. Reuse same 9 keys, fund funder with ~0.05 BNB                │
│ 8. Append mainnet DAO + token to SWARM_*_MAINNET                │
│ 9. SWARM_CHAIN_ID=56; preflight + fund + smoke                  │
│ 10. Run S01 + S22–S25 + S12 + S14. ~$0.50/pass.                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1 — Generate the wallet pool

You only have one BSC wallet today. The swarm needs **9 wallets** (8 agents + 1 funder).

Recommended path: derive 8 fresh keys offline, keep them in `.env`, fund from your existing
wallet. None of these keys ever need to leave your machine.

Use any tool you trust. Quick option with the project's existing `ethers` dep:

```bash
node -e "const{Wallet}=require('ethers');for(let i=1;i<=9;i++){const w=Wallet.createRandom();console.log(i===9?'AGENT_FUNDER_PK':'AGENT_PK_'+i,'=',w.privateKey,'  #',w.address);}"
```

Save the output. The first 8 lines map to `AGENT_PK_1..8`; the 9th maps to `AGENT_FUNDER_PK`.

Alternative: use a hardware wallet for the funder and only generate `AGENT_PK_1..8`, then
hand-fund from the hardware wallet. The funder script supports any private key, but a
hardware-derived key is safer for the larger BNB reserve.

---

## Step 2 — Fill in `.env`

Copy `.env.example` → `.env` and paste the keys. Minimum block to add to your existing `.env`:

```bash
# Pool wallets (paste the 8 generated keys here). Reused across testnet + mainnet.
AGENT_PK_1=0x...
AGENT_PK_2=0x...
AGENT_PK_3=0x...
AGENT_PK_4=0x...
AGENT_PK_5=0x...
AGENT_PK_6=0x...
AGENT_PK_7=0x...
AGENT_PK_8=0x...
AGENT_FUNDER_PK=0x...

# Stage A — testnet
SWARM_CHAIN_ID=97
SWARM_RPC_URL_TESTNET=https://data-seed-prebsc-1-s1.binance.org:8545
SWARM_DAOS_TESTNET=                     # filled in step 3 after deploy
SWARM_TOKENS_TESTNET=                   # filled in step 3 after deploy
SWARM_TOKENSALE_TESTNET=                # optional: TokenSaleProposal helper, one per DAO
SWARM_DISTRIBUTION_TESTNET=             # optional: DistributionProposal helper, one per DAO

# Stage B — mainnet (fill in when ready to run final pass)
SWARM_RPC_URL_MAINNET=https://bsc-dataseed.binance.org
SWARM_DAOS_MAINNET=0x3E224749a18dBF46FdAE027ba152B1d1D5B4568F
SWARM_TOKENS_MAINNET=0x0051Cf7595BeEA1669a13d23A74B74E6415B721d
```

### The four allowlists are INDEX-PARALLEL

`SWARM_TOKENS_<tag>[i]` must be the gov token of `SWARM_DAOS_<tag>[i]`, and the same for
`SWARM_TOKENSALE_<tag>[i]` / `SWARM_DISTRIBUTION_<tag>[i]`. The orchestrator picks the
token by the DAO's index (`{{firstAllowlistedToken}}` resolves against the scenario's own
DAO), and preflight resolves `daos[i]`'s UserKeeper when it counts `tokens[i]`. A second
DAO appended out of order used to mis-pair in silence: preflight stayed green because a
wallet passes if *any* allowlisted token clears its floor, and the scenario then failed much
later with an unrelated-looking "low creating power".

Preflight now refuses a length mismatch and, where it can read the chain, refuses a pair
whose token is not that DAO's `GovUserKeeper.tokenAddress()`. Both checks fail OPEN on an
RPC error — a flaky node must never block a valid run.

`SWARM_TOKENSALE_*` / `SWARM_DISTRIBUTION_*` are optional. They exist because `GovPool` has
no forward getter for either helper (both are factory-*predicted* addresses), and both are
proposal **executors** — write targets — so they get the same allowlist treatment as tokens
and DAOs rather than being free-form env. Populate them from the `predicted.govTokenSale` /
`predicted.distributionProposal` that `dexe_dao_create` returns at deploy time. Scenarios
S20–S22 and S41–S50 need them; without them `{{dao.tokenSale}}` resolves to an empty string
and those builders refuse with `Invalid tokenSaleProposal`.

---

## Step 3 — Stage A funding (testnet, free)

BSC testnet faucets give 0.5 testnet BNB per claim and reset every 24 h. Free.

1. **Faucet — funder + (optional) PK_1** to a fresh address:
   - https://testnet.bnbchain.org/faucet-smart  (official, captcha)
   - https://www.bnbchain.org/en/testnet-faucet  (mirror)
   Send to `AGENT_FUNDER_PK` address. ~0.3 BNB is plenty for hundreds of runs.

2. **Deploy a fresh DAO on testnet** using your existing dexe-mcp tools. From a Claude
   Code session in this repo, ask for a DAO with one of the personas in
   `tests/swarm/fixtures/dao-personas.json` (e.g. *Helios Climate Fund*). Use the
   single-wallet flow (`DEXE_PRIVATE_KEY` is fine for this — it's the same wallet you'll
   later use as `AGENT_PK_1`, since wallets are reused across chains).
   - Expected outputs: `govPool` address + `govToken` address.
   - Cost: a couple of testnet BNB max.

3. **Append testnet addrs to `.env`:**
   ```
   SWARM_DAOS_TESTNET=0x<your-testnet-govPool>
   SWARM_TOKENS_TESTNET=0x<your-testnet-govToken>
   ```

4. **Mint / transfer testnet token** to the funder so it can later top up the pool. The
   DAO deployer wallet receives the full token supply on deploy — transfer 200k to the
   funder address, then funder distributes to PK_1..8.

## Step 3b — Stage B funding (mainnet, real money — only after Stage A green)

Send to the funder address from your existing mainnet wallet:

| Item | Amount | Reason |
|---|---|---|
| BNB | ≥ 0.01 (~$6) | Mainnet pass runs only S01 + S22–S25 + S12 + S14 ≈ ~10 txs, ~$0.30. The 0.01 covers many passes. |
| DAO governance token (DTT) | ≥ 200,000 | Same as testnet — pool needs 135k minimum + headroom. |

Per-tx cost reference (BSC mainnet, ~0.1 gwei):
- proposal create (~500k gas): **~$0.03**
- vote / delegate / deposit (~200k gas): **~$0.012**
- one S01 run (4 txs): **~$0.05**
- mainnet final pass (~10 txs): **~$0.30**
- DAO deploy (only when seeding): **~$0.60**

If you don't have 200k DTT, deploy a smaller DAO first. The persona library
(`tests/swarm/fixtures/dao-personas.json`) ships realistic names — pick one and use Phase
1's `dexe_dao_build_deploy` flow to deploy a fresh DAO with whatever supply you can fund.

> **Important:** the fund-pool script REFUSES to transfer any token that isn't in
> `SWARM_TOKENS`. If you add a new DAO with a new gov token, append its address to that env
> var first.

---

## Fixture DAOs must be registered

Every composite (`dexe_proposal_create`, `dexe_proposal_vote_and_execute`, the
`dexe_dao_create` follow-ups) refuses a DAO that `PoolRegistry.isGovPool()` does not
recognize — the W10 guard. The chain-97 protocol has been **redeployed** since the
2026-05 fixtures were minted, so those pools are no longer registered under the canonical
registry, and the 2026-07-23 sweep lost 13 scenarios to the same refusal one scenario at a
time, ~40 minutes in.

Two things make this hard to notice:

- **A de-registered pool still answers READS.** `dexe_proposal_state`,
  `dexe_proposal_list`, `dexe_dao_info` all work fine against a dead pool, so the read-only
  scenarios stay green and hide the problem.
- **A dead pool self-reports its OLD registry.** `getHelperContracts()[3]` returns the
  registry it was minted under, and *that* registry still answers `isGovPool == true`. Any
  check that trusts the pool's own answer green-lights exactly the fixture it exists to
  catch. The guard resolves `POOL_REGISTRY` through `ContractsRegistry` instead.

Preflight (and the orchestrator, once, at startup) now runs this check and fails with the
offending address, its index, the chain and the remedy. Under `--dry-run` the orchestrator
warns instead of failing, so `npm run swarm:smoke` stays usable.

### Refresh the fixture DAO

Run this from a Claude Code session with the `dexe` MCP server connected. It is a
**preview** first: `dexe_dao_create` shows the resolved config and the safety proof, and
only deploys when you re-run with `confirm: true`.

`daos[0]` — the member DAO. SIMPLE mode, one call, recipients split across the whole pool
so no separate token-funding step is needed:

```jsonc
// dexe_dao_create
{
  "chainId": 97,
  "daoName": "Kestrel Research Guild",       // any name from tests/swarm/fixtures/dao-personas.json
  "daoDescription": "Swarm fixture DAO for the dexe-mcp live regression sweep.",
  "symbol": "KRT",
  "totalSupply": "1000000",
  "durationSeconds": 3600,                    // S65 needs the proposal to still be in Voting
  "minVotesTokens": "1",
  "recipients": [
    // The FUNDER gets 5x a normal slice: `npm run swarm:fund` can only refill from the
    // funder's own balance, so an even split leaves the pool one-shot.
    { "address": "0x769345ccC3B1f5EEDc660A7eC45D8EBaF5b674ea", "percent": 25 },  // AGENT_FUNDER_PK
    { "address": "0xCa543e570e4A1F6DA7cf9C4C7211692Bc105a00A", "percent": 5 },   // primary / deployer
    { "address": "0x9572f3Bc4F88758259F29D80d73EAc012d7Fa09f", "percent": 5 },   // AGENT_PK_1
    { "address": "0x425f1072F911f5ee23bF4e9634701898Bd0B0652", "percent": 5 },   // AGENT_PK_2
    { "address": "0x37dB3c3B51c2980007a8cD086E3a5F0B81c9E37B", "percent": 5 },   // AGENT_PK_3
    { "address": "0x9e207Ce7E88E5a4Cf8eB08A7e6aF56D504426683", "percent": 5 },   // AGENT_PK_4
    { "address": "0x1aeB55E2239Fe1C9FC148d8DE93595Be04A508b4", "percent": 5 },   // AGENT_PK_5
    { "address": "0xf0BF4f08AE3C101fC15bc3E26a600c6fefE67638", "percent": 5 },   // AGENT_PK_6
    { "address": "0x3E01e90E5361002bF7c02001C7363626168C7ff1", "percent": 5 },   // AGENT_PK_7
    { "address": "0x7340b46959f4598f86aA23D5d26ec289e2736e77", "percent": 5 }    // AGENT_PK_8
  ]
}
```

Why these numbers:

- `recipients[].percent` are shares of **total** supply and must sum to exactly
  `100 − treasuryPercent`. Omitting `treasuryPercent` takes the safe default **30**, so the
  percents above sum to **70**. Change one and you must change the other.
- The synthesized config is treasury 30 / quorum 51 / votable 70 ⇒ **72.86 %** required
  turnout, under the 80 % ceiling. Both quorum rules hold: quorum ≤ the votable share, and
  quorum ≥ the 50 % treasury-safety floor.
- 5 % of 1,000,000 = **50,000 tokens** per wallet, comfortably over preflight's 5,000 /
  2,000 / 1,000 floors; the funder keeps **250,000** as the refill reserve.

Then:

1. Re-run the same call with `"confirm": true`. Record `predictedGovPool`, the gov token,
   and the `predicted.govTokenSale` / `predicted.distributionProposal` helpers.
2. Put them in `.env` **index-parallel**: `SWARM_DAOS_TESTNET`, `SWARM_TOKENS_TESTNET`,
   `SWARM_TOKENSALE_TESTNET`, `SWARM_DISTRIBUTION_TESTNET`.
3. **Warm the pool before the first broadcast sweep**: deposit, wait a block, then create
   one throwaway proposal. The first create on a freshly deployed pool can revert
   `Gov: low creating power` because the deposit is not yet credited (bug #35's unbundle
   race). Without the warm-up, S00/S01/S07 step 1 eats one spurious failure — the ledger
   resume heals it on a re-run, but the report is misleading.
4. Restart Claude Code / the MCP server: `process.loadEnvFile()` runs once at startup.

`daos[1]` — the **validator** DAO, needed by `{{secondAllowlistedDao}}` (S02, S03, S07,
S10, S13, S14, S23–S26, S38). SIMPLE mode **cannot** create validators — the SIMPLE schema
has no `validators` field at all — so this one needs ADVANCED `params` with
`validatorsParams.validators = [AGENT_PK_6 addr, AGENT_PK_7 addr]` and matching balances,
`proposalSettings[].validatorsVote = true`, and `durationValidators` ≥ 600. Model it on
`tests/swarm/scenarios/S58-dao-create-dry.json`, which is a complete ADVANCED payload
(remember `cap ≥ mintedTotal > 0`; `cap: 0` reverts `ERC20Capped: cap is 0`).

---

## Build before you run

```bash
npm run build          # <- the swarm spawns `node dist/index.js`
npm run swarm:preflight
```

The harness and the server under test are built by different mechanisms:
`npm run swarm:run` is `tsx`, so the **harness** is always source-of-truth, while the
orchestrator spawns the **built** `dist/index.js`. `dist/` is gitignored, there is no
`prepare` script, and `nightly.sh`'s `npm install` is conditional — so nothing refreshed
`dist/` and a gas-spending regression pass could certify the previously-built server.

`nightly.sh` now builds unconditionally, and both preflight and the orchestrator check
`dist/index.js` against the newest mtime under `src/`. A **missing** `dist/index.js` is
always fatal; a **stale** one is an mtime heuristic and can be overridden with
`SWARM_SKIP_DIST_CHECK=1` (a `git pull` or the documented CRLF re-checkout bumps `src`
mtimes without changing content).

---

## Step 4 — Verify wallet pool readiness

```bash
npm run swarm:preflight
```

Output is a green / red table per wallet showing BNB + token balance vs threshold. Red rows
show with a `!` after the deficit value. Exit code is non-zero if any row is red.

Expected first run: every pool wallet will be red (newly generated, zero balance). The
funder row will be green if you funded it in step 3.

---

## Step 5 — Top up the pool

```bash
npm run swarm:fund                 # dry-run first — see exactly what will be sent
npm run swarm:fund -- --confirm    # broadcast
```

The fund script:
1. Derives all 8 pool addresses from `AGENT_PK_*`.
2. Refuses to run if any token in the planned transfer list isn't in `SWARM_TOKENS`.
3. Refuses to send to any address not derived from `AGENT_PK_1..8`.
4. Sends the BNB shortfall to each red wallet, then the token shortfall.
5. Prints tx hashes per transfer.

Re-run `npm run swarm:preflight` after — every row should be green.

---

## Step 6 — Phase 0 dry-run (no broadcast)

```bash
npm run swarm:smoke
```

This runs `S00-reset` + `S01-delegation-chain-3hop` in dry-run mode. Each step is logged as
`would-call` — no transactions are broadcast, no IPFS uploads, no MCP tool dispatch yet
(Phase 1 wires that).

Output:
- `tests/swarm/state/<run-id>.jsonl` — every step's planned action as JSON.
- `tests/reports/swarm/<run-id>/run.md` — Markdown summary.

If both files are written and exit code is 0, Phase 0 harness is green.

### Closing the lifecycle (S07)

`S07-full-lifecycle-execute` stops at `SucceededFor` because the actual `execute()`
call is interaction-flaky inside a chained sweep — the validator vote tx and the
follow-up state read often race against the chain delay. The success criteria
explicitly accept `SucceededFor` / `Locked` / `ExecutedFor`.

To close the lifecycle (drive the proposal to `ExecutedFor`) **after** S07 has
landed a proposal in `SucceededFor`, run the one-shot helper:

```bash
node scripts/swarm/one-shot-execute.mjs <govPool> <proposalId>
```

It refuses to send unless the state is in `[SucceededFor, SucceededAgainst, Locked]`,
caps `wait()` at 90 s, and prints the post-execute state. Validated 2026-04-30
against Sentinel proposal 33 — `SucceededFor` → `ExecutedFor`, tx
`0x309d2ec42eac1574061abf49b7aaf50c5c8a825a004be2cda0a5980e3e541e69`.

---

## Server-signed steps (`serverSign`)

By default the orchestrator spawns the MCP with `DEXE_PRIVATE_KEY: ""` so the composites
return TxPayload lists, then signs each payload itself with a local `ethers.Wallet`. That
is deliberate — one process drives eight personas — but it means the swarm has never
exercised anything on the **server's** send path: the B6/B7/B9/B10/B11/B12 broadcast
guards, the SignerManager per-(chain, address) nonce queue, the broadcast recorder and
agent ledger, and the receipt-timeout / resume handling.

`"serverSign": true` on a step flips that one step:

- the orchestrator derives the keyring slot from the step's **own** agent wallet
  (`AGENT_PK_3` → `agent3`, `AGENT_FUNDER_PK` → `funder`) and passes it as `signerKey`;
- the step must NOT also set `"broadcast": true` — the MCP already sent the transaction,
  and a second local send would double-spend the nonce. Both together is a load-time error.
- `serverSign` is refused on any tool the orchestrator answers with an inline dispatcher,
  because MCP zod schemas strip unknown keys and `signerKey` would be dropped in silence.
- If payloads come back anyway, the run fails loudly: that slot is not configured in the
  child's env, and signing locally would rescue the step while proving nothing.

`AGENT_PK_1..8` / `AGENT_FUNDER_PK` already reach the keyring as `agent1..agent8` / `funder`
through the `DEXE_AGENT_PK_*` aliases in `src/config.ts` — no extra env needed.

> **A serverSign run is subject to the RUNNER's own signer guards.** If
> `DEXE_SIGNER_ALLOWLIST`, `DEXE_SIGNER_MAX_VALUE_WEI`,
> `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN`, `DEXE_AGENT_FUND_MAX_WEI` or
> `SWARM_DAILY_BNB_BUDGET` are set, they apply — and B6 fires *before* B12, so a
> denylist scenario whose destination is not allowlisted fails as B6 and "passes" for the
> wrong reason. Preflight prints which of these are armed.

---

## Scenario inventory additions (S63–S69)

Scenarios were historically added per shipped FEATURE — a new proposal type meant a new
S-file. The 0.30–0.33 work shipped **guards on existing tools**, which produce no new tool
name and so produced no new scenario. These seven close that gap:

| Scenario | Chain | Broadcasts | What it pins |
|---|---|---|---|
| `S63-addsettings-refusal` | 97 | no | The #36 addSettings trap refuses `proposal_create` **through the `custom` branch**, which bypasses the builder registry. `mode: blocked-risky`, `risk: DANGER`, advisory names `#36`. |
| `S64-create-dedupe` | 97 | **yes** | A byte-identical re-create returns `already-created` with the create step skipped and no new tx. Cannot be dry-run — the dedupe scan is skipped under `dryRun`. |
| `S65-vote-already-cast` | 97 | **yes** (step 1) | The vote leg skips an already-cast vote *and* its deposit; flipping direction adds the `⚠ HARM WARNING` cancel-then-revote advisory. |
| `S66-tx-send-guards` | 97 | no | B11 wrong-chain, B11 codeless destination, B12 via `dexe_tx_send`, and B12 via the **shared** `runBroadcastGuards` copy (step 4). All `serverSign`. |
| `S67-keyring-signerkey-routing` | 97 | **yes** (step 2) | `signerKey` picks the persona, the ledger attributes the spend, an unknown slot is refused by name. One `approve(0x…dEaD, 0)` ≈ $0.01. |
| `S68-agents-fund-preview` | 97 | no | `dexe_agents_fund` previews, caps at `DEXE_AGENT_FUND_MAX_WEI`, and reports the rolling budget. `dryRun: true` is mandatory and test-enforced; **never** add `confirm: true`. |
| `S69-dao-create-simple-defaults` | 97 | no | SIMPLE-mode synthesis (30 / 51 / turnout ≤ 80) and the refusal of an unreachable treasury+quorum pair. |

S58 and S69 both require **`DEXE_PINATA_JWT`**: `dexe_dao_create` checks for it before any
dryRun branch, and the composite still pins the settings JSON even under `dryRun` (only the
DAO-metadata CID is computed locally). Without it both scenarios fail at step 1.

Not scenario-able, and covered by unit tests instead: the receipt-timeout ledger
(`tests/tools/flow-resume-idempotency.test.ts` — "a timed-out step is told to CHECK, never
to re-run"). A live chain cannot be made to time out deterministically; do not invent a
flaky case for it.

---

## When Phase 1 lands

You won't need to redo any of this — the env vars and wallet pool stay the same. Phase 1
adds:
- Real MCP-tool dispatch in the orchestrator.
- Validator + Expert role prompts.
- Wallet semaphore for parallel scenarios.
- `S02..S06` multi-agent scenarios.

Then `npm run swarm:run -- --scenarios=S01-delegation-chain-3hop` (no `--dry-run`) will
actually broadcast the 4 delegate / vote / approve transactions on BSC mainnet against
DeployTestDAO.

---

## Cost estimate (two-stage)

| Run | Chain | Cost |
|---|---|---|
| Stage A — full S00–S21 sweep | testnet (97) | **free** (faucet BNB) |
| Stage B — mainnet final pass (S01 + S22–S25 + S12 + S14) | mainnet (56) | **~$0.30** |
| Mainnet DAO deploy (one-time seed) | mainnet (56) | **~$0.60** |
| Nightly cron (Phase 5, if pointed at testnet) | testnet (97) | **free** |

`SWARM_DAILY_BNB_BUDGET` is a fat safety net, not a target.

---

## Switching between testnet and mainnet

All you change is one line in `.env`:

```bash
SWARM_CHAIN_ID=97   # Stage A — testnet (default)
SWARM_CHAIN_ID=56   # Stage B — mainnet
```

Every script (`preflight`, `fund-pool`, `orchestrator`) reads the chain id, picks the
matching `SWARM_*_TESTNET` or `SWARM_*_MAINNET` env vars, and rejects mismatched RPCs.
Scenarios with `requiresChain: [56]` skip automatically when running on testnet.

---

## Common pitfalls

- **MCP server didn't pick up new env vars.** Restart the MCP server. Memory note
  `feedback_mcp_env_restart` documents this — `process.loadEnvFile()` runs on startup only.
- **DeployTestDAO is approaching deadlock** (per memory `reference_test_dao_state`,
  2026-04-23): VotePower beacon broken, two stuck proposals locking tokens. Phase 0 dry-run
  is unaffected. For Phase 1+ broadcast, recommend deploying a fresh DAO from a persona —
  add its `govPool` to `SWARM_DAOS` and its token to `SWARM_TOKENS` before running.
- **WindowsPATH issues with `tsx`.** All swarm scripts use `npx tsx` via npm scripts; if
  `npm run swarm:*` works but bare `tsx` doesn't, that's expected.
