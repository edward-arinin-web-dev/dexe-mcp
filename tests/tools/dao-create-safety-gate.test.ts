import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDaoCreateTools } from "../../src/tools/daoCreate.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * 0.33.0 findings C + D + E, at the tool boundary.
 *
 * Every assertion here is about something the caller learns BEFORE anything is
 * signed. A DAO's quorum cannot be repaired after deploy — repairing it needs a
 * proposal passed under the quorum being repaired — so "we'll warn them in the
 * result" is not a warning, it is a post-mortem.
 *
 * Fully offline: with a signer present and `confirm` unset the tool answers from
 * the preview/gate path, which touches neither IPFS nor RPC.
 */

const DEPLOYER = "0xdEADBEeF00000000000000000000000000000001";

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

/** A signer that exists but never signs — enough to reach the preview path. */
const signer = {
  hasSigner: () => true,
  getAddress: () => DEPLOYER,
} as unknown as SignerManager;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function daoCreate(args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerDaoCreateTools(
    server,
    { config: config() } as unknown as ToolContext,
    signer,
    {} as unknown as WalletConnectManager,
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({
      name: "dexe_dao_create",
      arguments: { daoName: "Aurora Collective", symbol: "AUR", totalSupply: "1000000", chainId: 97, ...args },
    })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const payload = (r: ToolResult) => JSON.parse(text(r)) as Record<string, any>;

let savedGuard: string | undefined;
beforeEach(() => {
  savedGuard = process.env.DEXE_TREASURY_GUARD;
  delete process.env.DEXE_TREASURY_GUARD;
});
afterEach(() => {
  if (savedGuard === undefined) delete process.env.DEXE_TREASURY_GUARD;
  else process.env.DEXE_TREASURY_GUARD = savedGuard;
});

describe("dexe_dao_create — quorum turnout margin (finding D)", () => {
  it("the old 49/51 default is refused, with both numeric ways out", async () => {
    const r = await daoCreate({ treasuryPercent: 49, quorumPercent: 51 });
    const p = payload(r);
    expect(p.mode).toBe("blocked-risky");
    expect(String(p.risks.join(" "))).toContain("100%");
    expect(p.requiredTurnoutPercent).toBe(100);
    expect(p.safeAlternatives.maxQuorumPercentForThisDistribution).toBe(40.8);
    expect(p.safeAlternatives.minVotablePercentForThisQuorum).toBe(63.75);
    expect(String(p.next)).toContain("NOTHING was broadcast");
  });

  it("omitting treasuryPercent/quorumPercent synthesizes a split that PASSES the margin", async () => {
    const p = payload(await daoCreate({}));
    expect(p.mode).toBe("preview");
    expect(p.resolvedConfig.quorumPercent).toBe(51);
    expect(p.resolvedConfig.distribution.treasury.percent).toBe(30);
    expect(p.safetyProof.turnoutMarginOk).toBe(true);
    expect(p.safetyProof.requiredTurnoutPercent).toBe(72.86);
    expect(String(p.adjustments.join(" "))).toContain("72.86% turnout");
  });

  it("an explicit risky split proceeds only after confirmRisky, and the preview still says why", async () => {
    const p = payload(await daoCreate({ treasuryPercent: 49, quorumPercent: 51, confirmRisky: true }));
    expect(p.mode).toBe("preview");
    expect(p.safetyProof.turnoutMarginOk).toBe(false);
    expect(String(p.warnings.join(" "))).toContain("turn out");
  });

  it("a treasury share that hosts no safe quorum is refused with the number to use", async () => {
    const r = await daoCreate({ treasuryPercent: 49 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("≤37.5");
  });

  it("a quorum nothing can clear is refused before any config is built", async () => {
    const r = await daoCreate({ quorumPercent: 95 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("participation margin");
  });
});

describe("dexe_dao_create — the advisory arrives BEFORE the act (finding C)", () => {
  it("a below-floor quorum stops the ONE-CALL confirm:true path, which shows no preview", async () => {
    const p = payload(await daoCreate({ treasuryPercent: 0, quorumPercent: 20, confirm: true }));
    expect(p.mode).toBe("blocked-risky");
    expect(String(p.risks.join(" "))).toContain("50% treasury-safety floor");
    expect(p.steps).toBeUndefined(); // nothing was even built
  });

  it("DEXE_TREASURY_GUARD=block REFUSES, and confirmRisky does not override it", async () => {
    process.env.DEXE_TREASURY_GUARD = "block";
    const r = await daoCreate({ treasuryPercent: 0, quorumPercent: 20, confirm: true, confirmRisky: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Refusing");
    expect(text(r)).toContain("Nothing was broadcast");
    expect(text(r)).toContain("DEXE_TREASURY_GUARD=warn");
  });

  it("block does not block a config that passes the checks", async () => {
    process.env.DEXE_TREASURY_GUARD = "block";
    const p = payload(await daoCreate({}));
    expect(p.mode).toBe("preview");
  });

  it("a malformed DEXE_TREASURY_GUARD falls back to warn — advisory, not refusal, never a crash", async () => {
    process.env.DEXE_TREASURY_GUARD = "Blocked!";
    const p = payload(await daoCreate({ treasuryPercent: 0, quorumPercent: 20, confirm: true }));
    expect(p.mode).toBe("blocked-risky"); // warn behaviour: overridable
    const p2 = payload(await daoCreate({ treasuryPercent: 0, quorumPercent: 20, confirmRisky: true }));
    expect(p2.mode).toBe("preview");
  });

  it("DEXE_TREASURY_GUARD=off silences the gate entirely (opt-out stays honoured)", async () => {
    process.env.DEXE_TREASURY_GUARD = "off";
    const p = payload(await daoCreate({ treasuryPercent: 0, quorumPercent: 20 }));
    expect(p.mode).toBe("preview");
  });
});

describe("dexe_dao_create — ADVANCED params: all five settings slots (finding E)", () => {
  const okSlot = {
    earlyCompletion: true,
    delegatedVotingAllowed: false,
    validatorsVote: true,
    duration: "86400",
    durationValidators: "86400",
    executionDelay: "0",
    quorum: (51n * 10n ** 25n).toString(),
    quorumValidators: (51n * 10n ** 25n).toString(),
    minVotesForVoting: (10n ** 18n).toString(),
    minVotesForCreating: (10n ** 18n).toString(),
    rewardsInfo: {
      rewardToken: "0x0000000000000000000000000000000000000000",
      creationReward: "0",
      executionReward: "0",
      voteRewardsCoefficient: "0",
    },
    executorDescription: "",
  };

  const advanced = (overrides: Record<number, Record<string, unknown>> = {}) => ({
    params: {
      settingsParams: {
        proposalSettings: [0, 1, 2, 3, 4].map((i) => ({ ...okSlot, ...(overrides[i] ?? {}) })),
        additionalProposalExecutors: [],
      },
      userKeeperParams: {
        tokenAddress: "0x0000000000000000000000000000000000000000",
        nftAddress: "0x0000000000000000000000000000000000000000",
        individualPower: "0",
        nftsTotalSupply: "0",
      },
      tokenParams: {
        name: "Aurora Collective",
        symbol: "AUR",
        users: [DEPLOYER],
        cap: (1_000_000n * 10n ** 18n).toString(),
        mintedTotal: (1_000_000n * 10n ** 18n).toString(),
        amounts: [(700_000n * 10n ** 18n).toString()],
      },
      votePowerParams: { voteType: "LINEAR_VOTES", presetAddress: "0x0000000000000000000000000000000000000000" },
      verifier: "0x0000000000000000000000000000000000000000",
      onlyBABTHolders: false,
    },
  });

  it("accepts a coherent five-slot config", async () => {
    const r = await daoCreate({ ...advanced(), deployer: DEPLOYER, dryRun: true, confirmRisky: true });
    // It gets past every governance guard; the only thing left to fail is the
    // RPC-backed address prediction, which this offline test cannot satisfy.
    expect(text(r)).not.toContain("un-governable");
  });

  it("refuses an un-passable quorum hidden in the distributionProposal slot", async () => {
    const r = await daoCreate({ ...advanced({ 3: { quorum: (95n * 10n ** 25n).toString() } }), deployer: DEPLOYER });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("un-governable");
    expect(text(r)).toContain("proposalSettings[3] (distributionProposal)");
  });

  it("refuses min-votes above every holder hidden in the validators slot", async () => {
    const r = await daoCreate({
      ...advanced({ 2: { minVotesForCreating: (900_000n * 10n ** 18n).toString() } }),
      deployer: DEPLOYER,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("proposalSettings[2] (validators)");
    expect(text(r)).toContain("deploy.min-votes");
  });

  it("refuses a zero duration hidden in the tokenSale slot", async () => {
    const r = await daoCreate({ ...advanced({ 4: { duration: "0" } }), deployer: DEPLOYER });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("proposalSettings[4] (tokenSale)");
  });

  it("names every broken slot at once, not just the first", async () => {
    const r = await daoCreate({
      ...advanced({ 1: { quorum: (95n * 10n ** 25n).toString() }, 4: { duration: "0" } }),
      deployer: DEPLOYER,
    });
    expect(text(r)).toContain("proposalSettings[1] (internal)");
    expect(text(r)).toContain("proposalSettings[4] (tokenSale)");
    expect(text(r)).toContain("2 settings slot issues");
  });
});
