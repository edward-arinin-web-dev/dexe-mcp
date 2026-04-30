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

What is **not** in Phase 0:
- Real broadcast dispatch. Orchestrator currently emits `would-call` log entries instead of
  calling MCP tools. Phase 1 wires real dispatch.
- Validator / Expert role prompts (only Proposer / Voter / Delegator / Reporter / Triage are written).
- Triage and Fixer agents (Phase 4).
- Cron schedule (Phase 5).

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

# Stage B — mainnet (fill in when ready to run final pass)
SWARM_RPC_URL_MAINNET=https://mbsc1.dexe.io/rpc
SWARM_DAOS_MAINNET=0x3E224749a18dBF46FdAE027ba152B1d1D5B4568F
SWARM_TOKENS_MAINNET=0x0051Cf7595BeEA1669a13d23A74B74E6415B721d
```

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
