import { describe, it, expect } from "vitest";
import { z } from "zod";
import { withdrawCallHint, voteLockAtCreateAdvisory } from "../../src/lib/protocolAdvisories.js";

/**
 * Live regression, 2026-09-24: every `dexe_proposal_create` and every
 * `dexe_proposal_vote_and_execute` printed
 *
 *   dexe_vote_build_withdraw {"govPool":"0x…","chainId":97}
 *
 * as the way to unlock the deposit — and `dexe_vote_build_withdraw` REQUIRES
 * `receiver` and `amount`, so the pasted call failed schema validation. The
 * hint now carries both, and the arguments it prints must pass the same shape
 * the tool enforces.
 */

const GOV = "0xe1fC51cdf1a1a3a3ee7997Da140d42EA9b4E1Fe2";
const ME = "0xCa543e570e4A1F6DA7cf9C4C7211692Bc105a00A";
const WEI = "350000000000000000000000";

/** The shape `dexe_vote_build_withdraw` validates (nftIds defaults). */
const WithdrawArgs = z.object({
  govPool: z.string(),
  receiver: z.string(),
  amount: z.string().regex(/^\d+$/),
  chainId: z.number().int(),
});

function argsOf(hint: string): unknown {
  const m = /^dexe_vote_build_withdraw (\{.*\})/.exec(hint);
  if (!m) throw new Error(`not a paste-able call: ${hint}`);
  return JSON.parse(m[1]!);
}

describe("withdrawCallHint", () => {
  it("prints a call that dexe_vote_build_withdraw accepts as-is", () => {
    const hint = withdrawCallHint({ govPool: GOV, chainId: 97, receiver: ME, amountWei: WEI });
    const parsed = WithdrawArgs.safeParse(argsOf(hint));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ govPool: GOV, receiver: ME, amount: WEI, chainId: 97 });
  });

  it("names the missing fields as placeholders when it cannot fill them, instead of dropping them", () => {
    const hint = withdrawCallHint({ govPool: GOV, chainId: 97 });
    expect(hint).toContain('"receiver":"<your address>"');
    expect(hint).toContain('"amount":"<deposited wei>"');
    expect(hint).toContain("raw wei");
  });
});

describe("voteLockAtCreateAdvisory carries the paste-able withdraw call", () => {
  it("includes receiver + raw amount when the caller knows them", () => {
    const a = voteLockAtCreateAdvisory({
      amount: "350000.0 TMG",
      broadcast: true,
      govPool: GOV,
      chainId: 97,
      proposalId: 1,
      receiver: ME,
      amountWei: WEI,
    });
    const m = /dexe_vote_build_withdraw (\{[^}]*\})/.exec(a.text);
    expect(m).not.toBeNull();
    expect(WithdrawArgs.safeParse(JSON.parse(m![1]!)).success).toBe(true);
    expect(a.text).toContain("are now locked");
  });
});
