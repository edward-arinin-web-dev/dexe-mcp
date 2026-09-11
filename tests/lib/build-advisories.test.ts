/**
 * The convergence layer itself — `assessBuildPure` / `assessBuildContext`.
 *
 * Unit-level counterpart to tests/tools/guard-wiring-matrix.test.ts: that file
 * proves each guard reaches every SURFACE, this one proves each guard is
 * CORRECT, including the bounds that must NOT fire (the contract has no lower
 * bound on quorumValidators) and the tier model's invariants.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import {
  assessBuildPure,
  assessBuildContext,
  govSettingsBoundViolations,
  classifyGovernanceActions,
  governanceVerdict,
  resetBuildContextCache,
  PERCENTAGE_100,
} from "../../src/lib/buildAdvisories.js";
import {
  decodeCreateTiersVesting,
  decodeBlacklistAdditions,
  TOKEN_SALE_CREATE_TIERS_SELECTOR,
  BLACKLIST_SELECTOR,
} from "../../src/lib/protocolAdvisories.js";
import { TOKEN_SALE_PROPOSAL_ABI } from "../../src/tools/proposalBuildComplex.js";
import type { DexeConfig } from "../../src/config.js";

const GOVPOOL = "0x0fe0474aE9499F4b5da85617e5482Db83714da6b";
const KEEPER = "0xaecD56D70f0A686302c41FB6988359980e39090C";
const TOKEN = "0xe70645259756186F03610c9432d7dE3b3f4Aab69";
const USER = "0x000000000000000000000000000000000000dEaD";

const ERC20 = new Interface([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);
const BLACKLIST = new Interface(["function blacklist(address[] accounts, bool value)"]);
const SETTINGS_IFACE = new Interface([
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
]);

function settingsTuple(over: Partial<Record<string, string>> = {}) {
  return [
    true,
    false,
    false,
    BigInt(over.duration ?? "86400"),
    BigInt(over.durationValidators ?? "86400"),
    86400n,
    BigInt(over.quorum ?? "510000000000000000000000000"),
    BigInt(over.quorumValidators ?? "510000000000000000000000000"),
    1000000000000000000n,
    1000000000000000000n,
    [ZeroAddress, 0n, 0n, 0n],
    "keep",
  ];
}

const addSettingsData = (over?: Partial<Record<string, string>>) =>
  SETTINGS_IFACE.encodeFunctionData("addSettings", [[settingsTuple(over)]]);

const base = { chainIdExplicit: true, treasuryGuard: "warn" as const };

beforeEach(() => resetBuildContextCache());

describe("govSettingsBoundViolations mirrors GovSettings._validateProposalSettings exactly", () => {
  it("1e27 is the inclusive upper bound", () => {
    expect(PERCENTAGE_100).toBe(10n ** 27n);
    expect(
      govSettingsBoundViolations({
        quorum: PERCENTAGE_100.toString(),
        quorumValidators: "0",
        duration: "1",
        durationValidators: "1",
      }),
    ).toEqual([]);
  });

  const rows: { name: string; input: Record<string, string>; field?: string; revert?: string }[] = [
    {
      name: "quorum 150%",
      input: { quorum: "1500000000000000000000000000", quorumValidators: "510000000000000000000000000", duration: "86400", durationValidators: "86400" },
      field: "quorum",
      revert: "GovSettings: invalid quorum value",
    },
    {
      name: "quorum 0",
      input: { quorum: "0", quorumValidators: "510000000000000000000000000", duration: "86400", durationValidators: "86400" },
      field: "quorum",
      revert: "GovSettings: invalid quorum value",
    },
    {
      name: "duration 0",
      input: { quorum: "510000000000000000000000000", quorumValidators: "510000000000000000000000000", duration: "0", durationValidators: "86400" },
      field: "duration",
      revert: "GovSettings: invalid vote duration value",
    },
    {
      name: "durationValidators 0",
      input: { quorum: "510000000000000000000000000", quorumValidators: "510000000000000000000000000", duration: "86400", durationValidators: "0" },
      field: "durationValidators",
      revert: "GovSettings: invalid validator vote duration value",
    },
    {
      name: "quorumValidators 150%",
      input: { quorum: "510000000000000000000000000", quorumValidators: "1500000000000000000000000000", duration: "86400", durationValidators: "86400" },
      field: "quorumValidators",
      revert: "GovSettings: invalid validator quorum value",
    },
    // THE regression guard: the contract has NO `quorumValidators > 0` require,
    // and the project deliberately treats 0 with validatorsVote=false as legal
    // (tests/lib/protocol-advisories.test.ts pins that). `checkSettingsBounds`
    // in preflight.ts IS stricter, which is why it is not reused here.
    {
      name: "quorumValidators 0 is LEGAL",
      input: { quorum: "510000000000000000000000000", quorumValidators: "0", duration: "86400", durationValidators: "86400" },
    },
    { name: "all in range", input: { quorum: "510000000000000000000000000", quorumValidators: "510000000000000000000000000", duration: "86400", durationValidators: "86400" } },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const out = govSettingsBoundViolations(row.input);
      if (!row.field) {
        expect(out).toEqual([]);
        return;
      }
      expect(out.map((v) => v.field)).toContain(row.field);
      expect(out.find((v) => v.field === row.field)!.revert).toBe(row.revert);
    });
  }

  it("never throws on a non-numeric value", () => {
    const out = govSettingsBoundViolations({ quorum: "abc", quorumValidators: "0", duration: "86400", durationValidators: "86400" });
    expect(out.map((v) => v.field)).toContain("quorum");
    expect(out.find((v) => v.field === "quorum")!.revert).toBe("");
  });
});

describe("assessBuildPure", () => {
  it("finds an out-of-range quorum in emitted addSettings calldata", () => {
    const w = assessBuildPure({
      ...base,
      chainId: 56,
      actions: [{ executor: TOKEN, value: "0", data: addSettingsData({ quorum: "1500000000000000000000000000" }) }],
    });
    const bounds = w.find((x) => x.code === "settings.bounds")!;
    expect(bounds).toBeDefined();
    expect(bounds.severity).toBe("DANGER");
    expect(bounds.block).toBe("confirmable");
    expect(bounds.message).toContain("GovSettings: invalid quorum value");
    expect(bounds.remedy).toContain("510000000000000000000000000");
  });

  it("raises #36 on a blocked chain and not on an allowed one", () => {
    const action = { executor: TOKEN, value: "0", data: addSettingsData() };
    expect(assessBuildPure({ ...base, chainId: 97, actions: [action] }).map((w) => w.code)).toContain(
      "upstream.add-settings-chain",
    );
    expect(assessBuildPure({ ...base, chainId: 56, actions: [action] }).map((w) => w.code)).not.toContain(
      "upstream.add-settings-chain",
    );
  });

  it("downgrades a chain-keyed finding when the chain was assumed, not named", () => {
    const w = assessBuildPure({
      chainId: 97,
      chainIdExplicit: false,
      treasuryGuard: "warn",
      actions: [{ executor: TOKEN, value: "0", data: addSettingsData() }],
    });
    const hit = w.find((x) => x.code === "upstream.add-settings-chain")!;
    expect(hit.severity).toBe("WARN");
    expect(hit.block).toBe("none");
    expect(hit.message.startsWith("chainId was not supplied; assumed 97 — ")).toBe(true);
  });

  it("refuses a zero executor as a hard block", () => {
    const w = assessBuildPure({ ...base, chainId: 97, actions: [{ executor: ZeroAddress, value: "0", data: "0x12345678" }] });
    const hit = w.find((x) => x.code === "action.zero-executor")!;
    expect(hit.block).toBe("hard");
    expect(hit.message).toContain("no revert receipt");
  });

  it("flags an approve whose spender IS the govPool, and only then", () => {
    const bad = assessBuildPure({
      ...base,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: ERC20.encodeFunctionData("approve", [GOVPOOL, 1n]) }],
    });
    expect(bad.find((w) => w.code === "approve.target")!.block).toBe("hard");

    // A TokenSaleProposal / DistributionProposal / StakingProposal spender is
    // CORRECT — this is the project's general ERC20 approve encoder.
    const ok = assessBuildPure({
      ...base,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: ERC20.encodeFunctionData("approve", [KEEPER, 1n]) }],
    });
    expect(ok.map((w) => w.code)).not.toContain("approve.target");
  });

  it("flags blacklisting the DAO's own GovPool, and ignores un-blacklisting", () => {
    const add = assessBuildPure({
      ...base,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: BLACKLIST.encodeFunctionData("blacklist", [[GOVPOOL], true]) }],
    });
    expect(add.map((w) => w.code)).toContain("blacklist.self-harm");
    // Removing is the CURE — never flagged.
    const remove = assessBuildPure({
      ...base,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: BLACKLIST.encodeFunctionData("blacklist", [[GOVPOOL], false]) }],
    });
    expect(remove.map((w) => w.code)).not.toContain("blacklist.self-harm");
  });

  it("treasury.risk is emitted at block:'none' and silenced by guard 'off'", () => {
    const action = { executor: TOKEN, value: "0", data: ERC20.encodeFunctionData("transfer", [USER, 1n]) };
    const on = assessBuildPure({ ...base, chainId: 97, actions: [action] });
    expect(on.find((w) => w.code === "treasury.risk")!.block).toBe("none");
    const off = assessBuildPure({ chainId: 97, chainIdExplicit: true, treasuryGuard: "off", actions: [action] });
    expect(off.map((w) => w.code)).not.toContain("treasury.risk");
  });

  it("a clean build yields no warnings at all", () => {
    expect(
      assessBuildPure({
        ...base,
        chainId: 56,
        actions: [{ executor: TOKEN, value: "0", data: addSettingsData() }],
      }),
    ).toEqual([]);
  });

  it("never throws on junk calldata", () => {
    for (const data of ["", "0x", "0xdead", "0x6a11e769ffff", TOKEN_SALE_CREATE_TIERS_SELECTOR, BLACKLIST_SELECTOR]) {
      expect(() => assessBuildPure({ ...base, chainId: 97, govPool: GOVPOOL, actions: [{ executor: TOKEN, data }] })).not.toThrow();
    }
  });
});

describe("F15 decode works on the calldata the builders actually emit", () => {
  const CREATE_TIERS = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);

  function tier(pct: bigint) {
    return [
      ["Seed", ""],
      1000000000000000000000n,
      1790000000n,
      1800000000n,
      0n,
      TOKEN,
      [TOKEN],
      [1000000000000000000000000n],
      0n,
      0n,
      [pct, 2592000n, 0n, 86400n],
      [],
    ];
  }

  it("round-trips a 50% vesting tier out of createTiers calldata", () => {
    const data = CREATE_TIERS.encodeFunctionData("createTiers", [[tier(500000000000000000000000000n)]]);
    const hits = decodeCreateTiersVesting(data);
    expect(hits).toEqual([{ index: 0, name: "Seed", vestingPercentage: "50" }]);
    const w = assessBuildPure({ ...base, chainId: 56, actions: [{ executor: TOKEN, value: "0", data }] });
    const f15 = w.find((x) => x.code === "tier.vesting-blocked")!;
    expect(f15.id).toBe("F15");
    expect(f15.block).toBe("confirmable");
    expect(f15.upstream).toContain("UPSTREAM-ISSUES");
  });

  it("a 0% tier is clean, and the comparison is bigint (not float) exact", () => {
    const data = CREATE_TIERS.encodeFunctionData("createTiers", [[tier(0n)]]);
    expect(decodeCreateTiersVesting(data)).toEqual([]);
    // 5e26 / 1e25 === 50 exactly; Number(5e26)/1e25 is 49.99999999999999.
    const one = CREATE_TIERS.encodeFunctionData("createTiers", [[tier(10000000000000000000000000n)]]);
    expect(decodeCreateTiersVesting(one)[0]!.vestingPercentage).toBe("1");
  });

  it("returns [] for junk and for a non-createTiers selector", () => {
    expect(decodeCreateTiersVesting("0xdeadbeef")).toEqual([]);
    expect(decodeCreateTiersVesting(TOKEN_SALE_CREATE_TIERS_SELECTOR + "ff")).toEqual([]);
    expect(decodeCreateTiersVesting(undefined)).toEqual([]);
    expect(decodeBlacklistAdditions("0xdeadbeef")).toEqual([]);
  });

  it("the selector is recomputed from the builders' own ABI (drift pin)", () => {
    expect(TOKEN_SALE_CREATE_TIERS_SELECTOR).toBe(CREATE_TIERS.getFunction("createTiers")!.selector);
    expect(TOKEN_SALE_CREATE_TIERS_SELECTOR).toBe("0x6a6effda");
    expect(BLACKLIST_SELECTOR).toBe("0xc997eb8d");
  });
});

describe("assessBuildContext never blocks and never throws", () => {
  const cfg = { defaultChainId: 97, chains: new Map() } as unknown as DexeConfig;

  it("no RPC configured ⇒ at most one context.unavailable INFO, never a refusal", async () => {
    const out = await assessBuildContext({
      ...base,
      cfg,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: ERC20.encodeFunctionData("transfer", [USER, 1n]) }],
    });
    expect(out.filter((w) => w.code === "context.unavailable")).toHaveLength(1);
    expect(out.every((w) => w.block === "none")).toBe(true);
    expect(out.every((w) => w.severity !== "DANGER")).toBe(true);
  });

  it("says nothing at all when there was no context question to ask", async () => {
    const out = await assessBuildContext({
      ...base,
      cfg,
      chainId: 97,
      actions: [{ executor: TOKEN, value: "0", data: "0x12345678" }],
    });
    expect(out).toEqual([]);
  });

  it("a throwing provider degrades to the same INFO — the build is never wedged", async () => {
    const provider = {
      getCode: async () => {
        throw new Error("boom");
      },
    } as never;
    const out = await assessBuildContext({
      ...base,
      cfg,
      provider,
      chainId: 97,
      govPool: GOVPOOL,
      actions: [{ executor: TOKEN, value: "0", data: ERC20.encodeFunctionData("transfer", [USER, 1n]) }],
    });
    expect(out.every((w) => w.block === "none")).toBe(true);
  });
});

describe("classifyGovernanceActions — the risk_assess blind spot", () => {
  const protocolAddresses = [GOVPOOL, KEEPER, TOKEN];

  it("blacklist targeting the DAO's own GovPool is DANGER", () => {
    const hits = classifyGovernanceActions(
      [{ executor: TOKEN, data: BLACKLIST.encodeFunctionData("blacklist", [[GOVPOOL], true]) }],
      { protocolAddresses },
    );
    expect(hits[0]!.kind).toBe("blacklist");
    expect(hits[0]!.protocolTargets).toContain(GOVPOOL);
    expect(governanceVerdict(hits)).toBe("DANGER");
  });

  it("blacklisting a third party is CAUTION, not DANGER", () => {
    const hits = classifyGovernanceActions(
      [{ executor: TOKEN, data: BLACKLIST.encodeFunctionData("blacklist", [[USER], true]) }],
      { protocolAddresses: [GOVPOOL, KEEPER] },
    );
    expect(hits[0]!.protocolTargets).toEqual([]);
    expect(governanceVerdict(hits)).toBe("CAUTION");
  });

  it("addSettings on a DAO helper is CAUTION", () => {
    const hits = classifyGovernanceActions([{ executor: KEEPER, data: addSettingsData() }], { protocolAddresses });
    expect(hits[0]!.kind).toBe("changeSettings");
    expect(governanceVerdict(hits)).toBe("DANGER"); // executor is DAO-owned
  });

  it("an unrecognised selector on a DAO contract is unknownPrivileged, on a third party it is nothing", () => {
    expect(
      classifyGovernanceActions([{ executor: KEEPER, data: "0x12345678" }], { protocolAddresses })[0]!.kind,
    ).toBe("unknownPrivileged");
    expect(
      classifyGovernanceActions([{ executor: USER, data: "0x12345678" }], { protocolAddresses }),
    ).toEqual([]);
  });

  it("a plain ERC20 transfer is NOT double-reported as a governance hit", () => {
    expect(
      classifyGovernanceActions(
        [{ executor: TOKEN, data: ERC20.encodeFunctionData("transfer", [USER, 1n]) }],
        { protocolAddresses: [] },
      ),
    ).toEqual([]);
  });

  it("malformed calldata yields no throw and no targets", () => {
    expect(() => classifyGovernanceActions([{ executor: TOKEN, data: "0xc997eb8dff" }], { protocolAddresses })).not.toThrow();
  });
});
