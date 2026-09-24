import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { Interface } from "ethers";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── What the create actually did, said out loud ─────────────────────────────
 *
 * D15-1 / D15-3 / D15-11.
 *
 * `dexe_proposal_create` with no `voteAmount` deposits the caller's ENTIRE
 * wallet balance and votes their ENTIRE available power FOR — and said so
 * nowhere: not in the step label (`createProposalAndVote("<title>")`), not in
 * the response, not in any advisory. It also never returned the id of the
 * proposal it had just created, so the one fact the rest of the journey depends
 * on had to be re-read from the chain by hand, and the knowledge layer's
 * `bindsFrom: {proposalId: "create.proposalId"}` could never resolve.
 *
 * The disclosure must never alter calldata, and it must never claim a tense it
 * has not earned: under dryRun nothing is locked and nothing exists.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

vi.mock("../../src/lib/ipfs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipfs.js")>()),
  PinataClient: class {
    async pinJson(obj: unknown) {
      return { cid: `bafyfake${createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 24)}` };
    }
  },
}));

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
const VOTE_END = 1784788677;

const GOV = new Interface([
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
]);
const SEL = {
  create: GOV.getFunction("createProposalAndVote")!.selector,
  deposit: GOV.getFunction("deposit")!.selector,
};

interface FakeChain {
  proposals: Array<{ descriptionURL: string; state: number; voteEnd: number }>;
  depositedPower: bigint;
  walletBalance: bigint;
  allowance: bigint;
}
let chain: FakeChain;

/** One `getProposals` row, nested exactly as `decodeProposalView` walks it. */
function proposalView(descriptionURL: string, state: number, voteEnd: number): unknown[] {
  const settings = [false, false, false, 0n, 0n, 0n, 51n * 10n ** 25n, 0n, 0n, 0n, [], ""];
  const core = [settings, BigInt(voteEnd), 0n, false, 0n, 0n, 0n, 0n, 0n];
  const proposal = [core, descriptionURL, [], []];
  const validatorProposal = [[false, 0n, 0n, 0n, 0n, 0n, 0n]];
  return [proposal, validatorProposal, state, 0n, 0n];
}

function routeCall(call: { method: string; args: readonly unknown[] }): unknown {
  switch (call.method) {
    case "getHelperContracts":
      return [SETTINGS, USER_KEEPER, VALIDATORS, GOV_POOL, GOV_POOL];
    case "tokenAddress":
      return TOKEN;
    case "getDefaultSettings":
      return { minVotesForCreating: 0n, minVotesForVoting: 0n };
    case "tokenBalance":
      return [chain.depositedPower, 0n];
    case "balanceOf":
      return chain.walletBalance;
    case "allowance":
      return chain.allowance;
    case "decimals":
      return 18n;
    case "symbol":
      return "TST";
    case "latestProposalId":
      return BigInt(chain.proposals.length);
    case "getProposals": {
      const [offset, limit] = call.args as [number, number];
      return chain.proposals
        .slice(Number(offset), Number(offset) + Number(limit))
        .map((p) => proposalView(p.descriptionURL, p.state, p.voteEnd));
    }
    case "descriptionURL":
      return "";
    default:
      return undefined;
  }
}

function installChainMock(failReads: string[] = []): void {
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string; args: readonly unknown[] }>) =>
    calls.map((c) => {
      if (failReads.includes(c.method)) {
        return { success: false, value: null, raw: "0x", error: "call reverted" };
      }
      const value = routeCall(c);
      return value === undefined
        ? { success: false, value: null, raw: "0x", error: "call reverted" }
        : { success: true, value: value as never, raw: "0x" };
    }),
  );
}

const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

function fakeSigner(onSend?: (data: string, index: number) => void) {
  const sent: string[] = [];
  const wallet = {
    address: USER,
    async sendTransaction(tx: { data: string }) {
      const index = sent.length;
      sent.push(tx.data);
      const hash = `0x${(index + 1).toString(16).padStart(64, "a")}`;
      return {
        hash,
        chainId: BigInt(CHAIN),
        async wait() {
          onSend?.(tx.data, index);
          return { status: 1, hash };
        },
      };
    },
  };
  const signer = {
    hasSigner: () => true,
    getAddress: () => USER,
    getConfig: () => GUARD_CFG,
    trySigner: () => ({ ok: wallet }),
    describeSigner: () => ({ signerKey: "primary", address: USER }),
    withBroadcastLock: (_c: number, task: () => Promise<unknown>) => task(),
  } as unknown as SignerManager;
  return { signer, sent };
}

const NO_WC = { isConfigured: () => false } as unknown as WalletConnectManager;

function envelope(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const texts = res.content.filter((c) => c.type === "text" && typeof c.text === "string");
  return JSON.parse(texts[texts.length - 1]!.text!) as Record<string, unknown>;
}

let ctx: ToolContext;
let rpc: RpcProvider;

beforeEach(async () => {
  const base = await loadConfig();
  ctx = { config: { ...base, pinataJwt: "test-jwt", treasuryGuard: "off" } } as unknown as ToolContext;
  rpc = new RpcProvider(ctx.config);
  chain = { proposals: [], depositedPower: 153000n * ONE, walletBalance: 0n, allowance: 0n };
  installChainMock();
});

const createInput = () => ({
  govPool: GOV_POOL,
  chainId: CHAIN,
  proposalType: "custom",
  title: "Fund the grants pool",
  description: "Move 10k from treasury to the grants multisig.",
  actionsOnFor: [{ executor: GOV_POOL, value: "0", data: "0xdeadbeef" }],
  voteNftIds: [],
  user: USER,
});

/** A signer whose landed create appends the new proposal, as a real chain does. */
function landingSigner() {
  let url = "";
  const s = fakeSigner((data) => {
    if (data.startsWith(SEL.create)) {
      const [decoded] = GOV.decodeFunctionData("createProposalAndVote", data);
      url = decoded as string;
      chain.proposals.push({ descriptionURL: url, state: 0, voteEnd: VOTE_END });
    }
  });
  return { ...s, url: () => url };
}

async function run(input = createInput(), signer?: SignerManager) {
  const s = signer ? { signer, sent: [] as string[] } : landingSigner();
  const res = (await runProposalCreate(input, { ctx, signer: s.signer, rpc, wc: NO_WC })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return { body: envelope(res), sent: s.sent };
}

describe("the auto-vote amount is disclosed", () => {
  it("omitting voteAmount votes the whole balance and says so", async () => {
    const { body } = await run();
    const autoVote = body.autoVote as Record<string, unknown>;
    expect(autoVote.allAvailablePower).toBe(true);
    expect(autoVote.amountWei).toBe("153000000000000000000000");
    expect(autoVote.amount).toBe("153000.0 TST");
    expect(String(autoVote.note)).toMatch(/ALL your available power/);
  });

  it("an explicit voteAmount is reported as such", async () => {
    const { body } = await run({ ...createInput(), voteAmount: "10.0" });
    const autoVote = body.autoVote as Record<string, unknown>;
    expect(autoVote.allAvailablePower).toBe(false);
    expect(autoVote.amountWei).toBe("10000000000000000000");
  });

  it("a falsy voteAmount takes the vote-everything branch and is reported as such", async () => {
    // The resolution branches on TRUTHINESS, so `""` defaults to all power.
    // `input.voteAmount === undefined` would have claimed a bounded vote here.
    const { body } = await run({ ...createInput(), voteAmount: "" });
    expect((body.autoVote as Record<string, unknown>).allAvailablePower).toBe(true);
  });

  it("the wire ledger names the amount, like the sibling vote step does", async () => {
    const { body } = await run();
    const steps = body.steps as Array<{ label: string }>;
    const create = steps.find((s) => s.label.startsWith("GovPool.createProposalAndVote"))!;
    expect(create.label).toContain("vote 153000.0 TST FOR");
  });

  it("nothing moved on the wire — the disclosure never touches calldata", async () => {
    const { sent } = await run();
    const create = sent.find((d) => d.startsWith(SEL.create))!;
    const [, , , voteAmount] = GOV.decodeFunctionData("createProposalAndVote", create);
    expect(voteAmount as bigint).toBe(153000n * ONE);
  });
});

describe("the deposit lock is warned about where it is CREATED, not only after execute", () => {
  it("names the real remedy and not the old myth", async () => {
    const { body } = await run();
    const advisories = body.advisories as Array<Record<string, string>>;
    expect(advisories[0]!.id).toBe("tokens-locked-after-execute");
    expect(advisories[0]!.text).toContain("dexe_vote_build_withdraw");
    expect(advisories[0]!.text).toContain("GovUK: can't withdraw this");
    // The lock does NOT stop you creating or voting elsewhere: lockTokens only
    // records a max, and _canVote checks the deposited balance, which locking
    // never reduces. Shipping that claim would put a falsehood in front of
    // every user.
    expect(advisories[0]!.text).not.toContain("No voting power available");
    expect(advisories[0]!.text).toMatch(/can still create and vote on OTHER proposals/i);
  });

  it("a dryRun says 'will be', never 'are now'", async () => {
    const { body } = await run({ ...createInput(), dryRun: true });
    const text = (body.advisories as Array<Record<string, string>>)[0]!.text;
    expect(text).toContain("will be locked");
    expect(text).not.toContain("are now locked");
    expect(text).toContain("NOTHING has been broadcast yet");
  });

  it("the warning precedes the act in the ledger", async () => {
    const { body } = await run();
    const labels = (body.steps as Array<{ label: string }>).map((s) => s.label);
    const warn = labels.indexOf("advisory:tokens-locked-after-execute");
    const act = labels.findIndex((l) => l.startsWith("GovPool.createProposalAndVote"));
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(warn).toBeLessThan(act);
  });
});

describe("the created proposal is named", () => {
  it("a successful create reports the id, the state and when voting ends", async () => {
    const { body } = await run();
    expect(body.proposalId).toBe(1);
    expect(body.proposalState).toBe("Voting");
    expect(body.votingEndsAtUnix).toBe(VOTE_END);
    expect(String(body.votingEndsAt)).toMatch(/^\d{4}-\d{2}-\d{2} .* UTC$/);
    const preview = body.preview as Record<string, unknown>;
    expect(String(preview.next)).toContain(
      `dexe_proposal_vote_and_execute {"govPool":"${GOV_POOL}","proposalId":1`,
    );
  });

  it("a create whose id cannot be read back still tells the caller how to find it", async () => {
    installChainMock(["getProposals"]);
    const { body } = await run(createInput(), fakeSigner().signer);
    expect(body.mode).toBe("executed");
    expect("proposalId" in body).toBe(false);
    const next = String((body.preview as Record<string, unknown>).next);
    expect(next).toContain("dexe_proposal_list");
    expect(next).toContain(String(body.descriptionURL));
    expect(next).toMatch(/Do NOT guess/);
  });

  it("a dryRun never claims anything landed", async () => {
    const { body } = await run({ ...createInput(), dryRun: true });
    expect("proposalId" in body).toBe(false);
    const preview = body.preview as Record<string, unknown>;
    expect(preview.broadcast).toBe(false);
    expect(String(preview.next)).toMatch(/NOTHING WAS BROADCAST \(dryRun\)/);
    expect(String(preview.next)).not.toMatch(/landed/);
  });

  it("allowDuplicate reports the NEW id, never the pre-existing copy", async () => {
    // The duplicate guard would suppress this create; allowDuplicate mints a
    // second copy on purpose. A lagging node returning the OLD row must not be
    // reported as "the one you just created" — a vote on the wrong proposal
    // cannot be undone in one call.
    const probe = await run({ ...createInput(), dryRun: true });
    chain.proposals = [{ descriptionURL: probe.body.descriptionURL as string, state: 0, voteEnd: VOTE_END }];
    const { body } = await run({ ...createInput(), allowDuplicate: true });
    expect(body.proposalId).toBe(2);
  });

  it("a lagging node reports NO id rather than the caller's earlier copy", async () => {
    const probe = await run({ ...createInput(), dryRun: true });
    chain.proposals = [{ descriptionURL: probe.body.descriptionURL as string, state: 0, voteEnd: VOTE_END }];
    // onSend appends nothing: the create landed, the node has not caught up.
    const { body } = await run({ ...createInput(), allowDuplicate: true }, fakeSigner().signer);
    expect("proposalId" in body).toBe(false);
  });
});

describe("the response stays backward compatible and affordable", () => {
  it("every pre-0.34.0 field is still there with the same shape", async () => {
    const { body } = await run();
    expect(body.mode).toBe("executed");
    expect(String(body.descriptionURL)).toMatch(/^ipfs:\/\//);
    expect(typeof body.proposalMetadataCID).toBe("string");
    expect(Array.isArray(body.steps)).toBe(true);
    const p = body.prereqs as Record<string, unknown>;
    for (const k of ["walletBalance", "depositedPower", "allowance", "minVotesForCreating", "tokenAddress"]) {
      expect(p, k).toHaveProperty(k);
    }
  });

  it("the 0.34.0 disclosure blocks cost under 1700 chars together", async () => {
    // A budget, so "one short sentence or one formatted number" stays the rule
    // for these fields in a later release. Measured on the blocks themselves
    // rather than the whole envelope: warnings/governanceAdvisories are
    // fixture-driven (this DAO's executor is codeless) and would let real
    // growth hide behind their noise.
    //
    // 1600 → 1700 in 0.34.1: the deposit-lock advisory's withdraw call now
    // carries `receiver` (an address) and `amount` (raw wei) — ~90 chars that
    // turn a call the tool's schema rejected into one that runs as pasted.
    const { body } = await run();
    const added = JSON.stringify({
      preview: body.preview,
      autoVote: body.autoVote,
      advisories: body.advisories,
    });
    expect(added.length).toBeLessThan(1700);
  });

  it("an executed create response stays under 4200 chars end to end", async () => {
    // ~1.1k of this fixture is the codeless-executor build warning, emitted
    // twice (warnings[] + the deprecated governanceAdvisories[]) because the
    // fixture points the action at the GovPool itself, which the offline mock
    // reports as having no code. A real proposal carries neither copy.
    const { body } = await run();
    expect(JSON.stringify(body).length).toBeLessThan(4200);
  });
});
