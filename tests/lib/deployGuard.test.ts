import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { roundTripDeployCalldata, type DeployStructView } from "../../src/lib/deployGuard.js";

/**
 * deployGovPool calldata round-trip guard.
 *
 * A live BSC deploy (tx 0x7217…9147) reverted "PoolFactory: pool name cannot be
 * empty": the built calldata had an empty `name` (and empty vote-power
 * `initData`) because of an encode-time field shift, invisible to any
 * param-value check. `roundTripDeployCalldata` decodes the built calldata and
 * asserts every load-bearing field survived. A correct build stays green; the
 * two historical corruptions flip it red.
 */

const FALLBACK = [
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)",
];
const iface = new Interface(FALLBACK);

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x6b1daeD74540e906563B117Ac4d0D9aa39EF7233";
const INIT = new Interface(["function __LinearPower_init()"]).encodeFunctionData("__LinearPower_init", []);
const CAP = 10n ** 25n;
const AMT = 9n * 10n ** 24n;
const QUORUM = 600000000000000000000000000n; // 60%

const setting = {
  earlyCompletion: false,
  delegatedVotingAllowed: false,
  validatorsVote: true,
  duration: "86400",
  durationValidators: "86400",
  executionDelay: "0",
  quorum: QUORUM.toString(),
  quorumValidators: QUORUM.toString(),
  minVotesForVoting: "1000000000000000000000",
  minVotesForCreating: "1000000000000000000000",
  rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
  executorDescription: "ipfs://cid",
};

/** Build the positional deployGovPool tuple the way buildDeployGovPool does. */
function buildTuple(name: string, initData: string): unknown[] {
  return [
    [
      [
        [
          setting.earlyCompletion,
          setting.delegatedVotingAllowed,
          setting.validatorsVote,
          BigInt(setting.duration),
          BigInt(setting.durationValidators),
          BigInt(setting.executionDelay),
          BigInt(setting.quorum),
          BigInt(setting.quorumValidators),
          BigInt(setting.minVotesForVoting),
          BigInt(setting.minVotesForCreating),
          [ZERO, 0n, 0n, 0n],
          setting.executorDescription,
        ],
      ],
      [ZERO, ZERO],
    ],
    ["Validator Token-VT", "VT-VT", [BigInt(setting.duration), 0n, BigInt(setting.quorum)], [], []],
    [A, ZERO, 0n, 0n],
    ["T", "T", [A], CAP, CAP, [AMT]],
    [0, initData, ZERO],
    ZERO,
    false,
    "cid",
    name,
  ];
}

const expected: DeployStructView = {
  name: "DBS",
  descriptionURL: "cid",
  verifier: ZERO,
  onlyBABTHolders: false,
  votePowerParams: { voteType: 0, initData: INIT, presetAddress: ZERO },
  settingsParams: {
    proposalSettings: [setting] as unknown as DeployStructView["settingsParams"]["proposalSettings"],
    additionalProposalExecutors: [ZERO, ZERO],
  },
  validatorsParams: {
    name: "Validator Token-VT",
    symbol: "VT-VT",
    proposalSettings: { duration: setting.duration, executionDelay: "0", quorum: setting.quorum },
    validators: [],
    balances: [],
  },
  userKeeperParams: { tokenAddress: A, nftAddress: ZERO, individualPower: "0", nftsTotalSupply: "0" },
  tokenParams: {
    name: "T",
    symbol: "T",
    users: [A],
    cap: CAP.toString(),
    mintedTotal: CAP.toString(),
    amounts: [AMT.toString()],
  },
};

describe("roundTripDeployCalldata", () => {
  it("passes when the encoded calldata matches the intended params", () => {
    const data = iface.encodeFunctionData("deployGovPool", [buildTuple("DBS", INIT)]);
    const rt = roundTripDeployCalldata(data, iface, expected);
    expect(rt.ok).toBe(true);
    expect(rt.mismatches).toEqual([]);
  });

  it("flags an empty name (the PoolFactory: pool name cannot be empty revert cause)", () => {
    const data = iface.encodeFunctionData("deployGovPool", [buildTuple("", INIT)]);
    const rt = roundTripDeployCalldata(data, iface, expected);
    expect(rt.ok).toBe(false);
    expect(rt.mismatches.map((m) => m.field)).toContain("name");
  });

  it("flags an empty vote-power initData (would revert PoolFactory: power init failed)", () => {
    const data = iface.encodeFunctionData("deployGovPool", [buildTuple("DBS", "0x")]);
    const rt = roundTripDeployCalldata(data, iface, expected);
    expect(rt.ok).toBe(false);
    const initMismatch = rt.mismatches.find((m) => m.field === "votePower.initData");
    expect(initMismatch).toBeDefined();
    expect(initMismatch?.expected).toBe(INIT.toLowerCase());
    expect(initMismatch?.got).toBe("0x");
  });

  it("rejects calldata that is not a deployGovPool call", () => {
    const rt = roundTripDeployCalldata("0xdeadbeef", iface, expected);
    expect(rt.ok).toBe(false);
    expect(rt.mismatches[0]?.field).toBe("<decode>");
  });
});
