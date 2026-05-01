// Regenerate OTC fixtures by:
//   1. Running an *independent* synthesizer that mirrors the frontend hook
//      `useGovPoolCreateTokenSaleProposal.ts` (lines 33-130).
//   2. Calling `buildTokenSaleMultiActions` from `dist/`.
//   3. Asserting the two produce byte-identical calldata. If they match, the
//      fixture's `expected.actions` is recorded — locking in the contract
//      between MCP and the frontend's encoding logic.
//
// Re-run when:
//   - The frontend regenerates `TokenSaleProposal` ABI (contract changed).
//   - The MCP helper `buildTokenSaleMultiActions` is refactored.
//   - Adding a new fixture shape.
//
// Usage:  node tests/compat/gen-otc-fixtures.mjs
// Exit 0 on regenerate success, 1 on synth/helper divergence.

import { Interface, AbiCoder, getAddress } from "ethers";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const helper = await import(
  "file:///" + path.join(repoRoot, "dist/tools/proposalBuildComplex.js").replace(/\\/g, "/")
);
const merkle = await import(
  "file:///" + path.join(repoRoot, "dist/lib/merkleTree.js").replace(/\\/g, "/")
);

// Canonical TokenSaleProposal signatures — matches the compiled frontend ABI
// at `C:/dev/investing-dashboard/src/abi/TokenSaleProposal` (regenerated from
// the same Solidity source as MCP's `dexe_get_methods TokenSaleProposal`).
const TSP_SIG = [
  "function createTiers(tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint64 saleStartTime, uint64 saleEndTime, uint64 claimLockDuration, address saleTokenAddress, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 vestingPercentage, uint64 vestingDuration, uint64 cliffPeriod, uint64 unlockStep) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
  "function addToWhitelist(tuple(uint256 tierId, address[] users, string uri)[] requests)",
];
const ERC20_SIG = ["function approve(address spender, uint256 amount) returns (bool)"];

const tspIface = new Interface(TSP_SIG);
const ercIface = new Interface(ERC20_SIG);
const coder = AbiCoder.defaultAbiCoder();

const PT = { DAOVotes: 0, Whitelist: 1, BABT: 2, TokenLock: 3, NftLock: 4, MerkleWhitelist: 5 };

function encodePart(p) {
  if (p.type === "DAOVotes")
    return { type: PT.DAOVotes, data: coder.encode(["uint256"], [BigInt(p.requiredVotes)]) };
  if (p.type === "Whitelist") return { type: PT.Whitelist, data: "0x" };
  if (p.type === "BABT") return { type: PT.BABT, data: "0x" };
  if (p.type === "TokenLock")
    return {
      type: PT.TokenLock,
      data: coder.encode(["address", "uint256"], [getAddress(p.token), BigInt(p.amount)]),
    };
  if (p.type === "NftLock")
    return {
      type: PT.NftLock,
      data: coder.encode(["address", "uint256"], [getAddress(p.nft), BigInt(p.amount)]),
    };
  if (p.type === "MerkleWhitelist") {
    let root = p.root;
    if (!root) root = merkle.buildAddressMerkleTree(p.users.map((u) => getAddress(u))).root;
    return {
      type: PT.MerkleWhitelist,
      data: coder.encode(["bytes32", "string"], [root, p.uri ?? ""]),
    };
  }
  throw new Error(`bad participation type: ${p.type}`);
}

function buildTierTuple(tier) {
  const parts = (tier.participation ?? []).map(encodePart);
  return [
    [tier.name, tier.description ?? ""],
    BigInt(tier.totalTokenProvided),
    BigInt(tier.saleStartTime),
    BigInt(tier.saleEndTime),
    BigInt(tier.claimLockDuration ?? "0"),
    getAddress(tier.saleTokenAddress),
    tier.purchaseTokenAddresses.map(getAddress),
    tier.exchangeRates.map(BigInt),
    BigInt(tier.minAllocationPerUser ?? "0"),
    BigInt(tier.maxAllocationPerUser ?? "0"),
    [
      BigInt(tier.vestingSettings?.vestingPercentage ?? "0"),
      BigInt(tier.vestingSettings?.vestingDuration ?? "0"),
      BigInt(tier.vestingSettings?.cliffPeriod ?? "0"),
      BigInt(tier.vestingSettings?.unlockStep ?? "0"),
    ],
    parts.map((p) => [p.type, p.data]),
  ];
}

/**
 * Mirror useGovPoolCreateTokenSaleProposal.ts:33-130:
 *   - Fetch latestTierId (caller supplies)
 *   - whitelistingRequests: only for plain-Whitelist tiers, tierId = latest+1+i
 *   - encodedCreateTiersExecution = createTiers(tiers)
 *   - encodedAddToWhitelistExecution = addToWhitelist(requests) when any
 *   - saleTokensMap: keyed by saleTokenAddress.toLowerCase(), summed
 *   - actions: [...approves, createTiers, addToWhitelist?]
 */
function frontendSynthesize(input) {
  const totals = new Map();
  for (const t of input.tiers) {
    const key = t.saleTokenAddress.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(t.totalTokenProvided));
  }
  const approves = [];
  // Frontend iterates Object.values(saleTokensMap) in insertion order — which
  // matches first-occurrence order in `tiers`. Map preserves that.
  for (const [tokenLower, amt] of totals.entries()) {
    approves.push({
      executor: getAddress(tokenLower), // both forms produce identical calldata
      value: "0",
      data: ercIface.encodeFunctionData("approve", [getAddress(input.tokenSaleProposal), amt]),
    });
  }
  const tierTuples = input.tiers.map(buildTierTuple);
  const createData = tspIface.encodeFunctionData("createTiers", [tierTuples]);
  const baseTier = BigInt(input.latestTierId ?? "0");
  const wlReqs = [];
  input.tiers.forEach((t, i) => {
    const wlPart = (t.participation ?? []).find(
      (p) => p.type === "Whitelist" && p.users && p.users.length > 0,
    );
    if (wlPart) {
      wlReqs.push([baseTier + 1n + BigInt(i), wlPart.users.map(getAddress), wlPart.uri ?? ""]);
    }
  });
  const actions = [
    ...approves,
    { executor: getAddress(input.tokenSaleProposal), value: "0", data: createData },
  ];
  if (wlReqs.length > 0) {
    const wlData = tspIface.encodeFunctionData("addToWhitelist", [wlReqs]);
    actions.push({
      executor: getAddress(input.tokenSaleProposal),
      value: "0",
      data: wlData,
    });
  }
  return actions;
}

// ---- fixture inputs ----
const TSP = "0x9E74AD4f2aFe44073f4E07D8eafE4d92387fFcE6";
const SALE_TOKEN = "0x77a6Ce0E5166d4c129E07951aD1c56210b66C763";
const PURCHASE_TOKEN = "0x55d398326f99059fF775485246999027B3197955";
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const A3 = "0x3333333333333333333333333333333333333333";

const FIX_1TIER_OPEN = {
  tokenSaleProposal: TSP,
  latestTierId: "0",
  proposalName: "OTC Open Tier",
  proposalDescription: "Open OTC sale, single tier, no participation gating.",
  tiers: [
    {
      name: "Open Tier",
      description: "Anyone can buy.",
      totalTokenProvided: "1000000000000000000000",
      saleStartTime: "1750000000",
      saleEndTime: "1760000000",
      claimLockDuration: "0",
      saleTokenAddress: SALE_TOKEN,
      purchaseTokenAddresses: [PURCHASE_TOKEN],
      exchangeRates: ["1000000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "0",
        vestingDuration: "0",
        cliffPeriod: "0",
        unlockStep: "0",
      },
      participation: [],
    },
  ],
};

const FIX_2TIER_MERKLE = {
  tokenSaleProposal: TSP,
  latestTierId: "0",
  proposalName: "OTC Open + Merkle Whitelist",
  proposalDescription: "Two tiers — open + merkle-gated.",
  tiers: [
    {
      name: "Tier A Open",
      description: "",
      totalTokenProvided: "500000000000000000000",
      saleStartTime: "1750000000",
      saleEndTime: "1760000000",
      claimLockDuration: "0",
      saleTokenAddress: SALE_TOKEN,
      purchaseTokenAddresses: [PURCHASE_TOKEN],
      exchangeRates: ["1000000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "0",
        vestingDuration: "0",
        cliffPeriod: "0",
        unlockStep: "0",
      },
      participation: [],
    },
    {
      name: "Tier B Merkle",
      description: "Whitelisted via merkle root.",
      totalTokenProvided: "500000000000000000000",
      saleStartTime: "1750000000",
      saleEndTime: "1760000000",
      claimLockDuration: "0",
      saleTokenAddress: SALE_TOKEN,
      purchaseTokenAddresses: [PURCHASE_TOKEN],
      exchangeRates: ["2000000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "250000000000000000000000000",
        vestingDuration: "2592000",
        cliffPeriod: "604800",
        unlockStep: "86400",
      },
      participation: [{ type: "MerkleWhitelist", users: [A1, A2, A3], uri: "" }],
    },
  ],
};

const FIX_2TIER_PLAIN_WL = {
  tokenSaleProposal: TSP,
  latestTierId: "0",
  proposalName: "OTC Open + Plain Whitelist",
  proposalDescription:
    "Two tiers — open + NFT-mint plain whitelist (auto addToWhitelist).",
  tiers: [
    {
      name: "Tier A Open",
      description: "",
      totalTokenProvided: "500000000000000000000",
      saleStartTime: "1750000000",
      saleEndTime: "1760000000",
      claimLockDuration: "0",
      saleTokenAddress: SALE_TOKEN,
      purchaseTokenAddresses: [PURCHASE_TOKEN],
      exchangeRates: ["1000000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "0",
        vestingDuration: "0",
        cliffPeriod: "0",
        unlockStep: "0",
      },
      participation: [],
    },
    {
      name: "Tier B Plain WL",
      description: "",
      totalTokenProvided: "500000000000000000000",
      saleStartTime: "1750000000",
      saleEndTime: "1760000000",
      claimLockDuration: "86400",
      saleTokenAddress: SALE_TOKEN,
      purchaseTokenAddresses: [PURCHASE_TOKEN],
      exchangeRates: ["1500000000000000000"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "0",
      vestingSettings: {
        vestingPercentage: "0",
        vestingDuration: "0",
        cliffPeriod: "0",
        unlockStep: "0",
      },
      participation: [{ type: "Whitelist", users: [A1, A2], uri: "" }],
    },
  ],
};

const cases = [
  { name: "otc-frontend-1tier-open", input: FIX_1TIER_OPEN },
  { name: "otc-frontend-2tier-merkle", input: FIX_2TIER_MERKLE },
  { name: "otc-frontend-2tier-plain-whitelist", input: FIX_2TIER_PLAIN_WL },
];

const refLines = [
  "C:/dev/investing-dashboard/src/hooks/dao/proposals/useGovPoolCreateTokenSaleProposal.ts:33-130 (createProposal pipeline)",
  "C:/dev/investing-dashboard/src/utils/MerkleTreeEntity.ts:80-88 (StandardMerkleTree.of leafEncoding=address)",
  "src/tools/proposalBuildComplex.ts:29-33 (TOKEN_SALE_PROPOSAL_ABI canonical signatures, fixed in Bug #25)",
  "src/tools/proposalBuildComplex.ts:290-359 (encodeParticipationData per-type payload encoding)",
  "src/tools/proposalBuildComplex.ts:417-438 (buildSaleApprovals dedupe+sum per saleTokenAddress)",
  "src/tools/proposalBuildComplex.ts:445-519 (buildTokenSaleMultiActions: approves first, createTiers, optional addToWhitelist)",
];

let allOk = true;
const summary = [];
for (const c of cases) {
  const synth = frontendSynthesize(c.input);
  const helped = helper.buildTokenSaleMultiActions(c.input);
  const synthData = synth.map((a) => a.data);
  const helpData = helped.actions.map((a) => a.data);
  const lenMatch = synthData.length === helpData.length;
  let dataMatch = lenMatch;
  if (lenMatch) {
    for (let i = 0; i < synthData.length; i++) {
      if (synthData[i] !== helpData[i]) {
        dataMatch = false;
        break;
      }
    }
  }
  summary.push({ name: c.name, lenMatch, dataMatch, n: synth.length });
  if (!dataMatch) {
    allOk = false;
    console.error(`DIVERGE [${c.name}]:`);
    for (let i = 0; i < Math.max(synthData.length, helpData.length); i++) {
      if (synthData[i] !== helpData[i]) {
        console.error(`  action[${i}] synth=${(synthData[i] || "").slice(0, 18)}...`);
        console.error(`  action[${i}] help =${(helpData[i] || "").slice(0, 18)}...`);
      }
    }
  }
}

console.log("Synthesizer ↔ helper equivalence:");
for (const s of summary) {
  console.log(
    `  ${s.dataMatch ? "OK" : "FAIL"}  ${s.name}  actions=${s.n}`,
  );
}

if (!allOk) {
  console.error("\nNot writing fixtures: synth/helper divergence above.");
  process.exit(1);
}

const fixDir = path.join(repoRoot, "tests/compat/fixtures");
fs.mkdirSync(fixDir, { recursive: true });
for (const c of cases) {
  const built = helper.buildTokenSaleMultiActions(c.input);
  const fixture = {
    input: c.input,
    expected: {
      actions: built.actions,
      derivedMerkleRoots: built.derivedMerkleRoots,
      whitelistRequests: built.whitelistRequests,
    },
    captureMethod: "synthesized",
    captureNotes:
      "Synthesizer mirrors useGovPoolCreateTokenSaleProposal.ts. The canonical " +
      "TokenSaleProposal ABI is shared between the compiled frontend artifact and " +
      "TOKEN_SALE_PROPOSAL_ABI in src/tools/proposalBuildComplex.ts (both regenerate " +
      "from the same Solidity source — Bug #25 confirmed they were drifted before, " +
      "so this fixture locks in the post-fix canonical encoding). Regenerate via " +
      "`node tests/compat/gen-otc-fixtures.mjs` after a frontend ABI bump or helper " +
      "refactor; live re-capture instructions in tests/compat/CAPTURE.md.",
    captureRefSourceLines: refLines,
  };
  const outPath = path.join(fixDir, `${c.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${path.relative(repoRoot, outPath)} (actions=${built.actions.length})`);
}
console.log("\nAll fixtures regenerated.");
