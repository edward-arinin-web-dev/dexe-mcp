import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface } from "ethers";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── The worst half of the dryRun leak: `modify_dao_profile` ─────────────────
 *
 * `runProposalCreate` gated its proposal-metadata pin on `dryRun` and then, 150
 * lines earlier, pinned three things unconditionally in the `modify_dao_profile`
 * branch: the description slate, the DAO metadata, and — via
 * `pinAvatarFromInput` → `pinFile` — the user's IMAGE FILE, read off their disk
 * and published to public IPFS during what the docs call a preview.
 *
 * These tests drive the real composite with every RPC read faked and both
 * Pinata primitives spied. `pinFile` is the one that matters most: nothing else
 * in this repo uploads a user's local file during a read-only-looking call.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

// W10's registered-GovPool probe is a live eth_call — make the registry
// unresolvable so it takes its documented "cannot verify → proceed" branch.
vi.mock("../../src/lib/addresses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/addresses.js")>()),
  AddressBook: class {
    async resolve(): Promise<string> {
      throw new Error("offline test — registry unresolvable");
    }
  },
}));

import { multicall } from "../../src/lib/multicall.js";
import { loadConfig } from "../../src/config.js";
import { RpcProvider } from "../../src/rpc.js";
import { PinataClient } from "../../src/lib/ipfs.js";
import { renderAvatarJpeg } from "../../src/lib/avatarImage.js";
import { runProposalCreate } from "../../src/tools/flow.js";

const mc = vi.mocked(multicall);

const GOV_POOL = "0x1111111111111111111111111111111111111111";
const SETTINGS = "0x2222222222222222222222222222222222222222";
const USER_KEEPER = "0x3333333333333333333333333333333333333333";
const VALIDATORS = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
const USER = "0x000000000000000000000000000000000000dEaD";
const CHAIN = 97;
const ONE = 10n ** 18n;

const GOV = new Interface([
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
  "function editDescriptionURL(string newDescriptionURL)",
]);

function routeCall(call: { method: string }): unknown {
  switch (call.method) {
    case "getHelperContracts":
      return [SETTINGS, USER_KEEPER, VALIDATORS, GOV_POOL, GOV_POOL];
    case "tokenAddress":
      return TOKEN;
    case "getDefaultSettings":
      return { minVotesForCreating: 0n, minVotesForVoting: 0n };
    case "tokenBalance":
      return [1000n * ONE, 0n];
    case "balanceOf":
      return 0n;
    case "allowance":
      return 0n;
    case "decimals":
      return 18n;
    case "symbol":
      return "TST";
    case "latestProposalId":
      return 0n;
    case "getProposals":
      return [];
    case "descriptionURL":
      // No current profile on chain → nothing to merge, no IPFS read.
      return "";
    default:
      return undefined;
  }
}

const NO_WC = { isConfigured: () => false } as unknown as WalletConnectManager;
/** No signer → sendOrCollect returns mode "payloads" without needing a wallet. */
const noSigner = { hasSigner: () => false, getAddress: () => USER } as unknown as SignerManager;

const JPEG_BYTES = renderAvatarJpeg("Fixture", 64);
let dir: string;
let jpegPath: string;
let svgPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "modify-profile-dryrun-"));
  jpegPath = join(dir, "logo.jpeg");
  svgPath = join(dir, "logo.svg");
  await writeFile(jpegPath, JPEG_BYTES);
  await writeFile(svgPath, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let ctx: ToolContext;
let rpc: RpcProvider;
let pinJson: ReturnType<typeof vi.spyOn>;
let pinFile: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(multicall).mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
    calls.map((c) => {
      const value = routeCall(c);
      return value === undefined
        ? { success: false, value: null, raw: "0x", error: "call reverted" }
        : { success: true, value: value as never, raw: "0x" };
    }),
  );
  pinJson = vi
    .spyOn(PinataClient.prototype, "pinJson")
    .mockRejectedValue(new Error("test: a dryRun must never touch the network"));
  pinFile = vi
    .spyOn(PinataClient.prototype, "pinFile")
    .mockRejectedValue(new Error("test: a dryRun must never touch the network"));
  const base = await loadConfig();
  ctx = { config: { ...base, pinataJwt: "test-jwt", treasuryGuard: "off" } } as unknown as ToolContext;
  rpc = new RpcProvider(ctx.config);
  mc.mockClear();
});

interface Res {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}
const text = (r: Res) => r.content.map((c) => c.text ?? "").join("\n");
const envelope = (r: Res) => {
  const texts = r.content.filter((c) => c.type === "text" && typeof c.text === "string");
  return JSON.parse(texts[texts.length - 1]!.text!) as Record<string, any>;
};

const profileInput = (extra: Record<string, unknown> = {}) => ({
  govPool: GOV_POOL,
  chainId: CHAIN,
  proposalType: "modify_dao_profile",
  title: "Refresh the DAO profile",
  // All three merge-relevant fields set → isPartialUpdate is false, so no
  // current-metadata IPFS read is needed.
  newDaoName: "Aurora Collective",
  newWebsiteUrl: "https://aurora.example",
  newSocialLinks: [] as [string, string][],
  user: USER,
  ...extra,
});

/** The `editDescriptionURL` argument out of the emitted createProposalAndVote calldata. */
function editedDescriptionURL(data: string): string {
  const [, actionsOnFor] = GOV.decodeFunctionData("createProposalAndVote", data);
  const action = actionsOnFor[0];
  return GOV.decodeFunctionData("editDescriptionURL", action[2])[0] as string;
}

describe("dexe_proposal_create(modify_dao_profile) — dryRun pins nothing", () => {
  it("pins neither the description, the DAO metadata, nor the avatar image", async () => {
    const res = (await runProposalCreate(
      profileInput({ dryRun: true, newDaoDescription: "hello", newAvatarPath: jpegPath }),
      { ctx, signer: noSigner, rpc, wc: NO_WC },
    )) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(pinJson).not.toHaveBeenCalled();
    expect(pinFile).not.toHaveBeenCalled();
    const body = envelope(res);
    expect(body.mode).toBe("dryRun");
    // The emitted calldata still carries a real, correctly shaped CID.
    const url = editedDescriptionURL(body.steps.at(-1).payload.data);
    expect(url).toMatch(/^ipfs:\/\/Qm/);
  });

  it("declares every unpinned artifact, including the profile metadata", async () => {
    const res = (await runProposalCreate(profileInput({ dryRun: true, newDaoDescription: "hello" }), {
      ctx,
      signer: noSigner,
      rpc,
      wc: NO_WC,
    })) as Res;
    const body = envelope(res);
    const fields = body.ipfs.artifacts.map((a: any) => a.field);
    expect(fields).toEqual(expect.arrayContaining(["daoDescription", "editDescriptionURL", "descriptionURL"]));
    for (const a of body.ipfs.artifacts) expect(a.pinned).toBe(false);
    expect(body.ipfs.note).toContain("computed locally, not pinned (dryRun)");
  });

  it("folds in artifacts a wrapping composite already resolved (the OTC merkle path)", async () => {
    // dexe_otc_dao_open_sale resolves its merkle whitelists BEFORE calling this
    // function, so without this hand-off the response's `ipfs` block would
    // describe only the proposal metadata and silently omit the whitelist CIDs
    // that also rode into the createTiers calldata.
    const res = (await runProposalCreate(
      {
        ...profileInput({ dryRun: true }),
        proposalType: "custom",
        actionsOnFor: [{ executor: GOV_POOL, value: "0", data: "0xdeadbeef" }],
        extraIpfsArtifacts: [
          { field: "merkleWhitelist[Founding circle]", uri: "ipfs://QmWL", pinned: false },
        ],
      },
      { ctx, signer: noSigner, rpc, wc: NO_WC },
    )) as Res;
    const fields = envelope(res).ipfs.artifacts.map((a: any) => a.field);
    expect(fields).toContain("merkleWhitelist[Founding circle]");
    expect(fields).toContain("descriptionURL");
  });

  it("rejects an SVG avatar in the preview — as a clean error, not a raw throw", async () => {
    const res = (await runProposalCreate(profileInput({ dryRun: true, newAvatarPath: svgPath }), {
      ctx,
      signer: noSigner,
      rpc,
      wc: NO_WC,
    })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/SVG/i);
    expect(pinFile).not.toHaveBeenCalled();
  });

  it("a real run pins description + daoMeta + proposalMeta and carries no marker", async () => {
    pinJson.mockReset();
    pinJson.mockResolvedValue({ cid: "QmFAKE", size: 1, pinnedAt: "x" });
    const res = (await runProposalCreate(profileInput({ newDaoDescription: "hello" }), {
      ctx,
      signer: noSigner,
      rpc,
      wc: NO_WC,
    })) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(pinJson).toHaveBeenCalledTimes(3);
    expect(envelope(res).ipfs).toBeUndefined();
  });
});

describe("dexe_proposal_create — the Pinata key is demanded at the first pin", () => {
  it("a keyless dryRun previews instead of refusing", async () => {
    const keyless = { config: { ...ctx.config, pinataJwt: undefined } } as unknown as ToolContext;
    const res = (await runProposalCreate(
      { ...profileInput({ dryRun: true, newDaoDescription: "hello" }) },
      { ctx: keyless, signer: noSigner, rpc, wc: NO_WC },
    )) as Res;
    expect(res.isError, text(res)).toBeFalsy();
    expect(text(res)).not.toContain("DEXE_PINATA_JWT is required");
    expect(envelope(res).mode).toBe("dryRun");
  });

  it("a keyless real run still fails fast with the actionable hint", async () => {
    const keyless = { config: { ...ctx.config, pinataJwt: undefined } } as unknown as ToolContext;
    const res = (await runProposalCreate(profileInput({ newDaoDescription: "hello" }), {
      ctx: keyless,
      signer: noSigner,
      rpc,
      wc: NO_WC,
    })) as Res;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("DEXE_PINATA_JWT is required");
  });

  it("a keyless internal-proposal dryRun previews instead of refusing", async () => {
    const keyless = { config: { ...ctx.config, pinataJwt: undefined } } as unknown as ToolContext;
    const res = (await runProposalCreate(
      {
        govPool: GOV_POOL,
        chainId: CHAIN,
        proposalType: "change_validator_balances",
        title: "Rebalance validators",
        description: "x",
        params: { validators: [USER], newBalances: ["1000000000000000000"] },
        user: USER,
        dryRun: true,
      },
      { ctx: keyless, signer: noSigner, rpc, wc: NO_WC },
    )) as Res;
    expect(text(res)).not.toContain("DEXE_PINATA_JWT is required");
    expect(pinJson).not.toHaveBeenCalled();
  });
});
