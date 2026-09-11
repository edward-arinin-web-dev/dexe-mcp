import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * D15-8 — the deploy preview answered none of the four questions a human asks
 * before spending money on something they can never change.
 *
 * It said what the config IS (a safety-engineering goal) and nothing about who
 * pays, what it costs, what is permanent, or what the tool chose on the
 * caller's behalf. Every missing item was already in scope in the same
 * function: `deployer` was resolved and used twice, the synthesized settings
 * sat in `deployParams`, and the permanence sentence existed — but only on the
 * branch for configs the tool already disliked.
 *
 * Fully offline. `probeDeployCost` is best-effort and bounded, so an
 * unreachable RPC must degrade to a note, never stall or fail the preview.
 */

const DEPLOYER = "0xdeadbeef00000000000000000000000000000001";
const SIGNER_ADDR = "0xdeadbeef00000000000000000000000000000001";

// A pin here would be a side effect in a review-only response.
const pinJson = vi.fn();
vi.mock("../../src/lib/ipfs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipfs.js")>()),
  PinataClient: class {
    async pinJson(obj: unknown) {
      pinJson(obj);
      return { cid: "bafyshouldneverhappen" };
    }
    async pinFile() {
      pinJson("file");
      return { cid: "bafyshouldneverhappen" };
    }
  },
}));

const { registerDaoCreateTools } = await import("../../src/tools/daoCreate.js");

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

const signer = {
  hasSigner: () => true,
  getAddress: () => DEPLOYER,
  describeSigner: () => ({ signerKey: "primary", address: SIGNER_ADDR }),
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

const payload = (r: ToolResult) => {
  const t = r.content.map((c) => c.text ?? "").join("\n");
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    throw new Error(`not JSON — the tool answered: ${t.slice(0, 600)}`);
  }
};

let savedGuard: string | undefined;
beforeEach(() => {
  pinJson.mockClear();
  savedGuard = process.env.DEXE_TREASURY_GUARD;
  delete process.env.DEXE_TREASURY_GUARD;
});
afterEach(() => {
  if (savedGuard === undefined) delete process.env.DEXE_TREASURY_GUARD;
  else process.env.DEXE_TREASURY_GUARD = savedGuard;
});

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

const advanced = (slot: Record<string, unknown> = {}, token: Record<string, unknown> = {}) => ({
  params: {
    settingsParams: {
      proposalSettings: [0, 1, 2, 3, 4].map(() => ({ ...okSlot, ...slot })),
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
      ...token,
    },
    votePowerParams: { voteType: "LINEAR_VOTES", presetAddress: "0x0000000000000000000000000000000000000000" },
    verifier: "0x0000000000000000000000000000000000000000",
    onlyBABTHolders: false,
  },
});

describe("who pays", () => {
  it("names the wallet that pays the gas, at the top level and in the preview block", async () => {
    const p = payload(await daoCreate({}));
    expect(p.mode).toBe("preview");
    expect(p.gasPaidBy).toBe(SIGNER_ADDR);
    expect(p.deployer).toBe(DEPLOYER);
    expect(p.signer).toEqual({ signerKey: "primary", address: SIGNER_ADDR });
    expect(String(p.preview.whoPays)).toContain(SIGNER_ADDR);
  });

  it("labels the recipient row that is the paying signer", async () => {
    const p = payload(await daoCreate({}));
    const mine = p.resolvedConfig.distribution.recipients.find(
      (r: { address: string }) => r.address.toLowerCase() === SIGNER_ADDR.toLowerCase(),
    );
    expect(mine.role).toContain("this signer");
  });
});

describe("what it costs", () => {
  it("degrades to a note when the RPC is unreachable, and does not stall", async () => {
    const started = Date.now();
    const p = payload(await daoCreate({}));
    expect(p.mode).toBe("preview");
    expect(p.cost).toBeUndefined();
    expect(String(p.costNote)).toMatch(/gas price unavailable/);
    // The probe is bounded; a preview must never hang on an endpoint.
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("what is permanent", () => {
  it("the preview says so unconditionally, not only for configs the tool dislikes", async () => {
    const p = payload(await daoCreate({}));
    expect(p.permanence).toContain("PERMANENT");
    expect(String(p.next)).toContain("PERMANENT");
    expect(String(p.preview.irreversible)).toContain("PERMANENT");
  });

  it("says the treasury share can never vote", async () => {
    const p = payload(await daoCreate({}));
    expect(p.permanence).toMatch(/treasury share can never vote/);
  });
});

describe("what the tool chose for the caller", () => {
  it("SIMPLE mode publishes the synthesized defaults, in units a person can read", async () => {
    const p = payload(await daoCreate({}));
    expect(p.defaults.source).toContain("SIMPLE");
    expect(p.defaults.votingDuration).toBe("1 day");
    expect(p.defaults.executionDelay).toBe("none — executable as soon as it passes");
    expect(p.defaults.supply).toContain("fixed");
    expect(p.defaults.rewards).toContain("none");
    expect(String(p.defaults.minVotesToVoteOrCreate)).toContain("AUR");
  });

  it("un-inverts delegatedVotingAllowed — a flag nobody would guess", async () => {
    // The contract field means the OPPOSITE of its name:
    // delegatedVotingAllowed:true DISABLES delegation.
    const allowed = payload(await daoCreate({}));
    expect(allowed.defaults.delegationAllowed).toBe(true);

    // ADVANCED params skip the SIMPLE synthesis, so the review gate only fires
    // on mainnet — which is also the only place a wrong delegation flag costs
    // real money.
    const disabled = payload(
      await daoCreate({ ...advanced({ delegatedVotingAllowed: true }), chainId: 56, confirmRisky: true }),
    );
    expect(disabled.defaults.delegationAllowed).toBe(false);
  });

  it("ADVANCED mode reads the CALLER's params and says they are the caller's", async () => {
    const p = payload(
      await daoCreate({
        ...advanced({ duration: "3600" }, { cap: (2_000_000n * 10n ** 18n).toString() }),
        chainId: 56,
        confirmRisky: true,
      }),
    );
    expect(p.defaults.source).toContain("ADVANCED");
    expect(p.defaults.votingDuration).toBe("1 hour");
    expect(String(p.defaults.supply)).toContain("capped at");
  });
});

describe("the settings-slot count no longer reads as '1 of 5'", () => {
  it("SIMPLE: 1 slot supplied, 5 checked on-chain — and the old key is untouched", async () => {
    const p = payload(await daoCreate({}));
    expect(p.safetyProof.settingsSlotsChecked).toBe(1); // back-compat
    expect(p.safetyProof.settingsSlots.supplied).toBe(1);
    expect(p.safetyProof.settingsSlots.expandedOnChain).toBe(5);
    expect(String(p.safetyProof.settingsSlots.note)).toContain("expands it into all 5");
  });

  it("ADVANCED: 5 supplied says exactly that", async () => {
    const p = payload(await daoCreate({ ...advanced(), chainId: 56, confirmRisky: true }));
    expect(p.safetyProof.settingsSlots.supplied).toBe(5);
    expect(String(p.safetyProof.settingsSlots.note)).toContain("all 5 supplied");
  });
});

describe("the preview is still side-effect free", () => {
  it("pins nothing", async () => {
    await daoCreate({});
    expect(pinJson).not.toHaveBeenCalled();
  });

  it("still says NOTHING was broadcast and how to proceed", async () => {
    const p = payload(await daoCreate({}));
    expect(p.preview.broadcast).toBe(false);
    expect(String(p.next)).toContain("confirm:true");
  });
});
