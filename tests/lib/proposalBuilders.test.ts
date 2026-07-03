import { describe, it, expect } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import { PROPOSAL_BUILDERS, FLOW_PROPOSAL_TYPES } from "../../src/lib/proposalBuilders.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const GOVPOOL = "0x3333333333333333333333333333333333333333";
const EXPERT_NFT = "0x4444444444444444444444444444444444444444";
const USER = "0x5555555555555555555555555555555555555555";
const DIST = "0x6666666666666666666666666666666666666666";
const SALE = "0x7777777777777777777777777777777777777777";
const SETTINGS = "0x8888888888888888888888888888888888888888";

// No RPC → checkBlacklist returns "skipped" → builders proceed without network.
const deps = { ctx: { config: { rpcUrl: undefined } } as never, govPool: GOVPOOL, chainId: 97 };

const ERC20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ERC721 = new Interface(["function transferFrom(address from, address to, uint256 tokenId)"]);
const EXPERT = new Interface(["function mint(address to, string uri)", "function burn(address from)"]);
const DISTP = new Interface(["function execute(uint256 proposalId, address token, uint256 amount)"]);

describe("proposal builder registry", () => {
  it("exposes the 8 wired types + the 2 native flow types", () => {
    expect(Object.keys(PROPOSAL_BUILDERS).sort()).toEqual(
      [
        "add_expert",
        "change_voting_settings",
        "custom_abi",
        "remove_expert",
        "token_distribution",
        "token_sale",
        "token_transfer",
        "withdraw_treasury",
      ].sort(),
    );
    expect(FLOW_PROPOSAL_TYPES).toContain("modify_dao_profile");
    expect(FLOW_PROPOSAL_TYPES).toContain("custom");
    expect(FLOW_PROPOSAL_TYPES.length).toBe(10);
  });
});

describe("token_transfer builder (byte-parity)", () => {
  it("ERC20 path encodes transfer(recipient, amount)", async () => {
    const b = PROPOSAL_BUILDERS.token_transfer!;
    const parsed = b.schema.parse({ token: TOKEN, recipient: RECIPIENT, amount: "1000000000000000000" });
    const out = await b.build(parsed, deps);
    expect(out.category).toBe("tokenTransfer");
    expect(out.actionsOnFor).toHaveLength(1);
    expect(out.actionsOnFor[0]!.executor).toBe(TOKEN);
    expect(out.actionsOnFor[0]!.data).toBe(ERC20.encodeFunctionData("transfer", [RECIPIENT, 1000000000000000000n]));
    const extra = out.metadataExtra as { changes: { proposedChanges: Record<string, unknown> } };
    expect(extra.changes.proposedChanges.tokenAddress).toBe(TOKEN);
  });
  it("native path sends value with empty data", async () => {
    const b = PROPOSAL_BUILDERS.token_transfer!;
    const parsed = b.schema.parse({ recipient: RECIPIENT, amount: "500", isNative: true });
    const out = await b.build(parsed, deps);
    expect(out.actionsOnFor[0]).toEqual({ executor: RECIPIENT, value: "500", data: "0x" });
    const extra = out.metadataExtra as { changes: { proposedChanges: Record<string, unknown> } };
    expect(extra.changes.proposedChanges.tokenAddress).toBe(ZeroAddress);
  });
});

describe("withdraw_treasury builder (mode 8 — external transfer)", () => {
  it("emits token.transfer, never GovPool.withdraw", async () => {
    const b = PROPOSAL_BUILDERS.withdraw_treasury!;
    const parsed = b.schema.parse({ receiver: RECIPIENT, token: TOKEN, amount: "1000" });
    const out = await b.build(parsed, deps);
    expect(out.category).toBe("withdrawDeposit");
    expect(out.actionsOnFor[0]!.executor).toBe(TOKEN);
    expect(out.actionsOnFor[0]!.data).toBe(ERC20.encodeFunctionData("transfer", [RECIPIENT, 1000n]));
  });
  it("adds one transferFrom(govPool, receiver, id) per NFT", async () => {
    const b = PROPOSAL_BUILDERS.withdraw_treasury!;
    const parsed = b.schema.parse({ receiver: RECIPIENT, nftAddress: EXPERT_NFT, nftIds: ["7", "8"] });
    const out = await b.build(parsed, deps);
    expect(out.actionsOnFor).toHaveLength(2);
    expect(out.actionsOnFor[0]!.data).toBe(ERC721.encodeFunctionData("transferFrom", [GOVPOOL, RECIPIENT, 7n]));
  });
  it("rejects an empty withdrawal", async () => {
    const b = PROPOSAL_BUILDERS.withdraw_treasury!;
    await expect(b.build(b.schema.parse({ receiver: RECIPIENT }), deps)).rejects.toThrow(/Nothing to withdraw/);
  });
});

describe("expert builders", () => {
  it("add_expert mints with the right category per scope", async () => {
    const b = PROPOSAL_BUILDERS.add_expert!;
    const local = await b.build(b.schema.parse({ expertNftContract: EXPERT_NFT, scope: "local", nominatedUser: USER }), deps);
    expect(local.category).toBe("localExpert");
    expect(local.actionsOnFor[0]!.data).toBe(EXPERT.encodeFunctionData("mint", [USER, ""]));
    const global = await b.build(b.schema.parse({ expertNftContract: EXPERT_NFT, scope: "global", nominatedUser: USER }), deps);
    expect(global.category).toBe("globalExpert");
  });
  it("remove_expert burns", async () => {
    const b = PROPOSAL_BUILDERS.remove_expert!;
    const out = await b.build(b.schema.parse({ expertNftContract: EXPERT_NFT, scope: "local", nominatedUser: USER }), deps);
    expect(out.category).toBe("localExpertRemoval");
    expect(out.actionsOnFor[0]!.data).toBe(EXPERT.encodeFunctionData("burn", [USER]));
  });
});

describe("token_distribution builder", () => {
  it("prepends approve for ERC20, executes", async () => {
    const b = PROPOSAL_BUILDERS.token_distribution!;
    const out = await b.build(
      b.schema.parse({ distributionProposal: DIST, proposalId: "3", token: TOKEN, amount: "1000" }),
      deps,
    );
    expect(out.actionsOnFor).toHaveLength(2);
    expect(out.actionsOnFor[0]!.data).toBe(ERC20.encodeFunctionData("approve", [DIST, 1000n]));
    expect(out.actionsOnFor[1]!.data).toBe(DISTP.encodeFunctionData("execute", [3n, TOKEN, 1000n]));
  });
  it("native path is a single execute with value", async () => {
    const b = PROPOSAL_BUILDERS.token_distribution!;
    const out = await b.build(
      b.schema.parse({ distributionProposal: DIST, proposalId: "3", token: TOKEN, amount: "1000", isNative: true }),
      deps,
    );
    expect(out.actionsOnFor).toHaveLength(1);
    expect(out.actionsOnFor[0]!.value).toBe("1000");
  });
});

describe("change_voting_settings builder", () => {
  const settings = {
    earlyCompletion: true,
    delegatedVotingAllowed: false,
    validatorsVote: false,
    duration: "86400",
    durationValidators: "86400",
    executionDelay: "0",
    quorum: "500000000000000000000000000",
    quorumValidators: "500000000000000000000000000",
    minVotesForVoting: "1000000000000000000",
    minVotesForCreating: "1000000000000000000",
    rewardsInfo: { rewardToken: ZeroAddress, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
    executorDescription: "",
  };
  it("addSettings when no ids", async () => {
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    const out = await b.build(b.schema.parse({ govSettings: SETTINGS, settings: [settings] }), deps);
    expect(out.category).toBe("changeSettings");
    expect(out.actionsOnFor[0]!.executor).toBe(SETTINGS);
    expect(out.actionsOnFor[0]!.data.slice(0, 10)).toBe(
      new Interface([
        "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
      ]).getFunction("addSettings")!.selector,
    );
  });
  it("editSettings when ids supplied", async () => {
    const b = PROPOSAL_BUILDERS.change_voting_settings!;
    const out = await b.build(b.schema.parse({ govSettings: SETTINGS, settings: [settings], settingsIds: ["2"] }), deps);
    const extra = out.metadataExtra as { changes: { proposedChanges: { mode: string } } };
    expect(extra.changes.proposedChanges.mode).toBe("editSettings");
  });
});

describe("token_sale builder", () => {
  it("builds createTiers actions (shared multi-tier encoder)", async () => {
    const b = PROPOSAL_BUILDERS.token_sale!;
    const now = 1_800_000_000;
    const out = await b.build(
      b.schema.parse({
        tokenSaleProposal: SALE,
        tiers: [
          {
            name: "Tier 1",
            totalTokenProvided: "1000000000000000000000",
            saleStartTime: String(now),
            saleEndTime: String(now + 86400),
            saleTokenAddress: TOKEN,
            purchaseTokenAddresses: [TOKEN],
            exchangeRates: ["10000000000000000000000000"],
            maxAllocationPerUser: "1000000000000000000000",
          },
        ],
      }),
      deps,
    );
    expect(out.category).toBe("tokenSale");
    expect(out.actionsOnFor.length).toBeGreaterThanOrEqual(1);
    // last action targets the TokenSaleProposal (createTiers)
    expect(out.actionsOnFor.some((a) => a.executor === SALE)).toBe(true);
  });
});

describe("custom_abi builder", () => {
  it("encodes an arbitrary signature", async () => {
    const b = PROPOSAL_BUILDERS.custom_abi!;
    const out = await b.build(
      b.schema.parse({ target: TOKEN, signature: "function setX(uint256)", method: "setX", args: ["42"] }),
      deps,
    );
    expect(out.actionsOnFor[0]!.executor).toBe(TOKEN);
    expect(out.actionsOnFor[0]!.data).toBe(new Interface(["function setX(uint256)"]).encodeFunctionData("setX", [42n]));
  });
});
