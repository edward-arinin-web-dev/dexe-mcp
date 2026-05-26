import { describe, expect, it } from "vitest";
import { resolveGovernor } from "../../src/governor/loader.js";
import {
  GOVERNOR_BRAVO_READ_ABI,
  GOVERNOR_OZ_READ_ABI,
  projectVoteImpact,
  readProposal,
  readQuorum,
  readVotingPower,
  type VoteTally,
} from "../../src/governor/adapter.js";

/**
 * Pure-logic coverage for the read/projection layer that the offline suite
 * previously left untested (the live RPC paths are exercised only by the
 * network-gated parity tests). We stub the ethers Contract so the family
 * branching and struct mapping run without a node.
 */
function stubContract(handlers: Record<string, (...a: any[]) => any>): any {
  return {
    getFunction(name: string) {
      const h = handlers[name];
      if (!h) throw new Error(`stub contract: no handler for ${name}`);
      return { staticCall: async (...args: any[]) => h(...args) };
    },
  };
}

const uniswap = resolveGovernor("uniswap"); // Bravo + ERC20VotesComp
const optimism = resolveGovernor("optimism"); // OZ v4 + ERC20Votes

describe("readVotingPower — method routing by token type", () => {
  it("ERC20VotesComp (UNI) → getCurrentVotes when no block", async () => {
    let called = "";
    const c = stubContract({
      getCurrentVotes: (acc: string) => {
        called = "getCurrentVotes";
        expect(acc).toBe("0xabc");
        return 100n;
      },
    });
    const { power, method } = await readVotingPower(c, uniswap, "0xabc", undefined);
    expect(method).toBe("getCurrentVotes");
    expect(called).toBe("getCurrentVotes");
    expect(power).toBe(100n);
  });

  it("ERC20VotesComp (UNI) → getPriorVotes when block given", async () => {
    const c = stubContract({
      getPriorVotes: (acc: string, blk: number) => {
        expect(blk).toBe(123);
        return 55n;
      },
    });
    const { method, power } = await readVotingPower(c, uniswap, "0xabc", 123);
    expect(method).toBe("getPriorVotes");
    expect(power).toBe(55n);
  });

  it("ERC20Votes (OP) → getVotes / getPastVotes", async () => {
    const live = stubContract({ getVotes: () => 7n });
    expect((await readVotingPower(live, optimism, "0xabc", undefined)).method).toBe("getVotes");
    const past = stubContract({ getPastVotes: (_a: string, b: number) => (b === 9 ? 8n : 0n) });
    const r = await readVotingPower(past, optimism, "0xabc", 9);
    expect(r.method).toBe("getPastVotes");
    expect(r.power).toBe(8n);
  });
});

describe("readProposal — family-aware struct mapping", () => {
  it("Bravo proposals() flat struct maps onto OZ shape + bravoExtra", async () => {
    const c = stubContract({
      state: () => 1n,
      proposals: () => ({
        id: 7n,
        proposer: "0xPROPOSER",
        eta: 1234n,
        startBlock: 1000n,
        endBlock: 2000n,
        forVotes: 500n,
        againstVotes: 200n,
        abstainVotes: 50n,
        canceled: false,
        executed: true,
      }),
    });
    const r = await readProposal(c, uniswap, 7n);
    expect(r.state).toEqual({ index: 1, name: "Active" });
    expect(r.snapshotBlock).toBe("1000"); // startBlock
    expect(r.deadlineBlock).toBe("2000"); // endBlock
    expect(r.votes).toEqual({ against: "200", for: "500", abstain: "50" });
    expect(r.bravoExtra).toEqual({
      proposer: "0xPROPOSER",
      eta: "1234",
      canceled: false,
      executed: true,
    });
  });

  it("OZ proposalVotes returns [against, for, abstain] in that order", async () => {
    const c = stubContract({
      state: () => 4n,
      proposalSnapshot: () => 111n,
      proposalDeadline: () => 222n,
      proposalVotes: () => [9n, 90n, 3n], // against, for, abstain
    });
    const r = await readProposal(c, optimism, 1n);
    expect(r.state).toEqual({ index: 4, name: "Succeeded" });
    expect(r.snapshotBlock).toBe("111");
    expect(r.deadlineBlock).toBe("222");
    expect(r.votes).toEqual({ against: "9", for: "90", abstain: "3" });
    expect(r.bravoExtra).toBeUndefined();
  });
});

describe("projectVoteImpact — quorum semantics branch by family", () => {
  const base: VoteTally = { against: 0n, for: 0n, abstain: 0n };

  it("OZ counts for+abstain toward quorum; Bravo counts for only", () => {
    // Cast an Abstain of weight 100 against a quorum of 100.
    const oz = projectVoteImpact(false, base, 2, 100n, 100n);
    const bravo = projectVoteImpact(true, base, 2, 100n, 100n);
    expect(oz.projected.abstain).toBe(100n);
    expect(oz.quorumMet).toBe(true); // for(0)+abstain(100) >= 100
    expect(bravo.quorumMet).toBe(false); // for(0) < 100
  });

  it("willPass requires quorum met AND for > against", () => {
    // For=150 against=100 quorum=100 → quorum met, for>against → pass.
    const pass = projectVoteImpact(false, { against: 100n, for: 0n, abstain: 0n }, 1, 150n, 100n);
    expect(pass.projected.for).toBe(150n);
    expect(pass.quorumMet).toBe(true);
    expect(pass.willPass).toBe(true);

    // Same tallies but for <= against → fail despite quorum.
    const tie = projectVoteImpact(false, { against: 150n, for: 0n, abstain: 0n }, 1, 150n, 100n);
    expect(tie.quorumMet).toBe(true);
    expect(tie.willPass).toBe(false);
  });

  it("Against vote never helps pass", () => {
    const r = projectVoteImpact(true, base, 0, 999n, 1n);
    expect(r.projected.against).toBe(999n);
    expect(r.quorumMet).toBe(false); // bravo: for(0) < 1
    expect(r.willPass).toBe(false);
  });
});

describe("readQuorum — family + quorumSource branching", () => {
  it("Bravo (UNI) → fixed quorumVotes(), block ignored", async () => {
    const c = stubContract({ quorumVotes: () => 40_000_000n });
    const r = await readQuorum(c, uniswap, 99);
    expect(r.method).toBe("quorumVotes()");
    expect(r.quorum).toBe(40_000_000n);
  });

  it("OP (quorumSource=votable-supply) → votableSupply(block) * num/den, NOT quorum()", async () => {
    expect(optimism.quorumSource).toBe("votable-supply");
    let calledBlock = -1;
    const c = stubContract({
      votableSupply: (blk: number) => {
        calledBlock = blk;
        return 1000n;
      },
      // quorum() must NOT be called for OP — it returns 0 (keyed by proposalId).
      quorum: () => {
        throw new Error("quorum() should not be called for votable-supply governors");
      },
    });
    const r = await readQuorum(c, optimism, 152_000_000);
    expect(calledBlock).toBe(152_000_000);
    expect(r.method).toBe("votableSupply(blockNumber)*ratio");
    // optimism config: quorumNumerator 30 / quorumDenominator 100 → 1000 * 30/100.
    expect(r.quorum).toBe(300n);
  });

  it("vanilla OZ (no quorumSource) → quorum(blockNumber)", async () => {
    const vanilla = { ...optimism, quorumSource: undefined };
    const c = stubContract({ quorum: (blk: number) => (blk === 500 ? 12345n : 0n) });
    const r = await readQuorum(c, vanilla, 500);
    expect(r.method).toBe("quorum(blockNumber)");
    expect(r.quorum).toBe(12345n);
  });
});

describe("hashProposal ABI invariant — basis for the Bravo refusal", () => {
  it("OZ read ABI exposes hashProposal; Bravo read ABI does not", () => {
    const ozHas = GOVERNOR_OZ_READ_ABI.some((f) => f.includes("hashProposal"));
    const bravoHas = GOVERNOR_BRAVO_READ_ABI.some((f) => f.includes("hashProposal"));
    expect(ozHas).toBe(true);
    expect(bravoHas).toBe(false);
  });
});
