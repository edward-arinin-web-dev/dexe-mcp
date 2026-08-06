import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { buildChainIdParam, chainIdParam } from "../../src/lib/params.js";

/**
 * 0.30.3 review follow-ups. Each case here is a defect that survived the first
 * cut of the release whose whole thesis is "the default profile tells the
 * truth" — a tool description that promised something the code did not do.
 */

let client: Client;
let server: McpServer;

beforeAll(async () => {
  process.env.DEXE_TOOLSETS = "full";
  const config = await loadConfig();
  server = new McpServer({ name: "build-truth-test", version: "0.0.0" }, {});
  registerAll(server, config);
  client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  delete process.env.DEXE_TOOLSETS;
});

async function call(name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

/**
 * F2 — the blacklist probe reads the TOKEN contract, so it has to run on the
 * chain the proposal targets. Without a chainId it hit the default chain, where
 * the token usually has no code: the guard degraded to "skipped" and a
 * blacklisted recipient produced a proposal that passes the vote and then
 * reverts forever (bug #29). This is the primary fund-moving builder, and the
 * catalog now routes treasury withdrawals to it.
 */
describe("dexe_proposal_build_token_transfer runs its blacklist check on the target chain", () => {
  it("accepts a chainId", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "dexe_proposal_build_token_transfer")!;
    expect(Object.keys(t.inputSchema.properties ?? {})).toContain("chainId");
  });

  it("emits identical calldata whichever chain is named — only the envelope moves", async () => {
    const base = {
      govPool: "0x" + "11".repeat(20),
      token: "0x" + "22".repeat(20),
      recipient: "0x" + "33".repeat(20),
      amount: "1000",
    };
    const a = await call("dexe_proposal_build_token_transfer", { ...base, chainId: 56 });
    const b = await call("dexe_proposal_build_token_transfer", { ...base, chainId: 97 });
    const hexOf = (r: typeof a) => (r.content[0]?.text ?? "").match(/0x[0-9a-fA-F]{16,}/g) ?? [];
    expect(hexOf(a).length).toBeGreaterThan(0);
    expect(hexOf(a)).toEqual(hexOf(b));
  });
});

/**
 * F4 — amountDesc told callers that a decimal like '1.5' is REJECTED. That was
 * true for `amount` but NOT for `value`: buildPayload only .toString()s it, so
 * 'abc' was stamped into the payload verbatim and failed later, far from the
 * cause. The description was added by this release, so the release introduced
 * the false promise. Now the promise is enforced rather than softened.
 */
describe("native `value` is validated, not just described as validated", () => {
  const govPool = "0x" + "44".repeat(20);

  for (const bad of ["1.5", "abc", "-1"]) {
    it(`dexe_vote_build_deposit rejects value='${bad}'`, async () => {
      const res = await call("dexe_vote_build_deposit", { govPool, amount: "1", value: bad });
      expect(res.isError).toBe(true);
    });
  }

  it("still accepts a digits-only value", async () => {
    const res = await call("dexe_vote_build_deposit", {
      govPool,
      amount: "1",
      value: "100000000000000000",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("100000000000000000");
  });
});

/**
 * F5 — the read-tool chainId param was reused verbatim on 28 write builders,
 * publishing two claims that are false there: builders do not "read from" the
 * chain, and they do not "reject if no RPC is configured" (they only stamp the
 * envelope; a mismatch is caught later by the B11 broadcast guard).
 */
describe("builders use the builder chainId param, not the read one", () => {
  it("the two params carry different descriptions", () => {
    const read = chainIdParam.description ?? "";
    const build = buildChainIdParam.description ?? "";
    expect(read).not.toBe(build);
    expect(read).toMatch(/read from/i);
    expect(build).not.toMatch(/read from/i);
    expect(build).not.toMatch(/rejects/i);
  });

  it("the builder param is the shorter of the two — it is repeated across the whole build surface", () => {
    expect((buildChainIdParam.description ?? "").length).toBeLessThan(
      (chainIdParam.description ?? "").length,
    );
  });

  it("a builder does NOT reject an unconfigured chain — B11 catches it at send time", async () => {
    const res = await call("dexe_proposal_build_external", {
      govPool: "0x" + "55".repeat(20),
      descriptionURL: "ipfs://cid",
      chainId: 999_999,
    });
    expect(res.isError).toBeFalsy();
  });
});
