import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  GOV_POOL_ABI,
  PENDING_REWARDS_ABI,
  isUnvotedTotalVotes,
  summarizePendingRewards,
} from "../../src/tools/inbox.js";

/**
 * F6 regression guard. `getPendingRewards` has a SINGLE tuple output, so
 * multicall's single-return unwrap (multicall.ts: `decoded.length === 1 ?
 * decoded[0] : decoded`) yields the tuple itself. The pre-fix reader assumed
 * an extra `{ rewards: ... }` wrapper and crashed the whole per-DAO scan with
 * "Cannot read properties of undefined (reading 'amounts')" — every DAO with
 * proposals landed in scanErrors and unvoted proposals were silently dropped.
 * These tests run real ABI encode → decode → unwrap, exactly the production
 * path.
 */

const T1 = "0x1111111111111111111111111111111111111111";
const T2 = "0x2222222222222222222222222222222222222222";

const REAL = new Interface([
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] tokens, uint256[] amounts, uint256[] proposalIds) rewards)",
]);

function encodeAndUnwrap(rewards: { tokens: string[]; amounts: bigint[]; proposalIds: bigint[] }) {
  const data = REAL.encodeFunctionResult("getPendingRewards", [rewards]);
  const decoded = PENDING_REWARDS_ABI.decodeFunctionResult("getPendingRewards", data);
  // Same unwrap as src/lib/multicall.ts
  return decoded.length === 1 ? decoded[0] : decoded;
}

describe("inbox getPendingRewards decode (F6 regression)", () => {
  it("multicall unwrap yields the tuple directly — no .rewards wrapper", () => {
    const value = encodeAndUnwrap({ tokens: [T1], amounts: [5n * 10n ** 18n], proposalIds: [3n] });
    // The regression: pre-fix code read value.rewards.amounts.
    expect((value as { rewards?: unknown }).rewards).toBeUndefined();
    expect((value as { amounts: bigint[] }).amounts.length).toBe(1);
  });

  it("summarizePendingRewards totals amounts and stringifies proposal ids", () => {
    const value = encodeAndUnwrap({
      tokens: [T1, T2],
      amounts: [5n * 10n ** 18n, 7n * 10n ** 18n],
      proposalIds: [3n, 9n],
    });
    const s = summarizePendingRewards(value);
    expect(s).not.toBeNull();
    expect(s!.totalAmount).toBe((12n * 10n ** 18n).toString());
    expect(s!.proposalIds).toEqual(["3", "9"]);
  });

  it("returns null for empty and all-zero reward sets", () => {
    expect(
      summarizePendingRewards(encodeAndUnwrap({ tokens: [], amounts: [], proposalIds: [] })),
    ).toBeNull();
    expect(
      summarizePendingRewards(encodeAndUnwrap({ tokens: [T1], amounts: [0n], proposalIds: [4n] })),
    ).toBeNull();
    expect(summarizePendingRewards(null)).toBeNull();
    expect(summarizePendingRewards(undefined)).toBeNull();
  });
});

describe("inbox getTotalVotes field selection (F6 unvoted regression)", () => {
  // GovPool.sol: return (core.rawVotesFor, core.rawVotesAgainst,
  //               info.rawVotes[voteType].totalVoted, info.isVoteFor)
  const REAL = new Interface([
    "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256, uint256, uint256, bool)",
  ]);

  function encodeAndUnwrap(values: [bigint, bigint, bigint, boolean]) {
    const data = REAL.encodeFunctionResult("getTotalVotes", values);
    const decoded = GOV_POOL_ABI.decodeFunctionResult("getTotalVotes", data);
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  it("non-voter on a proposal OTHERS voted on is unvoted (pre-fix false negative)", () => {
    // 1M rawVotesFor at proposal level, voter's own stake 0.
    const value = encodeAndUnwrap([10n ** 24n, 0n, 0n, false]);
    expect(isUnvotedTotalVotes(value)).toBe(true);
  });

  it("actual voter is NOT unvoted", () => {
    const value = encodeAndUnwrap([10n ** 24n, 0n, 10n ** 24n, true]);
    expect(isUnvotedTotalVotes(value)).toBe(false);
  });

  it("failed/absent result is not treated as unvoted", () => {
    expect(isUnvotedTotalVotes(null)).toBe(false);
    expect(isUnvotedTotalVotes(undefined)).toBe(false);
  });
});
