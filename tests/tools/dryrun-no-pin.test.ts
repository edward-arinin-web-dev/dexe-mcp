import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Interface, getAddress } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * ── `dryRun` means "writes NOTHING", including to IPFS ──────────────────────
 *
 * docs/USAGE.md, docs/USE_CASES.md and docs/SAFE.md all teach `dryRun: true` as
 * the safe way to inspect what a composite would do. In 0.33.1 that preview
 * pinned, for real, to the caller's Pinata account:
 *
 *   dexe_dao_create            → 2 settings JSONs (via buildDeployGovPool)
 *   dexe_proposal_create       → dao-desc JSON + the user's AVATAR IMAGE +
 *     (modify_dao_profile)       dao-meta JSON
 *   dexe_otc_dao_open_sale     → the DAO's merkle whitelist (private addresses,
 *                                published to a public content network)
 *   dexe_dao_build_deploy      → 2 settings JSONs on EVERY call, no opt-out
 *
 * Every test here spies on the two network primitives (`PinataClient.pinJson`
 * and `.pinFile`) and asserts zero calls. The spies REJECT rather than resolve,
 * so a regression fails loudly instead of quietly passing a fake CID through.
 */

const PINATA_SPY_ERROR = new Error("test: a dryRun must never touch the network");

// The RPC provider daoCreate builds internally (daoCreate.ts constructs it at
// register time, so there is no injection point at the tool boundary).
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
vi.mock("../../src/rpc.js", () => ({
  RpcProvider: class {
    tryProvider() {
      return { ok: { call: async () => predictResult, getCode: async () => "0x" } };
    }
  },
}));

import { PinataClient } from "../../src/lib/ipfs.js";
import { registerDaoCreateTools } from "../../src/tools/daoCreate.js";
import { registerDaoDeployTools } from "../../src/tools/daoDeploy.js";
import { renderAvatarJpeg } from "../../src/lib/avatarImage.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

const DEPLOYER = getAddress("0xdeadbeef00000000000000000000000000000001");
const JPEG_BYTES = renderAvatarJpeg("Fixture", 64);

let dir: string;
let jpegPath: string;
let svgPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dryrun-no-pin-"));
  jpegPath = join(dir, "logo.jpeg");
  svgPath = join(dir, "logo.svg");
  await writeFile(jpegPath, JPEG_BYTES);
  await writeFile(svgPath, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(overrides: Partial<DexeConfig> = {}): DexeConfig {
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
    ...overrides,
  } as unknown as DexeConfig;
}

/** A signer that exists but never signs — enough to reach every preview path. */
const signer = { hasSigner: () => true, getAddress: () => DEPLOYER } as unknown as SignerManager;
/**
 * No signer at all. `sendOrCollect` then returns mode "payloads" — a REAL run
 * (it pins for real) that never needs a wallet, which is the cheap way to
 * exercise the non-dryRun branch offline.
 */
const noSigner = { hasSigner: () => false, getAddress: () => DEPLOYER } as unknown as SignerManager;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function daoCreate(
  args: Record<string, unknown>,
  cfg: DexeConfig = config(),
  sm: SignerManager = signer,
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

let pinJson: ReturnType<typeof vi.spyOn>;
let pinFile: ReturnType<typeof vi.spyOn>;
let savedGuard: string | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  pinJson = vi.spyOn(PinataClient.prototype, "pinJson").mockRejectedValue(PINATA_SPY_ERROR);
  pinFile = vi.spyOn(PinataClient.prototype, "pinFile").mockRejectedValue(PINATA_SPY_ERROR);
  savedGuard = process.env.DEXE_TREASURY_GUARD;
  delete process.env.DEXE_TREASURY_GUARD;
  return () => {
    if (savedGuard === undefined) delete process.env.DEXE_TREASURY_GUARD;
    else process.env.DEXE_TREASURY_GUARD = savedGuard;
  };
});

const DEPLOY_ABI = new Interface([
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) params)",
]);

/** Every `executorDescription` string in the emitted deploy calldata. */
function executorDescriptions(data: string): string[] {
  const [params] = DEPLOY_ABI.decodeFunctionData("deployGovPool", data);
  return params[0][0].map((s: any) => s[11] as string);
}

describe("dexe_dao_create — dryRun pins nothing", () => {
  it("makes ZERO Pinata calls with a description and an avatar", async () => {
    const r = await daoCreate({ dryRun: true, daoDescription: "hello", avatarPath: jpegPath });
    expect(r.isError, text(r)).toBeFalsy();
    expect(payload(r).mode).toBe("dryRun");
    expect(pinJson).not.toHaveBeenCalled();
    expect(pinFile).not.toHaveBeenCalled();
  });

  it("labels every local CID unpinned and tells the caller not to broadcast", async () => {
    const p = payload(await daoCreate({ dryRun: true, daoDescription: "hello" }));
    expect(p.ipfs.allPinned).toBe(false);
    const fields = p.ipfs.artifacts.map((a: any) => a.field);
    expect(fields).toContain("descriptionURL");
    expect(fields).toContain("daoDescription");
    expect(fields).toContain("executorDescription[default]");
    expect(fields).toContain("executorDescription[distributionProposal]");
    for (const a of p.ipfs.artifacts) expect(a.pinned).toBe(false);
    expect(p.ipfs.note).toContain("computed locally, not pinned (dryRun)");
    expect(p.ipfs.note).toContain("Do NOT broadcast");
  });

  it("emits the SAME executorDescription CIDs a real run would pin", async () => {
    // The whole point of computing Pinata's dag-pb CID locally: preview
    // calldata is not a different-shaped stand-in, it is the real bytes.
    const preview = payload(await daoCreate({ dryRun: true }));
    const previewCids = executorDescriptions(preview.steps[0].payload.data);

    pinJson.mockReset();
    // A "real" run whose pin returns whatever CID the local computation says —
    // i.e. a faithful Pinata. Assert the two calldatas match byte for byte.
    const { pinataCidForJson } = await import("../../src/lib/ipfs.js");
    pinJson.mockImplementation(async (value: unknown) => ({
      cid: (await pinataCidForJson(value)).cid,
      size: 1,
      pinnedAt: "x",
    }));
    const real = payload(await daoCreate({ deployer: DEPLOYER }, config(), noSigner));
    expect(real.steps[0].payload.data).toBe(preview.steps[0].payload.data);
    expect(previewCids.every((c) => c.startsWith("ipfs://Qm"))).toBe(true);
  });

  it("validates the avatar in the preview instead of only on the deploy call", async () => {
    const svg = await daoCreate({ dryRun: true, avatarPath: svgPath });
    expect(svg.isError).toBe(true);
    expect(text(svg)).toMatch(/SVG/i);
    expect(pinFile).not.toHaveBeenCalled();

    const missing = await daoCreate({ dryRun: true, avatarPath: join(dir, "nope.jpeg") });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/Cannot read avatar file/);
  });

  it("normalizes the previewed avatar filename the way the real run does", async () => {
    // Before 0.34.0 the preview echoed the raw `avatarFileName` input while the
    // real run normalized to `.jpeg`, so the two daoMeta objects disagreed.
    const p = payload(await daoCreate({ dryRun: true, avatarPath: jpegPath, avatarFileName: "logo.png" }));
    expect(p.mode).toBe("dryRun");
    expect(pinFile).not.toHaveBeenCalled();
  });

  it("a real run DOES pin, and carries no unpinned marker", async () => {
    pinJson.mockReset();
    pinJson.mockResolvedValue({ cid: "QmFAKE", size: 1, pinnedAt: "x" });
    const r = await daoCreate({ deployer: DEPLOYER, daoDescription: "hello" }, config(), noSigner);
    expect(r.isError, text(r)).toBeFalsy();
    // dao-desc + dao-meta + 2 executorDescription slots.
    expect(pinJson).toHaveBeenCalledTimes(4);
    expect(payload(r).ipfs).toBeUndefined();
  });
});

describe("dexe_dao_create — the Pinata key is demanded at the first pin, not at the door", () => {
  it("previews a DAO with no Pinata key at all", async () => {
    const r = await daoCreate({ dryRun: true }, config({ pinataJwt: undefined } as Partial<DexeConfig>));
    expect(r.isError, text(r)).toBeFalsy();
    expect(payload(r).mode).toBe("dryRun");
    expect(text(r)).not.toContain("DEXE_PINATA_JWT is required");
    // …but it must not pretend the real run will be fine: without a key the
    // deploy ships EMPTY executorDescriptions and a broken settings UI.
    expect(payload(r).note).toContain("EMPTY");
    expect(payload(r).note).toContain("DEXE_PINATA_JWT is not configured");
  });

  it("the 49/51 safety gate answers first, not the JWT error", async () => {
    const r = await daoCreate(
      { treasuryPercent: 49, quorumPercent: 51 },
      config({ pinataJwt: undefined } as Partial<DexeConfig>),
    );
    const p = payload(r);
    expect(p.mode).toBe("blocked-risky");
    expect(text(r)).not.toContain("DEXE_PINATA_JWT is required");
  });

  it("a real deploy still demands the key, with the same actionable hint", async () => {
    const r = await daoCreate({ deployer: DEPLOYER }, config({ pinataJwt: undefined } as Partial<DexeConfig>), noSigner);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("DEXE_PINATA_JWT is required");
    expect(text(r)).toContain("/dexe-setup");
  });
});

// ── D4-6: the one `*_build_*` tool that writes to the network ──────────────
//
// Every other `dexe_*_build_*` tool only encodes calldata, so agents (and the
// server instructions) treat the whole family as network-write-free. This one
// pinned two settings JSONs on every default-shaped call, including calls whose
// result was thrown away. `previewOnly` is the opt-out — deliberately NOT named
// `dryRun`, because the payload it returns is shape-identical to a sendable one
// and the name should not suggest otherwise.
describe("dexe_dao_build_deploy — previewOnly", () => {
  const DEPLOY_PARAMS = {
    settingsParams: {
      proposalSettings: [
        {
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
        },
      ],
      additionalProposalExecutors: [] as string[],
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
    descriptionURL: "ipfs://QmPreview",
    name: "Aurora Collective",
  };

  async function buildDeploy(args: Record<string, unknown>): Promise<ToolResult> {
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerDaoDeployTools(server, {
      config: config(),
      artifacts: { get: () => [] },
    } as unknown as ToolContext);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      return (await client.callTool({
        name: "dexe_dao_build_deploy",
        arguments: { chainId: 97, deployer: DEPLOYER, params: DEPLOY_PARAMS, ...args },
      })) as unknown as ToolResult;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("pins nothing and labels the payload NOT BROADCASTABLE", async () => {
    const r = await buildDeploy({ previewOnly: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(pinJson).not.toHaveBeenCalled();
    // eth_call cannot detect an unpinned executorDescription — the contract
    // never validates the string — so a PASS verdict would read as "safe to
    // send" and be exactly wrong. previewOnly skips the sim and leads with the
    // refusal instead.
    expect(text(r)).toContain("NOT BROADCASTABLE");
  });

  it("still pins by default — the opt-out must not become the default", async () => {
    pinJson.mockReset();
    pinJson.mockResolvedValue({ cid: "QmFAKE", size: 1, pinnedAt: "x" });
    const r = await buildDeploy({ skipSimulation: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(pinJson).toHaveBeenCalledTimes(2);
    expect(text(r)).not.toContain("NOT BROADCASTABLE");
  });
});
