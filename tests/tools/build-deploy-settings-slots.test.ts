import { describe, expect, it } from "vitest";
import { AbiCoder, getAddress } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDeployGovPool, registerDaoDeployTools, type DeployParams } from "../../src/tools/daoDeploy.js";
import { registerDaoCreateTools } from "../../src/tools/daoCreate.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { RpcProvider } from "../../src/rpc.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * 0.33.0 HIGH-3 — `dexe_dao_build_deploy` validated `proposalSettings[0]` and
 * nothing else, while `checkAllProposalSettings` (written this release for
 * exactly this) was wired only into `dexe_dao_create`.
 *
 * `deployGovPool` takes FIVE settings entries, one per executor family
 * (default / internal / validators / distributionProposal / tokenSale). An
 * ADVANCED 5-slot config is the scenario, and `build_deploy` is the most
 * natural way for one to arrive. A DAO that ships one un-governable slot is
 * UNRECOVERABLE — repairing that slot needs a proposal passed under it.
 *
 * The guard is wired into `buildDeployGovPool`, the ONE function BOTH deploy
 * surfaces funnel through (`dexe_dao_build_deploy`'s handler and
 * `dexe_dao_create` both call it), so there is exactly one place to bypass.
 * These tests therefore assert two things:
 *   1. the builder refuses a broken slot and NAMES it, at every index;
 *   2. the two deploy surfaces return the SAME verdict text for the same
 *      config — a user comparing them must not see two different answers.
 *
 * Fully offline: `predictGovAddresses` and `getCode` are stubbed.
 */

const DEPLOYER = getAddress("0xdeadbeef00000000000000000000000000000001");
const FACTORY = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------- offline stubs (predictGovAddresses tuple, no deployed code) ----------
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
const rpc = {
  tryProvider: () => ({ ok: { call: async () => predictResult, getCode: async () => "0x" } }),
} as unknown as RpcProvider;

const ctx = (treasuryGuard: "off" | "warn" = "warn") =>
  ({
    config: {
      chains: new Map([[97, { chainId: 97 }]]),
      defaultChainId: 97,
      minSafeQuorumPct: 50,
      treasuryGuard,
      pinataJwt: undefined, // no IPFS in these tests
    },
    artifacts: { get: () => [] },
  }) as unknown as ToolContext;

// ---------- a coherent five-slot ADVANCED config ----------
// 1,000,000 supply, 700,000 (70%) distributed to one wallet, 30% implicit
// treasury. 51% quorum against a 70% votable share == 72.86% turnout: reachable
// AND inside the margin, so a pristine config trips nothing at all.
const SUPPLY = (1_000_000n * 10n ** 18n).toString();
const DISTRIBUTED = (700_000n * 10n ** 18n).toString();
const pct = (n: bigint) => (n * 10n ** 25n).toString();

type Slot = DeployParams["settingsParams"]["proposalSettings"][number];

const okSlot: Slot = {
  earlyCompletion: true,
  delegatedVotingAllowed: false,
  validatorsVote: true,
  duration: "86400",
  durationValidators: "86400",
  executionDelay: "0",
  quorum: pct(51n),
  quorumValidators: pct(51n),
  minVotesForVoting: (10n ** 18n).toString(),
  minVotesForCreating: (10n ** 18n).toString(),
  rewardsInfo: { rewardToken: ZERO, creationReward: "0", executionReward: "0", voteRewardsCoefficient: "0" },
  executorDescription: "",
};

/** The five-slot params both surfaces are given, minus name/descriptionURL. */
function advancedCore(overrides: Record<number, Partial<Slot>> = {}, amounts = DISTRIBUTED) {
  return {
    settingsParams: {
      proposalSettings: [0, 1, 2, 3, 4].map((i) => ({ ...okSlot, ...(overrides[i] ?? {}) })),
      additionalProposalExecutors: [] as string[],
    },
    userKeeperParams: { tokenAddress: ZERO, nftAddress: ZERO, individualPower: "0", nftsTotalSupply: "0" },
    tokenParams: {
      name: "Aurora Collective",
      symbol: "AUR",
      users: [DEPLOYER],
      cap: SUPPLY,
      mintedTotal: SUPPLY,
      amounts: [amounts],
    },
    votePowerParams: { voteType: "LINEAR_VOTES" as const, presetAddress: ZERO },
    verifier: ZERO,
    onlyBABTHolders: false,
  };
}

const NAME = "Aurora Collective";

function advancedParams(overrides: Record<number, Partial<Slot>> = {}, amounts = DISTRIBUTED): DeployParams {
  return { ...advancedCore(overrides, amounts), descriptionURL: "ipfs://QmSlotGuard", name: NAME };
}

const build = (overrides: Record<number, Partial<Slot>> = {}, guard: "off" | "warn" = "warn", amounts = DISTRIBUTED) =>
  buildDeployGovPool(
    { chainId: 97, poolFactory: FACTORY, deployer: DEPLOYER, params: advancedParams(overrides, amounts) },
    ctx(guard),
    rpc,
  );

const errorOf = async (overrides: Record<number, Partial<Slot>>) => {
  const res = await build(overrides);
  if (res.ok) throw new Error("expected the builder to refuse this config");
  return res.error;
};

describe("dexe_dao_build_deploy — every settings slot, not just [0] (HIGH-3)", () => {
  it("a coherent five-slot config still builds", async () => {
    const res = await build();
    expect(res.ok).toBe(true);
  });

  // The regression itself: slot 0 is pristine in every one of these, so the
  // old `expandedSettings[0]`-only guard waved them all through.
  const slotNames = ["default", "internal", "validators", "distributionProposal", "tokenSale"];
  for (const index of [1, 2, 3, 4]) {
    it(`refuses an UNREACHABLE quorum hidden in slot ${index} (${slotNames[index]})`, async () => {
      const e = await errorOf({ [index]: { quorum: pct(95n) } });
      expect(e).toContain("un-governable");
      expect(e).toContain(`proposalSettings[${index}] (${slotNames[index]})`);
      expect(e).toContain("deploy.quorum-reachable");
      expect(e).toContain("1 settings slot issue");
    });
  }

  it("names the distributionProposal slot for the finding's own scenario (broken slot 3)", async () => {
    const e = await errorOf({ 3: { quorum: pct(95n) } });
    expect(e).toContain("proposalSettings[3] (distributionProposal)");
    // slot 0 is untouched — the config the old guard called healthy
    expect(e).not.toContain("proposalSettings[0] (default)");
  });

  it("refuses min-votes above every holder hidden in the validators slot", async () => {
    const e = await errorOf({ 2: { minVotesForCreating: (900_000n * 10n ** 18n).toString() } });
    expect(e).toContain("proposalSettings[2] (validators)");
    expect(e).toContain("deploy.min-votes");
  });

  it("refuses a zero duration hidden in the tokenSale slot", async () => {
    const e = await errorOf({ 4: { duration: "0" } });
    expect(e).toContain("proposalSettings[4] (tokenSale)");
    expect(e).toContain("deploy.settings-bounds");
  });

  it("names every broken slot at once, not just the first", async () => {
    const e = await errorOf({ 1: { quorum: pct(95n) }, 4: { duration: "0" } });
    expect(e).toContain("proposalSettings[1] (internal)");
    expect(e).toContain("proposalSettings[4] (tokenSale)");
    expect(e).toContain("2 settings slot issues");
  });

  it("still catches slot 0 — the consolidated guard did not drop the old coverage", async () => {
    const e = await errorOf({ 0: { quorum: pct(95n) } });
    expect(e).toContain("proposalSettings[0] (default)");
    expect(e).toContain("deploy.quorum-reachable");
  });

  it("reports unparseable slot numerics instead of throwing", async () => {
    const e = await errorOf({ 2: { quorum: "not-a-number" } });
    expect(e).toContain("deploy.settings-unparseable");
    expect(e).toContain("proposalSettings[2] (validators)");
  });

  it("the auto-expanded 1 → 5 path is judged on all five EXPANDED slots", async () => {
    // One supplied slot becomes the five that actually reach the chain, so the
    // verdict names all five while staying truthful about what was supplied.
    const one = advancedParams();
    one.settingsParams.proposalSettings = [{ ...okSlot, minVotesForCreating: (900_000n * 10n ** 18n).toString() }];
    const res = await buildDeployGovPool(
      { chainId: 97, poolFactory: FACTORY, deployer: DEPLOYER, params: one },
      ctx(),
      rpc,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("5 settings slot issues (of 1 supplied; deployGovPool expands 1 → 5)");
    expect(res.error).toContain("proposalSettings[4] (tokenSale)");
  });
});

describe("dexe_dao_build_deploy — turnout margin stays advisory, never a refusal", () => {
  // 51% quorum against a 51% votable share == 100% turnout, forever.
  const noMargin = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {} };
  const HALF = (510_000n * 10n ** 18n).toString();

  it("emits the payload and warns, naming every slot with no margin", async () => {
    const res = await build(noMargin, "warn", HALF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.data.length).toBeGreaterThan(10);
    expect(res.note).toContain("no turnout margin");
    expect(res.note).toContain("[0] default");
    expect(res.note).toContain("[3] distributionProposal");
    expect(res.note).toContain("100% turnout");
    expect(res.note).toContain("[governance-safety advisory]");
  });

  it("DEXE_TREASURY_GUARD=off silences it — the opt-out is honoured", async () => {
    const res = await build(noMargin, "off", HALF);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).not.toContain("no turnout margin");
  });

  it("a config with real headroom says nothing about margin", async () => {
    const res = await build();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.note).not.toContain("no turnout margin");
  });
});

// ---------- cross-surface: one config, one verdict ----------

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

function daoCreateConfig(): DexeConfig {
  const chain = (chainId: number) => ({ chainId, rpcUrl: `https://rpc.invalid/${chainId}`, rpcUrls: [] });
  return {
    defaultChainId: 97,
    chainId: 97,
    chains: new Map([[97, chain(97)]]),
    pinataJwt: "test-jwt",
    minSafeQuorumPct: 50,
    treasuryGuard: "warn",
    ipfsGateways: [],
  } as unknown as DexeConfig;
}

const signer = { hasSigner: () => true, getAddress: () => DEPLOYER } as unknown as SignerManager;

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  const toolCtx = { config: daoCreateConfig() } as unknown as ToolContext;
  if (name === "dexe_dao_create") {
    registerDaoCreateTools(server, toolCtx, signer, {} as unknown as WalletConnectManager);
  } else {
    registerDaoDeployTools(server, toolCtx);
  }
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/** The verdict block, isolated from anything surface-specific around it. */
const verdictOf = (s: string) => s.slice(s.indexOf("This DAO would be un-governable"));

describe("the two deploy surfaces agree on the same config", () => {
  for (const [label, overrides] of [
    ["an un-passable distributionProposal slot", { 3: { quorum: pct(95n) } }],
    ["min-votes above every holder in the validators slot", { 2: { minVotesForCreating: (900_000n * 10n ** 18n).toString() } }],
    ["a zero duration in the tokenSale slot", { 4: { duration: "0" } }],
    ["two broken slots at once", { 1: { quorum: pct(95n) }, 4: { duration: "0" } }],
  ] as Array<[string, Record<number, Partial<Slot>>]>) {
    it(`${label}: dexe_dao_create and dexe_dao_build_deploy return the same verdict`, async () => {
      const fromCreate = await callTool("dexe_dao_create", {
        daoName: NAME,
        chainId: 97,
        deployer: DEPLOYER,
        params: advancedCore(overrides),
      });
      const built = await build(overrides);

      expect(fromCreate.isError).toBe(true);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(text(fromCreate)).toContain("This DAO would be un-governable");
      // Byte-identical verdicts — same count, same slot names, same check ids,
      // same remediation. Two surfaces, one answer.
      expect(verdictOf(built.error)).toBe(verdictOf(text(fromCreate)));
    });
  }

  it("both surfaces accept the coherent config (the guard is not a blanket refusal)", async () => {
    const fromCreate = await callTool("dexe_dao_create", {
      daoName: NAME,
      chainId: 97,
      deployer: DEPLOYER,
      params: advancedCore(),
      dryRun: true,
      confirmRisky: true,
    });
    expect(text(fromCreate)).not.toContain("un-governable");
    expect((await build()).ok).toBe(true);
  });

  it("dexe_dao_build_deploy's handler returns the builder's refusal verbatim", async () => {
    // Proves the tool boundary forwards `res.error` untouched — the guard above
    // is what the caller actually sees. Uses a pre-RPC failure so the assertion
    // stays offline and deterministic.
    const r = await callTool("dexe_dao_build_deploy", {
      chainId: 97,
      poolFactory: FACTORY,
      deployer: "not-an-address",
      params: advancedParams(),
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Invalid deployer: not-an-address");
  });
});
