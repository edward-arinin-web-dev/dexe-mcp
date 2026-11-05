import { describe, expect, it, beforeEach, vi } from "vitest";
import { AbiCoder, Interface, getAddress, getCreateAddress, parseUnits } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The agent fast lane at the tool layer, fully offline:
 *   - `fastLane` on dexe_agent_treasury_create (chain fence, config refusals,
 *     the 6th settings slot + executor in the deploy calldata, the float
 *     recipient, the metadata pin, existingLane verification, the predicted
 *     CREATE address in a preview, the hot-key requirement);
 *   - dexe_agent_fast_lane_build_pay (verdicts and the custom_abi recipe).
 * The RPC provider is a small dispatcher: the PoolFactory answers
 * predictGovAddresses, a fake lane answers its views and runs the real
 * validate() rules in TypeScript, the token answers decimals().
 */

const PREDICTED = {
  govPool: getAddress("0x" + "aa".repeat(20)),
  govTokenSale: getAddress("0x" + "bb".repeat(20)),
  govToken: getAddress("0x" + "cc".repeat(20)),
  distributionProposal: getAddress("0x" + "dd".repeat(20)),
  expertNft: getAddress("0x" + "ee".repeat(20)),
  nftMultiplier: getAddress("0x" + "11".repeat(20)),
};
const LANE = getAddress("0x" + "fa".repeat(20));
const WRONG_LANE = getAddress("0x" + "fb".repeat(20));
const R1 = getAddress("0x00000000000000000000000000000000000000c1");
const R2 = getAddress("0x00000000000000000000000000000000000000c2");
const STRANGER = getAddress("0x00000000000000000000000000000000000000c9");
const PER_PAYMENT = parseUnits("50", 18);
const WINDOW = parseUnits("500", 18);
const SPENT = parseUnits("120", 18);
const FLOAT = parseUnits("10000", 18);

const coder = AbiCoder.defaultAbiCoder();
const predictResult = coder.encode(["tuple(address,address,address,address,address,address)"], [Object.values(PREDICTED)]);

const laneAbi = new Interface([
  "function govPool() view returns (address)",
  "function token() view returns (address)",
  "function perPaymentCap() view returns (uint256)",
  "function windowCap() view returns (uint256)",
  "function allowed(address) view returns (bool)",
  "function spentInWindow() view returns (uint256)",
  "function available() view returns (uint256,uint256)",
  "function validate(tuple(address executor,uint256 value,bytes data)[] actions) view returns (bool)",
  "function pay(address to, uint256 amount)",
]);
const PAY_SELECTOR = laneAbi.getFunction("pay")!.selector;

/** The lane's validate() rules, mirrored for the mock. */
function mockValidate(actions: Array<{ executor: string; value: bigint; data: string }>, lane: string): boolean {
  if (actions.length === 0 || actions.length > 3) return false;
  let total = 0n;
  for (const a of actions) {
    if (getAddress(a.executor) !== lane || a.value !== 0n) return false;
    if (a.data.length !== 2 + 68 * 2 || !a.data.startsWith(PAY_SELECTOR)) return false;
    const [to, amount] = laneAbi.decodeFunctionData("pay", a.data) as unknown as [string, bigint];
    if (![R1, R2].includes(getAddress(to))) return false;
    if (amount === 0n || amount > PER_PAYMENT) return false;
    total += amount;
  }
  return SPENT + total <= WINDOW;
}

function laneCall(lane: string, data: string): string {
  const parsed = laneAbi.parseTransaction({ data })!;
  const ret = (types: string[], values: unknown[]) => coder.encode(types, values);
  switch (parsed.name) {
    case "govPool":
      return ret(["address"], [lane === WRONG_LANE ? STRANGER : PREDICTED.govPool]);
    case "token":
      return ret(["address"], [PREDICTED.govToken]);
    case "perPaymentCap":
      return ret(["uint256"], [PER_PAYMENT]);
    case "windowCap":
      return ret(["uint256"], [WINDOW]);
    case "allowed":
      return ret(["bool"], [[R1, R2].includes(getAddress(parsed.args[0] as string))]);
    case "spentInWindow":
      return ret(["uint256"], [SPENT]);
    case "available":
      return ret(["uint256", "uint256"], [WINDOW - SPENT, FLOAT]);
    case "validate": {
      const actions = (parsed.args[0] as Array<[string, bigint, string]>).map(([executor, value, d]) => ({
        executor,
        value,
        data: d,
      }));
      return ret(["bool"], [mockValidate(actions, lane)]);
    }
    default:
      throw new Error(`mock lane: unexpected ${parsed.name}`);
  }
}

const provider = {
  call: async (tx: { to?: string; data?: string }) => {
    const to = tx.to ? getAddress(tx.to) : "";
    if (to === LANE || to === WRONG_LANE) return laneCall(to, tx.data ?? "0x");
    if (to === PREDICTED.govToken) return coder.encode(["uint8"], [18]);
    return predictResult; // PoolFactory.predictGovAddresses and the registry lookups
  },
  getCode: async (addr: string) => ([LANE, WRONG_LANE].includes(getAddress(addr)) ? "0x6001" : "0x"),
  getTransactionCount: async () => 7,
};
vi.mock("../../src/rpc.js", () => ({
  RpcProvider: class {
    constructor(private readonly config: { chainId?: number; defaultChainId?: number }) {}
    tryProvider() {
      return { ok: provider };
    }
    resolveChainId(chainId?: number) {
      return chainId ?? this.config.chainId ?? this.config.defaultChainId ?? 97;
    }
  },
}));

import { PinataClient } from "../../src/lib/ipfsPin.js";
import { registerDaoCreateTools } from "../../src/tools/daoCreate.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

const DEPLOYER = getAddress("0xdeadbeef00000000000000000000000000000001");
const A1 = getAddress("0x00000000000000000000000000000000000000a1");
const A2 = getAddress("0x00000000000000000000000000000000000000a2");
const A3 = getAddress("0x00000000000000000000000000000000000000a3");
const V1 = getAddress("0x00000000000000000000000000000000000000b1");

function config(chainId = 97): DexeConfig {
  const chain = (id: number) => ({ chainId: id, rpcUrl: `https://rpc.invalid/${id}`, rpcUrls: [] });
  return {
    defaultChainId: chainId,
    chainId,
    chains: new Map([
      [56, chain(56)],
      [97, chain(97)],
    ]),
    pinataJwt: "test-jwt",
    minSafeQuorumPct: 50,
    treasuryGuard: "warn",
    ipfsGateways: [],
  } as unknown as DexeConfig;
}

const noSigner = { hasSigner: () => false, getAddress: () => DEPLOYER } as unknown as SignerManager;
/** A signer the server knows about but that cannot hand out a hot Wallet (keystore / WalletConnect). */
const coldSigner = {
  hasSigner: () => true,
  getAddress: () => DEPLOYER,
  trySigner: () => ({ error: "Keystore mode signs only through an approved batch", remediation: "use dexe_tx_send" }),
} as unknown as SignerManager;
/** A hot key: previews predict the lane at CREATE(address, pending nonce). */
const hotSigner = {
  hasSigner: () => true,
  getAddress: () => DEPLOYER,
  trySigner: () => ({ ok: { address: DEPLOYER, provider: { getTransactionCount: async () => 7 } } }),
} as unknown as SignerManager;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

const BASE = {
  daoName: "Agent Fund",
  symbol: "AGF",
  chainId: 97,
  agents: [
    { address: A1, role: "researcher" },
    { address: A2, role: "trader" },
    { address: A3, role: "auditor" },
  ],
  humanValidators: [{ address: V1 }],
};
const FAST = { perPaymentCap: "50", windowCap: "500", allowlist: [R1, R2], voteSeconds: 600 };

async function call(
  args: Record<string, unknown>,
  sm: SignerManager = noSigner,
  tool = "dexe_agent_treasury_create",
  cfg: DexeConfig = config(),
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerDaoCreateTools(
    server,
    { config: cfg, artifacts: { get: () => [] } } as unknown as ToolContext,
    sm,
    { isConfigured: () => false } as unknown as WalletConnectManager,
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name: tool, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const payload = (r: ToolResult) => {
  try {
    return JSON.parse(text(r)) as Record<string, any>;
  } catch {
    throw new Error(`not JSON — the tool answered: ${text(r).slice(0, 600)}`);
  }
};

const DEPLOY_ABI = new Interface([
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) params)",
]);
const DEPLOY_SELECTOR = DEPLOY_ABI.getFunction("deployGovPool")!.selector;

function findDeployData(body: unknown): string {
  const hits: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.startsWith(DEPLOY_SELECTOR)) hits.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(body);
  if (hits.length === 0) throw new Error(`no deployGovPool calldata in ${JSON.stringify(body).slice(0, 400)}`);
  return hits[0]!;
}

let pinJson: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  pinJson = vi.spyOn(PinataClient.prototype, "pinJson").mockResolvedValue({ cid: "QmFAKE", size: 1, pinnedAt: "x" } as any);
  vi.spyOn(PinataClient.prototype, "pinFile").mockRejectedValue(new Error("test: no file pins expected"));
});

describe("fastLane — refusals", () => {
  it("refuses mainnet 56 before anything else", async () => {
    const r = await call({ ...BASE, chainId: 56, deployer: DEPLOYER, fastLane: FAST }, noSigner, undefined, config(56));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/TESTNET ONLY/);
    expect(text(r)).toMatch(/MAINNET/);
    expect(pinJson).not.toHaveBeenCalled();
  });

  it("refuses a per-payment cap above the window cap", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, perPaymentCap: "600" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("perPaymentCap (600) exceeds fastLane.windowCap (500)");
  });

  it("refuses a float that would eat the treasury", async () => {
    // 3 agents, k=2, quorum 50 → 25.5% each, treasury 23.5%
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, floatPercent: 23.5 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/must stay below the treasury share/);
  });

  it("refuses an empty allowlist and a float with 3 decimals", async () => {
    const r1 = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, allowlist: [] } });
    expect(r1.isError).toBe(true);
    const r2 = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, floatPercent: 0.125 } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toMatch(/at most 2 decimals/);
  });

  it("without a hot key and without existingLane it says what to do", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: FAST }, coldSigner);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/hot key/);
    expect(text(r)).toMatch(/existingLane/);
  });

  it("an existingLane bound to another govPool is refused", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, existingLane: WRONG_LANE } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/govPool\(\) is/);
    expect(text(r)).toContain(PREDICTED.govPool);
  });

  it("an existingLane with other caps is refused", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, existingLane: LANE, windowCap: "900" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/its caps are/);
  });

  it("an existingLane missing an allowlisted recipient is refused", async () => {
    const r = await call({
      ...BASE,
      deployer: DEPLOYER,
      fastLane: { ...FAST, existingLane: LANE, allowlist: [R1, STRANGER] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not on its allowlist/);
  });
});

describe("fastLane — the deploy (no signer: payload returned, existing lane)", () => {
  it("binds the lane as the 6th executor with fast settings, mints it the float, keeps the agents' shares", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, existingLane: LANE } });
    expect(r.isError, text(r)).toBeFalsy();
    const [params] = DEPLOY_ABI.decodeFunctionData("deployGovPool", findDeployData(payload(r)));

    const [slots, executors] = params[0];
    expect(slots.length).toBe(6);
    expect(executors.map((a: string) => getAddress(a))).toEqual([PREDICTED.distributionProposal, PREDICTED.govTokenSale, LANE]);
    const fast = slots[5];
    expect(fast[0]).toBe(true); // earlyCompletion
    expect(fast[2]).toBe(false); // validatorsVote — the whole point
    expect(fast[3]).toBe(600n); // duration = voteSeconds
    expect(fast[4]).toBe(86400n); // durationValidators kept non-zero (GovSettings validates it)
    expect(fast[6]).toBe(slots[0][6]); // same quorum as the default slot
    expect(fast[8]).toBe(slots[0][8]); // same minVotesForVoting
    expect(fast[11]).toBe("ipfs://" + "QmFAKE".replace("QmFAKE", "QmFAKE")); // executorDescription pinned (mock CID)
    for (let i = 0; i < 5; i++) expect(slots[i][2]).toBe(true); // the other five keep the validator round

    const [, , users, , minted, amounts] = params[3];
    const byUser = new Map<string, bigint>(users.map((u: string, i: number) => [getAddress(u), amounts[i] as bigint]));
    const share = 255_000n * 10n ** 18n;
    for (const a of [A1, A2, A3]) expect(byUser.get(a)).toBe(share);
    expect(byUser.get(LANE)).toBe(10_000n * 10n ** 18n); // 1% float
    expect(minted).toBe(1_000_000n * 10n ** 18n);
    const sum = (amounts as bigint[]).reduce((x, y) => x + y, 0n);
    expect(minted - sum).toBe(225_000n * 10n ** 18n); // treasury 23.5% − 1% float

    const p = payload(r);
    expect(p.agentTreasury.fastLane.address).toBe(LANE);
    expect(p.agentTreasury.fastLane.addressSource).toMatch(/existing lane/);
    expect(p.agentTreasury.treasury.percent).toBe(22.5);
    expect(p.fastLane.payRecipeExample.args.proposalType).toBe("custom_abi");
    expect(p.fastLane.payRecipeExample.args.params.target).toBe(LANE);
    expect(p.fastLane.payRecipeExample.args.govPool).toBe(PREDICTED.govPool);
    expect(p.governance.settingsSlots.expandedOnChain).toBe(6);
    expect(String(p.next)).toContain("dexe_agent_fast_lane_build_pay");
  });

  it("pins the lane into the DAO metadata and pins a settings JSON for its slot", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, fastLane: { ...FAST, existingLane: LANE } });
    expect(r.isError, text(r)).toBeFalsy();
    const pinned = pinJson.mock.calls.map((c) => c[0] as Record<string, any>);
    const meta = pinned.find((o) => o && "preset" in o);
    expect(meta.fastLane).toMatchObject({
      address: LANE,
      token: PREDICTED.govToken,
      perPaymentCapWei: PER_PAYMENT.toString(),
      windowCapWei: WINDOW.toString(),
      windowDays: 30,
      allowlist: [R1, R2],
      voteSeconds: 600,
      testnetOnly: true,
    });
    const laneSettings = pinned.filter((o) => o && "validatorsVote" in o && o.validatorsVote === false);
    expect(laneSettings.length).toBe(1);
    expect(laneSettings[0]!.duration).toBe("600");
    const names = pinJson.mock.calls.map((c) => (c[1] as { name?: string } | undefined)?.name ?? "");
    expect(names.some((n) => n.includes("agentFastLane"))).toBe(true);
  });

  it("without fastLane the deploy is the plain preset: 5 slots, 2 executors, no lane in the metadata", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER });
    expect(r.isError, text(r)).toBeFalsy();
    const [params] = DEPLOY_ABI.decodeFunctionData("deployGovPool", findDeployData(payload(r)));
    expect(params[0][0].length).toBe(5);
    expect(params[0][1].length).toBe(2);
    const meta = pinJson.mock.calls.map((c) => c[0] as Record<string, any>).find((o) => o && "preset" in o);
    expect(meta.fastLane).toBeUndefined();
    expect(payload(r).fastLane).toBeUndefined();
  });
});

describe("fastLane — preview with a hot key", () => {
  it("predicts the lane at CREATE(signer, pending nonce) and says so", async () => {
    const r = await call({ ...BASE, fastLane: FAST }, hotSigner);
    expect(r.isError, text(r)).toBeFalsy();
    const p = payload(r);
    expect(p.mode).toBe("preview");
    const expected = getCreateAddress({ from: DEPLOYER, nonce: 7 });
    expect(p.agentTreasury.fastLane.address).toBe(expected);
    expect(p.agentTreasury.fastLane.addressSource).toMatch(/predicted CREATE/);
    expect(p.agentTreasury.fastLane.guarantees.join(" ")).toMatch(/TESTNET ONLY/);
    expect(p.agentTreasury.fastLane.settingsSlot).toBe(5);
    expect(p.agentTreasury.treasury.percent).toBe(22.5);
    expect(pinJson).not.toHaveBeenCalled();
  });

  it("warns when the window cap exceeds the float and when an agent is allowlisted", async () => {
    const r = await call({ ...BASE, fastLane: { ...FAST, windowCap: "20000", perPaymentCap: "50", allowlist: [A1] } }, hotSigner);
    expect(r.isError, text(r)).toBeFalsy();
    const w = payload(r).agentTreasury.fastLane.warnings.join("\n");
    expect(w).toMatch(/exceeds the float/);
    expect(w).toMatch(/agent wallet is on the fast-lane allowlist/);
  });
});

describe("dexe_agent_fast_lane_build_pay", () => {
  const PAY = "dexe_agent_fast_lane_build_pay";

  it("refuses mainnet", async () => {
    const r = await call({ lane: LANE, to: R1, amount: "1", chainId: 56 }, noSigner, PAY, config(56));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/TESTNET ONLY/);
  });

  it("ok: validate() true → the custom_abi recipe", async () => {
    const r = await call({ lane: LANE, to: R1, amount: "25.0", chainId: 97 }, noSigner, PAY);
    expect(r.isError, text(r)).toBeFalsy();
    const p = payload(r);
    expect(p.verdict).toBe("ok");
    expect(p.validateReturned).toBe(true);
    expect(p.lane).toMatchObject({
      govPool: PREDICTED.govPool,
      token: PREDICTED.govToken,
      perPaymentCap: "50.0",
      windowCap: "500.0",
      spentInWindow: "120.0",
      windowRemaining: "380.0",
      floatBalance: "10000.0",
      recipientAllowed: true,
    });
    expect(p.proposal.args).toMatchObject({
      govPool: PREDICTED.govPool,
      chainId: 97,
      proposalType: "custom_abi",
      params: { target: LANE, method: "pay", args: [R1, parseUnits("25", 18).toString()], value: "0" },
    });
    expect(p.action.executor).toBe(LANE);
    expect(p.action.data.startsWith(PAY_SELECTOR)).toBe(true);
    expect(String(p.next)).toContain("dexe_proposal_create");
  });

  it("accepts raw wei too", async () => {
    const r = await call({ lane: LANE, to: R2, amount: parseUnits("50", 18).toString(), chainId: 97 }, noSigner, PAY);
    expect(payload(r).verdict).toBe("ok");
  });

  it("refused: over the per-payment cap, with the reason", async () => {
    const r = await call({ lane: LANE, to: R1, amount: "51.0", chainId: 97 }, noSigner, PAY);
    const p = payload(r);
    expect(p.verdict).toBe("refused");
    expect(p.validateReturned).toBe(false);
    expect(p.reasons.join(" ")).toMatch(/exceeds the per-payment cap 50\.0/);
    expect(p.proposal).toBeUndefined();
    expect(String(p.next)).toMatch(/validation failed/);
  });

  it("refused: a recipient off the allowlist", async () => {
    const r = await call({ lane: LANE, to: STRANGER, amount: "1.0", chainId: 97 }, noSigner, PAY);
    const p = payload(r);
    expect(p.verdict).toBe("refused");
    expect(p.lane.recipientAllowed).toBe(false);
    expect(p.reasons.join(" ")).toMatch(/not on the lane's allowlist/);
  });

  it("refused: a payment the rolling window no longer allows", async () => {
    // 120 spent of 500; cap 50 per payment → 50 fits; the mock's window check kicks in at 380
    const r = await call({ lane: LANE, to: R1, amount: "50.0", chainId: 97 }, noSigner, PAY);
    expect(payload(r).verdict).toBe("ok");
  });

  it("no contract at the address", async () => {
    const r = await call({ lane: STRANGER, to: R1, amount: "1", chainId: 97 }, noSigner, PAY);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No contract at/);
  });
});
