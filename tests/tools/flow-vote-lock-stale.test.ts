import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Interface } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── vote_and_execute: the post-quorum lock and the stale read ───────────────
 *
 * Two live-chain failures of the composite (testnet 97, agent-treasury demo):
 *
 * 1. The vote that reaches quorum leaves the proposal `Locked` IN THAT BLOCK —
 *    GovPoolView reports Locked while `block.timestamp <= executeAfter`, and
 *    executeAfter is the quorum block's own timestamp + executionDelay. So even
 *    with executionDelay 0 the composite read Locked, skipped execute, and the
 *    caller had to re-run. Now a lock that ends within seconds is waited out
 *    (bounded) and execute goes out; a longer lock gets a "re-run after" note.
 *
 * 2. A load-balanced RPC answers the read right after a receipt from a node one
 *    block behind — the pre-vote state. Every read now carries the block it was
 *    evaluated at (Multicall3 getBlockNumber in the same aggregate3), and a read
 *    from below the flow's last landed tx is retried.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));
vi.mock("../../src/lib/controllingVoters.js", () => ({
  resolveControllingHoldersVotedFor: async () => null,
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
import { registerFlowTools, FLOW_READ_TIMING } from "../../src/tools/flow.js";

const mc = vi.mocked(multicall);

const GOV_POOL = "0x1111111111111111111111111111111111111111";
const SETTINGS = "0x2222222222222222222222222222222222222222";
const USER_KEEPER = "0x3333333333333333333333333333333333333333";
const VALIDATORS = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
const USER = "0x000000000000000000000000000000000000dEaD";
const TESTNET = 97;
const ONE = 10n ** 18n;
const PCT = 10n ** 25n;

const GOV = new Interface([
  "function multicall(bytes[] data) returns (bytes[])",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function execute(uint256 proposalId)",
  "function moveProposalToValidators(uint256 proposalId)",
]);
const ERC20 = new Interface(["function approve(address,uint256)"]);
const SEL = {
  multicall: GOV.getFunction("multicall")!.selector,
  vote: GOV.getFunction("vote")!.selector,
  execute: GOV.getFunction("execute")!.selector,
  move: GOV.getFunction("moveProposalToValidators")!.selector,
  approve: ERC20.getFunction("approve")!.selector,
};

/** One aggregate3 answer: the proposal state AND the block it was evaluated at. */
interface Read {
  state: number;
  block?: number;
  ts?: number;
}

interface FakeChain {
  /** Successive reads, one per multicall that asks getProposalState; the last repeats. */
  reads: Read[];
  memberExecuteAfter: number;
  validatorExecuteAfter: number;
  deposited: bigint;
  wallet: bigint;
  allowance: bigint;
  /** Block number the next receipt reports. */
  nextReceiptBlock: number;
}

let chain: FakeChain;

function proposalView(): unknown[] {
  const settings = [false, false, false, 0n, 0n, 0n, 60n * PCT, 0n, 0n, 0n, [], ""];
  const core = [settings, 0n, BigInt(chain.memberExecuteAfter), false, 0n, 0n, 0n, 0n, 0n];
  const proposal = [core, "ipfs://meta", [], []];
  const validatorProposal = [[false, 0n, 0n, BigInt(chain.validatorExecuteAfter), 0n, 0n, 0n]];
  return [proposal, validatorProposal, 6, 0n, 0n];
}

function routeCall(method: string): unknown {
  switch (method) {
    case "getHelperContracts":
      return [SETTINGS, USER_KEEPER, VALIDATORS, GOV_POOL, GOV_POOL];
    case "tokenAddress":
      return TOKEN;
    case "getDefaultSettings":
      return { minVotesForCreating: 0n, minVotesForVoting: 0n };
    case "tokenBalance":
      return [chain.deposited, 0n];
    case "balanceOf":
      return chain.wallet;
    case "allowance":
      return chain.allowance;
    case "decimals":
      return 18n;
    case "symbol":
      return "TST";
    case "isValidator":
      return false;
    case "getUserVotes":
      return { isVoteFor: false, totalVoted: 0n, tokensVoted: 0n, totalRawVoted: 0n, nftsVoted: [] };
    case "getProposals":
      return [proposalView()];
    case "latestProposalId":
      return 1n;
    default:
      return undefined;
  }
}

let stateReads = 0;

function installChainMock(): void {
  let current: Read = { state: 0 };
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) => {
    if (calls.some((c) => c.method === "getProposalState")) {
      stateReads++;
      current = chain.reads.length > 1 ? chain.reads.shift()! : chain.reads[0]!;
    }
    return calls.map((c) => {
      const value =
        c.method === "getProposalState"
          ? current.state
          : c.method === "getBlockNumber"
            ? current.block === undefined ? undefined : BigInt(current.block)
            : c.method === "getCurrentBlockTimestamp"
              ? current.ts === undefined ? undefined : BigInt(current.ts)
              : routeCall(c.method);
      return value === undefined
        ? { success: false, value: null, raw: "0x", error: "call reverted" }
        : { success: true, value: value as never, raw: "0x" };
    });
  });
}

const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

function fakeSigner(): { signer: SignerManager; sent: string[] } {
  const sent: string[] = [];
  const wallet = {
    address: USER,
    async sendTransaction(tx: { data: string }) {
      const index = sent.length;
      sent.push(tx.data);
      const hash = `0x${(index + 1).toString(16).padStart(64, "a")}`;
      const blockNumber = chain.nextReceiptBlock++;
      return { hash, chainId: BigInt(TESTNET), async wait() { return { status: 1, hash, blockNumber }; } };
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

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function envelope(res: ToolResult): Record<string, any> {
  const texts = res.content.filter((c) => c.type === "text" && typeof c.text === "string");
  const last = texts[texts.length - 1]!.text!;
  try {
    return JSON.parse(last) as Record<string, any>;
  } catch {
    return { text: last }; // err() results are plain text
  }
}

let ctx: ToolContext;
const savedTiming = { ...FLOW_READ_TIMING };

beforeEach(async () => {
  const base = await loadConfig();
  ctx = { config: { ...base, pinataJwt: "test-jwt", treasuryGuard: "off", minSafeQuorumPct: 50 } } as unknown as ToolContext;
  chain = {
    reads: [{ state: 0 }],
    memberExecuteAfter: 0,
    validatorExecuteAfter: 0,
    deposited: 1000n * ONE,
    wallet: 0n,
    allowance: 0n,
    nextReceiptBlock: 101,
  };
  stateReads = 0;
  installChainMock();
  // Keep the retries/polls instant.
  Object.assign(FLOW_READ_TIMING, { staleBackoffMs: 1, lockPollMs: 1, lockMaxWaitMs: 300 });
});

afterEach(() => {
  Object.assign(FLOW_READ_TIMING, savedTiming);
});

async function voteAndExecute(over: Record<string, unknown> = {}) {
  const { signer, sent } = fakeSigner();
  const tools = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
  const fake = {
    tool: (name: string, _d: string, _s: unknown, cb: (i: Record<string, unknown>) => Promise<ToolResult>) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  registerFlowTools(fake, ctx as never, signer, NO_WC);
  const res = await tools.get("dexe_proposal_vote_and_execute")!({
    govPool: GOV_POOL,
    chainId: TESTNET,
    proposalId: 1,
    isVoteFor: true,
    voteNftIds: [],
    depositFirst: false,
    autoExecute: true,
    driveValidatorRound: true,
    dryRun: false,
    user: USER,
    ...over,
  });
  return { res, sent, body: envelope(res) };
}

const isVote = (d: string) => d.startsWith(SEL.multicall) || d.startsWith(SEL.vote);

// ═══════════════════════════════════════════════ next-block execute (fix 1)

describe("post-quorum Locked: wait for the next block, then execute", () => {
  it("member vote reaches quorum → Locked for 0 s → waits one block → executes", async () => {
    chain.memberExecuteAfter = 1003;
    chain.reads = [
      { state: 0, block: 100, ts: 1000 }, // entry
      { state: 6, block: 101, ts: 1003 }, // right after the vote (quorum block)
      { state: 6, block: 101, ts: 1003 }, // awaitUnlock: lock ends at 1003, 0 s away
      { state: 4, block: 102, ts: 1006 }, // next block: SucceededFor
    ];
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    expect(isVote(sent[0]!)).toBe(true);
    expect(sent[1]!.startsWith(SEL.execute)).toBe(true);
    expect(body.executed).toBe(true);
  });

  it("a long execution delay is NOT waited out — it says when to re-run", async () => {
    chain.memberExecuteAfter = 1003 + 3600;
    chain.reads = [
      { state: 0, block: 100, ts: 1000 },
      { state: 6, block: 101, ts: 1003 },
    ];
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1); // the vote only
    expect(body.executed).toBe(false);
    // previewBlock nests `next`; the note is the caller-facing next step.
    expect(JSON.stringify(body)).toContain("Re-run dexe_proposal_vote_and_execute");
    expect(JSON.stringify(body)).toContain(`unix ${1003 + 3600 + 1}`);
    const exec = (body.steps as Array<{ label: string; reason?: string }>).find((s) => s.label === "GovPool.execute");
    expect(exec?.reason).toContain("Locked by the execution delay");
  });

  it("entry state Locked with a short lock: no vote, waits, executes", async () => {
    chain.memberExecuteAfter = 1002;
    chain.reads = [
      { state: 6, block: 100, ts: 1000 }, // entry
      { state: 6, block: 100, ts: 1000 }, // awaitUnlock
      { state: 6, block: 101, ts: 1002 }, // still inside the lock (ts == executeAfter)
      { state: 4, block: 102, ts: 1005 },
    ];
    const { res, sent } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.execute)).toBe(true);
  });

  it("entry state Locked with a long lock: nothing broadcast, mode locked, re-run note", async () => {
    chain.memberExecuteAfter = 1000 + 86_400;
    chain.reads = [{ state: 6, block: 100, ts: 1000 }];
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toEqual([]);
    expect(body.mode).toBe("locked");
    expect(body.executeAfter).toBe(1000 + 86_400);
    expect(String(body.next)).toContain("Re-run");
  });

  it("validator path: the move leaves it Locked (validator executeAfter) → waits → executes", async () => {
    chain.validatorExecuteAfter = 1006;
    chain.reads = [
      { state: 1, block: 100, ts: 1000 }, // entry: WaitingForVotingTransfer
      { state: 1, block: 100, ts: 1000 }, // drive's first read
      { state: 6, block: 101, ts: 1006 }, // settled read after the move
      { state: 6, block: 101, ts: 1006 }, // awaitUnlock
      { state: 4, block: 102, ts: 1009 },
    ];
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.startsWith(SEL.move)).toBe(true);
    expect(sent[1]!.startsWith(SEL.execute)).toBe(true);
    expect(body.executed).toBe(true);
  });

  it("an unreadable lock end keeps the old behaviour (no wait, no execute on Locked)", async () => {
    chain.reads = [{ state: 0 }, { state: 6 }]; // no block/timestamp, executeAfter 0
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(body.executed).toBe(false);
    expect(body.proposalStateAfter).toBe("Locked");
  });
});

// ═══════════════════════════════════════════════════ stale-read guard (fix 2)

describe("stale-read guard", () => {
  it("a post-vote read from a node behind the vote's block is retried", async () => {
    chain.nextReceiptBlock = 200;
    chain.reads = [
      { state: 0, block: 199, ts: 1000 }, // entry
      { state: 0, block: 199, ts: 1000 }, // lagging node: has not seen block 200
      { state: 4, block: 200, ts: 1003 }, // caught up
    ];
    const { res, sent, body } = await voteAndExecute();
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.startsWith(SEL.execute)).toBe(true);
    expect(body.executed).toBe(true);
  });

  it("the vote is NOT sent when the state moved on between approve and vote", async () => {
    chain.deposited = 0n;
    chain.wallet = 1000n * ONE; // deposit-first: approve, then multicall(deposit, vote)
    chain.reads = [
      { state: 0, block: 100, ts: 1000 }, // entry
      { state: 3, block: 101, ts: 1003 }, // after the approve landed: Defeated
    ];
    const { res, sent, body } = await voteAndExecute({ depositFirst: "auto" });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.approve)).toBe(true);
    expect(body.mode).toBe("vote-not-sent");
    expect(body.proposalStateAfter).toBe("Defeated");
    expect(body.executed).toBe(false);
    const vote = (body.steps as Array<{ label: string; skipped?: boolean }>).find((s) => s.label === "GovPool.vote");
    expect(vote?.skipped).toBe(true);
  });

  it("the pre-vote re-read lets the vote through when the proposal is still Voting", async () => {
    chain.deposited = 0n;
    chain.wallet = 1000n * ONE;
    chain.reads = [
      { state: 0, block: 100, ts: 1000 },
      { state: 0, block: 101, ts: 1003 }, // still Voting after the approve
      { state: 4, block: 102, ts: 1006 }, // after the vote
    ];
    const { res, sent } = await voteAndExecute({ depositFirst: "auto" });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(3);
    expect(sent[0]!.startsWith(SEL.approve)).toBe(true);
    expect(isVote(sent[1]!)).toBe(true);
    expect(sent[2]!.startsWith(SEL.execute)).toBe(true);
  });

  it("zero GovPool power on a stale 'Voting' read: re-reads and routes by the fresh state", async () => {
    chain.deposited = 0n;
    chain.wallet = 0n; // e.g. a validator-only caller
    chain.reads = [
      { state: 0, block: 100, ts: 1000 }, // stale entry read
      { state: 4, block: 101, ts: 1003 }, // fresh: already passed
    ];
    const { res, sent } = await voteAndExecute({ depositFirst: "auto" });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.execute)).toBe(true);
  });

  it("zero power while truly Voting still fails with the clear message", async () => {
    chain.deposited = 0n;
    chain.wallet = 0n;
    chain.reads = [{ state: 0, block: 100, ts: 1000 }];
    const { res, sent, body } = await voteAndExecute({ depositFirst: "auto" });
    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(JSON.stringify(body)).toContain("No voting power available");
    expect(stateReads).toBeGreaterThan(1); // it did re-read before failing
  });
});
