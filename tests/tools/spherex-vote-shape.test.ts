import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";

const GOV_POOL = "0x5555555555555555555555555555555555555555";
const DELEGATEE = "0x6666666666666666666666666666666666666666";

const GOV = new Interface([
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function undelegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
]);

type ToolCb = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: { payload: { to: string; data: string } };
}>;

function captureVoteTools() {
  const tools = new Map<string, ToolCb>();
  const fake = {
    registerTool: (name: string, _cfg: unknown, cb: ToolCb) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  registerVoteBuildTools(fake, { config: { chainId: 97 } } as unknown as ToolContext);
  return tools;
}

/**
 * F4 guardrail (2026-07-21). SphereX-protected pools (every GovPool deployed
 * since ~2026-07-06) revert a raw top-level vote()/delegate() with
 * "SphereX error: disallowed tx pattern" — proven with a real broadcast
 * (tx 0x56e28e0d…4e4a, status 0). The frontend never sends them raw: it always
 * wraps in GovPool.multicall([...]) (useGovPoolVote.ts / useGovPoolDelegate.ts),
 * and multicall([vote]) / multicall([delegate]) land with status 1. The
 * builders must emit that exact shape.
 */
describe("F4 SphereX shape: vote/delegate wrapped in multicall", () => {
  const tools = captureVoteTools();

  it("dexe_vote_build_vote emits multicall([vote(...)])", async () => {
    const res = await tools.get("dexe_vote_build_vote")!({
      govPool: GOV_POOL,
      proposalId: "2",
      isVoteFor: true,
      amount: "1500000000000000000000000",
    });
    const data = res.structuredContent!.payload.data;
    expect(data.startsWith("0xac9650d8")).toBe(true); // multicall selector
    const [calls] = GOV.decodeFunctionData("multicall", data);
    expect(calls).toHaveLength(1);
    const inner = GOV.decodeFunctionData("vote", calls[0]);
    expect(inner[0]).toBe(2n);
    expect(inner[1]).toBe(true);
    expect(inner[2]).toBe(1500000000000000000000000n);
  });

  it("dexe_vote_build_delegate emits multicall([delegate(...)])", async () => {
    const res = await tools.get("dexe_vote_build_delegate")!({
      govPool: GOV_POOL,
      delegatee: DELEGATEE,
      amount: "100000000000000000000000",
    });
    const data = res.structuredContent!.payload.data;
    expect(data.startsWith("0xac9650d8")).toBe(true);
    const [calls] = GOV.decodeFunctionData("multicall", data);
    expect(calls).toHaveLength(1);
    const inner = GOV.decodeFunctionData("delegate", calls[0]);
    expect(inner[0].toLowerCase()).toBe(DELEGATEE.toLowerCase());
    expect(inner[1]).toBe(100000000000000000000000n);
  });

  it("dexe_vote_build_undelegate stays a raw call (SphereX allows it)", async () => {
    const res = await tools.get("dexe_vote_build_undelegate")!({
      govPool: GOV_POOL,
      delegatee: DELEGATEE,
      amount: "100000000000000000000000",
    });
    const data = res.structuredContent!.payload.data;
    expect(data.startsWith("0x7810436a")).toBe(true); // undelegate selector
  });

  it("dexe_vote_build_multicall accepts a single-element batch (frontend shape)", async () => {
    const inner = GOV.encodeFunctionData("vote", [2n, true, 1n, []]);
    const res = await tools.get("dexe_vote_build_multicall")!({
      govPool: GOV_POOL,
      calls: [inner],
    });
    expect(res.isError).toBeFalsy();
    const [calls] = GOV.decodeFunctionData("multicall", res.structuredContent!.payload.data);
    expect(calls).toHaveLength(1);
  });
});
