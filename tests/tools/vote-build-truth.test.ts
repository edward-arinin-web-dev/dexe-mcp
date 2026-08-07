import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";

/**
 * 0.30.3 — "the default profile tells the truth", voteBuild half.
 *
 * Two silent-wrong-action defects, both reachable with DEXE_TOOLSETS unset
 * (`dexe_vote_build_vote` and friends ship in the default `core,proposals`
 * profile, so a first-time user hits them with no opt-in):
 *
 *  D1 — five amount params were bare `z.string()` with NO description, and two
 *       more said only "in wei". An agent had nothing in the schema telling it
 *       whether "100" meant 100 wei or 100 tokens; guessing wrong is a 10^18
 *       error on a fund-moving call that still encodes and broadcasts fine.
 *  D2 — the builders stamped `ctx.config.chainId` into the payload with no way
 *       for the caller to say which chain they meant, so a multichain install
 *       got a correctly-encoded tx addressed at the wrong network.
 *
 * The description assertions are a WALK over the registered schemas, not a
 * hardcoded list, so a builder added later cannot quietly skip the contract.
 */

const ADDR = (n: string) => `0x${n.repeat(40)}`;
const GOV_POOL = ADDR("5");
const PEER = ADDR("6");
const TOKEN = ADDR("7");
const DEFAULT_CHAIN = 56;
const OTHER_CHAIN = 97;

interface ToolResult {
  isError?: boolean;
  structuredContent?: {
    payload?: { to: string; data: string; value: string; chainId: number };
    typedData?: { domain: { chainId: number } };
  };
  content?: Array<{ type: string; text?: string }>;
}

type ToolCb = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Registered {
  shape: Record<string, ZodTypeAny>;
  cb: ToolCb;
}

function captureVoteBuildTools(): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const fake = {
    registerTool: (name: string, cfg: { inputSchema?: Record<string, ZodTypeAny> }, cb: ToolCb) => {
      tools.set(name, { shape: cfg.inputSchema ?? {}, cb });
      return undefined as never;
    },
  } as unknown as McpServer;
  registerVoteBuildTools(fake, {
    config: { defaultChainId: DEFAULT_CHAIN, chainId: DEFAULT_CHAIN },
  } as unknown as ToolContext);
  return tools;
}

const TOOLS = captureVoteBuildTools();

/**
 * `.describe()` may sit on the outer wrapper (`.default().describe()`) or on the
 * inner type (`.describe().default()`), so unwrap until a description shows up.
 */
function descriptionOf(schema: ZodTypeAny): string {
  let node: unknown = schema;
  const seen = new Set<unknown>();
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const d = (node as { description?: unknown }).description;
    if (typeof d === "string" && d.length > 0) return d;
    node = (node as { _def?: { innerType?: unknown } })._def?.innerType;
  }
  return "";
}

/**
 * "Amount-ish" = anything the caller supplies as a quantity of value, i.e. the
 * `amount` args and the native-coin `value` args. Ids (proposalId / tierId /
 * nftIds / tokenId) are counters, not denominated quantities, and are excluded.
 */
const AMOUNT_KEY = /amount|value/i;

const AMOUNT_PARAMS: Array<[tool: string, param: string, description: string]> = [...TOOLS.entries()]
  .flatMap(([tool, { shape }]) =>
    Object.entries(shape)
      .filter(([key]) => AMOUNT_KEY.test(key))
      .map(([key, schema]) => [tool, key, descriptionOf(schema)] as [string, string, string]),
  )
  .sort();

describe("D1: every amount-ish param states its units", () => {
  it("the walk actually found the amount params (guards against a vacuous suite)", () => {
    // The five that were bare `z.string()` at 0.30.2 — the regression targets.
    const names = AMOUNT_PARAMS.map(([tool, param]) => `${tool}.${param}`);
    expect(names).toContain("dexe_vote_build_vote.amount");
    expect(names).toContain("dexe_vote_build_withdraw.amount");
    expect(names).toContain("dexe_vote_build_delegate.amount");
    expect(names).toContain("dexe_vote_build_undelegate.amount");
    expect(names).toContain("dexe_vote_build_validator_vote.amount");
    // …plus deposit/approve/staking/token-sale/multicall amounts and values.
    expect(AMOUNT_PARAMS.length).toBeGreaterThanOrEqual(12);
  });

  it.each(AMOUNT_PARAMS)("%s.%s has a non-empty description", (_tool, _param, description) => {
    expect(description.length).toBeGreaterThan(0);
  });

  it.each(AMOUNT_PARAMS)("%s.%s shows a concrete RAW example", (_tool, _param, description) => {
    // A digits-only integer long enough to be unmistakably base units, not "100".
    expect(description).toMatch(/\d{7,}/);
  });

  it.each(AMOUNT_PARAMS)(
    "%s.%s addresses the human-decimal form with a concrete example",
    (_tool, _param, description) => {
      // The MCP-wide contract advertises "raw wei OR human units ('12.5')", but
      // these builders encode through parseUintString, which throws on decimals.
      // Every description must resolve that ambiguity rather than leave it open.
      expect(description).toMatch(/'\d+\.\d+'/);
      expect(description).toMatch(/reject|not accepted|throw/i);
    },
  );

  it.each(AMOUNT_PARAMS)("%s.%s says what the value is denominated in", (_tool, _param, description) => {
    expect(description).toMatch(/token|native coin/i);
  });
});

describe("D1: the stated contract matches what the builder actually accepts", () => {
  it("a human-decimal amount is rejected, exactly as the descriptions claim", async () => {
    const res = await TOOLS.get("dexe_vote_build_vote")!.cb({
      govPool: GOV_POOL,
      proposalId: "1",
      isVoteFor: true,
      amount: "1.5",
    });
    expect(res.isError).toBe(true);
  });

  it("the raw-units example form is accepted", async () => {
    const res = await TOOLS.get("dexe_vote_build_vote")!.cb({
      govPool: GOV_POOL,
      proposalId: "1",
      isVoteFor: true,
      amount: "1500000000000000000",
    });
    expect(res.isError).toBeFalsy();
  });
});

/**
 * Minimal valid args per tool. Keyed by tool name and asserted to cover the
 * registry exactly, so adding a builder without chainId coverage fails here
 * instead of shipping unchecked.
 */
const ARGS: Record<string, Record<string, unknown>> = {
  dexe_vote_build_erc20_approve: { token: TOKEN, spender: PEER, amount: "1" },
  dexe_vote_build_deposit: { govPool: GOV_POOL, amount: "1" },
  dexe_vote_build_withdraw: { govPool: GOV_POOL, receiver: PEER, amount: "1" },
  dexe_vote_build_delegate: { govPool: GOV_POOL, delegatee: PEER, amount: "1" },
  dexe_vote_build_undelegate: { govPool: GOV_POOL, delegatee: PEER, amount: "1" },
  dexe_vote_build_vote: { govPool: GOV_POOL, proposalId: "1", isVoteFor: true, amount: "1" },
  dexe_vote_build_cancel_vote: { govPool: GOV_POOL, proposalId: "1" },
  dexe_vote_build_validator_vote: {
    govValidators: PEER,
    scope: "internal",
    proposalId: "1",
    amount: "1",
    isVoteFor: true,
  },
  dexe_vote_build_validator_cancel_vote: { govValidators: PEER, scope: "external", proposalId: "1" },
  dexe_vote_build_move_to_validators: { govPool: GOV_POOL, proposalId: "1" },
  dexe_vote_build_execute: { govPool: GOV_POOL, proposalId: "1" },
  dexe_vote_build_claim_rewards: { govPool: GOV_POOL, proposalIds: ["1"], user: PEER },
  dexe_vote_build_claim_micropool_rewards: {
    govPool: GOV_POOL,
    proposalIds: ["1"],
    delegator: PEER,
    delegatee: TOKEN,
  },
  dexe_vote_build_nft_multiplier_lock: { nftMultiplier: TOKEN, tokenId: "1" },
  dexe_vote_build_nft_multiplier_unlock: { nftMultiplier: TOKEN },
  dexe_vote_build_token_sale_buy: {
    tokenSaleProposal: GOV_POOL,
    tierId: "1",
    tokenToBuyWith: TOKEN,
    amount: "1",
  },
  dexe_vote_build_token_sale_claim: { tokenSaleProposal: GOV_POOL, tierIds: ["1"] },
  dexe_vote_build_token_sale_vesting_withdraw: { tokenSaleProposal: GOV_POOL, tierIds: ["1"] },
  dexe_vote_build_distribution_claim: { distributionProposal: GOV_POOL, voter: PEER, proposalIds: ["1"] },
  dexe_vote_build_staking_stake: { userKeeper: PEER, tierId: "1", amount: "1" },
  dexe_vote_build_staking_claim: { stakingProposal: GOV_POOL, stakingId: "1" },
  dexe_vote_build_staking_claim_all: { stakingProposal: GOV_POOL },
  dexe_vote_build_staking_reclaim: { stakingProposal: GOV_POOL, stakingId: "1" },
  dexe_vote_build_privacy_policy_sign: { userRegistry: PEER, documentHash: `0x${"11".repeat(32)}` },
  dexe_vote_build_privacy_policy_agree: { userRegistry: PEER, signature: "0xabcd" },
  dexe_vote_build_multicall: { govPool: GOV_POOL, calls: ["0x12345678"] },
};

const TOOL_NAMES = [...TOOLS.keys()].sort();

/** privacy_policy_sign returns EIP712 typed data, not a payload; the domain carries the chain. */
function chainOf(res: ToolResult): number | undefined {
  return res.structuredContent?.payload?.chainId ?? res.structuredContent?.typedData?.domain.chainId;
}

describe("D2: every builder lets the caller name the chain", () => {
  it("the arg fixtures cover the registered tools exactly", () => {
    expect(Object.keys(ARGS).sort()).toEqual(TOOL_NAMES);
  });

  it.each(TOOL_NAMES)("%s exposes an OPTIONAL chainId param", (name) => {
    const schema = TOOLS.get(name)!.shape.chainId;
    expect(schema, `${name} has no chainId param`).toBeDefined();
    // Optional keeps the addition non-breaking for every existing caller.
    expect(schema!.isOptional()).toBe(true);
  });

  it.each(TOOL_NAMES)("%s stamps the requested chainId, not the default", async (name) => {
    const res = await TOOLS.get(name)!.cb({ ...ARGS[name], chainId: OTHER_CHAIN });
    expect(res.isError, `${name} errored: ${res.content?.[0]?.text}`).toBeFalsy();
    expect(chainOf(res)).toBe(OTHER_CHAIN);
  });

  it.each(TOOL_NAMES)("%s falls back to the default chain when chainId is omitted", async (name) => {
    const res = await TOOLS.get(name)!.cb({ ...ARGS[name] });
    expect(res.isError).toBeFalsy();
    expect(chainOf(res)).toBe(DEFAULT_CHAIN);
  });

  it.each(TOOL_NAMES)("%s emits byte-identical calldata regardless of chainId", async (name) => {
    // chainId belongs to the payload envelope only — this release must not move
    // a single calldata byte.
    const withChain = await TOOLS.get(name)!.cb({ ...ARGS[name], chainId: OTHER_CHAIN });
    const without = await TOOLS.get(name)!.cb({ ...ARGS[name] });
    expect(withChain.structuredContent?.payload?.data).toBe(without.structuredContent?.payload?.data);
    expect(withChain.structuredContent?.payload?.to).toBe(without.structuredContent?.payload?.to);
    expect(withChain.structuredContent?.payload?.value).toBe(without.structuredContent?.payload?.value);
  });
});
