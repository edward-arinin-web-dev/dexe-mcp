import { describe, it, expect } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import {
  PROPOSAL_BUILDERS,
  INTERNAL_PROPOSAL_BUILDERS,
  OFFCHAIN_FLOW_TYPES,
  FLOW_PROPOSAL_TYPES,
} from "../../src/lib/proposalBuilders.js";
import { PROPOSAL_CATALOG } from "../../src/lib/proposalCatalog.js";

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

describe("proposal builder registry (v0.22 — full catalog)", () => {
  it("wires every on-chain external type incl. catalog-style aliases", () => {
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
        "manage_validators",
        "validators_allocation",
        "delegate_to_expert",
        "revoke_from_expert",
        "token_sale_recover",
        "token_sale_whitelist",
        "create_staking_tier",
        "change_math_model",
        "blacklist",
        "reward_multiplier",
        "apply_to_dao",
        "new_proposal_type",
        "enable_staking",
        "delegate_tokens_to_expert",
        "revoke_tokens_from_expert",
        "add_local_expert",
        "add_global_expert",
        "remove_local_expert",
        "remove_global_expert",
      ].sort(),
    );
    expect(FLOW_PROPOSAL_TYPES).toContain("modify_dao_profile");
    expect(FLOW_PROPOSAL_TYPES).toContain("custom");
  });

  it("covers every catalog id: external → builder, internal → internal builder, offchain → flow-reject list", () => {
    for (const entry of PROPOSAL_CATALOG) {
      const [kind, ...rest] = entry.id.split(".");
      const suffix = rest.join(".");
      if (kind === "external") {
        // manual_calldata is raw actions — served by proposalType 'custom'.
        // modify_dao_profile has its own dedicated flow branch.
        if (suffix === "manual_calldata" || suffix === "modify_dao_profile") {
          expect(FLOW_PROPOSAL_TYPES).toContain(suffix === "manual_calldata" ? "custom" : suffix);
          continue;
        }
        expect(PROPOSAL_BUILDERS[suffix], `external.${suffix} must be wired`).toBeDefined();
      } else if (kind === "internal") {
        const mapped = suffix === "offchain_proposal" ? "offchain_internal_proposal" : suffix;
        expect(INTERNAL_PROPOSAL_BUILDERS[mapped], `internal.${suffix} must be wired`).toBeDefined();
      } else if (kind === "offchain") {
        // change_voting_settings / new_template are backend template management,
        // covered by the same offchain rejection guidance as the vote types.
        const mapped = `offchain_${suffix}`;
        const handled =
          (OFFCHAIN_FLOW_TYPES as readonly string[]).includes(mapped) ||
          ["change_voting_settings", "new_template"].includes(suffix);
        expect(handled, `offchain.${suffix} must be handled`).toBe(true);
      }
    }
  });
});

describe("v0.22 new builders (byte-parity)", () => {
  const VALIDATORS = new Interface(["function changeBalances(uint256[] balances, address[] users)"]);
  const TREASURY = new Interface([
    "function delegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
    "function undelegateTreasury(address delegatee, uint256 amount, uint256[] nftIds)",
  ]);
  const SALE_IFACE = new Interface([
    "function addToWhitelist(tuple(uint256 tierId, address[] users, string uri)[] requests)",
    "function recover(uint256[] tierIds)",
  ]);
  const STAKING = new Interface([
    "function createStaking(address rewardToken, uint256 rewardAmount, uint256 startedAt, uint256 deadline, string metadata)",
  ]);
  const GOV_EXT = new Interface([
    "function changeVotePower(address newVotePower)",
    "function setNftMultiplierAddress(address nftMultiplier)",
  ]);
  const ERC20GOV = new Interface([
    "function blacklist(address[] users, bool isBlacklisted)",
    "function mint(address to, uint256 amount)",
  ]);
  const MULTIPLIER = new Interface([
    "function mint(address to, uint256 multiplier, uint64 duration, string uri_)",
  ]);
  const GOV_SETTINGS = new Interface([
    "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
    "function changeExecutors(address[] executors, uint256[] settingsIds)",
  ]);

  it("manage_validators == validators_allocation, encodes changeBalances", async () => {
    expect(PROPOSAL_BUILDERS.validators_allocation).toBe(PROPOSAL_BUILDERS.manage_validators);
    const b = PROPOSAL_BUILDERS.manage_validators!;
    const out = await b.build(
      b.schema.parse({ govValidators: DIST, changes: [{ user: USER, balance: "100" }, { user: RECIPIENT, balance: "0" }] }),
      deps,
    );
    expect(out.category).toBe("changeValidators");
    expect(out.actionsOnFor[0]!.data).toBe(
      VALIDATORS.encodeFunctionData("changeBalances", [[100n, 0n], [USER, RECIPIENT]]),
    );
  });

  it("delegate/revoke to expert target the deps govPool", async () => {
    const d = PROPOSAL_BUILDERS.delegate_to_expert!;
    const out = await d.build(d.schema.parse({ expert: USER, amount: "5000" }), deps);
    expect(out.actionsOnFor[0]!.executor).toBe(GOVPOOL);
    expect(out.actionsOnFor[0]!.data).toBe(TREASURY.encodeFunctionData("delegateTreasury", [USER, 5000n, []]));
    expect(out.category).toBe("delegateTokensToExpert");

    const r = PROPOSAL_BUILDERS.revoke_from_expert!;
    const out2 = await r.build(r.schema.parse({ expert: USER, amount: "5000" }), deps);
    expect(out2.actionsOnFor[0]!.data).toBe(TREASURY.encodeFunctionData("undelegateTreasury", [USER, 5000n, []]));
    expect(PROPOSAL_BUILDERS.delegate_tokens_to_expert).toBe(d);
    expect(PROPOSAL_BUILDERS.revoke_tokens_from_expert).toBe(r);
  });

  it("token_sale_recover + token_sale_whitelist encode canonically", async () => {
    const rec = PROPOSAL_BUILDERS.token_sale_recover!;
    const out = await rec.build(rec.schema.parse({ tokenSaleProposal: SALE, tierIds: ["1", "2"] }), deps);
    expect(out.actionsOnFor[0]!.data).toBe(SALE_IFACE.encodeFunctionData("recover", [[1n, 2n]]));
    expect(out.category).toBe("recoverTokenSale");

    const wl = PROPOSAL_BUILDERS.token_sale_whitelist!;
    const out2 = await wl.build(
      wl.schema.parse({ tokenSaleProposal: SALE, requests: [{ tierId: "1", users: [USER] }] }),
      deps,
    );
    expect(out2.actionsOnFor[0]!.data).toBe(
      SALE_IFACE.encodeFunctionData("addToWhitelist", [[[1n, [USER], ""]]]),
    );
  });

  it("create_staking_tier prepends approve for ERC20 rewards", async () => {
    const b = PROPOSAL_BUILDERS.create_staking_tier!;
    const out = await b.build(
      b.schema.parse({
        stakingProposal: DIST, rewardToken: TOKEN, rewardAmount: "777",
        startedAt: "1000", deadline: "2000", stakingMetadataUrl: "ipfs://x",
      }),
      deps,
    );
    expect(out.actionsOnFor).toHaveLength(2);
    expect(out.actionsOnFor[0]!.data).toBe(ERC20.encodeFunctionData("approve", [DIST, 777n]));
    expect(out.actionsOnFor[1]!.data).toBe(
      STAKING.encodeFunctionData("createStaking", [TOKEN, 777n, 1000n, 2000n, "ipfs://x"]),
    );
    expect(out.category).toBe("createStakingTier");
  });

  it("change_math_model targets deps govPool", async () => {
    const b = PROPOSAL_BUILDERS.change_math_model!;
    const out = await b.build(b.schema.parse({ newVotePower: USER }), deps);
    expect(out.actionsOnFor[0]).toMatchObject({
      executor: GOVPOOL,
      data: GOV_EXT.encodeFunctionData("changeVotePower", [USER]),
    });
    expect(out.category).toBe("mathModel");
  });

  it("blacklist emits add + remove actions", async () => {
    const b = PROPOSAL_BUILDERS.blacklist!;
    const out = await b.build(
      b.schema.parse({ erc20Gov: TOKEN, addAddresses: [USER], removeAddresses: [RECIPIENT] }),
      deps,
    );
    expect(out.actionsOnFor).toHaveLength(2);
    expect(out.actionsOnFor[0]!.data).toBe(ERC20GOV.encodeFunctionData("blacklist", [[USER], true]));
    expect(out.actionsOnFor[1]!.data).toBe(ERC20GOV.encodeFunctionData("blacklist", [[RECIPIENT], false]));
    expect(out.category).toBe("blacklistManagement");
  });

  it("reward_multiplier mint enforces PRECISION scale + uint64 duration", async () => {
    const b = PROPOSAL_BUILDERS.reward_multiplier!;
    const out = await b.build(
      b.schema.parse({
        mode: "mint", nftMultiplierContract: EXPERT_NFT, to: USER,
        multiplier: "15000000000000000000000000", rewardPeriod: "3600",
      }),
      deps,
    );
    expect(out.actionsOnFor[0]!.data).toBe(
      MULTIPLIER.encodeFunctionData("mint", [USER, 15000000000000000000000000n, 3600n, ""]),
    );
    await expect(
      b.build(b.schema.parse({ mode: "mint", nftMultiplierContract: EXPERT_NFT, to: USER, multiplier: "15", rewardPeriod: "1" }), deps),
    ).rejects.toThrow(/PRECISION=1e25/);
  });

  it("apply_to_dao: full-treasury transfer vs transfer+mint shortfall (H-4)", async () => {
    const b = PROPOSAL_BUILDERS.apply_to_dao!;
    const full = await b.build(
      b.schema.parse({ token: TOKEN, receiver: RECIPIENT, amount: "100", treasuryBalance: "200" }),
      deps,
    );
    expect(full.actionsOnFor).toHaveLength(1);
    const short = await b.build(
      b.schema.parse({ token: TOKEN, receiver: RECIPIENT, amount: "100", treasuryBalance: "30" }),
      deps,
    );
    expect(short.actionsOnFor).toHaveLength(2);
    expect(short.actionsOnFor[0]!.data).toBe(ERC20.encodeFunctionData("transfer", [RECIPIENT, 30n]));
    expect(short.actionsOnFor[1]!.data).toBe(ERC20GOV.encodeFunctionData("mint", [RECIPIENT, 70n]));
  });

  it("F11: omitted treasuryBalance without RPC fails actionably (no silent full mint)", async () => {
    const b = PROPOSAL_BUILDERS.apply_to_dao!;
    await expect(
      b.build(b.schema.parse({ token: TOKEN, receiver: RECIPIENT, amount: "100" }), deps),
    ).rejects.toThrow(/treasuryBalance/);
  });

  it("new_proposal_type == enable_staking: addSettings + changeExecutors", async () => {
    expect(PROPOSAL_BUILDERS.enable_staking).toBe(PROPOSAL_BUILDERS.new_proposal_type);
    const b = PROPOSAL_BUILDERS.new_proposal_type!;
    const settings = {
      earlyCompletion: true, delegatedVotingAllowed: false, validatorsVote: false,
      duration: "86400", durationValidators: "86400", executionDelay: "0",
      quorum: "510000000000000000000000000", quorumValidators: "510000000000000000000000000",
      minVotesForVoting: "0", minVotesForCreating: "0",
      rewardsInfo: { rewardToken: ZeroAddress, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
      executorDescription: "staking",
    };
    const out = await b.build(
      b.schema.parse({ govSettings: SETTINGS, settings, executors: [DIST], newSettingId: "5" }),
      deps,
    );
    expect(out.actionsOnFor).toHaveLength(2);
    expect(out.actionsOnFor[1]!.data).toBe(GOV_SETTINGS.encodeFunctionData("changeExecutors", [[DIST], [5n]]));
    expect(out.category).toBe("createProposalType");
  });

  it("scoped expert aliases bake the scope", async () => {
    const b = PROPOSAL_BUILDERS.add_global_expert!;
    const out = await b.build(b.schema.parse({ expertNftContract: EXPERT_NFT, nominatedUser: USER }), deps);
    expect(out.category).toBe("globalExpert");
    const r = PROPOSAL_BUILDERS.remove_local_expert!;
    const out2 = await r.build(r.schema.parse({ expertNftContract: EXPERT_NFT, nominatedUser: USER }), deps);
    expect(out2.category).toBe("localExpertRemoval");
  });
});

describe("internal proposal builders (GovValidators path)", () => {
  const EXEC = new Interface([
    "function changeBalances(uint256[] balances, address[] users)",
    "function changeSettings(uint64 duration, uint64 executionDelay, uint128 quorum)",
    "function monthlyWithdraw(address[] tokens, uint256[] amounts, address destination)",
  ]);

  // IGovValidators.ProposalType: 0=ChangeSettings, 1=ChangeBalances (bug F8:
  // the 0/1 pair was shipped inverted and reverted on-chain with
  // "Validators: not ChangeSettings/ChangeBalances function").
  it("change_validator_balances → type 1 (ChangeBalances)", () => {
    const b = INTERNAL_PROPOSAL_BUILDERS.change_validator_balances!;
    const out = b.build(b.schema.parse({ changes: [{ user: USER, balance: "10" }] }));
    expect(out.internalType).toBe(1);
    expect(out.data).toBe(EXEC.encodeFunctionData("changeBalances", [[10n], [USER]]));
    expect(out.category).toBe("changeValidatorBalances");
  });

  it("change_validator_settings → type 0 (ChangeSettings)", () => {
    const b = INTERNAL_PROPOSAL_BUILDERS.change_validator_settings!;
    const out = b.build(b.schema.parse({ duration: "3600", executionDelay: "0", quorum: "510000000000000000000000000" }));
    expect(out.internalType).toBe(0);
    expect(out.data).toBe(
      EXEC.encodeFunctionData("changeSettings", [3600n, 0n, 510000000000000000000000000n]),
    );
  });

  it("monthly_withdraw → type 2", () => {
    const b = INTERNAL_PROPOSAL_BUILDERS.monthly_withdraw!;
    const out = b.build(b.schema.parse({ withdrawals: [{ token: TOKEN, amount: "5" }], destination: RECIPIENT }));
    expect(out.internalType).toBe(2);
    expect(out.data).toBe(EXEC.encodeFunctionData("monthlyWithdraw", [[TOKEN], [5n], RECIPIENT]));
  });

  it("offchain_internal_proposal → type 3, data MUST be 0x", () => {
    const b = INTERNAL_PROPOSAL_BUILDERS.offchain_internal_proposal!;
    const out = b.build(b.schema.parse({}));
    expect(out.internalType).toBe(3);
    expect(out.data).toBe("0x");
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
  it("F9: human-unit amount without RPC fails actionably instead of BigInt crash", async () => {
    const b = PROPOSAL_BUILDERS.token_distribution!;
    await expect(
      b.build(
        b.schema.parse({ distributionProposal: DIST, proposalId: "3", token: TOKEN, amount: "50000.0" }),
        deps,
      ),
    ).rejects.toThrow(/human units.*RPC/s);
  });
  it("F9: native human-unit amount scales by 18 without RPC", async () => {
    const b = PROPOSAL_BUILDERS.token_distribution!;
    const out = await b.build(
      b.schema.parse({ distributionProposal: DIST, proposalId: "3", token: TOKEN, amount: "1.5", isNative: true }),
      deps,
    );
    expect(out.actionsOnFor[0]!.value).toBe("1500000000000000000");
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
