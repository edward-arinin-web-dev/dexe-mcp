import { describe, it, expect } from "vitest";
import {
  previewBlock,
  prereqsBlock,
  votedWithFields,
  postVoteNextStep,
} from "../../src/tools/flow.js";

/**
 * ── The four questions, and the numbers a human can read ────────────────────
 *
 * D15-2 / D15-4 / D15-10 / D15-11. Before 0.34.0 a composite response answered
 * none of "what does this do", "whose wallet pays", "how many transactions" and
 * "what cannot be undone", and it printed every amount as raw wei — 24 digits
 * that differ from the amount a thousand times larger by three characters.
 *
 * The blocks are exported and unit-tested here because the handlers that emit
 * them (dexe_proposal_vote_and_execute in particular) are not exported: they
 * exist only inside `registerFlowTools`.
 */

const ONE = 10n ** 18n;

/** Minimal `Prereqs` — only the fields prereqsBlock reads carry meaning. */
function prereqs(over: Partial<Record<string, unknown>> = {}): never {
  return {
    userKeeper: "0x3333333333333333333333333333333333333333",
    settings: "0x2222222222222222222222222222222222222222",
    tokenAddress: "0x5555555555555555555555555555555555555555",
    walletBalance: 0n,
    currentAllowance: 0n,
    depositedPower: 153000n * ONE,
    minVotesForCreating: ONE,
    minVotesForVoting: 0n,
    tokenDecimals: 18,
    tokenSymbol: "QWT",
    ...over,
  } as never;
}

describe("prereqsBlock — human companions, legacy keys untouched", () => {
  it("renders every amount in human units AND keeps the raw wei string", () => {
    const b = prereqsBlock(prereqs());
    // Back-compat: the wei keys are the published contract and never change.
    expect(b.depositedPower).toBe("153000000000000000000000");
    expect(b.walletBalance).toBe("0");
    expect(b.allowance).toBe("0");
    expect(b.minVotesForCreating).toBe("1000000000000000000");
    // …and the reason this finding exists: 24 digits is not a readable number.
    expect(b.depositedPowerHuman).toBe("153000.0 QWT");
    expect(b.minVotesForCreatingHuman).toBe("1.0 QWT");
  });

  it("publishes the decimals and symbol, so a caller can convert for itself", () => {
    const b = prereqsBlock(prereqs());
    expect(b.tokenDecimals).toBe(18);
    expect(b.tokenSymbol).toBe("QWT");
  });

  it("uses the token's real decimals, never a hard-coded 18", () => {
    const b = prereqsBlock(prereqs({ depositedPower: 153000n * 10n ** 6n, tokenDecimals: 6 }));
    expect(b.depositedPowerHuman).toBe("153000.0 QWT");
  });

  it("a symbol that could not be read leaves no trailing space or 'undefined'", () => {
    const b = prereqsBlock(prereqs({ depositedPower: ONE, tokenSymbol: "" }));
    expect(b.depositedPowerHuman).toBe("1.0");
  });

  it("never prints the same wei twice — the human form carries no (raw …) tail", () => {
    const b = prereqsBlock(prereqs());
    expect(String(b.depositedPowerHuman)).not.toContain("raw");
  });

  it("says the figures predate this call's transactions", () => {
    // They are read before approve+deposit land, so in mode:'executed' they are
    // already stale by the deposit amount. Rendering them readably without
    // saying so invites "your wallet holds X" after X already moved.
    expect(String(prereqsBlock(prereqs()).asOf)).toMatch(/before this call/i);
  });
});

describe("previewBlock — who pays, what happens, how many txs, what is permanent", () => {
  const base = {
    chainId: 97,
    act: "Creates proposal \"Fund the grants pool\" on 0xabc — transfers 10 TST.",
    txCount: 3,
    irreversible: "A created proposal cannot be deleted or edited.",
    broadcast: false,
    next: "Re-run with dryRun:false.",
  };

  it("names the payer by keyring label AND address", () => {
    const { preview } = previewBlock({
      ...base,
      who: { signerKey: "agent2", address: "0x000000000000000000000000000000000000dEaD" },
    });
    expect(preview.whoPays).toContain("agent2");
    expect(preview.whoPays).toContain("0x000000000000000000000000000000000000dEaD");
    expect(preview.whoPays).toContain("chain 97");
  });

  it("with no key configured, says so instead of naming nobody", () => {
    const { preview } = previewBlock(base);
    expect(String(preview.whoPays)).toMatch(/no signing key/i);
    // Not a copy of ENABLE_WRITES_HINT: that is ~800 chars and already sits in
    // the same response under `enableWrites`.
    expect(String(preview.whoPays).length).toBeLessThan(160);
  });

  it("carries the act, the tx count and the irreversibility sentence", () => {
    const { preview } = previewBlock(base);
    expect(preview.whatHappens).toBe(base.act);
    expect(preview.txCount).toBe(3);
    expect(preview.irreversible).toBe(base.irreversible);
  });

  it("flags mainnet (1 and 56) and only mainnet", () => {
    expect(previewBlock({ ...base, chainId: 56 }).preview.mainnet).toBe(true);
    expect(previewBlock({ ...base, chainId: 1 }).preview.mainnet).toBe(true);
    expect(previewBlock({ ...base, chainId: 97 }).preview.mainnet).toBe(false);
  });

  it("`broadcast` is what makes every tense honest", () => {
    expect(previewBlock({ ...base, broadcast: true }).preview.broadcast).toBe(true);
    expect(previewBlock(base).preview.broadcast).toBe(false);
  });

  it("nests `next` under preview — the top-level key belongs to flowChain", () => {
    const out = previewBlock(base);
    // A top-level `next: string` would clobber FlowChainFields.next (an ARRAY
    // of guide pointers) in every dexe_guide-driven journey.
    expect(Object.keys(out)).toEqual(["preview"]);
    expect(out.preview.next).toBe("Re-run with dryRun:false.");
  });

  it("omits `next` for a surface that already carries its own", () => {
    const { preview } = previewBlock({ ...base, next: undefined });
    expect("next" in preview).toBe(false);
  });

  it("stays small — this rides on every composite response", () => {
    expect(JSON.stringify(previewBlock(base)).length).toBeLessThan(700);
  });
});

describe("votedWithFields — never publish an amount that was not voted", () => {
  it("a vote cast by THIS call reports the amount it cast", () => {
    const f = votedWithFields(false, null, 10n * ONE, 18, "TST");
    expect(f.votedWith).toBe("10000000000000000000");
    expect(f.votedWithHuman).toBe("10.0 TST");
    expect(f.votedWithSource).toBe("this call");
  });

  it("an already-cast vote reports the PRIOR on-chain amount, not the intended one", () => {
    // voteAmt is what the call WOULD have used; the vote leg was skipped, so
    // reporting it would publish a number nobody ever voted.
    const f = votedWithFields(true, { tokensVoted: 7n * ONE }, 10n * ONE, 18, "TST");
    expect(f.votedWith).toBe("7000000000000000000");
    expect(f.votedWithSource).toBe("prior on-chain vote");
  });

  it("an already-cast vote whose prior read failed reports NOTHING", () => {
    expect(votedWithFields(true, null, 10n * ONE, 18, "TST")).toEqual({});
  });
});

describe("postVoteNextStep — one remedy per state, not one for all five", () => {
  const G = "0x1111111111111111111111111111111111111111";
  const at = (state: number) => postVoteNextStep(state, G, 3, 97);

  it("Voting: more holders must vote", () => {
    expect(at(0)).toMatch(/quorum is not reached yet/i);
    expect(at(0)).toContain(`dexe_proposal_vote_and_execute {"govPool":"${G}","proposalId":3,"chainId":97}`);
  });

  it("WaitingForVotingTransfer / ValidatorVoting: quorum IS reached — never 'more power needed'", () => {
    for (const s of [1, 2]) {
      expect(at(s), `state ${s}`).toMatch(/quorum IS reached/i);
      expect(at(s), `state ${s}`).not.toMatch(/more voting power is needed/i);
      expect(at(s), `state ${s}`).toContain("driveValidatorRound");
    }
  });

  it("Defeated: voting is over, a new proposal is the only move", () => {
    expect(at(3)).toMatch(/DEFEATED/);
    expect(at(3)).toContain("dexe_proposal_create");
    expect(at(3)).not.toContain("driveValidatorRound");
  });

  it("Locked: the remedy is the execution delay, not votes", () => {
    expect(at(6)).toMatch(/execution delay/i);
    expect(at(6)).not.toMatch(/quorum is not reached/i);
  });

  it("every state names a callable tool with its exact params", () => {
    for (const s of [0, 1, 2, 3, 6]) {
      expect(at(s), `state ${s}`).toMatch(/dexe_\w+ \{|dexe_proposal_create/);
    }
  });
});
