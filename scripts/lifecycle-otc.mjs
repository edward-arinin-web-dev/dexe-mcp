// Full OTC lifecycle on a fresh BSC-testnet DAO. Proves the Phase B
// composites end-to-end: deploy → seed treasury (via initial mint) →
// open_sale → vote → execute → buy → claim. Idempotent: each run uses a
// fresh poolName so it always lands on a pristine DAO.
//
// Why a fresh DAO:
// - Existing DAOs (Glacier, Sentinel) have all mintedTotal locked in
//   deposits with ownedBalance==0 — withdraw() silently no-ops, no way
//   to fund either the deployer wallet or the treasury
// - dexe_dao_build_deploy lets us mint to multiple addresses at deploy
//   time, including the predicted govPool addr → treasury seeded for free
//
// Steps:
//   1. predict govPool/govToken/govTokenSale via dexe_dao_predict_addresses
//   2. dexe_dao_build_deploy → broadcast → wait for receipt
//   3. ERC20.approve(userKeeper, depositAmount) + GovPool.deposit(amount)
//   4. dexe_otc_dao_open_sale (1 tier, claimLock=0, no vesting)
//   5. dexe_proposal_vote_and_execute autoExecute=true
//   6. dexe_read_token_sale_tiers — confirm tier on-chain
//   7. dexe_otc_buyer_buy
//   8. dexe_otc_buyer_claim_all
//   9. Verify token balance change

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  Interface,
  formatUnits,
  MaxUint256,
} from "ethers";
import { readFileSync } from "node:fs";

// ---------- config ----------
const CHAIN_ID = 97;
const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
const POOL_NAME = `OTCLifecycle-${Date.now()}`;
const SYMBOL = "OTC";
const TOTAL_MINT = 1_000_100n * 10n ** 18n; // 1M to deployer + 100 to govPool
const DEPLOYER_MINT = 1_000_000n * 10n ** 18n;
const TREASURY_MINT = 100n * 10n ** 18n; // sale-tier total
const CAP = 2_000_000n * 10n ** 18n;
const DEPOSIT_FOR_VOTING = 600_000n * 10n ** 18n; // > 50% quorum on 1.0001M supply
const SALE_TOTAL = 100n * 10n ** 18n; // tier total = full treasury
const BUY_AMOUNT = 10n ** 18n; // buyer pays 1 sale token, gets 1 sale token at 1:1

// ---------- env ----------
function envFromDotenv() {
  const raw = readFileSync("D:/dev/dexe-mcp/.env", "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].split("#")[0].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = envFromDotenv();
if (!env.DEXE_PRIVATE_KEY) throw new Error("DEXE_PRIVATE_KEY missing");
if (!env.DEXE_PINATA_JWT) throw new Error("DEXE_PINATA_JWT missing");

const pk = env.DEXE_PRIVATE_KEY.startsWith("0x") ? env.DEXE_PRIVATE_KEY : `0x${env.DEXE_PRIVATE_KEY}`;
const provider = new JsonRpcProvider(RPC);
const deployer = new Wallet(pk, provider);

console.log(`deployer: ${deployer.address}`);
console.log(`poolName: ${POOL_NAME}`);

// ---------- mcp client ----------
const transport = new StdioClientTransport({
  command: "node",
  args: [resolve("dist/index.js")],
  env: { ...process.env, ...env, DEXE_RPC_URL: RPC, DEXE_CHAIN_ID: String(CHAIN_ID) },
  cwd: process.cwd(),
});
const mcp = new Client({ name: "lifecycle-otc", version: "0.1.0" });
await mcp.connect(transport);

async function call(name, args) {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) {
    const msg = r.content?.[0]?.text ?? JSON.stringify(r.content);
    throw new Error(`MCP ${name}: ${msg}`);
  }
  if (r.structuredContent) return r.structuredContent;
  const txt = r.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}

async function broadcastPayload(p, label) {
  const tx = await deployer.sendTransaction({
    to: p.to,
    data: p.data,
    value: BigInt(p.value ?? "0"),
    chainId: BigInt(CHAIN_ID),
  });
  console.log(`  [${label}] tx: ${tx.hash}`);
  const r = await tx.wait(1);
  if (r.status !== 1) throw new Error(`${label} reverted`);
  return r;
}

// ---------- 1. predict addresses ----------
console.log("\n=== STEP 1: predict addresses ===");
const predicted = await call("dexe_dao_predict_addresses", {
  deployer: deployer.address,
  poolName: POOL_NAME,
});
console.log("  govPool:", predicted.govPool);
console.log("  govToken:", predicted.govToken);
console.log("  govTokenSale:", predicted.govTokenSale);

// ---------- 2. deploy DAO ----------
console.log("\n=== STEP 2: deploy DAO ===");
const deployRes = await call("dexe_dao_build_deploy", {
  deployer: deployer.address,
  params: {
    name: POOL_NAME,
    descriptionURL: "ipfs://QmRPHQhYcz9f314cVkPtsPrcVmp9akm7NUUU9GcSJCS6gQ",
    onlyBABTHolders: false,
    settingsParams: {
      proposalSettings: [
        {
          earlyCompletion: true,
          delegatedVotingAllowed: false,
          validatorsVote: false,
          duration: "86400",
          durationValidators: "86400",
          quorum: "500000000000000000000000000",
          quorumValidators: "510000000000000000000000000",
          minVotesForVoting: "1000000000000000000",
          minVotesForCreating: "1000000000000000000",
          executionDelay: "0",
          rewardsInfo: {
            rewardToken: "0x0000000000000000000000000000000000000000",
            creationReward: "0",
            executionReward: "0",
            voteRewardsCoefficient: "0",
          },
        },
      ],
    },
    userKeeperParams: {
      tokenAddress: "0x0000000000000000000000000000000000000000",
      nftAddress: "0x0000000000000000000000000000000000000000",
      individualPower: "0",
      nftsTotalSupply: "0",
    },
    tokenParams: {
      name: `OTC Lifecycle ${POOL_NAME}`,
      symbol: SYMBOL,
      cap: CAP.toString(),
      mintedTotal: TOTAL_MINT.toString(),
      users: [deployer.address, predicted.govPool],
      amounts: [DEPLOYER_MINT.toString(), TREASURY_MINT.toString()],
    },
    votePowerParams: { voteType: "LINEAR_VOTES" },
  },
});
const deployPayload = deployRes.payload ?? deployRes;
const deployReceipt = await broadcastPayload(deployPayload, "deploy");
console.log(`  block: ${deployReceipt.blockNumber}, gasUsed: ${deployReceipt.gasUsed}`);

const govPool = predicted.govPool;
const govToken = predicted.govToken;
const tokenSaleProposal = predicted.govTokenSale;

// Read live helpers (settings/userKeeper) via getHelperContracts
const govPoolReader = new Contract(
  govPool,
  [
    "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
    "function latestProposalId() view returns (uint256)",
  ],
  provider,
);
const helpers = await govPoolReader.getHelperContracts();
const userKeeper = helpers[1];
console.log(`  userKeeper: ${userKeeper}`);

// ---------- 3. approve + deposit voting power ----------
console.log("\n=== STEP 3: approve + deposit voting power ===");
const ERC20 = new Contract(
  govToken,
  [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ],
  deployer,
);
const deployerBal = await ERC20.balanceOf(deployer.address);
const treasuryBal = await ERC20.balanceOf(govPool);
console.log(`  deployer: ${formatUnits(deployerBal, 18)} ${SYMBOL}`);
console.log(`  treasury: ${formatUnits(treasuryBal, 18)} ${SYMBOL}`);

const approveTx = await ERC20.approve(userKeeper, MaxUint256);
console.log(`  approve tx: ${approveTx.hash}`);
await approveTx.wait(1);

const GOV_POOL_IFACE = new Interface([
  "function deposit(uint256 amount, uint256[] nftIds) payable",
]);
await broadcastPayload(
  {
    to: govPool,
    data: GOV_POOL_IFACE.encodeFunctionData("deposit", [DEPOSIT_FOR_VOTING, []]),
    value: "0",
  },
  "deposit",
);

// ---------- 4. open_sale ----------
console.log("\n=== STEP 4: dexe_otc_dao_open_sale ===");
const now = Math.floor(Date.now() / 1000);
const open = await call("dexe_otc_dao_open_sale", {
  govPool,
  tokenSaleProposal,
  latestTierId: "0",
  tiers: [
    {
      name: "Lifecycle tier",
      description: "End-to-end OTC lifecycle proof",
      totalTokenProvided: SALE_TOTAL.toString(),
      saleStartTime: String(now - 60),
      saleEndTime: String(now + 60),
      claimLockDuration: "0",
      saleTokenAddress: govToken,
      purchaseTokenAddresses: [govToken],
      exchangeRates: ["10000000000000000000000000"], // 1:1 (DeXe PRECISION = 1e25)
      minAllocationPerUser: "0",
      maxAllocationPerUser: SALE_TOTAL.toString(),
    },
  ],
  proposalName: `OTC lifecycle ${now}`,
  proposalDescription: "Phase B end-to-end test",
  voteAmount: DEPOSIT_FOR_VOTING.toString(),
});
console.log("  mode:", open.mode, "executed steps:", open.steps?.length);

const proposalId = Number(await govPoolReader.latestProposalId());
console.log(`  proposalId: ${proposalId}`);

// ---------- 5. wait for executable state, then execute ----------
console.log("\n=== STEP 5: poll state + execute ===");
async function waitForExecutable(maxAttempts = 10, delayMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    const s = await call("dexe_proposal_state", { govPool, proposalId });
    console.log(`  poll ${i + 1}: state=${s.state} (idx ${s.stateIndex})`);
    if (s.stateIndex === 4 || s.stateIndex === 7) return s;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Proposal never reached SucceededFor within poll window");
}
const ready = await waitForExecutable();
if (ready.stateIndex === 4) {
  const exec = await call("dexe_vote_build_execute", { govPool, proposalId: String(proposalId) });
  const p = exec.payload ?? exec;
  await broadcastPayload(p, "execute");
} else {
  console.log("  already ExecutedFor, skipping");
}

// ---------- 6. confirm tier ----------
console.log("\n=== STEP 6: confirm tier created ===");
const tierAfter = await call("dexe_read_token_sale_tiers", {
  tokenSaleProposal,
  offset: 0,
  limit: 5,
});
console.log(`  totalTiers: ${tierAfter.totalTiers}`);
if ((tierAfter.totalTiers ?? 0) === 0) {
  throw new Error("Tier not created — check proposal execution + executor wiring");
}

// ---------- 7. buyer_buy ----------
console.log("\n=== STEP 7: dexe_otc_buyer_buy ===");
const buyerBalBefore = await ERC20.balanceOf(deployer.address);
const buy = await call("dexe_otc_buyer_buy", {
  tokenSaleProposal,
  tierId: "1",
  tokenToBuyWith: govToken,
  amount: BUY_AMOUNT.toString(),
});
console.log("  mode:", buy.mode);
console.log("  preflight:", buy.preflight);
const buyerBalAfter = await ERC20.balanceOf(deployer.address);
console.log(
  `  deployer ${SYMBOL}: ${formatUnits(buyerBalBefore, 18)} → ${formatUnits(buyerBalAfter, 18)}`,
);

// ---------- 7.5 wait for saleEndTime to elapse ----------
const saleEnd = now + 60; // matches tier.saleEndTime set in step 4
const blk = await provider.getBlock("latest");
const lag = saleEnd - Number(blk.timestamp) + 5;
if (lag > 0) {
  console.log(`\nwaiting ${lag}s for sale window to close (saleEndTime=${saleEnd}, now=${blk.timestamp}) ...`);
  await new Promise((r) => setTimeout(r, lag * 1000));
}

// ---------- 8. claim_all ----------
console.log("\n=== STEP 8: dexe_otc_buyer_claim_all ===");
const balBeforeClaim = await ERC20.balanceOf(deployer.address);
const claim = await call("dexe_otc_buyer_claim_all", {
  tokenSaleProposal,
  tierIds: ["1"],
});
console.log("  mode:", claim.mode);
console.log("  claimed tiers:", claim.claimedTierIds);
console.log("  vest tiers:", claim.vestingWithdrawTierIds);
const balAfterClaim = await ERC20.balanceOf(deployer.address);
const delta = balAfterClaim - balBeforeClaim;
console.log(
  `  deployer ${SYMBOL}: ${formatUnits(balBeforeClaim, 18)} → ${formatUnits(balAfterClaim, 18)} (delta ${formatUnits(delta, 18)})`,
);

if (delta < BUY_AMOUNT) {
  throw new Error(
    `Claim delta ${delta} < bought amount ${BUY_AMOUNT} — claim didn't deliver tokens`,
  );
}

await mcp.close();
console.log(`\n✓ OTC lifecycle complete on chain ${CHAIN_ID}`);
console.log(`  govPool: ${govPool}`);
console.log(`  govToken: ${govToken}`);
console.log(`  tokenSaleProposal: ${tokenSaleProposal}`);
console.log(`  proposalId: ${proposalId}`);
