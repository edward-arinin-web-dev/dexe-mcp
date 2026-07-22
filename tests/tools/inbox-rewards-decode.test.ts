import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  GOV_POOL_ABI,
  PENDING_REWARDS_ABI,
  isUnvotedTotalVotes,
  summarizePendingRewards,
} from "../../src/tools/inbox.js";

/**
 * Two regression classes guarded here:
 *
 * F6: `getPendingRewards` has a SINGLE tuple output, so multicall's
 * single-return unwrap (multicall.ts: `decoded.length === 1 ? decoded[0] :
 * decoded`) yields the tuple itself — no `.rewards` wrapper.
 *
 * F-UC4 (use-cases campaign, 2026-07-23): the ABI must mirror
 * IGovPool.PendingRewardsView EXACTLY — (onchainTokens, staticRewards,
 * VotingRewards[]{personal,micropool,treasury}, offchainRewards,
 * offchainTokens). The pre-fix flat shape (tokens, amounts, proposalIds)
 * decoded votingRewards structs into a bogus "proposalIds" array and
 * undercounted totals (static rewards only).
 *
 * These tests run real ABI encode → decode → unwrap, exactly the production path.
 */

const T1 = "0x1111111111111111111111111111111111111111";
const T2 = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

// Canonical PendingRewardsView encoder (mirrors GovPool on-chain return).
const REAL = new Interface([
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] onchainTokens, uint256[] staticRewards, tuple(uint256 personal, uint256 micropool, uint256 treasury)[] votingRewards, uint256[] offchainRewards, address[] offchainTokens) rewards)",
]);

interface ViewFixture {
  onchainTokens: string[];
  staticRewards: bigint[];
  votingRewards: Array<[bigint, bigint, bigint]>;
  offchainRewards: bigint[];
  offchainTokens: string[];
}

function encodeAndUnwrap(view: ViewFixture) {
  const data = REAL.encodeFunctionResult("getPendingRewards", [
    [view.onchainTokens, view.staticRewards, view.votingRewards, view.offchainRewards, view.offchainTokens],
  ]);
  const decoded = PENDING_REWARDS_ABI.decodeFunctionResult("getPendingRewards", data);
  // Same unwrap as src/lib/multicall.ts
  return decoded.length === 1 ? decoded[0] : decoded;
}

describe("inbox getPendingRewards decode (F6 + F-UC4 regressions)", () => {
  it("multicall unwrap yields the tuple directly — no .rewards wrapper", () => {
    const value = encodeAndUnwrap({
      onchainTokens: [T1],
      staticRewards: [5n * 10n ** 18n],
      votingRewards: [[0n, 0n, 0n]],
      offchainRewards: [],
      offchainTokens: [],
    });
    expect((value as { rewards?: unknown }).rewards).toBeUndefined();
    expect((value as { staticRewards: bigint[] }).staticRewards.length).toBe(1);
  });

  it("totals static + voting rewards and maps input proposal ids", () => {
    const value = encodeAndUnwrap({
      onchainTokens: [T1, T2, T1],
      staticRewards: [5n * 10n ** 18n, 0n, 0n],
      votingRewards: [
        [1n * 10n ** 18n, 2n * 10n ** 18n, 3n * 10n ** 18n], // proposal 3: 5 static + 6 voting
        [0n, 0n, 0n], // proposal 9: nothing
        [4n * 10n ** 18n, 0n, 0n], // proposal 12: 4 voting only
      ],
      offchainRewards: [],
      offchainTokens: [],
    });
    const s = summarizePendingRewards(value, ["3", "9", "12"]);
    expect(s).not.toBeNull();
    expect(s!.totalAmount).toBe((15n * 10n ** 18n).toString());
    expect(s!.proposalIds).toEqual(["3", "12"]); // zero-reward proposal 9 excluded
    expect(s!.rewardTokens.map((t) => t.toLowerCase())).toEqual([T1]); // deduped
  });

  it("surfaces offchain rewards separately", () => {
    const value = encodeAndUnwrap({
      onchainTokens: [ZERO],
      staticRewards: [0n],
      votingRewards: [[0n, 0n, 0n]],
      offchainRewards: [7n * 10n ** 18n],
      offchainTokens: [T2],
    });
    const s = summarizePendingRewards(value, ["1"]);
    expect(s).not.toBeNull();
    expect(s!.totalAmount).toBe("0");
    expect(s!.proposalIds).toEqual([]);
    expect(s!.offchainTotal).toBe((7n * 10n ** 18n).toString());
    expect(s!.offchainTokens!.map((t) => t.toLowerCase())).toEqual([T2]);
  });

  it("returns null for empty and all-zero reward sets", () => {
    expect(
      summarizePendingRewards(
        encodeAndUnwrap({
          onchainTokens: [],
          staticRewards: [],
          votingRewards: [],
          offchainRewards: [],
          offchainTokens: [],
        }),
        [],
      ),
    ).toBeNull();
    expect(
      summarizePendingRewards(
        encodeAndUnwrap({
          onchainTokens: [T1],
          staticRewards: [0n],
          votingRewards: [[0n, 0n, 0n]],
          offchainRewards: [0n],
          offchainTokens: [ZERO],
        }),
        ["4"],
      ),
    ).toBeNull();
    expect(summarizePendingRewards(null)).toBeNull();
    expect(summarizePendingRewards(undefined)).toBeNull();
  });
});

describe("inbox getTotalVotes field selection (F6 unvoted regression)", () => {
  // GovPool.sol: return (core.rawVotesFor, core.rawVotesAgainst,
  //               info.rawVotes[voteType].totalVoted, info.isVoteFor)
  const REAL_VOTES = new Interface([
    "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256, uint256, uint256, bool)",
  ]);

  function encodeVotes(values: [bigint, bigint, bigint, boolean]) {
    const data = REAL_VOTES.encodeFunctionResult("getTotalVotes", values);
    const decoded = GOV_POOL_ABI.decodeFunctionResult("getTotalVotes", data);
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  it("non-voter on a proposal OTHERS voted on is unvoted (pre-fix false negative)", () => {
    const value = encodeVotes([10n ** 24n, 0n, 0n, false]);
    expect(isUnvotedTotalVotes(value)).toBe(true);
  });

  it("actual voter is NOT unvoted", () => {
    const value = encodeVotes([10n ** 24n, 0n, 10n ** 24n, true]);
    expect(isUnvotedTotalVotes(value)).toBe(false);
  });

  it("failed/absent result is not treated as unvoted", () => {
    expect(isUnvotedTotalVotes(null)).toBe(false);
    expect(isUnvotedTotalVotes(undefined)).toBe(false);
  });
});
