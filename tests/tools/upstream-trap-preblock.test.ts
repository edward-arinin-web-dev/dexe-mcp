import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * ── Known protocol traps are pre-blocked, not reported post-revert ──────────
 *
 * F15 / #36 / F12 / the deposit lock are all deterministic and knowable before
 * a transaction is signed. Before 0.33.0 the user learned about them from a
 * revert receipt (or, for F15, from tokens that simply never arrived).
 *
 * These tests assert the guard fires at BUILD time — no payload is emitted for
 * a refused case — and that the documented opt-in still works for a caller who
 * insists.
 */

// `multicall` is the only network touch on the OTC read paths; stub it so the
// claim_all decision logic can be exercised offline.
const multicallMock = vi.fn();
vi.mock("../../src/lib/multicall.js", () => ({
  multicall: (...args: unknown[]) => multicallMock(...args),
}));

const TSP = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x1111111111111111111111111111111111111111";
const PURCHASE = "0x2222222222222222222222222222222222222222";
const GOV = "0x4444444444444444444444444444444444444444";
const VALIDATORS = "0x5555555555555555555555555555555555555555";
const USER = "0x6666666666666666666666666666666666666666";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Captures both registration shapes (`server.tool` and `server.registerTool`). */
function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as Handler);
      return undefined as never;
    },
    registerTool: (name: string, _cfg: unknown, cb: Handler) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  return { server, tools };
}

function config(): DexeConfig {
  return {
    defaultChainId: 56,
    chains: new Map([
      [56, { chainId: 56, rpcUrl: "http://localhost:0" }],
      [97, { chainId: 97, rpcUrl: "http://localhost:0" }],
    ]),
    pinataJwt: undefined,
  } as unknown as DexeConfig;
}

function text(res: ToolResult): string {
  return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

function json(res: ToolResult): Record<string, unknown> {
  return JSON.parse(text(res)) as Record<string, unknown>;
}

async function otcTools(): Promise<Map<string, Handler>> {
  const { registerOtcTools } = await import("../../src/tools/otc.js");
  const { server, tools } = fakeServer();
  registerOtcTools(
    server,
    { config: config() } as unknown as ToolContext,
    {} as unknown as SignerManager,
    {} as unknown as WalletConnectManager,
  );
  return tools;
}

async function voteBuildTools(): Promise<Map<string, Handler>> {
  const { registerVoteBuildTools } = await import("../../src/tools/voteBuild.js");
  const { server, tools } = fakeServer();
  registerVoteBuildTools(server, { config: config() } as unknown as ToolContext);
  return tools;
}

async function internalTools(): Promise<Map<string, Handler>> {
  const { registerProposalBuildInternalTools } = await import(
    "../../src/tools/proposalBuildInternal.js"
  );
  const { server, tools } = fakeServer();
  registerProposalBuildInternalTools(server, { config: config() } as unknown as ToolContext);
  return tools;
}

const future = (secs: number) => String(Math.floor(Date.now() / 1000) + secs);

function tier(name: string, vestingPercentage: string) {
  return {
    name,
    description: "",
    totalTokenProvided: "1000000000000000000",
    saleStartTime: future(3600),
    saleEndTime: future(7 * 86400),
    claimLockDuration: "0",
    saleTokenAddress: TOKEN,
    purchaseTokenAddresses: [PURCHASE],
    exchangeRates: ["10000000000000000000000000"],
    minAllocationPerUser: "0",
    maxAllocationPerUser: "0",
    vestingSettings: {
      vestingPercentage,
      vestingDuration: "100",
      cliffPeriod: "0",
      unlockStep: "10",
    },
    participation: [],
  };
}

const openSaleArgs = (tiers: unknown[], extra: Record<string, unknown> = {}) => ({
  govPool: GOV,
  tokenSaleProposal: TSP,
  tiers,
  latestTierId: "0",
  proposalName: "Sale",
  proposalDescription: "",
  voteNftIds: [],
  dryRun: false,
  buildOnly: true,
  acknowledgeVestingBlocked: false,
  ...extra,
});

beforeEach(() => {
  multicallMock.mockReset();
});

// ---------------------------------------------------------------- F15 -------

describe("F15 — dexe_otc_dao_open_sale refuses a stranding vesting tier", () => {
  it("refuses BEFORE emitting any actions, naming the tier and the upstream defect", async () => {
    const open = (await otcTools()).get("dexe_otc_dao_open_sale")!;
    const res = await open(openSaleArgs([tier("Open", "0"), tier("Seed", "40")]));

    expect(res.isError).toBe(true);
    const out = text(res);
    expect(out).toMatch(/REFUSED before building any calldata/);
    expect(out).toContain('tier[1] "Seed"');
    expect(out).toContain("F15");
    expect(out).toMatch(/acknowledgeVestingBlocked: true/);
    // The whole point: nothing signable came back.
    expect(res.structuredContent).toBeUndefined();
    expect(out).not.toMatch(/"actions"/);
  });

  it("builds normally when every tier has vestingPercentage 0", async () => {
    const open = (await otcTools()).get("dexe_otc_dao_open_sale")!;
    const res = await open(openSaleArgs([tier("Open", "0")]));
    expect(res.isError).toBeUndefined();
    const body = json(res);
    expect(body.mode).toBe("buildOnly");
    expect(Array.isArray(body.actions)).toBe(true);
    expect((body.otc as Record<string, unknown>).vestingBlocked).toBeUndefined();
  });

  it("still lets a caller who insists through, and records what they accepted", async () => {
    const open = (await otcTools()).get("dexe_otc_dao_open_sale")!;
    const res = await open(
      openSaleArgs([tier("Seed", "40")], { acknowledgeVestingBlocked: true }),
    );
    expect(res.isError).toBeUndefined();
    const otc = json(res).otc as Record<string, unknown>;
    const blocked = otc.vestingBlocked as Record<string, unknown>;
    expect(blocked.acknowledged).toBe(true);
    expect(blocked.tiers).toEqual([{ index: 0, name: "Seed", vestingPercentage: "40" }]);
    expect(String(blocked.upstream)).toContain("F15");
  });
});

describe("F15 — dexe_otc_buyer_claim_all stops auto-appending vestingWithdraw", () => {
  /** getUserViews: tier has nothing claimable but 500 wei of withdrawable vesting. */
  function vestingOnlyUserViews() {
    multicallMock.mockResolvedValue([
      {
        success: true,
        value: [
          {
            purchaseView: { isClaimed: true, canClaim: false, claimTotalAmount: 0n },
            vestingUserView: { amountToWithdraw: 500n },
          },
        ],
      },
    ]);
  }

  const args = (extra: Record<string, unknown> = {}) => ({
    tokenSaleProposal: TSP,
    chainId: 56,
    tierIds: ["1"],
    user: USER,
    dryRun: true,
    includeVesting: false,
    ...extra,
  });

  it("emits NO payload and reports vestingBlocked instead", async () => {
    vestingOnlyUserViews();
    const claim = (await otcTools()).get("dexe_otc_buyer_claim_all")!;
    const body = json(await claim(args()));

    expect(body.mode).toBe("noop"); // nothing broadcastable was produced
    const blocked = body.vestingBlocked as Record<string, unknown>;
    expect(blocked.tierIds).toEqual(["1"]);
    expect(String(blocked.reason)).toMatch(/blocked/i);
    expect(String(blocked.upstream)).toContain("F15");
    expect(blocked.overrideWith).toBe("includeVesting: true");
    expect(text(await claim(args()))).not.toContain("vestingWithdraw([1])");
  });

  it("attempts it anyway on includeVesting: true", async () => {
    vestingOnlyUserViews();
    const claim = (await otcTools()).get("dexe_otc_buyer_claim_all")!;
    const body = json(await claim(args({ includeVesting: true })));

    expect(body.mode).toBe("dryRun");
    expect(body.vestingWithdrawTierIds).toEqual(["1"]);
    const steps = body.steps as { label?: string; payload?: { data: string } }[];
    const withdraw = steps.find((s) => (s.label ?? "").includes("vestingWithdraw"));
    expect(withdraw, "the opt-in path must still produce the payload").toBeDefined();
    expect((body.vestingBlocked as Record<string, unknown>).attempted).toBe(true);
  });

  it("never reports blocked ids as withdrawn when it did not send them", async () => {
    vestingOnlyUserViews();
    const claim = (await otcTools()).get("dexe_otc_buyer_claim_all")!;
    const body = json(await claim(args()));
    expect(body.vestingWithdrawTierIds ?? []).toEqual([]);
  });
});

describe("F15 — the raw vestingWithdraw builder hands over the warning with the payload", () => {
  it("attaches the DANGER advisory", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_token_sale_vesting_withdraw")!;
    const res = await build({ tokenSaleProposal: TSP, tierIds: ["1"], chainId: 56 });
    expect(text(res)).toContain("F15");
    expect(text(res)).toMatch(/DANGER/);
    const advisories = res.structuredContent!.advisories as { id: string; severity: string }[];
    expect(advisories.map((a) => a.id)).toContain("F15");
    expect(advisories.find((a) => a.id === "F15")!.severity).toBe("DANGER");
  });
});

// ---------------------------------------------------------------- #36 -------

describe("#36 — GovPool.execute names the chain that will brick", () => {
  it("warns on chain 97 and says what to do instead", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_execute")!;
    const res = await build({ govPool: GOV, proposalId: "3", scope: "external", chainId: 97 });
    const out = text(res);
    expect(out).toContain("#36");
    expect(out).toContain("chain 97");
    expect(out).toMatch(/settingsIds/);
    const ids = (res.structuredContent!.advisories as { id: string }[]).map((a) => a.id);
    expect(ids).toContain("#36");
  });

  it("does not cry wolf on mainnet, where the same call executes", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_execute")!;
    const res = await build({ govPool: GOV, proposalId: "3", scope: "external", chainId: 56 });
    expect(text(res)).not.toContain("#36");
  });

  it("emits identical execute calldata either way — the guard is text-only", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_execute")!;
    const a = await build({ govPool: GOV, proposalId: "3", scope: "external", chainId: 97 });
    const b = await build({ govPool: GOV, proposalId: "3", scope: "external", chainId: 56 });
    const dataOf = (r: ToolResult) => (r.structuredContent!.payload as { data: string }).data;
    expect(dataOf(a)).toBe(dataOf(b));
  });
});

// ---------------------------------------------------------------- F12 -------

describe("F12 — validator cancel is warned in-band", () => {
  it("warns on the cancel builder itself, with the no-workaround fact", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_validator_cancel_vote")!;
    const res = await build({
      govValidators: VALIDATORS,
      scope: "internal",
      proposalId: "1",
      chainId: 56,
    });
    const out = text(res);
    expect(out).toContain("F12");
    expect(out).toMatch(/no client-side workaround/i);
    expect((res.structuredContent!.advisories as { id: string }[])[0]!.id).toBe("F12");
  });

  it("warns at creation time on every internal-proposal wrapper", async () => {
    const tools = await internalTools();
    const cases: [string, Record<string, unknown>][] = [
      ["dexe_proposal_build_change_validator_settings", { duration: "3600", executionDelay: "0", quorum: "1" }],
      ["dexe_proposal_build_change_validator_balances", { changes: [{ user: USER, balance: "1" }] }],
      [
        "dexe_proposal_build_monthly_withdraw",
        { withdrawals: [{ token: TOKEN, amount: "1" }], destination: USER },
      ],
      ["dexe_proposal_build_offchain_internal_proposal", {}],
    ];
    for (const [name, args] of cases) {
      const res = await tools.get(name)!(args);
      expect(text(res), name).toContain("F12");
      expect(text(res), name).toMatch(/CANNOT take it back/);
      const ids = (res.structuredContent!.advisories as { id: string }[]).map((a) => a.id);
      expect(ids, name).toContain("F12");
    }
  });
});

// -------------------------------------------------- deposit lock (mode 5) ---

describe("deposit lock — surfaced before the call, not after the revert", () => {
  it("warns on execute, which is what creates the lock", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_execute")!;
    const res = await build({ govPool: GOV, proposalId: "3", scope: "external", chainId: 56 });
    expect(text(res)).toMatch(/deposit lock/);
    expect(text(res)).toMatch(/[Ww]ithdraw between proposals/);
  });

  it("warns on vote, which is where the lock bites", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_vote")!;
    const res = await build({
      govPool: GOV,
      proposalId: "3",
      isVoteFor: true,
      amount: "1000",
      nftIds: [],
      chainId: 56,
    });
    expect(text(res)).toMatch(/deposit lock/);
    const ids = (res.structuredContent!.advisories as { id: string }[]).map((a) => a.id);
    expect(ids).toContain("tokens-locked-after-execute");
  });

  it("leaves the vote calldata untouched", async () => {
    const build = (await voteBuildTools()).get("dexe_vote_build_vote")!;
    const res = await build({
      govPool: GOV,
      proposalId: "3",
      isVoteFor: true,
      amount: "1000",
      nftIds: [],
      chainId: 56,
    });
    // still the SphereX-required multicall([vote]) shape (F4)
    expect((res.structuredContent!.payload as { data: string }).data.startsWith("0xac9650d8")).toBe(true);
  });
});
