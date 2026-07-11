import { describe, expect, it } from "vitest";
import { AbiCoder, Interface, getAddress } from "ethers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildDeployGovPool, type DeployParams } from "../../src/tools/daoDeploy.js";
import { synthesizeParams } from "../../src/tools/daoCreate.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { RpcProvider } from "../../src/rpc.js";

/**
 * Golden-vector parity — byte-for-byte regression net for deployGovPool
 * calldata, pinned against the FRONTEND'S rules (source of truth:
 * C:/dev/investing-dashboard useCreateDAO.ts + typechain PoolFactory.ts,
 * struct order re-verified against DeXe-Protocol IPoolFactory.sol 2026-07-11).
 *
 * Two independent paths must agree:
 *   1. the production builder (buildDeployGovPool, fully offline via a stubbed
 *      provider) — exercises SIMPLE synthesis, 1→5 auto-expand, executor
 *      wiring, initData auto-encode, -VT suffixing, ipfs:// stripping;
 *   2. an INDEPENDENT encoding in this file: separately-declared frontend-order
 *      signature + a hand-built tuple applying the frontend rules explicitly.
 * Plus a frozen fixture (deploy-golden.json) so ANY future drift — ABI string
 * edit, transform change, field reorder — fails loudly with a field-level diff.
 *
 * Regenerate the fixture ONLY after deliberately changing builder semantics:
 *   GOLDEN_UPDATE=1 npx vitest run tests/lib/deployParity.test.ts
 */

// ---------- fixed actors / predicted addresses (canned, deterministic) ----------
const DEPLOYER = getAddress("0xdeadbeef00000000000000000000000000000001");
const FACTORY = "0x2222222222222222222222222222222222222222";
const EXT_TOKEN = "0x3333333333333333333333333333333333333333";
const V1 = "0x4444444444444444444444444444444444444444";
const V2 = "0x5555555555555555555555555555555555555555";
const ZERO = "0x0000000000000000000000000000000000000000";

const PREDICTED = {
  govPool: getAddress("0x" + "aa".repeat(20)),
  govTokenSale: getAddress("0x" + "bb".repeat(20)),
  govToken: getAddress("0x" + "cc".repeat(20)),
  distributionProposal: getAddress("0x" + "dd".repeat(20)),
  expertNft: getAddress("0x" + "ee".repeat(20)),
  nftMultiplier: getAddress("0x" + "11".repeat(20)),
};

// ---------- offline stubs ----------
// predictGovAddresses returns (govPool, govTokenSale, govToken, distributionProposal, expertNft, nftMultiplier)
const predictResult = AbiCoder.defaultAbiCoder().encode(
  ["tuple(address,address,address,address,address,address)"],
  [
    [
      PREDICTED.govPool,
      PREDICTED.govTokenSale,
      PREDICTED.govToken,
      PREDICTED.distributionProposal,
      PREDICTED.expertNft,
      PREDICTED.nftMultiplier,
    ],
  ],
);
const fakeProvider = {
  call: async () => predictResult,
  getCode: async () => "0x", // no name collision, nothing deployed
};
const rpc = { tryProvider: () => ({ ok: fakeProvider }) } as unknown as RpcProvider;
const ctx = {
  config: {
    chains: new Map([[97, { chainId: 97 }]]),
    defaultChainId: 97,
    treasuryGuard: "off", // advisory only — irrelevant to calldata bytes
    pinataJwt: undefined, // executorDescription stays "" (no IPFS in this test)
  },
  artifacts: { get: () => [] }, // pins the FALLBACK tuple ABI — the golden reference
} as unknown as ToolContext;

// ---------- independent frontend-order signature (typechain PoolFactory.ts §1) ----------
// Deliberately re-declared here (NOT imported from src) so a drift in the
// builder's fallback ABI shows up as a selector/byte mismatch.
const FRONTEND_SIG =
  "function deployGovPool(tuple(" +
  "tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, " +
  "tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, " +
  "tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, " +
  "tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, " +
  "tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, " +
  "address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)";
const independentIface = new Interface([FRONTEND_SIG]);

const LINEAR_INIT = new Interface(["function __LinearPower_init()"]).encodeFunctionData("__LinearPower_init", []);
const POLY_INIT = (c1: bigint, c2: bigint, c3: bigint) =>
  new Interface(["function __PolynomialPower_init(uint256,uint256,uint256)"]).encodeFunctionData(
    "__PolynomialPower_init",
    [c1, c2, c3],
  );

type Setting = {
  earlyCompletion: boolean;
  delegatedVotingAllowed: boolean;
  validatorsVote: boolean;
  duration: string;
  durationValidators: string;
  executionDelay: string;
  quorum: string;
  quorumValidators: string;
  minVotesForVoting: string;
  minVotesForCreating: string;
  rewardsInfo: { rewardToken: string; creationReward: string; executionReward: string; voteRewardsCoefficient: string };
  executorDescription: string;
};

const settingTuple = (s: Setting) => [
  s.earlyCompletion,
  s.delegatedVotingAllowed,
  s.validatorsVote,
  BigInt(s.duration),
  BigInt(s.durationValidators),
  BigInt(s.executionDelay),
  BigInt(s.quorum),
  BigInt(s.quorumValidators),
  BigInt(s.minVotesForVoting),
  BigInt(s.minVotesForCreating),
  [
    s.rewardsInfo.rewardToken,
    BigInt(s.rewardsInfo.creationReward),
    BigInt(s.rewardsInfo.executionReward),
    BigInt(s.rewardsInfo.voteRewardsCoefficient),
  ],
  s.executorDescription,
];

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "deploy-golden.json");

async function build(daoName: string, params: DeployParams) {
  const res = await buildDeployGovPool({ chainId: 97, poolFactory: FACTORY, deployer: DEPLOYER, params }, ctx, rpc);
  if (!res.ok) throw new Error(`builder failed: ${res.error}`);
  return res;
}

/** Field-level diff on mismatch instead of a useless 12KB hex diff. */
function expectSameCalldata(got: string, want: string) {
  if (got !== want) {
    const dec = (d: string) => independentIface.decodeFunctionData("deployGovPool", d);
    expect(JSON.stringify(dec(got), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)).toBe(
      JSON.stringify(dec(want), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
    // decodable-equal but byte-different (e.g. selector) — still a failure:
    expect(got).toBe(want);
  }
}

describe("deployGovPool golden-vector parity (frontend rules)", () => {
  // ================= vector 1: SIMPLE synthesis, LINEAR =================
  const V1_NAME = "Aurora Collective";
  const simpleParams: DeployParams = {
    ...synthesizeParams(
      {
        daoName: V1_NAME,
        symbol: "AUR",
        totalSupply: "1000000",
        treasuryPercent: 49,
        quorumPercent: 51,
        voteModel: "LINEAR",
        durationSeconds: 86400,
        executionDelaySeconds: 0,
        minVotesTokens: "1",
        earlyCompletion: true,
      },
      DEPLOYER,
    ),
    descriptionURL: "ipfs://QmGoldenVector1",
    name: V1_NAME,
  };

  function independentSimpleCalldata(): string {
    // Frontend rules applied by hand: 5 identical settings except DP (index 3),
    // which forces delegatedVotingAllowed:false and earlyCompletion:false
    // (useCreateDAO.ts:149-164).
    const base: Setting = {
      earlyCompletion: true,
      delegatedVotingAllowed: false, // false = delegation ALLOWED (inverted semantics)
      validatorsVote: true,
      duration: "86400",
      durationValidators: "86400", // fallback to duration (no validators)
      executionDelay: "0",
      quorum: (51n * 10n ** 25n).toString(), // 51% at 1e25-per-percent
      quorumValidators: (51n * 10n ** 25n).toString(), // fallback to quorum
      minVotesForVoting: (10n ** 18n).toString(),
      minVotesForCreating: (10n ** 18n).toString(),
      rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
      executorDescription: "",
    };
    const dp: Setting = { ...base, delegatedVotingAllowed: false, earlyCompletion: false };
    const supply = 1_000_000n * 10n ** 18n;
    const distributed = (supply * 51n) / 100n; // 49% treasury = implicit remainder
    const tuple = [
      // settingsParams: [default, internal, validators, DP, tokenSale] + executors [distribution, tokenSale]
      [
        [settingTuple(base), settingTuple(base), settingTuple(base), settingTuple(dp), settingTuple(base)],
        [PREDICTED.distributionProposal, PREDICTED.govTokenSale],
      ],
      // validatorsParams: builder default + "-VT" suffix, settings mirror base
      ["Validator Token-VT", "VT-VT", [86400n, 0n, 51n * 10n ** 25n], [], []],
      // userKeeperParams: predicted govToken auto-wired
      [PREDICTED.govToken, ZERO, 0n, 0n],
      // tokenParams: fixed supply (cap == mintedTotal), deployer sole recipient
      [V1_NAME, "AUR", [DEPLOYER], supply, supply, [distributed]],
      // votePowerParams: LINEAR = enum 0, auto-encoded init, no preset
      [0, LINEAR_INIT, ZERO],
      ZERO, // verifier
      false, // onlyBABTHolders
      "QmGoldenVector1", // ipfs:// prefix stripped
      V1_NAME,
    ];
    return independentIface.encodeFunctionData("deployGovPool", [tuple]);
  }

  // ================= vector 2: ADVANCED, validators + POLYNOMIAL + external token =================
  const V2_NAME = "Meridian Council";
  const PCT = (n: bigint) => (n * 10n ** 25n).toString();
  const advSetting = (q: bigint): DeployParams["settingsParams"]["proposalSettings"][number] => ({
    earlyCompletion: false,
    delegatedVotingAllowed: true, // true = delegation DISABLED
    validatorsVote: true,
    duration: "172800",
    durationValidators: "86400",
    executionDelay: "3600",
    quorum: PCT(q),
    quorumValidators: PCT(60n),
    minVotesForVoting: (5n * 10n ** 18n).toString(),
    minVotesForCreating: (25n * 10n ** 18n).toString(),
    rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
    executorDescription: "",
  });
  const advancedParams: DeployParams = {
    settingsParams: {
      // explicit 5 — passed through verbatim (no auto-expand)
      proposalSettings: [advSetting(51n), advSetting(52n), advSetting(53n), advSetting(54n), advSetting(55n)],
      additionalProposalExecutors: [],
    },
    validatorsParams: {
      name: "Meridian Guard",
      symbol: "MG",
      proposalSettings: { duration: "86400", executionDelay: "0", quorum: PCT(60n) },
      validators: [V1, V2],
      balances: [(10n * 10n ** 18n).toString(), (20n * 10n ** 18n).toString()],
    },
    userKeeperParams: { tokenAddress: EXT_TOKEN, nftAddress: ZERO, individualPower: "0", nftsTotalSupply: "0" },
    tokenParams: { name: "", symbol: "", users: [], cap: "0", mintedTotal: "0", amounts: [] },
    votePowerParams: {
      voteType: "POLYNOMIAL_VOTES",
      presetAddress: ZERO,
      // frontend defaults: c1=expertsDelegation 1.08, c2=experts 0.92, c3=holders 0.97 (×1e25)
      polynomialCoefficients: {
        coefficient1: (108n * 10n ** 23n).toString(),
        coefficient2: (92n * 10n ** 23n).toString(),
        coefficient3: (97n * 10n ** 23n).toString(),
      },
    },
    verifier: ZERO,
    onlyBABTHolders: false,
    descriptionURL: "ipfs://QmGoldenVector2",
    name: V2_NAME,
  };

  function independentAdvancedCalldata(): string {
    const s = (q: bigint, extra?: Partial<Setting>): Setting => ({
      earlyCompletion: false,
      delegatedVotingAllowed: true,
      validatorsVote: true,
      duration: "172800",
      durationValidators: "86400",
      executionDelay: "3600",
      quorum: PCT(q),
      quorumValidators: PCT(60n),
      minVotesForVoting: (5n * 10n ** 18n).toString(),
      minVotesForCreating: (25n * 10n ** 18n).toString(),
      rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
      executorDescription: "",
      ...extra,
    });
    const tuple = [
      [
        [settingTuple(s(51n)), settingTuple(s(52n)), settingTuple(s(53n)), settingTuple(s(54n)), settingTuple(s(55n))],
        [PREDICTED.distributionProposal, PREDICTED.govTokenSale],
      ],
      ["Meridian Guard-VT", "MG-VT", [86400n, 0n, 60n * 10n ** 25n], [V1, V2], [10n * 10n ** 18n, 20n * 10n ** 18n]],
      [EXT_TOKEN, ZERO, 0n, 0n], // external token NOT replaced by predicted govToken
      ["", "", [], 0n, 0n, []],
      [1, POLY_INIT(108n * 10n ** 23n, 92n * 10n ** 23n, 97n * 10n ** 23n), ZERO], // POLYNOMIAL = enum 1
      ZERO,
      false,
      "QmGoldenVector2",
      V2_NAME,
    ];
    return independentIface.encodeFunctionData("deployGovPool", [tuple]);
  }

  it("SIMPLE synthesis: builder output == independent frontend-rule encoding, byte for byte", async () => {
    const res = await build(V1_NAME, simpleParams);
    expectSameCalldata(res.payload.data, independentSimpleCalldata());
    expect(res.predictedGovPool).toBe(PREDICTED.govPool);
  });

  it("ADVANCED (validators + POLYNOMIAL + external token): builder == independent encoding", async () => {
    const res = await build(V2_NAME, advancedParams);
    expectSameCalldata(res.payload.data, independentAdvancedCalldata());
  });

  it("both vectors match the frozen fixture (deploy-golden.json)", async () => {
    const got = {
      provenance:
        "Derived from C:/dev/investing-dashboard useCreateDAO.ts rules + DeXe-Protocol IPoolFactory.sol struct order " +
        "(verified 2026-07-11). Regenerate ONLY on deliberate semantic change: GOLDEN_UPDATE=1 npx vitest run tests/lib/deployParity.test.ts",
      simple: (await build(V1_NAME, simpleParams)).payload.data,
      advanced: (await build(V2_NAME, advancedParams)).payload.data,
    };
    if (process.env.GOLDEN_UPDATE === "1" || !existsSync(fixturePath)) {
      writeFileSync(fixturePath, JSON.stringify(got, null, 2) + "\n");
    }
    const want = JSON.parse(readFileSync(fixturePath, "utf8")) as typeof got;
    expectSameCalldata(got.simple, want.simple);
    expectSameCalldata(got.advanced, want.advanced);
  });
});
