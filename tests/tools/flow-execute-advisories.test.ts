import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Interface } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── The path that spends the gas has to carry the warnings ──────────────────
 *
 * `dexe_vote_build_execute` only RETURNS calldata, and it carried both the #36
 * execute trap and the deposit-lock warning. `dexe_proposal_vote_and_execute`
 * BROADCASTS `GovPool.execute` — from three different places — and carried
 * neither, while the server instructions tell agents to prefer the composite.
 * The warning was on the path nobody is told to take.
 *
 * And the treasury guard computed its advisory, pushed it into `skippedSteps`
 * and called `sendOrCollect` in the same breath, so the advisory arrived after
 * the irreversible act — which is the original finding verbatim.
 *
 * Both are fixed in ONE funnel (`executeProposal`), because 0.32.0 shipped a
 * guard that a second entrypoint walked straight past. These tests drive the
 * real composite with every RPC read faked, and check the three execute
 * entrypoints — direct (already-passed), validator-driven, and post-vote —
 * against what actually goes on the wire.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

// The controlling-holder participation signal is a subgraph round-trip. Pin it
// to "unknown" so every assertion here is about the quorum reason alone.
vi.mock("../../src/lib/controllingVoters.js", () => ({
  resolveControllingHoldersVotedFor: async () => null,
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
import { registerFlowTools } from "../../src/tools/flow.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";
import { POST_EXECUTE_LOCK_ADVISORY, executeAddSettingsAdvisory } from "../../src/lib/protocolAdvisories.js";

const mc = vi.mocked(multicall);

const GOV_POOL = "0x1111111111111111111111111111111111111111";
const SETTINGS = "0x2222222222222222222222222222222222222222";
const USER_KEEPER = "0x3333333333333333333333333333333333333333";
const VALIDATORS = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
const GRANTEE = "0x6666666666666666666666666666666666666666";
const USER = "0x000000000000000000000000000000000000dEaD";
const TESTNET = 97;
const MAINNET = 56;
const ONE = 10n ** 18n;

const GOV = new Interface([
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function execute(uint256 proposalId)",
  "function moveProposalToValidators(uint256 proposalId)",
]);
const SEL = {
  multicall: GOV.getFunction("multicall")!.selector,
  execute: GOV.getFunction("execute")!.selector,
  move: GOV.getFunction("moveProposalToValidators")!.selector,
};

/** An ERC20 transfer out of the DAO treasury — what `classifyTreasuryActions` hunts for. */
const TREASURY_ACTION: [string, bigint, string] = [
  TOKEN,
  0n,
  new Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [GRANTEE, 10n * ONE]),
];
/** Moves nothing: the guard must stay silent on it. */
const BENIGN_ACTION: [string, bigint, string] = [
  GOV_POOL,
  0n,
  new Interface(["function setLatestVotePower(uint256)"]).encodeFunctionData("setLatestVotePower", [1n]),
];

const PCT = 10n ** 25n; // 1% of the 1e27 quorum scale

// ---------------------------------------------------------------- fake chain

interface FakeChain {
  /** Successive getProposalState answers; the last one repeats. */
  proposalStates: number[];
  actionsOnFor: Array<[string, bigint, string]>;
  quorumRaw: bigint;
  /** When true, getProposals reverts — the fail-soft path. */
  proposalsRevert: boolean;
}

let chain: FakeChain;

function proposalView(): unknown[] {
  const settings = [false, false, false, 0n, 0n, 0n, chain.quorumRaw, 0n, 0n, 0n, [], ""];
  const core = [settings, 0n, 0n, false, 0n, 0n, 0n, 0n, 0n];
  const proposal = [core, "ipfs://meta", chain.actionsOnFor, []];
  const validatorProposal = [[false, 0n, 0n, 0n, 0n, 0n, 0n]];
  return [proposal, validatorProposal, 4, 0n, 0n];
}

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
      return 1000n * ONE;
    case "allowance":
      return 0n;
    case "decimals":
      return 18n;
    case "symbol":
      return "TST";
    case "isValidator":
      return true;
    case "govValidatorsToken":
      return TOKEN;
    case "getUserVotes":
      return { isVoteFor: false, totalVoted: 0n, tokensVoted: 0n, totalRawVoted: 0n, nftsVoted: [] };
    case "getProposals":
      return chain.proposalsRevert ? undefined : [proposalView()];
    case "getProposalState":
      return chain.proposalStates.length > 1 ? chain.proposalStates.shift() : (chain.proposalStates[0] ?? 4);
    case "latestProposalId":
      return 1n;
    default:
      return undefined;
  }
}

function installChainMock(): void {
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
    calls.map((c) => {
      const value = routeCall(c);
      return value === undefined
        ? { success: false, value: null, raw: "0x", error: "call reverted" }
        : { success: true, value: value as never, raw: "0x" };
    }),
  );
}

// --------------------------------------------------------------- fake signer

const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

/** `onSend` may throw to simulate a reverted step. */
function fakeSigner(onSend?: (data: string) => void): { signer: SignerManager; sent: string[] } {
  const sent: string[] = [];
  const wallet = {
    address: USER,
    async sendTransaction(tx: { data: string }) {
      const index = sent.length;
      sent.push(tx.data);
      const hash = `0x${(index + 1).toString(16).padStart(64, "a")}`;
      return { hash, chainId: BigInt(TESTNET), async wait() { onSend?.(tx.data); return { status: 1, hash }; } };
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
  return JSON.parse(texts[texts.length - 1]!.text!) as Record<string, any>;
}

/** Capture the flow tools without standing up a real MCP server. */
function captureFlowTools(signer: SignerManager) {
  const tools = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
  const fake = {
    tool: (name: string, _d: string, _s: unknown, cb: (i: Record<string, unknown>) => Promise<ToolResult>) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  registerFlowTools(fake, ctx, signer, NO_WC);
  return tools;
}

let ctx: ToolContext;
let savedGuard: string | undefined;

beforeEach(async () => {
  const base = await loadConfig();
  ctx = {
    config: { ...base, pinataJwt: "test-jwt", treasuryGuard: "warn", minSafeQuorumPct: 50 },
  } as unknown as ToolContext;
  chain = {
    proposalStates: [4],
    actionsOnFor: [TREASURY_ACTION],
    quorumRaw: 5n * PCT, // 5% — well below the 50% safe floor
    proposalsRevert: false,
  };
  installChainMock();
  savedGuard = process.env.DEXE_TREASURY_GUARD;
  delete process.env.DEXE_TREASURY_GUARD;
});

afterEach(() => {
  if (savedGuard === undefined) delete process.env.DEXE_TREASURY_GUARD;
  else process.env.DEXE_TREASURY_GUARD = savedGuard;
});

const voteInput = (over: Record<string, unknown> = {}) => ({
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

async function voteAndExecute(over: Record<string, unknown> = {}, onSend?: (data: string) => void) {
  const { signer, sent } = fakeSigner(onSend);
  const res = await captureFlowTools(signer).get("dexe_proposal_vote_and_execute")!(voteInput(over));
  return { res, sent, body: envelope(res) };
}

/** Position of a step in the response ledger, by label prefix. -1 when absent. */
function stepIndex(body: Record<string, any>, label: string): number {
  return (body.steps as Array<{ label: string }>).findIndex((s) => s.label.startsWith(label));
}

// ══════════════════════════════════ the advisory arrives BEFORE the broadcast

describe("treasury guard on the composite execute path (MEDIUM-1)", () => {
  it("warn: the advisory is in the response, ordered BEFORE the execute step, and the tx still goes", async () => {
    const { res, sent, body } = await voteAndExecute();

    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.execute)).toBe(true);

    // Delivered, not narrated: it names the failing check and the value move.
    expect(body.treasuryRisk).toContain("quorum=5%");
    expect(body.treasuryRisk).toContain("moves treasury value");

    // …and it sits ahead of the act in the ledger.
    const advisory = stepIndex(body, "treasury-risk");
    const execute = stepIndex(body, "GovPool.execute");
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(execute).toBeGreaterThan(advisory);
  });

  it("block: a treasury-moving execute is REFUSED and nothing is broadcast", async () => {
    process.env.DEXE_TREASURY_GUARD = "block";
    const { res, sent, body } = await voteAndExecute();

    expect(sent).toEqual([]); // ← the whole point
    expect(res.isError).toBe(true);
    expect(body.mode).toBe("blocked-treasury");
    expect(body.refusal).toContain("Refusing");
    expect(body.refusal).toContain("GovPool.execute(1)");
    expect(body.refusal).toContain("Nothing was broadcast");
    // block is not a dead end — the way out is named.
    expect(body.refusal).toContain("DEXE_TREASURY_GUARD=warn");
    // block ⊃ warn: the advisory is produced too.
    expect(body.treasuryRisk).toContain("quorum=5%");
    expect(String(body.next)).toContain("NOTHING was broadcast");
  });

  it("block does NOT refuse an execute whose safety checks pass", async () => {
    process.env.DEXE_TREASURY_GUARD = "block";
    chain.quorumRaw = 60n * PCT; // above the 50% floor → no failing reason
    const { sent, body } = await voteAndExecute();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(SEL.execute)).toBe(true);
    // Still worth saying out loud that value moves.
    expect(body.treasuryRisk).toContain("moves treasury value");
  });

  it("block stays out of the way when the proposal moves no treasury value", async () => {
    process.env.DEXE_TREASURY_GUARD = "block";
    chain.actionsOnFor = [BENIGN_ACTION];
    const { sent, body } = await voteAndExecute();
    expect(sent).toHaveLength(1);
    expect(body.treasuryRisk).toBeUndefined();
  });

  it("off silences the treasury advisory entirely (opt-out stays honoured)", async () => {
    process.env.DEXE_TREASURY_GUARD = "off";
    const { sent, body } = await voteAndExecute();
    expect(sent).toHaveLength(1);
    expect(body.treasuryRisk).toBeUndefined();
  });

  it("a failed risk read fails SOFT — it says so, and the execute still goes out", async () => {
    chain.proposalsRevert = true;
    const { sent, body } = await voteAndExecute();
    expect(sent).toHaveLength(1);
    // "No advisory" must never be mistakeable for "no risk".
    expect(body.treasuryRisk).toContain("treasury-risk pre-check skipped");
  });

  it("block cannot be reached through the config field alone — the env var decides", async () => {
    // config.ts only models off|warn, so `block` would be lost if the flow read
    // ctx.config.treasuryGuard directly.
    ctx = { config: { ...ctx.config, treasuryGuard: "warn" } } as unknown as ToolContext;
    process.env.DEXE_TREASURY_GUARD = "block";
    const { sent } = await voteAndExecute();
    expect(sent).toEqual([]);
  });
});

// ═════════════════════════ the composite carries what the build-only tool does

describe("execute-time advisories on the gas-spending path (HIGH-2)", () => {
  it("chain 97 carries #36 and the deposit lock", async () => {
    const { body } = await voteAndExecute();
    const ids = (body.advisories as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["#36", "tokens-locked-after-execute"]);
    const text = (body.advisories as Array<{ text: string }>).map((a) => a.text).join("\n");
    expect(text).toContain("addSettings");
    expect(text).toContain("withdraw");
  });

  it("chain 56 drops the chain-scoped #36 and keeps the deposit lock", async () => {
    const { body } = await voteAndExecute({ chainId: MAINNET });
    const ids = (body.advisories as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["tokens-locked-after-execute"]);
  });

  it("every advisory is in the ledger BEFORE the execute step", async () => {
    const { body } = await voteAndExecute();
    const execute = stepIndex(body, "GovPool.execute");
    for (const a of body.advisories as Array<{ id: string }>) {
      const i = stepIndex(body, `advisory:${a.id}`);
      expect(i, a.id).toBeGreaterThanOrEqual(0);
      expect(i, a.id).toBeLessThan(execute);
    }
  });

  it("the advisories are the SAME ones dexe_vote_build_execute returns", async () => {
    const { body } = await voteAndExecute();
    const composite = (body.advisories as Array<{ text: string }>).map((a) => a.text);

    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerVoteBuildTools(server, ctx);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    let buildText: string;
    try {
      const r = (await client.callTool({
        name: "dexe_vote_build_execute",
        arguments: { govPool: GOV_POOL, proposalId: "1", chainId: TESTNET },
      })) as unknown as ToolResult;
      buildText = r.content.map((c) => c.text ?? "").join("\n");
    } finally {
      await client.close();
      await server.close();
    }

    expect(composite).toHaveLength(2);
    for (const text of composite) expect(buildText).toContain(text);
  });

  it("the advisories do not depend on the treasury guard being on", async () => {
    // They warn about upstream protocol defects, not about treasury policy.
    process.env.DEXE_TREASURY_GUARD = "off";
    const { body } = await voteAndExecute();
    expect((body.advisories as Array<{ id: string }>).map((a) => a.id)).toEqual([
      "#36",
      "tokens-locked-after-execute",
    ]);
    expect(body.treasuryRisk).toBeUndefined();
  });

  it("a REVERTED execute still reports them — #36 is the explanation for the revert", async () => {
    const { res, body } = await voteAndExecute({}, (data) => {
      if (data.startsWith(SEL.execute)) throw new Error("SphereX error: disallowed tx pattern");
    });
    expect(res.isError).toBe(true);
    expect(body.mode).toBe("failed");
    expect((body.advisories as Array<{ id: string }>).map((a) => a.id)).toContain("#36");
    expect(body.treasuryRisk).toContain("quorum=5%");
  });

  it("matches the library exactly — no restated copy to drift", async () => {
    const { body } = await voteAndExecute();
    const texts = (body.advisories as Array<{ text: string }>).map((a) => a.text);
    expect(texts).toEqual([executeAddSettingsAdvisory(TESTNET)!.text, POST_EXECUTE_LOCK_ADVISORY.text]);
  });
});

// ═════════════════════════════ all three execute entrypoints use ONE funnel

describe("every execute entrypoint goes through the same funnel", () => {
  it("post-vote execute (state Voting → SucceededFor) is guarded", async () => {
    chain.proposalStates = [0, 4]; // Voting on entry, SucceededFor after the vote
    const { sent, body } = await voteAndExecute({ depositFirst: false });
    expect(sent.some((d) => d.startsWith(SEL.multicall))).toBe(true);
    expect(sent.some((d) => d.startsWith(SEL.execute))).toBe(true);
    expect(body.treasuryRisk).toContain("quorum=5%");
    expect((body.advisories as unknown[]).length).toBe(2);

    process.env.DEXE_TREASURY_GUARD = "block";
    chain.proposalStates = [0, 4];
    const blocked = await voteAndExecute({ depositFirst: false });
    expect(blocked.body.mode).toBe("blocked-treasury");
    expect(blocked.body.voteLanded).toBe(true); // the vote is not lost, only the execute refused
    expect(blocked.sent.some((d) => d.startsWith(SEL.execute))).toBe(false);
    expect(blocked.sent.some((d) => d.startsWith(SEL.multicall))).toBe(true);
  });

  it("validator-round entry (state WaitingForVotingTransfer) is guarded", async () => {
    chain.proposalStates = [1, 1, 4]; // entry read, drive read, then SucceededFor
    const { sent, body } = await voteAndExecute();
    expect(sent.some((d) => d.startsWith(SEL.move))).toBe(true);
    expect(sent.some((d) => d.startsWith(SEL.execute))).toBe(true);
    expect(body.treasuryRisk).toContain("quorum=5%");
    expect((body.advisories as unknown[]).length).toBe(2);

    process.env.DEXE_TREASURY_GUARD = "block";
    chain.proposalStates = [1, 1, 4];
    const blocked = await voteAndExecute();
    expect(blocked.body.mode).toBe("blocked-treasury");
    expect(blocked.sent.some((d) => d.startsWith(SEL.move))).toBe(true);
    expect(blocked.sent.some((d) => d.startsWith(SEL.execute))).toBe(false);
  });

  it("dryRun previews the execute and still carries every advisory", async () => {
    const { sent, body } = await voteAndExecute({ dryRun: true });
    expect(sent).toEqual([]);
    expect(body.treasuryRisk).toContain("quorum=5%");
    expect((body.advisories as unknown[]).length).toBe(2);
  });
});
