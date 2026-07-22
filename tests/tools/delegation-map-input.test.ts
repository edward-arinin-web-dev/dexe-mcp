import { describe, expect, it } from "vitest";
import { toVoterAddress } from "../../src/tools/subgraph.js";
import { labelProposalSettings } from "../../src/tools/read.js";
import { transactionTypeLabels, proposalInteractionLabel } from "../../src/lib/interactionTypes.js";

const POOL = "0xbb1918019af8c6a26ff34ce8fb8305976e1f626d";
const VOTER = "0xca543e570e4a1f6da7cf9c4c7211692bc105a00a";

/**
 * F-UC2 regression: the delegation queries filter on wallet addresses
 * (`delegator_.voter_in`), but the tool used to DOCUMENT composite
 * 'govPool-voter' ids — passing one produced a subgraph store error
 * ("Odd number of digits"). All shapes must normalize to the wallet.
 */
describe("toVoterAddress (F-UC2)", () => {
  it("passes plain wallet addresses through (lowercased)", () => {
    expect(toVoterAddress(VOTER.toUpperCase().replace("0X", "0x"))).toBe(VOTER);
    expect(toVoterAddress(VOTER)).toBe(VOTER);
  });

  it("extracts the voter from 'govPool-voter' dash composites", () => {
    expect(toVoterAddress(`${POOL}-${VOTER}`)).toBe(VOTER);
  });

  it("extracts the voter from 80-hex VoterInPool ids (voter+pool)", () => {
    expect(toVoterAddress(`${VOTER}${POOL.slice(2)}`)).toBe(VOTER);
  });
});

describe("labelProposalSettings (F-UC5)", () => {
  it("labels the 12-field ProposalSettings tuple and derives quorum percents", () => {
    const tuple = [
      true, // earlyCompletion
      false, // delegatedVotingAllowed
      false, // validatorsVote
      "432000", // duration
      "432000", // durationValidators
      "1800", // executionDelay
      "510000000000000000000000000", // quorum = 51% × 1e25
      "510000000000000000000000000", // quorumValidators
      "13000000000000000000", // minVotesForVoting
      "10000000000000000000000", // minVotesForCreating
      ["0x0000000000000000000000000000000000000000", "0", "0", "0"], // rewardsInfo
      "default", // executorDescription
    ];
    const labeled = labelProposalSettings(tuple) as Record<string, unknown>;
    expect(labeled.earlyCompletion).toBe(true);
    expect(labeled.duration).toBe("432000");
    expect(labeled.quorumPct).toBe(51);
    expect(labeled.quorumValidatorsPct).toBe(51);
    expect((labeled.rewardsInfo as Record<string, unknown>).rewardToken).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(labeled.executorDescription).toBe("default");
  });

  it("returns non-tuple input unchanged", () => {
    expect(labelProposalSettings(null)).toBeNull();
    expect(labelProposalSettings(["short"])).toEqual(["short"]);
  });
});

describe("interaction type labels (F-UC1)", () => {
  it("labels interactions-subgraph transaction types", () => {
    expect(transactionTypeLabels(["4", "5"])).toEqual([
      "DAO_POOL_PROPOSAL_CREATED",
      "DAO_POOL_PROPOSAL_VOTED",
    ]);
    expect(transactionTypeLabels(["3"])).toEqual(["DAO_POOL_CREATED"]);
    expect(transactionTypeLabels(["99"])).toEqual(["UNKNOWN_99"]);
  });

  it("labels proposal interaction types", () => {
    expect(proposalInteractionLabel("1")).toBe("VOTE_FOR");
    expect(proposalInteractionLabel("2")).toBe("VOTE_AGAINST");
    expect(proposalInteractionLabel("3")).toBe("VOTE_CANCEL");
    expect(proposalInteractionLabel("0")).toBe("UNKNOWN_0");
  });
});
