/**
 * Advisory warnings for proposal/DAO configurations that are governance-safety
 * risks. These surface in the relevant builder's human-readable output so a
 * reviewer/agent doesn't unknowingly ship a degraded-governance configuration.
 * Advisory only — verify settings against your DAO's policy.
 */

import { Interface } from "ethers";
import { quorumPctFromRaw, judgeQuorum, lowQuorumAdvisory } from "./quorumRisk.js";
import { checkTokensUnlocked } from "./preflight.js";

function toBig(s: string): bigint | null {
  return /^[0-9]+$/.test(s) ? BigInt(s) : null;
}

// ==========================================================================
// Upstream protocol traps — pre-blocked at BUILD time, not after the revert
// ==========================================================================
//
// Everything below this line warns about a defect in the DEPLOYED PROTOCOL,
// not in dexe-mcp. Each one is deterministic and knowable before any gas is
// spent, so the tools refuse or DANGER-flag it BEFORE emitting a payload
// instead of letting the caller discover it from a revert receipt.
//
// `docs/UPSTREAM-ISSUES.md` is the authoritative description of every id used
// here; keep the two in sync.

/** Path to the authoritative write-up, quoted in every advisory. */
export const UPSTREAM_DOC = "docs/UPSTREAM-ISSUES.md";

export interface UpstreamAdvisory {
  /** Issue id as filed in docs/UPSTREAM-ISSUES.md — "F15", "F12", "#36". */
  readonly id: string;
  /** DANGER = funds or governance can be lost; WARN = the call will just fail. */
  readonly severity: "DANGER" | "WARN";
  /** Where the caller reads the full story. */
  readonly upstream: string;
  /** Ready-to-surface text, already prefixed with its severity marker. */
  readonly text: string;
}

function upstream(id: string, severity: UpstreamAdvisory["severity"], body: string): UpstreamAdvisory {
  const ref = `${UPSTREAM_DOC} (${id})`;
  return {
    id,
    severity,
    upstream: ref,
    text: `⚠ ${severity} — UPSTREAM PROTOCOL DEFECT ${id} (not a dexe-mcp bug): ${body} See ${ref}.`,
  };
}

/** Join advisories into one block for a tool's human-readable output. */
export function renderAdvisories(
  list: readonly (UpstreamAdvisory | null | undefined)[],
): string | null {
  const texts = list.filter((a): a is UpstreamAdvisory => Boolean(a)).map((a) => a.text);
  return texts.length > 0 ? texts.join("\n\n") : null;
}

// ---------- F15 — TokenSaleProposal.vestingWithdraw is blocked (funds-loss) --

/**
 * F15: on every SphereX-era pool, `vestingWithdraw` reverts in EVERY call shape
 * (raw and multicall-wrapped — the DeXe frontend uses only those two, so the
 * official UI fails identically). A tier opened with `vestingPercentage > 0`
 * therefore strands its vested allocation permanently. `claim` (the instant
 * portion) still works.
 */
export const VESTING_WITHDRAW_ADVISORY = upstream(
  "F15",
  "DANGER",
  "TokenSaleProposal.vestingWithdraw reverts \"SphereX error: disallowed tx pattern\" in every call shape on " +
    "current pools, so the VESTED portion of a purchase can never be withdrawn — the tokens are stranded, with " +
    "no client-side workaround. Only `claim` (the instant portion) works. Open tiers with vestingPercentage " +
    "\"0\" and hold back the remainder off-chain, or wait for the protocol fix.",
);

/** A tier whose vesting leg would be stranded by F15. */
export interface VestingTierRisk {
  /** Position in the caller's `tiers` array. */
  readonly index: number;
  readonly name: string;
  /** Human percent, as supplied (the on-chain value is this × 1e25). */
  readonly vestingPercentage: string;
}

/** True when a human-percent vesting string asks for a non-zero vested leg. */
export function hasVestingLeg(vestingPercentage: string | undefined): boolean {
  if (vestingPercentage === undefined) return false;
  const n = Number(vestingPercentage);
  return Number.isFinite(n) && n > 0;
}

/**
 * F15 pre-block for sale creation: find every tier that would strand funds.
 * Runs on the caller's raw tier specs, BEFORE any calldata is encoded.
 */
export function findVestingTiers(
  tiers: readonly { name?: string; vestingSettings?: { vestingPercentage?: string } }[],
): VestingTierRisk[] {
  const out: VestingTierRisk[] = [];
  tiers.forEach((t, index) => {
    const pct = t.vestingSettings?.vestingPercentage;
    if (hasVestingLeg(pct)) {
      out.push({ index, name: t.name ?? `tier[${index}]`, vestingPercentage: pct! });
    }
  });
  return out;
}

/** The machine-readable refusal report for a blocked vesting leg. */
export interface VestingBlockedReport {
  readonly tierIds: string[];
  readonly reason: string;
  readonly upstream: string;
  /** The exact opt-in that overrides the refusal. */
  readonly overrideWith: string;
}

export function vestingBlockedReport(
  tierIds: readonly string[],
  overrideWith: string,
): VestingBlockedReport {
  return {
    tierIds: [...tierIds],
    reason:
      "TokenSaleProposal.vestingWithdraw is blocked by the pool's SphereX firewall in every call shape " +
      "(upstream F15) — broadcasting it burns gas on a guaranteed revert and cannot release the vested tokens.",
    upstream: VESTING_WITHDRAW_ADVISORY.upstream,
    overrideWith,
  };
}

// ---------- #36 — GovSettings.addSettings bricks at execute on chain 97 ------

/**
 * `addSettings((bool,bool,bool,uint64,uint64,uint64,uint128,uint128,uint256,
 * uint256,(address,uint256,uint256,uint256),string)[])`. Pinned by a test that
 * recomputes it from the ABI the builders actually encode with, so a struct
 * reorder cannot silently disarm the guard.
 */
export const ADD_SETTINGS_SELECTOR = new Interface([
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
])
  .getFunction("addSettings")!
  .selector;

/**
 * Chains whose deployed protocol still rejects `execute → addSettings`.
 * BSC testnet (97) runs an older factory than mainnet: #36 was allowlisted on
 * 56 on 2026-07-22 and never mirrored to 97. Everything else is presumed fine
 * — this list only grows from measured evidence.
 */
export const ADD_SETTINGS_BLOCKED_CHAINS: readonly number[] = [97];

export function isAddSettingsBlockedChain(chainId: number): boolean {
  return ADD_SETTINGS_BLOCKED_CHAINS.includes(chainId);
}

function addSettingsAdvisory(chainId: number): UpstreamAdvisory {
  return upstream(
    "#36",
    "DANGER",
    `on chain ${chainId} a proposal whose action calls GovSettings.addSettings (${ADD_SETTINGS_SELECTOR}) ` +
      "creates and passes the vote normally and then reverts \"SphereX error: disallowed tx pattern\" at " +
      "GovPool.execute — deterministically, so the proposal is bricked and the voting period is wasted. This hits " +
      "change_voting_settings WITHOUT settingsIds, new_proposal_type and enable_staking. Fix: EDIT an existing " +
      "settings slot instead (pass settingsIds — editSettings is always allowed), or run the flow on BSC mainnet " +
      "(56), where the same call executes.",
  );
}

/** Indices of the actions whose calldata is an `addSettings` call. */
export function findAddSettingsActions(
  actions: readonly { data?: string | null }[],
): number[] {
  const out: number[] = [];
  actions.forEach((a, i) => {
    const d = a?.data;
    if (typeof d === "string" && d.toLowerCase().startsWith(ADD_SETTINGS_SELECTOR)) out.push(i);
  });
  return out;
}

export interface AddSettingsTrap {
  /** True when this build WOULD brick at execute on the target chain. */
  readonly blocked: boolean;
  /** Which actions carry the blocked selector. */
  readonly actionIndices: number[];
  readonly advisory: UpstreamAdvisory | null;
}

/**
 * The single chain-aware #36 guard. Every proposal builder that can emit an
 * `addSettings` action funnels through this rather than re-deriving the rule:
 * it works off the emitted CALLDATA, so it catches the trap no matter which
 * builder (or hand-rolled custom_abi action) produced it.
 */
export function checkAddSettingsTrap(args: {
  chainId: number;
  actions: readonly { data?: string | null }[];
}): AddSettingsTrap {
  const actionIndices = findAddSettingsActions(args.actions);
  const blocked = actionIndices.length > 0 && isAddSettingsBlockedChain(args.chainId);
  return {
    blocked,
    actionIndices,
    advisory: blocked ? addSettingsAdvisory(args.chainId) : null,
  };
}

/**
 * Chain-scoped warning for `GovPool.execute` itself, which cannot see the
 * proposal's actions: #36 fires AT execute, so this is the last point before
 * the revert at which the caller can be told. Null on unaffected chains.
 */
export function executeAddSettingsAdvisory(chainId: number): UpstreamAdvisory | null {
  if (!isAddSettingsBlockedChain(chainId)) return null;
  return upstream(
    "#36",
    "WARN",
    `chain ${chainId} still blocks GovPool.execute when the proposal's action is GovSettings.addSettings ` +
      `(${ADD_SETTINGS_SELECTOR}) — change_voting_settings without settingsIds, new_proposal_type and ` +
      "enable_staking all revert here after passing the vote. If this proposal is one of those, do not spend gas: " +
      "re-create it against an existing settings slot (settingsIds → editSettings), or execute on BSC mainnet (56).",
  );
}

// ---------- F12 — validator votes are irrevocable on fresh pools ------------

/**
 * F12: `GovValidators.cancelVote{Internal,External}Proposal` is blocked and
 * `GovValidators` exposes no `multicall`, so — unlike the GovPool F4 case —
 * there is no wrapping trick that works. A validator vote is final.
 */
export const VALIDATOR_CANCEL_VOTE_ADVISORY = upstream(
  "F12",
  "WARN",
  "GovValidators.cancelVote{Internal,External}Proposal reverts \"SphereX error: disallowed tx pattern\" on fresh " +
    "(SphereX-era) pools and GovValidators has no multicall entrypoint, so there is NO client-side workaround — " +
    "this call will simply burn gas there. It still works on pre-SphereX pools. What does work everywhere: " +
    "voteInternalProposal / voteExternalProposal, including a top-up re-vote in the same direction.",
);

/**
 * Same defect, stated for the moment a validator proposal is CREATED — that is
 * the last point at which the DAO can decide not to put an irrevocable vote in
 * front of its validators.
 */
export const VALIDATOR_VOTE_IRREVOCABLE_ADVISORY = upstream(
  "F12",
  "WARN",
  "once this reaches the validator chamber, a validator who has voted CANNOT take it back — " +
    "cancelVoteInternalProposal / cancelVoteExternalProposal are blocked on fresh (SphereX-era) pools with no " +
    "workaround (GovValidators has no multicall). Brief your validators before they vote; a top-up re-vote in the " +
    "same direction is the only move they keep.",
);

// ---------- Mode 5 — deposited tokens stay locked after a vote/execute -------

/**
 * The remedy text is READ OUT OF the preflight guard rather than restated, so
 * the two can never drift. `checkTokensUnlocked` had been written for exactly
 * this trap and then never called from production code — the lock was only ever
 * handled after a revert. These two exports are what make it live: the constant
 * ships the warning BEFORE the execute that creates the lock, and
 * `lockedPowerAdvisory` lets any caller holding live power figures flag it
 * before a vote that would under-count.
 */
const TOKENS_LOCKED_REMEDY = checkTokensUnlocked(1n, 0n).remediation!;

export const POST_EXECUTE_LOCK_ADVISORY: UpstreamAdvisory = {
  id: "tokens-locked-after-execute",
  severity: "WARN",
  upstream: `${UPSTREAM_DOC} (deposit lock)`,
  text:
    "⚠ WARN — deposit lock: executing a proposal does NOT release your deposited tokens; they stay locked and your " +
    `available voting power reads 0 until you withdraw. ${TOKENS_LOCKED_REMEDY}`,
};

/**
 * Live form of the same guard: pass the voter's deposited and currently
 * available power and get the DANGER advisory back when the lock is present.
 * Null when there is nothing to warn about.
 */
export function lockedPowerAdvisory(
  depositedPower: bigint,
  availablePower: bigint,
): UpstreamAdvisory | null {
  const r = checkTokensUnlocked(depositedPower, availablePower);
  if (r.ok) return null;
  return {
    id: "tokens-locked-after-execute",
    severity: "DANGER",
    upstream: `${UPSTREAM_DOC} (deposit lock)`,
    text: `⚠ DANGER — deposit lock: ${r.remediation}${r.detail ? ` (${r.detail})` : ""}`,
  };
}

/** Seconds. A validator phase beyond this is almost certainly a mistake — and keeps deposits locked. */
export const DURATION_VALIDATORS_SANITY_CAP = 2_592_000n; // 30 days

/**
 * Flag degraded-governance GovSettings: zero-delay execution (no timelock),
 * auto-defeating validator quorum, and an unbounded validator phase that can
 * keep deposits locked for its duration. Configure these against your DAO's policy.
 */
export function settingsAdvisories(
  s: {
    validatorsVote: boolean;
    durationValidators: string;
    executionDelay: string;
    quorumValidators: string;
    quorum?: string;
  },
  floorPct = 50,
): string[] {
  const out: string[] = [];
  // Low quorum reduces the participation required to pass a proposal — a
  // governance-safety risk for treasury-moving proposals.
  if (s.quorum !== undefined) {
    const pct = quorumPctFromRaw(s.quorum);
    if (judgeQuorum(pct, floorPct) !== "SAFE") {
      out.push(lowQuorumAdvisory(pct, floorPct));
    }
  }
  if (toBig(s.executionDelay) === 0n) {
    out.push(
      "executionDelay=0 → no timelock: a passed proposal executes immediately, leaving no window to review it before it takes effect. Set a non-zero execution delay (a 1-day minimum is recommended for standard governance).",
    );
  }
  if (s.validatorsVote) {
    if (toBig(s.quorumValidators) === 0n) {
      out.push(
        "quorumValidators=0 with validatorsVote=true → every validator proposal auto-defeats (governance stalls). Set a non-zero validator quorum.",
      );
    }
    const dv = toBig(s.durationValidators);
    if (dv !== null && dv > DURATION_VALIDATORS_SANITY_CAP) {
      out.push(
        `durationValidators=${s.durationValidators}s (> 30 days) → deposits stay locked for the whole validator phase, so a very large value can lock voters' funds for an extended period. Use a sane validator duration.`,
      );
    }
  }
  return out;
}

/** changeVotePower swaps the DAO's vote-power math contract — a privileged, governance-wide change. */
export const CHANGE_VOTE_POWER_ADVISORY =
  "⚠ changeVotePower swaps the DAO's entire vote-power math contract — a privileged, governance-wide change (reversible only by another passed proposal). Verify the new VotePower address before proposing. [governance-safety advisory]";

/** custom_abi can encode ANY call; ensure actions route to registered executors. */
export const CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY =
  "⚠ custom_abi encodes an arbitrary call with no semantic validation. Ensure every proposal action routes to a properly registered executor so the DAO's internal access controls apply, and keep the final action's executor a registered one. Privileged accounting selectors are refused by the MCP's selector guard. [governance-safety advisory]";
