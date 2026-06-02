# Escalation to the DeXe Protocol team — contract-level findings

These findings root-cause in the **deployed DeXe-Protocol contracts**, not in
`dexe-mcp`. The MCP can only *warn* about them (it does, in the relevant tool
previews); it cannot fix them. They were surfaced by the `dexe-mcp@0.7.2`
red-team audit (`.claude/TOTAL_REPORT.md`) and are reproducible through **any**
interface, not just this MCP.

> Severity/attribution use the audit's calibration. "Reproduced on" notes how
> each was confirmed. File:line references are against the runtime clone of
> `dexe-network/DeXe-Protocol`.

---

## C-2 — INTERNAL-allowlist bypass via DEFAULT routing → unlocked-deposit drain 🔴 CRITICAL

**Root cause (contracts).** Proposal-settings routing is taken from **only the
last** action's executor:

- `GovPoolCreate.sol` L140: `mainExecutor = actionsFor[actionsFor.length - 1].executor;`
- `GovPoolCreate.sol` L147: `settingsId = govSettings.executorToSettings(mainExecutor);`
- An unregistered last executor → `settingsId == 0 == DEFAULT`; the DEFAULT
  branch (`_handleDataForProposal`, L291-293) `return false` **without iterating
  or validating the earlier actions**, so the INTERNAL allowlist
  (`_handleDataForInternalProposal`, L255-271) never runs.
- `GovUserKeeper.withdrawTokens(payer, receiver, amount)` (selector `0x5e35359e`)
  decouples `payer` from `msg.sender`/`receiver` and is **not** in the INTERNAL
  allowlist, so a hidden early `withdrawTokens` action executes and moves an
  arbitrary depositor's **unlocked** PersonalVote balance to the attacker.

**Reproduced on.** Mainnet (self-payer, reversible, value_lost=0) proposal #4 on
`0x18c4…f04B`; cross-depositor variant forge-proven on real bytecode.

**Fix in contracts.** Validate the selector/settings of **every** `actionsFor[]`
action against its own executor's settings (or reject mixed-`settingsId`
proposals); do not derive the settings type from only the last executor. Bind
`withdrawTokens` so `payer` cannot be set arbitrarily (e.g. `payer == receiver`,
or explicit payer consent).

**MCP mitigation (shipped).** `lib/dangerousSelectors.ts` hard-refuses the 12
privileged `GovUserKeeper` accounting selectors in every proposal builder
(v0.8.3); `dexe_proposal_build_custom_abi` and the recursive decoder flag
DEFAULT-routing / privileged selectors.

---

## executionDelay = 0 → zero-delay execution (timelock bypass) 🟡 MEDIUM (protocol-property)

A passed proposal with `executionDelay == 0` executes immediately — there is no
window to react to a malicious-but-passed action, and it **amplifies C-2**.
`GovSettings._validateProposalSettings` enforces **no minimum** on
`executionDelay`. Confirmed by execution on a controlled DAO.

**Fix in contracts.** Enforce a non-zero minimum `executionDelay` (or a per-DAO
configurable floor).

**MCP mitigation.** `dexe_proposal_build_change_voting_settings` emits an
advisory when `executionDelay == 0` (`lib/protocolAdvisories.ts`).

---

## H-11 — unbounded `durationValidators` freezes all voters' deposits 🟠 (mixed)

`GovSettings._validateProposalSettings` (`GovSettings.sol:99`) has only a lower
bound (`durationValidators > 0`) — **no upper bound**. A proposal with
`validatorsVote:true` and a huge `durationValidators` is stuck in
`ProposalState.ValidatorVoting`, and `GovPoolUnlock._proposalIsActive`
(`GovPoolUnlock.sol:58-67`) does **not** include `ValidatorVoting` in the
unlocked set — so every voter's deposited tokens/NFTs are **non-withdrawable**
for the (effectively unbounded) duration. Companion: `quorumValidators` has no
lower bound, so `0` auto-defeats every validator proposal (governance DoS).

**Fix in contracts.** Add an upper bound on `durationValidators` and a lower
bound on `quorumValidators`; unlock deposits during `ValidatorVoting`.

**MCP mitigation.** `change_voting_settings` advises on a huge
`durationValidators` (> 30 days) and on `quorumValidators == 0`.

---

## `changeVotePower` — privileged vote-power swap 🟡 MEDIUM (protocol-property)

`GovPool.changeVotePower(address)` swaps the DAO's entire vote-power math
contract via a normal (passed) INTERNAL proposal. It is reversible, so not a
permanent capture, but it is a governance-wide privileged change.

**Decision for the DeXe team.** Keep as a feature, or add an extra
timelock/constraint on changing the vote-power contract.

**MCP mitigation.** `dexe_proposal_build_change_math_model` prints a privileged-
action advisory.

---

## PolynomialPower threshold-seam underflow → panic 0x11 🟡 LOW (fuzz-proven)

In `PolynomialPower._forHolders` / `_forExperts`, the expression
`((100·votes·PRECISION)/totalSupply) − 7·PRECISION` is computed in `uint256`
**before** the cast to `int256`. A voter holding exactly `floor(7%·totalSupply)`
(holders) / `floor(6.63%·totalSupply)` (experts) reverts their own vote-power
transform (panic 0x11). The band is 1 wei wide → self-DoS (the voter fixes it
with a ±1 wei deposit; others are unaffected).

**Fix in contracts.** Use a `<=` guard / clamp at the seam, or cast to `int256`
before subtracting.

---

## Not a bug (verified)

- **`governor/configs/uniswap.json` timelock** `0x1a9C8182C09F50355CeA8fFF4b7E1649A535498a`
  is the **correct** Uniswap Timelock — the audit's H-7 does not reproduce.
- **SSRF** — fetch URLs are operator-configured (not attacker-reachable); refuted
  in the audit.
