/**
 * Advisory warnings for proposal/DAO configurations that are governance-safety
 * risks. These surface in the relevant builder's human-readable output so a
 * reviewer/agent doesn't unknowingly ship a degraded-governance configuration.
 * Advisory only — verify settings against your DAO's policy.
 */

import { quorumPctFromRaw, judgeQuorum, lowQuorumAdvisory } from "./quorumRisk.js";

function toBig(s: string): bigint | null {
  return /^[0-9]+$/.test(s) ? BigInt(s) : null;
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
