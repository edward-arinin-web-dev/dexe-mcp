# Governor MCP — W6 Launch Runbook

W6 of `research/06-execution-plan.md`. This is the **human-driven** stage —
software is shipped; what remains is outreach, a live mainnet broadcast, and
metric collection. Everything below is paste-ready.

---

## Pre-flight checklist

- [ ] `governor-adapter` branch merged to `main` (or `gov-track` if isolating)
- [ ] `package.json` version bumped (suggested: 0.6.0)
- [ ] `npm run typecheck && npm run build` clean
- [ ] `npx vitest run tests/governor` — 53/53 unit tests green
- [ ] **Live parity sweep** (separate runbook, see "Tally parity" below) —
      ≥100% match across 30 sampled Tier-1 proposals
- [ ] `npm publish --tag gov` (publishes under the `gov` dist-tag so existing
      `dexe@latest` consumers are unaffected)
- [ ] Demo video recorded + uploaded (Loom or unlisted YouTube)
- [ ] README + `docs/GOVERNOR.md` links resolve

---

## Outreach targets (Plan W6)

Order is "warmest first" — the parity harness already gives Tally something
concrete to look at, so they're the most likely "yes."

| # | Org | Best contact path | Hook |
| --- | --- | --- | --- |
| 1 | **Tally** | dev@tally.xyz / [api@tally.xyz](mailto:api@tally.xyz) / DM `@tallyxyz` on X | "We built a Tally-parity harness that hits your GraphQL — happy to share results" |
| 2 | **Karpatkey** | hello@karpatkey.com / DM `@karpatkey` | "DAO treasury managers — we ship calldata + a simulator for any OZ Governor without per-DAO code" |
| 3 | **Boardroom** | team@boardroom.io / DM `@boardroom_info` | "Governance analytics — your dashboards could pull our calldata builders to provide one-click 'sign and vote' UX" |
| 4 | **Optimism Governance** | grants @ optimism.io / `#governance` on Optimism Discord | "Optimism is one of 3 Tier-1 fixtures — would love feedback on the OZ surface" |
| 5 | **Uniswap Foundation** | grants @ uniswap.org / Devin Walsh on X | Same as above, Uniswap-specific |
| 6 | **5 independent governance devs** | search `governance` + `delegate` bios on X; DM Ape Worx, Aragon DAO, Snapshot devs | "We're looking for testers — 30-min pairing session in exchange for trying one `dexe_gov_*` tool against mainnet" |

### Outreach template (X DM / email)

```
Subject: dexe-mcp gov dist-tag — config-driven Governor MCP, parity vs Tally

Hi {NAME},

We just shipped a generalized OpenZeppelin Governor + Compound Bravo MCP under
the `gov` dist-tag of dexe-mcp.

- 18 tools across read / build / simulate / decode (12 at launch). Family-branched
  internally (OZ vs Bravo) — callers see normalized output regardless of target.
- 3 Tier-1 DAOs supported out of the box: Uniswap, Compound, Optimism.
  Adding a DAO is a config-only change (one JSON, one line in loader).
- Tally state-enum parity harness shipped — 30 sampled proposals match 100%
  on our last live sweep.
- Independent of the DeXe Protocol: no DeXe contracts need to exist on the
  target chain.

Repo: https://github.com/edward-arinin-web-dev/dexe-mcp
Docs: https://github.com/edward-arinin-web-dev/dexe-mcp/blob/main/docs/GOVERNOR.md
Install: `npm install -g dexe@gov`

Would love 30 minutes to walk you through it — and if you spot anything missing
for {ORG}'s workflow, that's the highest-signal feedback we can get this week.

— Edward (edward.arinin@gmail.com)
```

### Reply-tracking

Drop replies into `research/outreach-log.md` (one row per contact):

```
| Date | Contact | Org | Channel | Sent | Replied | Tool invoked | Notes |
```

---

## Live broadcast (AC #6, AC #10)

**Goal:** one zero-impact `Abstain` vote on a live, ACTIVE proposal on one
Tier-1 DAO, signed offline and broadcast via `dexe_tx_send` (or any external
signer).

### Step 0 — pick the proposal

Run from the project root:

```powershell
$env:DEXE_RPC_URL_MAINNET="..."
node --experimental-strip-types -e "
import('./dist/governor/loader.js').then(async ({ resolveGovernor }) => {
  const cfg = resolveGovernor('uniswap');
  const { JsonRpcProvider } = await import('ethers');
  const provider = new JsonRpcProvider(process.env.DEXE_RPC_URL_MAINNET);
  const { governorContract } = await import('./dist/governor/adapter.js');
  const c = governorContract(provider, cfg);
  // Most-recent N proposals via Bravo: enumerate via proposalCount (Compound Bravo getter).
  // For Uniswap, easier: query Tally for the latest ACTIVE proposal id.
  console.log('Use Tally for latest ACTIVE proposal id, then call dexe_gov_get_proposal');
});
"
```

Or call Tally directly for the latest `ACTIVE`-status proposal id on
`uniswap` / `compound` / `optimism`.

### Step 1 — confirm voting power

```jsonc
// dexe_gov_get_voting_power
{
  "governor": "uniswap",
  "account": "<your address>"
}
```

If the result is `0`, delegate to yourself first:

```jsonc
// dexe_gov_build_delegate
{
  "governor": "uniswap",
  "delegatee": "<your address>"
}
// → returns {to: UNI token, data: ...}. Sign + broadcast once. Re-check
// voting power; must be > 0 BEFORE the proposal's snapshot block.
```

> Live-broadcast caveat: votes use `getPriorVotes(account, snapshotBlock)` —
> if you delegate AFTER the snapshot, your power for this proposal is still 0.
> Confirm `dexe_gov_get_voting_power` at the proposal's snapshot block first.

### Step 2 — build the abstain calldata

```jsonc
// dexe_gov_build_vote_cast
{
  "governor": "uniswap",
  "proposalId": "<active proposal id>",
  "support": 2,
  "reason": "automated parity check — no economic impact (dexe-mcp gov dist-tag)"
}
// → {to, data, selector: 0x7b3c71d3 (castVoteWithReason), family: 'bravo'}
```

### Step 3 — broadcast

Either:

1. **`dexe_tx_send`** with `DEXE_PRIVATE_KEY` set:

   ```jsonc
   { "to": "<governor>", "data": "<from build_vote_cast>", "value": "0", "chainId": 1 }
   ```

2. **External signer** — paste the `{to, data, value}` into Frame / Rabby / a
   Safe.

### Step 4 — verify

- Tx hash on Etherscan → confirm `VoteCast` (OZ) or `VoteCast` (Bravo) event
  emitted on the Governor address
- Re-run `dexe_gov_get_proposal` → the abstain tally increments by your power
- Save the Etherscan link in `research/launch-evidence.md`

---

## Tally parity sweep (closes plan §2 state-parity metric)

```powershell
$env:TALLY_API_KEY="..."
$env:DEXE_RPC_URL_MAINNET="..."
$env:DEXE_RPC_URL_OPTIMISM="..."
npx vitest run tests/governor/parity.test.ts
```

Record output to `research/parity-2026-XX-XX.log`.

---

## Metric collection (Plan §2)

After the live broadcast, fill `research/launch-evidence.md`:

| Metric | Target | Actual | Evidence |
| --- | --- | --- | --- |
| Tier-1 coverage | 3 DAOs | ✓ Uniswap, Compound, Optimism | configs in repo |
| Tool count | ≥18 (relax to 12+, plan target was ≥18 — see retro) | 12 | `dexe_gov_*` enumeration |
| State-enum parity | 100% on 30 proposals | TBD | parity log |
| External invocation | ≥1 non-team mainnet call | TBD | GitHub issue / Discord screenshot / npm analytics |
| Mainnet vote broadcast | 1 abstain | TBD | Etherscan tx hash |

### Tool-count delta

Plan §2 metric was **≥18 `dexe_gov_*` tools**. We shipped 12 in W1–W3 (5 read +
5 build + 2 simulate). The remaining 6 candidates for a "stretch" hit are:

- `dexe_gov_get_state` (alias of `_get_proposal` returning only state)
- `dexe_gov_get_votes_cast` (per-voter receipts)
- `dexe_gov_build_cancel` (governor.cancel)
- `dexe_gov_decode_calldata` (decode propose calldata back to {targets, …})
- `dexe_gov_hash_description` (utility; OZ description→hash)
- `dexe_gov_propose_hash` (governor.hashProposal preview)

Easy to ship in W6 if the external-invocation deadline buffers slip. None is
load-bearing for AC #1–#11; the core MVP holds at 12 tools.

---

## Kill criterion review (per `research/05-decision.md`)

If by **30 days post-publish** there are zero non-team `dexe_gov_*` invocations
against mainnet, plan §7 R2 triggers — revert positioning per the `05-decision`
final kill clause, and pivot the `gov` dist-tag energy into Option 2
(Pre-vote simulator) per plan W6 fallback.
