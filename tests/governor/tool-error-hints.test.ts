import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonRpcProvider } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RpcProvider } from "../../src/rpc.js";
import { registerGovernorReadTools } from "../../src/governor/tools/read.js";
import { registerGovernorExtraTools } from "../../src/governor/tools/extras.js";
import { resetGovernorProviderCache } from "../../src/governor/rpc.js";

/**
 * The legacy-id hint and the public-fallback note only matter if they reach the
 * payload a caller actually sees.
 *
 * `notes` in the config does NOT: only `dexe_gov_list_governors` returns it.
 * Before this, a Compound id <= 393 came back as a bare
 * `execution reverted (unknown custom error)` — the id is simply not addressable
 * on the post-migration governor, which no revert string says.
 *
 * So these drive the registered MCP handlers end-to-end against a stub runner,
 * rather than unit-testing the helper in isolation.
 */

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _meta: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

/** A ContractRunner whose every eth_call fails with `message`. */
function failingRpc(message: string, code = "CALL_EXCEPTION"): RpcProvider {
  const provider = {
    call: async () => {
      throw Object.assign(new Error(message), { code });
    },
    getBlockNumber: async () => 1,
    resolveName: async (n: string) => n,
  } as unknown as JsonRpcProvider;
  return { tryProvider: () => ({ ok: provider }) } as unknown as RpcProvider;
}

function textOf(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join("\n");
}

function tools(rpc: RpcProvider): Map<string, Handler> {
  resetGovernorProviderCache();
  const { server, tools } = fakeServer();
  registerGovernorReadTools(server, rpc);
  registerGovernorExtraTools(server, rpc);
  return tools;
}

const UNNAMED_REVERT = "execution reverted (unknown custom error)";
const RETIRED_BRAVO = "0xc0Da02939E1441F497fd74F78cE7Decb17B66529";

describe("legacy-id hint reaches the tool result", () => {
  it.each(["dexe_gov_get_proposal", "dexe_gov_get_state"])(
    "%s names the retired Compound governor for an id <= 393",
    async (tool) => {
      const t = tools(failingRpc(UNNAMED_REVERT));
      const r = await t.get(tool)!({ governor: "compound", proposalId: "374" });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain(RETIRED_BRAVO);
      expect(text).toContain("393");
      expect(text).toContain("0x309a862bbC1A00e45506cB8A802D1ff10004c8C0");
    },
  );

  it("dexe_gov_has_voted names it too", async () => {
    const t = tools(failingRpc(UNNAMED_REVERT));
    const r = await t.get("dexe_gov_has_voted")!({
      governor: "compound",
      proposalId: "1",
      account: "0x0000000000000000000000000000000000000001",
    });
    expect(textOf(r)).toContain(RETIRED_BRAVO);
  });

  it("stays quiet for a current id, and for a governor with no legacy contract", async () => {
    const t = tools(failingRpc(UNNAMED_REVERT));
    const current = await t.get("dexe_gov_get_proposal")!({ governor: "compound", proposalId: "605" });
    expect(textOf(current)).not.toContain(RETIRED_BRAVO);
    const uni = await t.get("dexe_gov_get_proposal")!({ governor: "uniswap", proposalId: "10" });
    expect(textOf(uni)).not.toContain("predates the current governor");
  });
});

describe("read failures are redacted and made actionable", () => {
  it("an endpoint API key in the ethers message never reaches the caller", () => {
    // ethers appends the full request URL to err.message on any non-2xx.
    const leak = "server response 429 (url=https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123)";
    const t = tools(failingRpc(leak, "SERVER_ERROR"));
    return Promise.all(
      ["dexe_gov_get_proposal", "dexe_gov_get_state"].map(async (tool) => {
        const r = await t.get(tool)!({ governor: "uniswap", proposalId: "1" });
        expect(textOf(r), `${tool} leaked the endpoint`).not.toContain("SECRETKEY123");
      }),
    );
  });

  it("an archive refusal is turned into per-chain advice", async () => {
    const t = tools(
      failingRpc('server response 403 {"message":"Archive requests require a personal token"}', "SERVER_ERROR"),
    );
    const r = await t.get("dexe_gov_get_voting_power")!({
      governor: "optimism",
      account: "0x0000000000000000000000000000000000000001",
      blockNumber: 100,
    });
    const text = textOf(r);
    expect(text).toContain("archive node");
    expect(text).toContain("DEXE_RPC_URL_10");
  });
});

describe("public-fallback note is wired into every success payload", () => {
  // Static, so it stays offline: default `npm test` must make zero network
  // calls, and actually exercising the fallback means dialing a public endpoint.
  // The behaviour of `governorProvider` itself is covered in rpc-fallback.test.ts.
  it("every governor tool that takes a provider spreads rpcNote(pr)", () => {
    const root = resolve(__dirname, "..", "..", "src", "governor", "tools");
    for (const file of ["read.ts", "extras.ts", "simulate.ts"]) {
      const src = readFileSync(resolve(root, file), "utf8");
      const providerSites = src.match(/governorProvider\(rpc, cfg\)/g)?.length ?? 0;
      const noteSites =
        (src.match(/\.\.\.rpcNote\(pr\)/g)?.length ?? 0) + (src.match(/\.\.\.note,/g)?.length ?? 0);
      expect(providerSites, `${file} should take a provider somewhere`).toBeGreaterThan(0);
      expect(
        noteSites,
        `${file}: ${providerSites} provider site(s) but only ${noteSites} payload(s) carry the fallback note`,
      ).toBeGreaterThanOrEqual(providerSites);
    }
  });
});
