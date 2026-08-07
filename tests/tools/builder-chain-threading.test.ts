import { describe, it, expect, beforeEach, vi } from "vitest";
import { AbiCoder, id } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.3 — the standalone `dexe_proposal_build_*` tools that perform an on-chain
 * SAFETY pre-check used to run that check against the MCP's default chain, with
 * no way for the caller to say otherwise. The composite path
 * (`src/lib/proposalBuilders.ts`) already threaded `deps.chainId`; these three
 * did not:
 *
 *   - dexe_proposal_build_apply_to_dao        → ERC20Gov blacklist probe
 *   - dexe_proposal_build_withdraw_treasury   → ERC20Gov blacklist probe
 *   - dexe_proposal_build_reward_multiplier   → code / selector / owner() probe
 *
 * A pre-check aimed at the wrong chain is worse than none: the token has no code
 * there, the probe degrades to "skipped"/inconclusive, and the build reports a
 * guard that never ran. This asserts the probe chain follows the caller, and
 * that supplying `chainId` does not perturb a single calldata byte.
 */

const abi = AbiCoder.defaultAbiCoder();
const sel = (sig: string) => id(sig).slice(0, 10);

const OWNER_SEL = sel("owner()");
const NFT_MULT_ADDR_SEL = sel("getNftMultiplierAddress()");
const TOTAL_BLACKLIST_SEL = sel("totalBlacklistAccounts()");

const GOVPOOL = "0x3333333333333333333333333333333333333333";
const MULTIPLIER = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x00346dafbbfb3b6822cd246e175adfd7678b8686";
const RECEIVER = "0x1111111111111111111111111111111111111111";

// Runtime bytecode carrying mint's selector (0xaf2d2333) as a PUSH4 immediate,
// so the bug #31 selector scan is satisfied and we reach the owner() probe.
const CODE_WITH_MINT = "0x60ff63af2d233314600057";

/** Every chain id handed to the provider factory, in call order. */
const probes = vi.hoisted(() => ({ chains: [] as (number | undefined)[] }));

vi.mock("../../src/rpc.js", () => {
  const fakeProvider = {
    async getCode() {
      return CODE_WITH_MINT;
    },
    async getStorage() {
      return "0x" + "0".repeat(64);
    },
    async call(tx: { data?: string }) {
      const s = (tx.data ?? "").slice(0, 10);
      if (s === OWNER_SEL) return abi.encode(["address"], [GOVPOOL]);
      if (s === NFT_MULT_ADDR_SEL) return abi.encode(["address"], [MULTIPLIER]);
      if (s === TOTAL_BLACKLIST_SEL) return abi.encode(["uint256"], [0n]);
      return abi.encode(["uint256"], [0n]);
    },
  };
  return {
    RpcProvider: class {
      constructor(_config: unknown) {}
      requireProvider(chainId?: number) {
        probes.chains.push(chainId);
        return fakeProvider;
      }
      tryProvider(chainId?: number) {
        probes.chains.push(chainId);
        return { ok: fakeProvider };
      }
    },
  };
});

import { registerProposalBuildComplexTools } from "../../src/tools/proposalBuildComplex.js";
import { registerProposalBuildMoreTools } from "../../src/tools/proposalBuildMore.js";

const DEFAULT_CHAIN = 56;

function ctx(defaultChainId = DEFAULT_CHAIN): ToolContext {
  return {
    config: {
      rpcUrl: "https://rpc.example/default",
      defaultChainId,
      chainId: defaultChainId,
      treasuryGuard: "off",
      chains: new Map(),
    } as unknown as DexeConfig,
  } as unknown as ToolContext;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { actions?: Array<{ executor: string; value: string; data: string }> };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  toolCtx: ToolContext = ctx(),
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildComplexTools(server, toolCtx);
  registerProposalBuildMoreTools(server, toolCtx);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const actionsOf = (r: ToolResult) => r.structuredContent?.actions ?? [];
const calldataOf = (r: ToolResult) => actionsOf(r).map((a) => `${a.executor}|${a.value}|${a.data}`);

beforeEach(() => {
  probes.chains = [];
});

describe("dexe_proposal_build_apply_to_dao runs its blacklist probe on the caller's chain", () => {
  const args = { token: TOKEN, receiver: RECEIVER, amount: "100", treasuryBalance: "1000" };

  it("probes chain 97 when chainId=97", async () => {
    const res = await callTool("dexe_proposal_build_apply_to_dao", { ...args, chainId: 97 });
    expect(res.isError).toBeFalsy();
    expect(probes.chains).toEqual([97]);
  });

  it("probes the DEFAULT chain when chainId is omitted (unchanged behavior)", async () => {
    const res = await callTool("dexe_proposal_build_apply_to_dao", args);
    expect(res.isError).toBeFalsy();
    expect(probes.chains).toEqual([DEFAULT_CHAIN]);
  });

  it("follows a testnet-default install rather than hardcoding mainnet", async () => {
    await callTool("dexe_proposal_build_apply_to_dao", args, ctx(97));
    expect(probes.chains).toEqual([97]);
  });

  it("chainId does not change a single calldata byte", async () => {
    const withChain = await callTool("dexe_proposal_build_apply_to_dao", { ...args, chainId: 97 });
    const without = await callTool("dexe_proposal_build_apply_to_dao", args);
    expect(calldataOf(withChain)).toEqual(calldataOf(without));
    expect(calldataOf(without)).toHaveLength(1);
  });
});

describe("dexe_proposal_build_withdraw_treasury runs its blacklist probe on the caller's chain", () => {
  const args = { govPool: GOVPOOL, receiver: RECEIVER, token: TOKEN, amount: "100" };

  it("probes chain 97 when chainId=97", async () => {
    const res = await callTool("dexe_proposal_build_withdraw_treasury", { ...args, chainId: 97 });
    expect(res.isError).toBeFalsy();
    expect(probes.chains).toEqual([97]);
  });

  it("probes the DEFAULT chain when chainId is omitted", async () => {
    await callTool("dexe_proposal_build_withdraw_treasury", args);
    expect(probes.chains).toEqual([DEFAULT_CHAIN]);
  });

  it("chainId does not change a single calldata byte", async () => {
    const withChain = await callTool("dexe_proposal_build_withdraw_treasury", { ...args, chainId: 97 });
    const without = await callTool("dexe_proposal_build_withdraw_treasury", args);
    expect(calldataOf(withChain)).toEqual(calldataOf(without));
  });

  it("an NFT-only withdrawal has no ERC20 to probe and touches no chain", async () => {
    const res = await callTool("dexe_proposal_build_withdraw_treasury", {
      govPool: GOVPOOL,
      receiver: RECEIVER,
      nftAddress: TOKEN,
      nftIds: ["1", "2"],
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(probes.chains).toEqual([]);
    expect(actionsOf(res)).toHaveLength(2);
  });
});

describe("dexe_proposal_build_reward_multiplier pre-checks the caller's chain", () => {
  const mint = {
    mode: "mint",
    govPool: GOVPOOL,
    nftMultiplierContract: MULTIPLIER,
    to: RECEIVER,
    multiplier: "15000000000000000000000000",
    rewardPeriod: "86400",
  };

  it("probes chain 97 when chainId=97", async () => {
    const res = await callTool("dexe_proposal_build_reward_multiplier", { ...mint, chainId: 97 });
    expect(res.isError).toBeFalsy();
    // One RpcProvider acquisition per precheck call; every one must be chain 97.
    expect(probes.chains.length).toBeGreaterThan(0);
    expect(new Set(probes.chains)).toEqual(new Set([97]));
  });

  it("probes the DEFAULT chain when chainId is omitted", async () => {
    await callTool("dexe_proposal_build_reward_multiplier", mint);
    expect(new Set(probes.chains)).toEqual(new Set([DEFAULT_CHAIN]));
  });

  it("change_token and set_token_uri thread the chain too", async () => {
    await callTool("dexe_proposal_build_reward_multiplier", {
      mode: "change_token",
      govPool: GOVPOOL,
      nftMultiplierContract: MULTIPLIER,
      tokenId: "1",
      multiplier: "15000000000000000000000000",
      rewardPeriod: "86400",
      chainId: 97,
    });
    expect(new Set(probes.chains)).toEqual(new Set([97]));

    probes.chains = [];
    await callTool("dexe_proposal_build_reward_multiplier", {
      mode: "set_token_uri",
      govPool: GOVPOOL,
      nftMultiplierContract: MULTIPLIER,
      tokenId: "1",
      uri: "ipfs://cid",
      chainId: 97,
    });
    expect(new Set(probes.chains)).toEqual(new Set([97]));
  });

  it("set_address needs no probe and takes no chain", async () => {
    const res = await callTool("dexe_proposal_build_reward_multiplier", {
      mode: "set_address",
      govPool: GOVPOOL,
      newMultiplierAddress: MULTIPLIER,
      chainId: 97,
    });
    expect(res.isError).toBeFalsy();
    expect(probes.chains).toEqual([]);
  });

  it("chainId does not change a single calldata byte", async () => {
    const withChain = await callTool("dexe_proposal_build_reward_multiplier", { ...mint, chainId: 97 });
    const without = await callTool("dexe_proposal_build_reward_multiplier", mint);
    expect(calldataOf(withChain)).toEqual(calldataOf(without));
    // mint(address,uint256,uint64,string) — the canonical selector (bug #31).
    expect(actionsOf(without)[0]!.data.slice(0, 10)).toBe("0xaf2d2333");
  });
});
