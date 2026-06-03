import { describe, expect, it } from "vitest";
import { decodeProposalView, GET_PROPOSALS_FRAGMENT } from "../../src/lib/govProposalView.js";
import { Interface } from "ethers";

/**
 * The shared ProposalView decoder feeds the flow execute-gate and
 * dexe_proposal_risk_assess. Its index mapping is the load-bearing part — if it
 * drifts from IGovPool.ProposalView the wrong field is read silently. These
 * tests pin the mapping against a synthetic tuple and prove fail-soft on junk.
 */

const TOKEN = "0x2222222222222222222222222222222222222222";

// settings tuple: [earlyCompletion, delegatedVotingAllowed, validatorsVote,
// duration, durationValidators, executionDelay, quorum(idx6), quorumValidators,
// minVotesForVoting, minVotesForCreating, rewardsInfo, executorDescription]
function makeView() {
  const settings = [false, false, true, 0n, 0n, 0n, 5n * 10n ** 26n, 0n, 0n, 0n, [], ""];
  const core = [settings, 100n, 200n, false, 123n, 4n, 0n, 0n, 0n];
  const actionsOnFor = [[TOKEN, 0n, "0xabcdef"]];
  const proposal = [core, "ipfs://desc", actionsOnFor, []];
  const validatorProposal = [[false, 0n, 0n, 0n, 0n, 0n, 0n]];
  return [proposal, validatorProposal, 4, 999n, 0n];
}

describe("decodeProposalView", () => {
  it("maps every field to the right index", () => {
    const d = decodeProposalView(makeView())!;
    expect(d).not.toBeNull();
    expect(d.quorumRaw).toBe(5n * 10n ** 26n); // settings[6]
    expect(d.votesFor).toBe(123n); // core[4]
    expect(d.votesAgainst).toBe(4n); // core[5]
    expect(d.requiredQuorum).toBe(999n); // view[3]
    expect(d.proposalState).toBe(4); // view[2]
    expect(d.descriptionURL).toBe("ipfs://desc");
    expect(d.actionsOnFor).toEqual([{ executor: TOKEN, value: "0", data: "0xabcdef" }]);
    expect(d.actionsOnAgainst).toEqual([]);
  });

  it("returns null on structurally invalid input (fail-soft)", () => {
    expect(decodeProposalView(null)).toBeNull();
    expect(decodeProposalView([])).toBeNull();
    expect(decodeProposalView(undefined)).toBeNull();
    expect(decodeProposalView("nope")).toBeNull();
  });
});

describe("GET_PROPOSALS_FRAGMENT", () => {
  it("is a parseable getProposals view function", () => {
    const iface = new Interface([GET_PROPOSALS_FRAGMENT]);
    const fn = iface.getFunction("getProposals")!;
    expect(fn.inputs.map((i) => i.type)).toEqual(["uint256", "uint256"]);
    expect(fn.stateMutability).toBe("view");
  });
});
