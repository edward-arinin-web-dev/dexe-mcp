import { describe, expect, it } from "vitest";
import { AbiCoder, Interface, getAddress, getCreateAddress, parseUnits } from "ethers";
import {
  encodeLaneDeploy,
  encodePayAction,
  FAST_LANE_BYTECODE,
  FAST_LANE_CHAIN_ID,
  fastLaneChainRefusal,
  fastLaneGuarantees,
  fastLaneSettings,
  laneIface,
  PAY_SELECTOR,
  PAY_SIGNATURE,
  payProposalRecipe,
  resolveFastLaneConfig,
} from "../../src/lib/agentFastLane.js";

const GOV = getAddress("0x" + "aa".repeat(20));
const TOKEN = getAddress("0x" + "cc".repeat(20));
const LANE = getAddress("0x" + "fa".repeat(20));
const R1 = "0x00000000000000000000000000000000000000c1";
const R2 = "0x00000000000000000000000000000000000000c2";

describe("fastLaneChainRefusal", () => {
  it("allows only 97 and names mainnet", () => {
    expect(FAST_LANE_CHAIN_ID).toBe(97);
    expect(fastLaneChainRefusal(97)).toBeUndefined();
    expect(fastLaneChainRefusal(56)).toMatch(/TESTNET ONLY.*Refusing chain 56 \(MAINNET\)/s);
    expect(fastLaneChainRefusal(1)).toMatch(/MAINNET/);
    expect(fastLaneChainRefusal(11155111)).toMatch(/Refusing chain 11155111\./);
  });
});

describe("resolveFastLaneConfig", () => {
  const base = { perPaymentCap: "50", windowCap: "500", allowlist: [R1, R2], voteSeconds: 600 };

  it("parses whole-token caps at the token's decimals and checksums the allowlist", () => {
    const r = resolveFastLaneConfig(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.perPaymentCapWei).toBe(parseUnits("50", 18));
    expect(r.config.windowCapWei).toBe(parseUnits("500", 18));
    expect(r.config.allowlist).toEqual([getAddress(R1), getAddress(R2)]);
    const six = resolveFastLaneConfig({ ...base, decimals: 6 });
    expect(six.ok && six.config.perPaymentCapWei).toBe(50_000_000n);
  });

  it.each([
    [{ perPaymentCap: "0" }, /perPaymentCap must be > 0/],
    [{ perPaymentCap: "501" }, /exceeds fastLane\.windowCap/],
    [{ windowCap: "1" + "0".repeat(40) }, /too large/],
    [{ allowlist: [] }, /at least one recipient/],
    [{ allowlist: ["0x1234"] }, /allowlist\[0\]: invalid address/],
    [{ allowlist: ["0x0000000000000000000000000000000000000000"] }, /the zero address/],
    [{ allowlist: [R1, R1.toUpperCase().replace("0X", "0x")] }, /allowlist\[1\]: duplicate/],
    [{ voteSeconds: 0 }, /voteSeconds must be a positive integer/],
    [{ voteSeconds: 1.5 }, /voteSeconds must be a positive integer/],
    [{ perPaymentCap: "abc" }, /fastLane caps:/],
  ])("refuses %o", (patch, re) => {
    const r = resolveFastLaneConfig({ ...base, ...patch });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(re);
  });
});

describe("fastLaneSettings", () => {
  const def = {
    earlyCompletion: false,
    delegatedVotingAllowed: false,
    validatorsVote: true,
    duration: "86400",
    durationValidators: "43200",
    executionDelay: "0",
    quorum: "500000000000000000000000000",
    quorumValidators: "0",
    minVotesForVoting: "1",
    minVotesForCreating: "1",
    rewardsInfo: { rewardToken: "0x0", creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
    executorDescription: "ipfs://default",
  };

  it("keeps the quorum and min-votes, drops the validator round, shortens the vote", () => {
    const s = fastLaneSettings(def, 600);
    expect(s).toMatchObject({
      earlyCompletion: true,
      validatorsVote: false,
      duration: "600",
      durationValidators: "43200",
      quorum: def.quorum,
      minVotesForVoting: "1",
      minVotesForCreating: "1",
      delegatedVotingAllowed: false,
      executorDescription: "",
    });
    expect(def.validatorsVote).toBe(true); // pure: the base slot is untouched
  });

  it("never leaves durationValidators at 0 (GovSettings rejects it on every slot)", () => {
    const s = fastLaneSettings({ ...def, durationValidators: "0" }, 600);
    expect(s.durationValidators).toBe("86400");
  });
});

describe("encodePayAction / payProposalRecipe / encodeLaneDeploy", () => {
  it("encodes pay(address,uint256) with value 0 and the lane as executor", () => {
    const a = encodePayAction(LANE.toLowerCase(), R1, 5n);
    expect(a.executor).toBe(LANE);
    expect(a.value).toBe("0");
    expect(a.data.startsWith(PAY_SELECTOR)).toBe(true);
    expect(a.data.length).toBe(2 + 68 * 2);
    const [to, amount] = laneIface.decodeFunctionData("pay", a.data);
    expect(to).toBe(getAddress(R1));
    expect(amount).toBe(5n);
    expect(new Interface([PAY_SIGNATURE]).getFunction("pay")!.selector).toBe(PAY_SELECTOR);
  });

  it("the recipe is a dexe_proposal_create custom_abi call with a default title", () => {
    const r = payProposalRecipe({ govPool: GOV, chainId: 97, lane: LANE, to: R1, amountWei: parseUnits("25", 18), amountHuman: "25.0" }) as any;
    expect(r.tool).toBe("dexe_proposal_create");
    expect(r.args).toEqual({
      govPool: GOV,
      chainId: 97,
      proposalType: "custom_abi",
      title: `Fast lane: pay 25.0 to ${getAddress(R1)}`,
      params: { target: LANE, signature: PAY_SIGNATURE, method: "pay", args: [getAddress(R1), parseUnits("25", 18).toString()], value: "0" },
    });
    expect(r.notes.join(" ")).toMatch(/LAST action/);
    const titled = payProposalRecipe({ govPool: GOV, chainId: 97, lane: LANE, to: R1, amountWei: 1n, title: "API bill" }) as any;
    expect(titled.args.title).toBe("API bill");
  });

  it("the deploy calldata is the bytecode followed by the constructor args", () => {
    const cfg = resolveFastLaneConfig({ perPaymentCap: "50", windowCap: "500", allowlist: [R1], voteSeconds: 600 });
    if (!cfg.ok) throw new Error(cfg.reason);
    const data = encodeLaneDeploy(GOV, TOKEN, cfg.config);
    expect(data.startsWith(FAST_LANE_BYTECODE)).toBe(true);
    const tail = "0x" + data.slice(FAST_LANE_BYTECODE.length);
    const decoded = AbiCoder.defaultAbiCoder().decode(
      laneIface.deploy.inputs.map((i) => i.type),
      tail,
    ) as unknown as unknown[];
    expect(decoded[0]).toBe(GOV);
    expect(decoded[1]).toBe(TOKEN);
    expect(decoded[2]).toBe(parseUnits("50", 18));
    expect(decoded[3]).toBe(parseUnits("500", 18));
    expect([...(decoded[4] as string[])]).toEqual([getAddress(R1)]);
    // a predicted CREATE address is a plain function of (deployer, nonce) — what the preset previews
    expect(getCreateAddress({ from: GOV, nonce: 7 })).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("fastLaneGuarantees", () => {
  it("states the caps, the double enforcement, the slow-lane admin and TESTNET ONLY", () => {
    const g = fastLaneGuarantees({ perPaymentCap: "50", windowCap: "500", symbol: "AGF", allowlistCount: 2, voteSeconds: 600 }).join("\n");
    expect(g).toMatch(/at most 50 AGF per payment and 500 AGF per rolling 30 days/);
    expect(g).toMatch(/2 allowlisted recipient/);
    expect(g).toMatch(/enforced twice/);
    expect(g).toMatch(/admin contract/);
    expect(g).toMatch(/TESTNET ONLY/);
  });
});
