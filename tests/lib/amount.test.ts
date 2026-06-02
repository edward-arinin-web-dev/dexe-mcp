import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseUintString } from "../../src/lib/amount.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";
import type { ToolContext } from "../../src/tools/context.js";

/**
 * H-8 guardrail coverage. Amount/id fields used to flow straight into
 * `BigInt(x)`, which silently accepts `""` (→0n), whitespace (→0n),
 * hex (`0x10`→16n) and negatives (`-5`→-5n) — a silent mis-encode on
 * fund-moving builders, live-broadcast-proven on BSC (`approve(KEEPER,0)`
 * from an empty amount). `parseUintString` rejects every bad class before
 * encoding. A correct maintainer fix keeps these green; a regression flips them.
 */

describe("parseUintString (H-8)", () => {
  it("accepts a plain base-10 integer string", () => {
    expect(parseUintString("0", "amount")).toBe(0n);
    expect(parseUintString("1000000000000000000", "amount")).toBe(10n ** 18n);
    // Arbitrary-precision: well past 2^53.
    expect(parseUintString("123456789012345678901234567890", "amount")).toBe(
      123456789012345678901234567890n,
    );
  });

  it("rejects the empty string (BigInt('')===0n footgun)", () => {
    expect(() => parseUintString("", "amount")).toThrow(/Invalid amount/);
  });

  it("rejects whitespace-only and padded values", () => {
    expect(() => parseUintString("   ", "amount")).toThrow(/Invalid amount/);
    expect(() => parseUintString(" 5", "amount")).toThrow(/Invalid amount/);
    expect(() => parseUintString("5 ", "amount")).toThrow(/Invalid amount/);
  });

  it("rejects hex strings (silently reinterpreted by BigInt)", () => {
    expect(() => parseUintString("0x10", "amount")).toThrow(/Invalid amount/);
  });

  it("rejects negative values (BigInt('-5')===-5n)", () => {
    expect(() => parseUintString("-5", "amount")).toThrow(/Invalid amount/);
  });

  it("rejects decimal / float strings", () => {
    expect(() => parseUintString("1.5", "amount")).toThrow(/Invalid amount/);
    expect(() => parseUintString("1e18", "amount")).toThrow(/Invalid amount/);
  });

  it("names the offending field in the error", () => {
    expect(() => parseUintString("", "tierId")).toThrow(/Invalid tierId/);
    expect(() => parseUintString("nope", "nftId")).toThrow(/Invalid nftId/);
  });
});

/**
 * Builder-level lock: drive the registered `dexe_vote_build_erc20_approve`
 * callback directly (a minimal fake server captures the callbacks). This is
 * the exact tool whose empty-amount `approve(spender, 0)` was broadcast on
 * mainnet in the audit, so it is locked end-to-end here.
 */
function captureTools(): Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: { payload: { data: string } } }>> {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<never>>();
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: (args: Record<string, unknown>) => Promise<never>) => {
      tools.set(name, cb);
      return undefined as never;
    },
  } as unknown as McpServer;
  registerVoteBuildTools(fakeServer, { config: { chainId: 56 } } as unknown as ToolContext);
  return tools as never;
}

describe("dexe_vote_build_erc20_approve amount guard (H-8)", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const SPENDER = "0x2222222222222222222222222222222222222222";

  it("errors on an empty amount instead of silently encoding approve(spender, 0)", async () => {
    const approve = captureTools().get("dexe_vote_build_erc20_approve")!;
    const res = await approve({ token: TOKEN, spender: SPENDER, amount: "" });
    expect(res.isError).toBe(true);
  });

  it("errors on hex and negative amounts", async () => {
    const approve = captureTools().get("dexe_vote_build_erc20_approve")!;
    expect((await approve({ token: TOKEN, spender: SPENDER, amount: "0x10" })).isError).toBe(true);
    expect((await approve({ token: TOKEN, spender: SPENDER, amount: "-5" })).isError).toBe(true);
  });

  it("still encodes a valid decimal amount (approve selector 0x095ea7b3)", async () => {
    const approve = captureTools().get("dexe_vote_build_erc20_approve")!;
    const res = await approve({ token: TOKEN, spender: SPENDER, amount: "1000000000000000000" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.payload.data.startsWith("0x095ea7b3")).toBe(true);
  });
});
