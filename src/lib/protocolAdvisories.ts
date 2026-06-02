/**
 * Advisory warnings for proposal configurations whose root cause is a DeXe
 * *contract* property the MCP cannot fix — it can only flag them (the full
 * write-up for the protocol team is docs/ESCALATION-DEXE.md). These surface in
 * the relevant builder's human-readable output so a reviewer/agent doesn't
 * unknowingly ship a degraded-governance configuration.
 */

function toBig(s: string): bigint | null {
  return /^[0-9]+$/.test(s) ? BigInt(s) : null;
}

/** Seconds. A validator phase beyond this is almost certainly a mistake — and freezes deposits (H-11). */
export const DURATION_VALIDATORS_SANITY_CAP = 2_592_000n; // 30 days

/**
 * Flag degraded-governance GovSettings: zero-delay execution (no timelock),
 * auto-defeating validator quorum, and an unbounded validator phase that
 * freezes every voter's deposit. All three are unfixable in the MCP — the
 * deployed contracts enforce no such bounds (H-11, executionDelay=0).
 */
export function settingsAdvisories(s: {
  validatorsVote: boolean;
  durationValidators: string;
  executionDelay: string;
  quorumValidators: string;
}): string[] {
  const out: string[] = [];
  if (toBig(s.executionDelay) === 0n) {
    out.push(
      "executionDelay=0 → no timelock: a passed proposal executes immediately, leaving no window to react to a malicious-but-passed action (amplifies C-2). DeXe contracts enforce no minimum — set a non-zero delay.",
    );
  }
  if (s.validatorsVote) {
    if (toBig(s.quorumValidators) === 0n) {
      out.push(
        "quorumValidators=0 with validatorsVote=true → every validator proposal auto-defeats (governance DoS). DeXe contracts enforce no lower bound.",
      );
    }
    const dv = toBig(s.durationValidators);
    if (dv !== null && dv > DURATION_VALIDATORS_SANITY_CAP) {
      out.push(
        `durationValidators=${s.durationValidators}s (> 30 days) → GovSettings has NO upper bound and deposits stay LOCKED for the whole validator phase (GovPoolUnlock excludes ValidatorVoting), so a huge value freezes every voter's funds (H-11).`,
      );
    }
  }
  return out;
}

/** changeVotePower swaps the DAO's vote-power math contract — a privileged, governance-wide change. */
export const CHANGE_VOTE_POWER_ADVISORY =
  "⚠ changeVotePower swaps the DAO's entire vote-power math contract — a privileged, governance-wide change (reversible only by another passed proposal). Verify the new VotePower address before proposing. [protocol-property — see docs/ESCALATION-DEXE.md]";

/** custom_abi can encode ANY call; the C-2 surface is privileged selectors routed via DEFAULT. */
export const CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY =
  "⚠ custom_abi encodes an arbitrary call with no semantic validation. If the LAST proposal action routes to an unregistered executor (settingsId=DEFAULT), the INTERNAL allowlist is skipped for ALL earlier actions — the C-2 amplifier. (Privileged GovUserKeeper selectors are hard-refused by the C-2 guard.) Keep the last action's executor a registered one. [protocol-property — see docs/ESCALATION-DEXE.md]";
