import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { STAKING_READ_ABI } from "../../src/tools/read.js";

/**
 * W39 guardrail. The staking read-ABI must match the deployed IStakingProposal
 * structs (StakingInfoView = 9 fields, TierUserInfo = 8 fields). The old ABI
 * declared 5 / 2 fields: getActiveStakings (dynamic) threw and was swallowed as
 * empty; getUserInfo (all-static) in-bounds head-aliased real values onto the
 * wrong names with no error (a 50e18 stake rendered as staked=tierId). These
 * encode real-struct data and decode it through the MCP ABI to pin the fix.
 */

const RT = "0x1111111111111111111111111111111111111111";

// The real deployed layout.
const REAL = new Interface([
  "function getActiveStakings() view returns (tuple(uint256 id, string metadata, address rewardToken, uint256 totalRewardsAmount, uint256 startedAt, uint256 deadline, bool isActive, uint256 totalStaked, uint256 owedToProtocol)[] stakings)",
  "function getUserInfo(address user) view returns (tuple(uint256 tierId, bool isActive, address rewardToken, uint256 startedAt, uint256 deadline, uint256 currentStake, uint256 currentRewards, uint256 tierCurrentStakes)[] tiersUserInfo)",
]);
// The buggy pre-fix getUserInfo reader.
const OLD = new Interface([
  "function getUserInfo(address user) view returns (tuple(uint256 staked, uint256 reward)[] tiersUserInfo)",
]);
const mcp = new Interface(STAKING_READ_ABI as unknown as string[]);

describe("staking read-ABI matches deployed IStakingProposal (W39)", () => {
  it("getActiveStakings decodes all 9 StakingInfoView fields", () => {
    const view = [
      {
        id: 3n,
        metadata: "tier-meta",
        rewardToken: RT,
        totalRewardsAmount: 4n * 10n ** 18n,
        startedAt: 100n,
        deadline: 200n,
        isActive: true,
        totalStaked: 50n * 10n ** 18n,
        owedToProtocol: 7n,
      },
    ];
    const data = REAL.encodeFunctionResult("getActiveStakings", [view]);
    const [decoded] = mcp.decodeFunctionResult("getActiveStakings", data);
    expect(decoded.length).toBe(1);
    const s = decoded[0];
    expect(s.id).toBe(3n);
    expect(s.isActive).toBe(true);
    expect(s.totalStaked).toBe(50n * 10n ** 18n);
    expect(s.owedToProtocol).toBe(7n);
    expect(typeof s.toObject).toBe("function"); // named-object conversion path works
  });

  it("getUserInfo decodes the real 8-field TierUserInfo with correct values", () => {
    const info = [
      {
        tierId: 2n,
        isActive: true,
        rewardToken: RT,
        startedAt: 1n,
        deadline: 9n,
        currentStake: 50n * 10n ** 18n,
        currentRewards: 4n * 10n ** 18n,
        tierCurrentStakes: 99n,
      },
    ];
    const data = REAL.encodeFunctionResult("getUserInfo", [info]);
    const [decoded] = mcp.decodeFunctionResult("getUserInfo", data);
    const u = decoded[0];
    expect(u.currentStake).toBe(50n * 10n ** 18n);
    expect(u.currentRewards).toBe(4n * 10n ** 18n);
    expect(u.tierId).toBe(2n);
  });

  it("CONTROL: the old 2-field reader head-aliases real data (silent corruption)", () => {
    const info = [
      {
        tierId: 2n,
        isActive: true,
        rewardToken: RT,
        startedAt: 1n,
        deadline: 9n,
        currentStake: 50n * 10n ** 18n,
        currentRewards: 4n * 10n ** 18n,
        tierCurrentStakes: 99n,
      },
    ];
    const data = REAL.encodeFunctionResult("getUserInfo", [info]);
    const [decoded] = OLD.decodeFunctionResult("getUserInfo", data);
    // The real 50e18 stake is NOT recoverable: "staked" aliases tierId(2).
    expect(decoded[0].staked).toBe(2n);
    expect(decoded[0].staked).not.toBe(50n * 10n ** 18n);
  });
});
