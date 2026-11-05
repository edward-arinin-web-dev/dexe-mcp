import { describe, expect, it, beforeEach, vi } from "vitest";
import { AbiCoder, Interface, getAddress } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * dexe_agent_treasury_create — the agent-treasury preset over dexe_dao_create.
 *
 * Fully offline: the RPC provider is mocked (predictGovAddresses answers with
 * fixed addresses, getCode says "no contract yet"), Pinata is spied. The
 * no-signer path returns the deploy payload without broadcasting, which is the
 * cheap way to inspect the exact calldata and the pinned metadata.
 */

const PREDICTED = {
  govPool: getAddress("0x" + "aa".repeat(20)),
  govTokenSale: getAddress("0x" + "bb".repeat(20)),
  govToken: getAddress("0x" + "cc".repeat(20)),
  distributionProposal: getAddress("0x" + "dd".repeat(20)),
  expertNft: getAddress("0x" + "ee".repeat(20)),
  nftMultiplier: getAddress("0x" + "11".repeat(20)),
};
const predictResult = AbiCoder.defaultAbiCoder().encode(
  ["tuple(address,address,address,address,address,address)"],
  [Object.values(PREDICTED)],
);
vi.mock("../../src/rpc.js", () => ({
  RpcProvider: class {
    tryProvider() {
      return { ok: { call: async () => predictResult, getCode: async () => "0x" } };
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
const V2 = getAddress("0x00000000000000000000000000000000000000b2");

function config(): DexeConfig {
  const chain = (chainId: number) => ({ chainId, rpcUrl: `https://rpc.invalid/${chainId}`, rpcUrls: [] });
  return {
    defaultChainId: 97,
    chainId: 97,
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

const signer = { hasSigner: () => true, getAddress: () => DEPLOYER } as unknown as SignerManager;
const noSigner = { hasSigner: () => false, getAddress: () => DEPLOYER } as unknown as SignerManager;

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
    { address: A2, role: "trader", scope: "DEX swaps only" },
    { address: A3, role: "auditor" },
  ],
  humanValidators: [{ address: V1 }],
};

async function call(
  args: Record<string, unknown>,
  sm: SignerManager = signer,
  tool = "dexe_agent_treasury_create",
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerDaoCreateTools(
    server,
    { config: config(), artifacts: { get: () => [] } } as unknown as ToolContext,
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

/** The deployGovPool calldata anywhere in a result body. */
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

describe("preview", () => {
  it("shows the agents table, k-of-n, validators, treasury, durations and guarantees", async () => {
    const r = await call(BASE);
    expect(r.isError, text(r)).toBeFalsy();
    const p = payload(r);
    expect(p.mode).toBe("preview");
    const at = p.agentTreasury;
    expect(at.preset).toBe("agent-treasury");
    expect(at.kOfN).toBe("2-of-3");
    expect(at.agents).toHaveLength(3);
    expect(at.agents[0]).toMatchObject({ address: A1, role: "researcher", sharePercent: 25.5, tokens: "255000" });
    expect(at.agents[1].scope).toBe("DEX swaps only");
    expect(at.treasury).toEqual({ percent: 23.5, tokens: "235000" });
    expect(at.validators.seated).toEqual([V1]);
    expect(at.validators.tokenEach).toBe("1");
    expect(at.durations).toEqual({ agentVoteSeconds: 3600, validatorVoteSeconds: 86400, executionDelaySeconds: 0 });
    expect(at.guarantees.quorumFormula).toContain("AGAINST vote also counts toward quorum");
    expect(at.guarantees.humanVeto).toContain("either quorum formula");
    expect(String(p.next)).toContain("dexe_agent_treasury_create");
    expect(pinJson).not.toHaveBeenCalled();
  });

  it("with monthlyBudget the preview carries the validators_allocation recipe", async () => {
    const p = payload(await call({ ...BASE, monthlyBudget: "1000" }));
    const recipe = p.agentTreasury.budgetRecipe;
    expect(recipe.tool).toBe("dexe_proposal_create");
    expect(recipe.args.proposalType).toBe("validators_allocation");
    expect(recipe.args.params.credits[0].amount).toBe((1000n * 10n ** 18n).toString());
    expect(String(p.next)).toContain("budgetRecipe");
  });
});

describe("refusals", () => {
  it("k > n", async () => {
    const r = await call({ ...BASE, approvalsNeeded: 4 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cannot exceed");
  });

  it("a quorum under the server's safety floor", async () => {
    const r = await call({ ...BASE, quorumPercent: 40 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("safety floor");
  });

  it("a duplicate agent address", async () => {
    const r = await call({ ...BASE, agents: [BASE.agents[0], { address: A1.toLowerCase(), role: "copy" }] });
    expect(r.isError).toBe(true);
    expect(text(r).toLowerCase()).toContain("duplicate");
  });

  it("a split no equal share can satisfy", async () => {
    const r = await call({ ...BASE, quorumPercent: 90 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("exceeds 100%");
  });
});

describe("deploy payload (no signer: payload returned, nothing broadcast)", () => {
  it("seats the validators, sets durationValidators, and splits the supply k-of-n", async () => {
    const r = await call(
      { ...BASE, deployer: DEPLOYER, humanValidators: [{ address: V1 }, { address: V2 }], validatorVoteSeconds: 7200 },
      noSigner,
    );
    expect(r.isError, text(r)).toBeFalsy();
    const [params] = DEPLOY_ABI.decodeFunctionData("deployGovPool", findDeployData(payload(r)));

    const [vName, vSymbol, vSettings, vAddrs, vBalances] = params[1];
    expect(vName).toBe("Agent Fund-VT");
    expect(vSymbol).toBe("AGF-VT");
    expect(vSettings[0]).toBe(7200n);
    expect(vSettings[2]).toBe(50n * 10n ** 25n);
    expect(vAddrs.map((a: string) => getAddress(a))).toEqual([V1, V2]);
    expect(vBalances).toEqual([10n ** 18n, 10n ** 18n]);

    for (const slot of params[0][0]) {
      expect(slot[4]).toBe(7200n); // durationValidators
      expect(slot[7]).toBe(50n * 10n ** 25n); // quorumValidators
      expect(slot[2]).toBe(true); // validatorsVote
    }
    expect(params[0][0][0][3]).toBe(3600n); // member vote duration (default slot)

    const [, , users, , minted, amounts] = params[3];
    const byUser = new Map<string, bigint>(users.map((u: string, i: number) => [getAddress(u), amounts[i] as bigint]));
    const share = 255_000n * 10n ** 18n;
    for (const a of [A1, A2, A3]) expect(byUser.get(a)).toBe(share);
    expect(minted).toBe(1_000_000n * 10n ** 18n);
    // The treasury is the implicit remainder: minted − Σ amounts.
    const sum = (amounts as bigint[]).reduce((x, y) => x + y, 0n);
    expect(minted - sum).toBe(235_000n * 10n ** 18n);
  });

  it("pins the preset marker into the DAO metadata", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER }, noSigner);
    expect(r.isError, text(r)).toBeFalsy();
    const pinned = pinJson.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const meta = pinned.find((o) => o && typeof o === "object" && "preset" in o);
    expect(meta, JSON.stringify(pinned).slice(0, 600)).toBeDefined();
    expect(meta).toMatchObject({
      preset: "agent-treasury",
      presetVersion: 1,
      agents: [
        { address: A1, role: "researcher" },
        { address: A2, role: "trader" },
        { address: A3, role: "auditor" },
      ],
    });
  });

  it("returns the budget recipe filled with the predicted govPool and gov token", async () => {
    const r = await call({ ...BASE, deployer: DEPLOYER, monthlyBudget: "500" }, noSigner);
    expect(r.isError, text(r)).toBeFalsy();
    const p = payload(r);
    expect(p.budgetRecipe.args.govPool).toBe(PREDICTED.govPool);
    expect(p.budgetRecipe.args.params.credits[0].token).toBe(PREDICTED.govToken);
    expect(String(p.next)).toContain("validators_allocation");
    expect(p.agentTreasury.kOfN).toBe("2-of-3");
  });
});

describe("dexe_dao_create is unchanged by the refactor", () => {
  it("carries no preset fields and pins no preset marker", async () => {
    const r = await call(
      { daoName: "Aurora Collective", symbol: "AUR", totalSupply: "1000000", chainId: 97, deployer: DEPLOYER },
      noSigner,
      "dexe_dao_create",
    );
    expect(r.isError, text(r)).toBeFalsy();
    expect(payload(r).agentTreasury).toBeUndefined();
    const pinned = pinJson.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(pinned.some((o) => o && typeof o === "object" && "preset" in o)).toBe(false);
    const [params] = DEPLOY_ABI.decodeFunctionData("deployGovPool", findDeployData(payload(r)));
    expect(params[1][3]).toEqual([]); // no validators seated
  });
});
