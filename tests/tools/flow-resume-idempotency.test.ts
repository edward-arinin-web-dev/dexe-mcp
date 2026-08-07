import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { Interface } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── The resume ledger has to be TRUE, not just reassuring ───────────────────
 *
 * Every composite failure answers with "fix the cause and re-run this same call
 * — already-satisfied steps are detected on-chain and skipped automatically."
 * That was true for approve and deposit (both re-derived from chain state) and
 * FALSE for the two steps that actually move governance:
 *
 *   CREATE — nothing checked whether the create had landed, and GovPool does
 *            not dedupe `descriptionURL` (GovPoolCreate just assigns it). A
 *            re-run after a timed-out receipt minted a SECOND identical
 *            proposal: real gas, and a DAO voting on two copies of one thing.
 *
 *   VOTE   — `GovPoolVote._canVote` asserts `!_isVoted(voteInfo)`, so a second
 *            vote from the same wallet reverts "Gov: need cancel". A re-run
 *            burned gas on a guaranteed revert AND could never reach the
 *            execute step queued behind the vote.
 *
 * And a receipt-wait TIMEOUT is not a failed step at all — the transaction was
 * broadcast. "Re-run" there is an instruction to double-send.
 *
 * These tests drive the real composites with every RPC read faked, so each
 * claim is checked against what the flow would actually put on the wire.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

// PinataClient is the only other network dependency in the create path. The
// fake CID is a hash of the pinned JSON, so "the same call re-derives the same
// descriptionURL" — the property the whole duplicate guard rests on — is
// exercised rather than assumed.
vi.mock("../../src/lib/ipfs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipfs.js")>()),
  PinataClient: class {
    async pinJson(obj: unknown) {
      return { cid: `bafyfake${createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 24)}` };
    }
  },
}));

// W10's registered-GovPool probe is a live eth_call. Make the registry
// unresolvable so `assertRegisteredGovPool` takes its documented
// "cannot verify → proceed" branch instead of hitting the network.
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
import {
  runProposalCreate,
  registerFlowTools,
  findLiveProposalByDescriptionURL,
  readPriorVote,
  broadcastTimeout,
  timeoutResume,
  RESUME_RECHECKS,
} from "../../src/tools/flow.js";

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
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function execute(uint256 proposalId)",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
]);
const SEL = {
  create: GOV.getFunction("createProposalAndVote")!.selector,
  multicall: GOV.getFunction("multicall")!.selector,
  execute: GOV.getFunction("execute")!.selector,
  deposit: GOV.getFunction("deposit")!.selector,
};

// ---------------------------------------------------------------- fake chain

/** Mutable chain state the multicall router answers from. */
interface FakeChain {
  proposals: Array<{ descriptionURL: string; state: number }>;
  /** Successive getProposalState answers; the last one repeats. */
  proposalStates: number[];
  depositedPower: bigint;
  walletBalance: bigint;
  allowance: bigint;
  userVote: { isVoteFor: boolean; tokensVoted: bigint; totalVoted: bigint; nftsVoted: bigint[] } | null;
}

let chain: FakeChain;

/**
 * One element of the `getProposals` return, nested exactly as
 * `decodeProposalView` walks it (proposal → core → settings). Only the fields
 * the decoder reads carry meaning.
 */
function proposalView(descriptionURL: string, state: number): unknown[] {
  const settings = [false, false, false, 0n, 0n, 0n, 51n * 10n ** 25n, 0n, 0n, 0n, [], ""];
  const core = [settings, 0n, 0n, false, 0n, 0n, 0n, 0n, 0n];
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
      // [balance, ownedBalance] — deposited power is their difference.
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
        .map((p) => proposalView(p.descriptionURL, p.state));
    }
    case "getUserVotes":
      return (
        chain.userVote ?? { isVoteFor: false, totalVoted: 0n, tokensVoted: 0n, totalRawVoted: 0n, nftsVoted: [] }
      );
    case "getProposalState":
      return chain.proposalStates.length > 1
        ? chain.proposalStates.shift()
        : (chain.proposalStates[0] ?? 0);
    case "descriptionURL":
      return "";
    default:
      return undefined;
  }
}

function installChainMock(): void {
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string; args: readonly unknown[] }>) =>
    calls.map((c) => {
      const value = routeCall(c);
      return value === undefined
        ? { success: false, value: null, raw: "0x", error: "call reverted" }
        : { success: true, value: value as never, raw: "0x" };
    }),
  );
}

// --------------------------------------------------------------- fake signer

/**
 * Config handed to the BROADCAST guards only. Deliberately RPC-less so B11's
 * `getCode` probe takes its fail-open branch offline; the read path uses the
 * real config via `deps.rpc`.
 */
const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

interface FakeSigner {
  signer: SignerManager;
  /** calldata of every transaction the flow actually broadcast, in order. */
  sent: string[];
}

/** `onSend` may mutate the fake chain (a landed deposit) or throw (a failure). */
function fakeSigner(onSend?: (data: string, index: number) => void | never): FakeSigner {
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

/** The JSON envelope of a flow response (last text block; QR blocks lead). */
function envelope(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const texts = res.content.filter((c) => c.type === "text" && typeof c.text === "string");
  const last = texts[texts.length - 1]!;
  return JSON.parse(last.text!) as Record<string, unknown>;
}

let ctx: ToolContext;
let rpc: RpcProvider;

beforeEach(async () => {
  const base = await loadConfig();
  ctx = { config: { ...base, pinataJwt: "test-jwt", treasuryGuard: "off" } } as unknown as ToolContext;
  rpc = new RpcProvider(ctx.config);
  chain = {
    proposals: [],
    proposalStates: [0],
    depositedPower: 1000n * ONE,
    walletBalance: 0n,
    allowance: 0n,
    userVote: null,
  };
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

// ═══════════════════════════════════════════════════ finding A — create leg

describe("create leg is idempotent across a re-run", () => {
  it("a re-run after a mid-flow failure does NOT create a second proposal", async () => {
    // Run 1: the create is broadcast and its receipt wait times out — the tx is
    // in flight, the caller sees a failure.
    const first = fakeSigner((data) => {
      if (data.startsWith(SEL.create)) {
        throw new Error(
          "Transaction 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was broadcast " +
            "but not mined within 180s — it may still land.",
        );
      }
    });
    const res1 = (await runProposalCreate(createInput(), {
      ctx,
      signer: first.signer,
      rpc,
      wc: NO_WC,
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(res1.isError).toBe(true);
    const body1 = envelope(res1);
    const descriptionURL = body1.descriptionURL as string;
    expect(descriptionURL).toMatch(/^ipfs:\/\/bafyfake/);
    expect(first.sent.filter((d) => d.startsWith(SEL.create))).toHaveLength(1);

    // …and it DID land. This is the exact state the old ledger mishandled.
    chain.proposals.push({ descriptionURL, state: 0 });

    // Run 2: identical call, as the failure text instructs.
    const second = fakeSigner();
    const res2 = (await runProposalCreate(createInput(), {
      ctx,
      signer: second.signer,
      rpc,
      wc: NO_WC,
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    expect(second.sent).toEqual([]); // ← the whole point: no duplicate, no gas
    const body2 = envelope(res2);
    expect(body2.mode).toBe("already-created");
    expect(body2.proposalId).toBe(1);
    expect(body2.descriptionURL).toBe(descriptionURL);
    expect(String(body2.note)).toMatch(/NOTHING WAS BROADCAST/);
    expect(String(body2.note)).toContain("dexe_proposal_vote_and_execute");
  });

  it("still creates when no live proposal carries this metadata URL", async () => {
    chain.proposals.push({ descriptionURL: "ipfs://something-else", state: 0 });
    const { signer, sent } = fakeSigner();
    const res = (await runProposalCreate(createInput(), { ctx, signer, rpc, wc: NO_WC })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(sent.filter((d) => d.startsWith(SEL.create))).toHaveLength(1);
    expect(envelope(res).mode).toBe("executed");
  });

  it("re-proposing something already Defeated or Executed is allowed", async () => {
    // Probe the URL this input pins by running once against an empty chain.
    const probe = fakeSigner();
    const url = envelope(
      (await runProposalCreate(createInput(), { ctx, signer: probe.signer, rpc, wc: NO_WC })) as never,
    ).descriptionURL as string;

    for (const deadState of [3, 7, 8]) {
      chain.proposals = [{ descriptionURL: url, state: deadState }];
      const { signer, sent } = fakeSigner();
      await runProposalCreate(createInput(), { ctx, signer, rpc, wc: NO_WC });
      expect(sent.filter((d) => d.startsWith(SEL.create)), `state ${deadState}`).toHaveLength(1);
    }
  });

  it("allowDuplicate:true mints the second copy on purpose", async () => {
    const probe = fakeSigner();
    const url = envelope(
      (await runProposalCreate(createInput(), { ctx, signer: probe.signer, rpc, wc: NO_WC })) as never,
    ).descriptionURL as string;
    chain.proposals = [{ descriptionURL: url, state: 0 }];

    const blocked = fakeSigner();
    await runProposalCreate(createInput(), { ctx, signer: blocked.signer, rpc, wc: NO_WC });
    expect(blocked.sent).toEqual([]);

    const forced = fakeSigner();
    await runProposalCreate({ ...createInput(), allowDuplicate: true }, {
      ctx,
      signer: forced.signer,
      rpc,
      wc: NO_WC,
    });
    expect(forced.sent.filter((d) => d.startsWith(SEL.create))).toHaveLength(1);
  });

  it("a read failure fails SOFT — the create still goes out", async () => {
    // A duplicate that cannot be confirmed must never block a legitimate create.
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string; args: readonly unknown[] }>) =>
      calls.map((c) => {
        if (c.method === "latestProposalId" || c.method === "getProposals") {
          return { success: false, value: null, raw: "0x", error: "call reverted" };
        }
        const value = routeCall(c);
        return value === undefined
          ? { success: false, value: null, raw: "0x", error: "call reverted" }
          : { success: true, value: value as never, raw: "0x" };
      }),
    );
    const { signer, sent } = fakeSigner();
    await runProposalCreate(createInput(), { ctx, signer, rpc, wc: NO_WC });
    expect(sent.filter((d) => d.startsWith(SEL.create))).toHaveLength(1);
  });
});

describe("findLiveProposalByDescriptionURL", () => {
  const provider = {} as never;

  it("maps the scan window back to 1-indexed proposal ids", async () => {
    chain.proposals = Array.from({ length: 30 }, (_, i) => ({
      descriptionURL: `ipfs://p${i + 1}`,
      state: 0,
    }));
    // Default scan window is the last 20 → ids 11..30.
    expect(await findLiveProposalByDescriptionURL(provider, GOV_POOL, "ipfs://p30")).toMatchObject({
      proposalId: 30,
    });
    expect(await findLiveProposalByDescriptionURL(provider, GOV_POOL, "ipfs://p11")).toMatchObject({
      proposalId: 11,
    });
    // Older than the window — reported as absent, which fails open (a create).
    expect(await findLiveProposalByDescriptionURL(provider, GOV_POOL, "ipfs://p10")).toBeNull();
  });

  it("returns null on an empty pool and on an empty URL", async () => {
    expect(await findLiveProposalByDescriptionURL(provider, GOV_POOL, "ipfs://x")).toBeNull();
    chain.proposals = [{ descriptionURL: "ipfs://x", state: 0 }];
    expect(await findLiveProposalByDescriptionURL(provider, GOV_POOL, "")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════ finding A — vote leg

/** Capture the flow tools without standing up a real MCP server. */
function captureFlowTools(signer: SignerManager) {
  const tools = new Map<string, (input: Record<string, unknown>) => Promise<never>>();
  const fake = {
    tool: (name: string, _d: string, _s: unknown, cb: (i: Record<string, unknown>) => Promise<never>) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  registerFlowTools(fake, ctx, signer, NO_WC);
  return tools;
}

const voteInput = (over: Record<string, unknown> = {}) => ({
  govPool: GOV_POOL,
  chainId: CHAIN,
  proposalId: 1,
  isVoteFor: true,
  voteNftIds: [],
  depositFirst: "auto",
  autoExecute: false,
  driveValidatorRound: true,
  dryRun: false,
  user: USER,
  ...over,
});

describe("vote leg is idempotent across a re-run", () => {
  it("a re-run after a landed vote does NOT double-vote", async () => {
    chain.userVote = { isVoteFor: true, tokensVoted: 1000n * ONE, totalVoted: 1000n * ONE, nftsVoted: [] };
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput());

    expect(sent).toEqual([]); // GovPool would have reverted "Gov: need cancel"
    const body = envelope(res as never);
    expect(body.mode).toBe("already-voted");
    expect(String(body.voteAlreadyCast)).toMatch(/already voted/i);
    expect(String(body.voteAlreadyCast)).toMatch(/Gov: need cancel/);
    const steps = body.steps as Array<{ label: string; skipped: boolean }>;
    expect(steps.find((s) => s.label === "GovPool.vote")?.skipped).toBe(true);
  });

  it("votes normally when this wallet has NOT voted (guard does not over-fire)", async () => {
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.multicall)).toBe(true);
    const [calls] = GOV.decodeFunctionData("multicall", sent[0]!);
    expect(GOV.decodeFunctionData("vote", (calls as string[])[0]!)[0]).toBe(1n);
    expect(envelope(res as never).mode).toBe("executed");
  });

  it("skips the funding deposit too — it exists only to pay for the skipped vote", async () => {
    chain.userVote = { isVoteFor: true, tokensVoted: 1000n * ONE, totalVoted: 1000n * ONE, nftsVoted: [] };
    chain.walletBalance = 500n * ONE; // 'auto' would otherwise deposit the shortfall
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput());
    expect(sent).toEqual([]);
    const steps = envelope(res as never).steps as Array<{ label: string; reason?: string }>;
    expect(steps.find((s) => s.label === "GovPool.deposit")?.reason).toMatch(/only to fund it/);
  });

  it("warns — and still sends nothing — when the requested vote differs from the one on-chain", async () => {
    chain.userVote = { isVoteFor: true, tokensVoted: 1000n * ONE, totalVoted: 1000n * ONE, nftsVoted: [] };
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(
      voteInput({ isVoteFor: false }),
    );
    expect(sent).toEqual([]);
    const advisory = String(envelope(res as never).voteChangeAdvisory);
    expect(advisory).toMatch(/was NOT applied/);
    expect(advisory).toContain("dexe_vote_build_cancel_vote (needs DEXE_TOOLSETS=core,vote)");
    // The harm the user must weigh BEFORE cancelling, not after.
    expect(advisory).toMatch(/HARM WARNING/);
    expect(advisory).toMatch(/below\s+quorum/);
  });

  it("carries a re-run through to EXECUTE instead of reverting on the vote", async () => {
    // The regression that made the old behavior expensive: the vote landed, the
    // execute did not, and every re-run died on "Gov: need cancel" before it.
    chain.userVote = { isVoteFor: true, tokensVoted: 1000n * ONE, totalVoted: 1000n * ONE, nftsVoted: [] };
    chain.proposalStates = [0, 4]; // Voting on entry, SucceededFor after the (skipped) vote
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(
      voteInput({ autoExecute: true }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.execute)).toBe(true);
    expect(sent.some((d) => d.startsWith(SEL.multicall))).toBe(false);
    expect(envelope(res as never).executed).toBe(true);
  });

  it("a resumed NFT-only voter is not rejected for holding zero tokens", async () => {
    // The vote-amount guards protect the vote about to be sent. When no vote
    // will be sent they must not fail the call over an amount nobody will use —
    // an NFT-only voter has 0 token power and would hit "No voting power
    // available" on every single re-run.
    chain.depositedPower = 0n;
    chain.walletBalance = 0n;
    chain.userVote = { isVoteFor: true, tokensVoted: 0n, totalVoted: 5n * ONE, nftsVoted: [7n] };
    const { signer, sent } = fakeSigner();
    const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput());
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(sent).toEqual([]);
    const body = envelope(res as never);
    expect(body.mode).toBe("already-voted");
    expect(String(body.voteAlreadyCast)).toContain("1 NFT(s)");
    expect(body.voteChangeAdvisory).toBeUndefined();
  });

  it("a read failure fails SOFT — the vote still goes out", async () => {
    mc.mockImplementation(async (_p: never, calls: Array<{ method: string; args: readonly unknown[] }>) =>
      calls.map((c) => {
        if (c.method === "getUserVotes") {
          return { success: false, value: null, raw: "0x", error: "call reverted" };
        }
        const value = routeCall(c);
        return value === undefined
          ? { success: false, value: null, raw: "0x", error: "call reverted" }
          : { success: true, value: value as never, raw: "0x" };
      }),
    );
    const { signer, sent } = fakeSigner();
    await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.multicall)).toBe(true);
  });
});

describe("readPriorVote", () => {
  const provider = {} as never;

  it("reports not-voted for a fresh voter", async () => {
    expect(await readPriorVote(provider, GOV_POOL, 1, USER)).toMatchObject({ voted: false });
  });

  it("counts an NFT-only vote as voted", async () => {
    chain.userVote = { isVoteFor: false, tokensVoted: 0n, totalVoted: 0n, nftsVoted: [7n] };
    expect(await readPriorVote(provider, GOV_POOL, 1, USER)).toMatchObject({ voted: true, nftCount: 1 });
  });

  it("returns null (not a false negative) when the read fails", async () => {
    mc.mockResolvedValue([{ success: false, value: null, raw: "0x", error: "call reverted" }] as never);
    expect(await readPriorVote(provider, GOV_POOL, 1, USER)).toBeNull();
  });
});

// ═══════════════════════════════════════════════ finding A — timeout resume

describe("a timed-out step is told to CHECK, never to re-run", () => {
  const TIMEOUT_MSG =
    "Transaction 0xabc1230000000000000000000000000000000000000000000000000000000000 was broadcast " +
    "but not mined within 180s — it may still land.";

  it("recognizes the receipt-wait timeout and pulls out the hash", () => {
    expect(broadcastTimeout(new Error(TIMEOUT_MSG))).toEqual({
      txHash: "0xabc1230000000000000000000000000000000000000000000000000000000000",
    });
    expect(broadcastTimeout(Object.assign(new Error("stalled"), { code: "TIMEOUT" }))).toEqual({});
    expect(broadcastTimeout(new Error("execution reverted"))).toBeNull();
    expect(broadcastTimeout(new Error("insufficient funds for gas"))).toBeNull();
  });

  it("the timeout resume points at dexe_tx_status and refuses to advise a re-run", () => {
    const text = timeoutResume("GovPool.execute(3)", 97, [], "0xfeed");
    expect(text).toMatch(/DO NOT re-run this call yet/);
    expect(text).toContain("dexe_tx_status");
    expect(text).toContain('"chainId":97');
    // The generic advice must not survive here — it is what caused double-sends.
    expect(text).not.toContain("Fix the cause above and re-run");
  });

  it("a real composite failure on a timeout carries the status-check resume", async () => {
    const { signer } = fakeSigner((data) => {
      if (data.startsWith(SEL.create)) throw new Error(TIMEOUT_MSG);
    });
    const res = (await runProposalCreate(createInput(), { ctx, signer, rpc, wc: NO_WC })) as never;
    const failure = envelope(res).failure as { resume: string };
    expect(failure.resume).toMatch(/DO NOT re-run this call yet/);
    expect(failure.resume).toContain("dexe_tx_status");
    expect(failure.resume).toContain("0xabc1230000000000000000000000000000000000000000000000000000000000");
    expect(failure.resume).not.toContain("Fix the cause above and re-run");
  });

  it("a NON-timeout failure keeps the re-run advice", async () => {
    const { signer } = fakeSigner((data) => {
      if (data.startsWith(SEL.create)) throw new Error("insufficient funds for gas");
    });
    const res = (await runProposalCreate(createInput(), { ctx, signer, rpc, wc: NO_WC })) as never;
    const failure = envelope(res).failure as { resume: string };
    expect(failure.resume).toContain("Fix the cause above and re-run this same call");
    expect(failure.resume).not.toMatch(/DO NOT re-run/);
  });
});

// ═══════════════════════════════════════════════ finding A — honest wording

describe("the resume string enumerates instead of generalizing", () => {
  it("names every step that is genuinely auto-skipped", () => {
    for (const step of ["ERC20.approve", "GovPool.deposit", "createProposalAndVote", "GovPool.vote"]) {
      expect(RESUME_RECHECKS).toContain(step);
    }
  });

  it("names the steps that are NOT auto-skipped, and where to look first", () => {
    expect(RESUME_RECHECKS).toMatch(/NOT auto-skipped/);
    expect(RESUME_RECHECKS).toContain("GovPool.execute");
    expect(RESUME_RECHECKS).toContain("moveProposalToValidators");
    expect(RESUME_RECHECKS).toContain("dexe_proposal_state");
  });

  it("does not repeat the blanket claim that made the ledger untrustworthy", () => {
    // The old text: "already-satisfied steps (approve / deposit / vote) are
    // detected on-chain and skipped automatically" — true for two of three.
    expect(RESUME_RECHECKS).not.toMatch(/skipped automatically/);
  });
});
