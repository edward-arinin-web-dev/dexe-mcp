# DeXe Protocol — SphereX Firewall Issues on Freshly Deployed GovPools

**Audience:** DeXe protocol / infrastructure team
**Reporter:** dexe-mcp maintainers (Edward Arinin)
**Date:** 2026-07-23
**Chains observed:** BSC testnet (97) and BSC mainnet (56)
**Affected deployments:** every GovPool deployed from the current factory since ~2026-07-06 ("SphereX-era" pools). Pools deployed before that date (Polaris 05-12, Glacier, older fixtures) are clean.

---

## Summary of the problem

Newly deployed GovPools ship with an on-chain SphereX firewall that reverts any call whose **transaction pattern** (the sequence/shape of the call, not just the selector) is not on a per-pool allowlist. The observed allowlist appears to be seeded from **the DeXe frontend's exact call shapes** — anything the frontend does works; anything shaped even slightly differently reverts with:

```
execution reverted: "SphereX error: disallowed tx pattern"
```

Two classes of damage follow:

1. **Broken behaviors the frontend ALSO hits** — where the frontend's own shape is the blocked one. These are genuine protocol regressions that will surface in the DeXe UI, not just in third-party tooling. The clearest case is `TokenSaleProposal.vestingWithdraw` (F15): the frontend calls it in exactly the shape that reverts, so **vested OTC funds are unrecoverable through the official UI** on fresh pools.

2. **An inconsistent allowlist policy** — some flows require raw calls (bundling forbidden), others require the call wrapped in a single-element `multicall` (raw forbidden). The two rules are inverses of each other and there is no documented principle telling an integrator which applies where. Each had to be discovered empirically on-chain (#35, #36, F4).

Because the allowlist is enforced in-contract, **none of this is fixable in client tooling** — dexe-mcp can only steer around the reachable cases and hard-block the unreachable ones. The items below need a protocol-side change (allowlist entries or a firewall policy revision).

All frontend line citations below were re-verified against `C:\dev\investing-dashboard` on 2026-07-23.

---

## F15 — `TokenSaleProposal.vestingWithdraw` blocked in every shape (P1, funds-loss)

**Symptom.** On a fresh pool, withdrawing the vested portion of an OTC purchase reverts `"SphereX error: disallowed tx pattern"` for every call shape attempted. The vested tokens a buyer is owed become permanently unrecoverable.

**Call shapes tested (all revert):**

| Shape | Source |
| --- | --- |
| `tsp.vestingWithdraw([tierId])` (raw, direct) | `src/hooks/contracts/useTokenSaleProposalContract.ts:351` (`vestingWithdraw` → `.vestingWithdraw(tierIds)` at :355) |
| `tsp.multicall([claim, vestingWithdraw])` | `src/context/createProposal/external/tokenSale/TokenSaleDetailsContext.tsx:167–180` (raw `vestingWithdraw([tierId])` at :172; `multicall([encodedClaim, encodedWithdraw])` at :179) |
| any `withdrawable` amount, any tier | — |

**Why this is a confirmed PROTOCOL bug (not a tooling bug).** The DeXe frontend uses *exactly* these two shapes and no others — there is no alternate code path in the UI. Therefore the official frontend would fail identically on a fresh pool. The `vestingWithdraw` selector is simply missing from the SphereX allowlist.

**Evidence.** Verified 2026-07-21 on Hazelbrook `0x4f9674AE…3C02` (chain 97); frontend cross-check of the two shapes above confirmed on 2026-07-23.

**Impact.** P1. Any tier opened with a non-zero `vestingPercentage` on a current DAO strands the vested allocation. `claim` (the instant portion) works; only the vested leg is dead.

**Current tooling mitigation.** dexe-mcp warns and recommends `vestingPercentage: "0"` on fresh DAOs (PLAYBOOK `otc-vesting-broken`). This avoids the trap; it does not recover already-vested funds.

**Suggested remediation.** Add the `TokenSaleProposal.vestingWithdraw` selector (both the raw and the `multicall`-wrapped shape used by `TokenSaleDetailsContext`) to the SphereX allowlist for TokenSaleProposal. Consider a migration path for any pool that already has vested-but-locked tiers.

---

## F12 — `GovValidators.cancelVote{Internal,External}Proposal` blocked, no workaround (P2)

**Symptom.** A validator who has cast a vote in the validator chamber cannot cancel it: both `cancelVoteInternalProposal` and `cancelVoteExternalProposal` revert `"SphereX error: disallowed tx pattern"` on fresh pools.

**Call shapes tested (all revert):**

| Shape | Result |
| --- | --- |
| raw `cancelVoteInternalProposal(id)` | ✗ blocked |
| raw `cancelVoteExternalProposal(id)` | ✗ blocked |
| `multicall([cancelVote…])` | **not possible — `GovValidators` exposes no `multicall`** |

The GovPool workaround used for F4 (wrap in single-element `multicall`) does **not** exist here, because `GovValidators` has no `multicall` entrypoint. There is therefore **no client-side workaround at all**.

**What still works.** Raw `voteInternalProposal` / `voteExternalProposal` (including top-up re-votes) and `createInternalProposal` are allowed. Only the cancel path is blocked.

**Evidence.** Verified 2026-07-21 on Hazelbrook `0x4f9674AE…3C02` (chain 97). Campaign `dao-e2e-kit/campaigns/2026-07-21-full-verify`, finding F12.

**Impact.** P2. A validator vote is irrevocable once cast. Not funds-loss, but removes a governance control the contract nominally exposes.

**Suggested remediation.** Add the `cancelVoteInternalProposal` / `cancelVoteExternalProposal` selectors to the GovValidators allowlist. (Adding a `multicall` to GovValidators would also unblock it but is a larger change.)

---

## F14 — `executeInternalProposal(monthly_withdraw)` — ROOT-CAUSED 2026-07-23: not a firewall issue, but the revert string masks the real cause (P3, UX)

**Original symptom (2026-07-21).** Executing an internal `monthly_withdraw` proposal in `Succeeded` state reverts `"Validators: failed to execute"`. Initially filed here as a suspected SphereX inner-call rejection.

**Actual root cause (contract source + live E2E, 2026-07-23).** `GovValidatorsExecute.executeInternalProposal` runs the action through a low-level self-call and re-throws any failure as the generic string:

```solidity
(bool success, ) = address(this).call(proposal.data);      // GovValidatorsExecute.sol:27
require(success, "Validators: failed to execute");          // :28  ← what integrators see
```

For `monthly_withdraw` the inner path is `GovValidators.monthlyWithdraw` → `GovPool.transferCreditAmount` → `GovPoolCredit.transferCreditAmount`, which requires the validators' **credit line** to cover the amount:

```solidity
require(currentAmount <= tokenCredit, "GPC: Current credit permission < amount to withdraw");  // GovPoolCredit.sol:60-63
```

A pool where `GovPool.setCreditInfo` was never executed has `tokenCredit == 0` — so **every** `monthly_withdraw` reverts, and the real reason is swallowed by the low-level call.

**E2E proof (chain 97, fresh validator pool `0x0fe0…da6b`, 2026-07-23):** with an unfunded line the withdraw cannot execute; after passing a `setCreditInfo(token, 500e18)` proposal, the same `monthly_withdraw` created → validator-voted → `executeInternalProposal` **succeeded** and the destination received the tokens. No firewall involved.

**Impact.** P3 (was P2): fully workable — fund the credit line first. dexe-mcp 0.29 refuses an uncovered `monthly_withdraw` up-front with the funding recipe and exposes the credit lines via `dexe_read_validators`.

**Suggested remediation (UX).** Bubble up the inner revert data in `GovValidatorsExecute.executeInternalProposal` (re-revert with the inner returndata instead of the generic string) so integrators and the UI see `"GPC: Current credit permission < amount to withdraw"` directly.

---

## #35 / #36 / F4 — Inconsistent multicall / raw-call policy (P2, integrator hazard)

The same firewall enforces **opposite rules** across GovPool flows. There is no documented principle for which shape is required where; each was found by on-chain trial.

### #35 — bundled `multicall([deposit, createProposalAndVote])` is BLOCKED

- **Symptom:** the create bundle reverts `"SphereX error: disallowed tx pattern"`.
- **Diagnosis (verified live, chain 97, DAO `0x390A7Ab0B0bD7e3dF8faE5ed65862292D78D6230`):** `deposit` alone = OK; `createProposalAndVote` alone = OK; the two wrapped in one `multicall` = revert.
- **Rule learned:** deposit and create must be **separate** transactions — do **not** bundle.
- **Tooling mitigation:** dexe-mcp (v0.22.0, `flow.ts`) never bundles; sends sequential resumable payloads.

### #36 — `execute → GovSettings.addSettings` is BLOCKED; `editSettings` is allowed

- **Symptom:** a `change_voting_settings` proposal *without* `settingsIds` encodes `GovSettings.addSettings`; it creates and votes fine but `GovPool.execute` reverts `"SphereX error: disallowed tx pattern"`. Deterministic (2/2 retries). Fresh pool Larkspur `0x9dEd437D…0F69`, 2026-07-19. **Re-confirmed 2026-07-23** on fresh pool Willowmere `0x4a14994b…4b6C` (chain 97).
- **Contrast:** the same proposal *with* `settingsIds` encodes `editSettings` and executes fine (proven for settingsId 0=DEFAULT and 1=INTERNAL; re-proven 2026-07-23 on Willowmere). `execute → TokenSaleProposal.createTiers` and `execute → ERC20.transfer` are NOT blocked on the same pool.
- **Chain asymmetry (2026-07-23):** on **mainnet (56)** the addSettings route now EXECUTES on a fresh pool — `enable_staking` proposal 3 on Aurora `0xa56BE71a…57B8` reached `ExecutedFor` (2026-07-22). Testnet (97) still blocks it. Independent evidence that testnet runs an older protocol deployment: a fresh 97 pool's `GovUserKeeper` has no `stakingProposalAddress()` (predates staking support), while same-day mainnet pools have it. **If addSettings was deliberately allowlisted on mainnet, please mirror the fix to the testnet factory** — integrators validate on 97 first and currently hit a wall that no longer exists on 56.
- **Blast radius:** `change_voting_settings` (no ids), `new_proposal_type`, `enable_staking` — all `addSettings`-based.
- **Tooling mitigation:** steer to `editSettings` (pass `settingsIds`); PLAYBOOK KB row `settings-ids-semantics`.

### F4 — raw `vote()` / `delegate()` are BLOCKED; single-element `multicall([call])` is REQUIRED

- **Symptom:** raw top-level `vote()` / `delegate()` revert `"SphereX error: disallowed tx pattern"` on fresh pools — proven by a raw broadcast that bypassed the client-side sim guard: tx `0x56e28e0d…4e4a`, **status 0** (chain 97).
- **Root cause:** the frontend NEVER calls vote/delegate raw — it always sends `govPool.multicall([… , vote|delegate])`, even for a single call. Verified: `src/hooks/dao/useGovPoolVote.ts:134` and `:194` (`govPool.multicall(params)`); `src/hooks/dao/useGovPoolDelegate.ts:39` (`govPool.multicall(params)`).
- **Proven workaround (both status 1, Evergreen `0x5025681B…b9E3`):** `multicall([vote])` tx `0x8b66eb99…77cb`; `multicall([delegate])` tx `0xe575dc35…6cfc`. Note: multi-element shapes like `multicall([vote, vote])` are rejected.
- **Tooling mitigation:** dexe-mcp emits `multicall`-wrapped vote/delegate since v0.24.1.

**The inconsistency.** #35 says *"don't wrap create in multicall — send raw separate txs."* F4 says *"don't send vote raw — you MUST wrap it in multicall."* These are direct inverses. An integrator cannot derive the rule for a new selector from first principles; the allowlist has to be probed on-chain per flow.

**Impact.** P2. No funds loss where a workaround exists, but every new write path is a landmine: correct behavior on old fixtures, revert on fresh pools, and the fix direction (add wrap vs. remove wrap) differs per call.

**Suggested remediation.** Publish the SphereX per-pool allowlist policy (which selectors require raw vs. `multicall`-wrapped, and whether multi-element bundles are ever permitted), or normalize it so a single consistent shape works across GovPool write methods. Ideally, allowlist both the raw and single-element-`multicall` shapes for the common write methods so integrators aren't shape-locked.

---

## C-2 — governance-validation issue (details withheld)

One additional protocol-side governance-validation weakness (not a SphereX
item) is documented privately. dexe-mcp ships a harm-reduction guard for it
(`src/lib/dangerousSelectors.ts`, since v0.8.3), but the real fix requires a
contract-side change. **Full mechanism, contract line-refs, and a reproducible
sequence are available to the DeXe security team on request** — deliberately
withheld from this public document.

---

## Summary table

| ID | Contract / method | Blocked shape(s) | Working shape | Workaround | Severity | Frontend also affected? |
| --- | --- | --- | --- | --- | --- | --- |
| **F15** | `TokenSaleProposal.vestingWithdraw` | raw + `multicall([claim,vestingWithdraw])` (every shape) | none | **none — funds stranded** | **P1 funds-loss** | **Yes (confirmed)** |
| **F12** | `GovValidators.cancelVote{Internal,External}Proposal` | raw (no multicall exists on contract) | none | **none** | P2 | Yes |
| **F14** | `GovValidators.executeInternalProposal` (monthly_withdraw) | — root-caused: unfunded credit line, NOT SphereX; revert string masks the cause | fund via `setCreditInfo` first | validators_allocation proposal | P3 (UX: bubble up inner revert) | Yes (same masked error) |
| **#35** | `GovPool.multicall([deposit, createProposalAndVote])` | bundled multicall | separate raw txs | send deposit + create separately | P2 | Yes (unbundle) |
| **#36** | `GovPool.execute → GovSettings.addSettings` | `addSettings` — **testnet 97 only** (mainnet 56 fixed as of 2026-07-22) | `editSettings` (with settingsIds); any shape on 56 | pass `settingsIds` on 97 | P2 | Yes (on 97) |
| **F4** | `GovPool.vote()` / `delegate()` | **raw** call | `multicall([call])` single-element | wrap in single-element multicall | P2 | No (frontend always wraps) |
| **C-2** | (withheld — governance validation, not SphereX) | — | — | MCP denylist (harm-reduction) | details on request | N/A |

**Cross-cutting note.** F15/F12/F14 have **no** client-side workaround and require a protocol change. #35/#36/F4 are workable today but expose an inconsistent, undocumented allowlist policy that makes every new GovPool write path a per-selector on-chain guessing game. We recommend (a) allowlisting the funds-loss/no-workaround selectors as the priority, and (b) publishing or normalizing the raw-vs-multicall policy.

**References:** dexe-mcp `docs/PLAYBOOK.md` (KB rows `otc-vesting-broken`, `spherex-create-pattern`, `spherex-vote-multicall`, `validator-cancel-blocked`, `settings-ids-semantics`); campaign `D:\dev\dao-e2e-kit\campaigns\2026-07-21-full-verify\FINDINGS.md` (F4/F12/F14/F15).
