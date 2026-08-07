import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";

/**
 * 0.33.0 findings — the deposit-lock guard, wired and made truthful.
 *
 * LOW-1: `lockedPowerAdvisory` — the LIVE form of the lock check, which takes
 *   the voter's deposited and available power and speaks only when the lock is
 *   real — had zero production call sites. Written, unit-tested, wired nowhere.
 *
 * LOW-2: what shipped in its place was the STATIC `POST_EXECUTE_LOCK_ADVISORY`,
 *   whose text ends in `checkTokensUnlocked`'s FAILURE remediation: "deposited
 *   tokens appear locked from a prior vote/execute (available power = 0 while
 *   deposited > 0)". That is a live OBSERVATION, and it was attached to every
 *   single vote/execute build — including for a caller with nothing deposited.
 *   A warning that always fires is a warning nobody reads, and that one states a
 *   false fact about the user's position.
 *
 * Both builders now go through ONE resolver (`depositLockAdvisory` in
 * voteBuild.ts). Given a `voter` it reads the real numbers and the advisory
 * appears only when the lock is actually there; with no voter the position is
 * unknown, so the caller gets a note about what WILL happen rather than a claim
 * about what IS. Calldata is untouched in every case.
 */

vi.mock("../../src/lib/multicall.js", () => ({ multicall: vi.fn() }));

import { multicall } from "../../src/lib/multicall.js";
import { loadConfig } from "../../src/config.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";
import { checkTokensUnlocked } from "../../src/lib/preflight.js";

const mc = vi.mocked(multicall);

const GOV_POOL = "0x1111111111111111111111111111111111111111";
const SETTINGS = "0x2222222222222222222222222222222222222222";
const USER_KEEPER = "0x3333333333333333333333333333333333333333";
const VALIDATORS = "0x4444444444444444444444444444444444444444";
const VOTER = "0x000000000000000000000000000000000000dEaD";
const CHAIN = 56;
const ONE = 10n ** 18n;

/** The sentence that must never be asserted about a caller we did not measure. */
const LIVE_CLAIM = "appear locked from a prior vote/execute";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: {
    payload?: { to: string; data: string; value: string };
    advisories?: Array<{ id: string; severity: string; text: string }>;
  };
}

type ToolCb = (args: Record<string, unknown>) => Promise<ToolResult>;

let tools: Map<string, { shape: Record<string, ZodTypeAny>; cb: ToolCb }>;

beforeEach(async () => {
  const config = await loadConfig();
  tools = new Map();
  const fake = {
    registerTool: (name: string, cfg: { inputSchema?: Record<string, ZodTypeAny> }, cb: ToolCb) => {
      tools.set(name, { shape: cfg.inputSchema ?? {}, cb });
      return undefined as never;
    },
  } as unknown as McpServer;
  registerVoteBuildTools(fake, { config } as unknown as ToolContext);
  mc.mockReset();
});

/**
 * Fake the two reads the resolver makes. `deposited`/`available` are the pair
 * `checkTokensUnlocked` judges; `ownedBalance` is the caller's un-deposited
 * wallet balance, which `tokenBalance` folds into `balance`.
 */
function chainWith(power: { deposited: bigint; available: bigint; owned?: bigint }): void {
  const owned = power.owned ?? 0n;
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
    calls.map((c) => {
      switch (c.method) {
        case "getHelperContracts":
          return { success: true, value: [SETTINGS, USER_KEEPER, VALIDATORS, GOV_POOL, GOV_POOL] as never, raw: "0x" };
        case "tokenBalance":
          return { success: true, value: [power.deposited + owned, owned] as never, raw: "0x" };
        case "votingPower":
          return { success: true, value: [{ power: power.available }] as never, raw: "0x" };
        default:
          return { success: false, value: null, raw: "0x", error: "call reverted" };
      }
    }),
  );
}

/** Every read reverts — the "we asked and could not find out" case. */
function chainUnreadable(): void {
  mc.mockImplementation(async (_p: never, calls: Array<{ method: string }>) =>
    calls.map(() => ({ success: false, value: null, raw: "0x", error: "call reverted" })),
  );
}

const voteArgs = (over: Record<string, unknown> = {}) => ({
  govPool: GOV_POOL,
  proposalId: "3",
  isVoteFor: true,
  amount: "1000",
  nftIds: [],
  chainId: CHAIN,
  ...over,
});

const executeArgs = (over: Record<string, unknown> = {}) => ({
  govPool: GOV_POOL,
  proposalId: "3",
  scope: "external",
  chainId: CHAIN,
  ...over,
});

const build = (tool: string, args: Record<string, unknown>) => tools.get(tool)!.cb(args);
const lockAdvisories = (res: ToolResult) =>
  (res.structuredContent?.advisories ?? []).filter((a) => a.id === "tokens-locked-after-execute");
const allText = (res: ToolResult) => res.content.map((c) => c.text ?? "").join("\n");

describe("the lock advisory fires when the lock is real", () => {
  it.each([
    ["dexe_vote_build_vote", voteArgs()],
    ["dexe_vote_build_execute", executeArgs()],
  ])("%s reports the live lock, quoting the measured numbers", async (tool, args) => {
    chainWith({ deposited: 100n * ONE, available: 0n });
    const res = await build(tool, { ...args, voter: VOTER });

    const [advisory, ...extra] = lockAdvisories(res);
    expect(advisory, "the live lock was not reported at all").toBeDefined();
    expect(extra, "the lock was reported more than once").toEqual([]);
    // DANGER, not WARN: this is a measured fact about THIS caller, not a note.
    expect(advisory!.severity).toBe("DANGER");
    expect(advisory!.text).toContain(LIVE_CLAIM);
    expect(advisory!.text).toContain(`deposited=${100n * ONE}`);
    expect(advisory!.text).toContain("available=0");
    expect(allText(res)).toContain("deposit lock");
  });

  it("says the same thing the preflight guard says — one source, no drift", async () => {
    chainWith({ deposited: 5n * ONE, available: 0n });
    const res = await build("dexe_vote_build_vote", { ...voteArgs(), voter: VOTER });
    expect(lockAdvisories(res)[0]!.text).toContain(checkTokensUnlocked(5n * ONE, 0n).remediation!);
  });
});

describe("…and is ABSENT when it is not", () => {
  it.each([
    ["a deposit that is free to vote", { deposited: 100n * ONE, available: 100n * ONE }],
    ["a partially available deposit", { deposited: 100n * ONE, available: 1n }],
    ["nothing deposited at all", { deposited: 0n, available: 0n }],
    ["nothing deposited, tokens in the wallet", { deposited: 0n, available: 0n, owned: 50n * ONE }],
  ])("%s produces no lock advisory on vote", async (_label, power) => {
    chainWith(power);
    const res = await build("dexe_vote_build_vote", { ...voteArgs(), voter: VOTER });
    expect(lockAdvisories(res)).toEqual([]);
    expect(allText(res)).not.toContain("deposit lock");
  });

  it("stays silent on execute too when the caller holds no lock", async () => {
    chainWith({ deposited: 100n * ONE, available: 100n * ONE });
    const res = await build("dexe_vote_build_execute", { ...executeArgs(), voter: VOTER });
    expect(lockAdvisories(res)).toEqual([]);
  });

  it("stays silent for the internal (GovValidators) execute scope as well", async () => {
    chainWith({ deposited: 0n, available: 0n });
    const res = await build("dexe_vote_build_execute", {
      ...executeArgs({ scope: "internal", govValidators: VALIDATORS }),
      voter: VOTER,
    });
    expect(lockAdvisories(res)).toEqual([]);
  });
});

describe("with no voter the position is unknown, so nothing is asserted about it", () => {
  it("vote carries a forward-looking note, not a claim about the caller's balance", async () => {
    const res = await build("dexe_vote_build_vote", voteArgs());
    const [advisory] = lockAdvisories(res);
    expect(advisory, "the trap must still be named").toBeDefined();
    expect(advisory!.severity).toBe("WARN");
    // The whole finding: this used to state a live observation on every build.
    expect(advisory!.text, "still asserting an unmeasured live observation").not.toContain(LIVE_CLAIM);
    expect(advisory!.text).toMatch(/withdraw/i);
    expect(advisory!.text).toContain("voter"); // how to get the measured answer
  });

  it("makes no RPC call when there is no voter to check", async () => {
    await build("dexe_vote_build_vote", voteArgs());
    await build("dexe_vote_build_execute", executeArgs());
    expect(mc, "a pure builder went to the network unasked").not.toHaveBeenCalled();
  });

  it("an unreadable chain falls back to the note rather than going quiet", async () => {
    // Unknown is never 'safe': failing to read must not silence the trap.
    chainUnreadable();
    const res = await build("dexe_vote_build_vote", { ...voteArgs(), voter: VOTER });
    const [advisory] = lockAdvisories(res);
    expect(advisory).toBeDefined();
    expect(advisory!.severity).toBe("WARN");
    expect(advisory!.text).not.toContain(LIVE_CLAIM);
  });

  it("a malformed voter is treated as no voter, not as an error", async () => {
    const res = await build("dexe_vote_build_vote", { ...voteArgs(), voter: "not-an-address" });
    expect(res.isError).toBeFalsy();
    expect(lockAdvisories(res)[0]!.severity).toBe("WARN");
    expect(mc).not.toHaveBeenCalled();
  });
});

describe("the advisory never touches what goes on the wire", () => {
  it.each([
    ["dexe_vote_build_vote", voteArgs()],
    ["dexe_vote_build_execute", executeArgs()],
  ])("%s emits byte-identical calldata locked, unlocked, and unchecked", async (tool, args) => {
    const unchecked = await build(tool, args);
    chainWith({ deposited: 100n * ONE, available: 0n });
    const locked = await build(tool, { ...args, voter: VOTER });
    chainWith({ deposited: 100n * ONE, available: 100n * ONE });
    const unlocked = await build(tool, { ...args, voter: VOTER });

    const wire = (r: ToolResult) => [r.structuredContent!.payload!.to, r.structuredContent!.payload!.data, r.structuredContent!.payload!.value];
    expect(wire(locked)).toEqual(wire(unchecked));
    expect(wire(unlocked)).toEqual(wire(unchecked));
  });

  it("keeps the SphereX-required multicall([vote]) shape (F4)", async () => {
    chainWith({ deposited: 100n * ONE, available: 0n });
    const res = await build("dexe_vote_build_vote", { ...voteArgs(), voter: VOTER });
    expect(res.structuredContent!.payload!.data.startsWith("0xac9650d8")).toBe(true);
  });
});

describe("the opt-in is discoverable", () => {
  it.each(["dexe_vote_build_vote", "dexe_vote_build_execute"])(
    "%s exposes an OPTIONAL voter param that says what it buys",
    (name) => {
      const schema = tools.get(name)!.shape.voter;
      expect(schema, `${name} has no voter param`).toBeDefined();
      expect(schema!.isOptional(), "adding it must not break existing callers").toBe(true);
      expect(schema!.description ?? "").toMatch(/live/i);
    },
  );
});
