import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Interface, type JsonRpcProvider } from "ethers";
import { registerGovTools } from "../../src/tools/gov.js";
import { GovAddressResolver } from "../../src/lib/govAddresses.js";
import { RpcProvider } from "../../src/rpc.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { Artifacts } from "../../src/artifacts.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.2 — dexe_read_gov_state resolves a GovPool's helper/NFT addresses through
 * a cache. That cache is now keyed by chain id, but the tool has to SAY which
 * chain it is reading: the same GovPool address exists on 56 and 97 (this repo
 * deploys the same configs to both via the deterministic factory), so a lookup
 * that leaves the chain implicit can be answered from the other chain's entry —
 * a successful-looking read pointing at the wrong settings/userKeeper/validators.
 *
 * The tool takes `chainId`, resolves a provider for it, and must key the cache by
 * the SAME resolution. These tests pin that: the resolver is never left to ask
 * the provider what network it is on (the parameter shipped dead once already),
 * and two chains never share an entry.
 */

const POOL = "0x9820abcdef0123456789abcdef01234567891c38";

const HELPER_IFACE = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
]);

/** Deterministic per-chain address, so a cross-chain cache hit shows up in a diff. */
const addr = (chainId: number, n: number) =>
  `0x${chainId.toString(16).padStart(8, "0")}${n.toString(16).padStart(32, "0")}`;

const SELECTORS = {
  helpers: HELPER_IFACE.getFunction("getHelperContracts")!.selector,
  nfts: HELPER_IFACE.getFunction("getNftContracts")!.selector,
};

interface FakeProvider {
  calls: string[];
  getNetwork: ReturnType<typeof vi.fn>;
  call: (tx: { data?: string | null }) => Promise<string>;
}

/**
 * Minimal ContractRunner returning chain-stamped addresses. `getNetwork` throws
 * AND is spied on: the resolver must never need it, because the caller already
 * knows the chain. On a real provider that call is a round-trip; here it is the
 * tripwire for the chainId argument going unpassed again.
 */
function fakeProvider(chainId: number): FakeProvider {
  const calls: string[] = [];
  return {
    calls,
    getNetwork: vi.fn(async () => {
      throw new Error(`getNetwork() should not be reached — chain ${chainId} was known upfront`);
    }),
    async call(tx: { data?: string | null }): Promise<string> {
      const selector = (tx.data ?? "").slice(0, 10);
      calls.push(selector);
      if (selector === SELECTORS.helpers) {
        return HELPER_IFACE.encodeFunctionResult("getHelperContracts", [
          addr(chainId, 1),
          addr(chainId, 2),
          addr(chainId, 3),
          addr(chainId, 4),
          addr(chainId, 5),
        ]);
      }
      if (selector === SELECTORS.nfts) {
        return HELPER_IFACE.encodeFunctionResult("getNftContracts", [
          addr(chainId, 6),
          addr(chainId, 7),
          addr(chainId, 8),
          addr(chainId, 9),
        ]);
      }
      throw new Error(`fakeProvider: unexpected selector ${selector}`);
    },
  };
}

/** Forces the hand-written ABI path — no compiled protocol artifacts in CI. */
const noArtifacts = {
  requireArtifactsExist() {
    throw new Error("no artifacts compiled");
  },
  get() {
    return [];
  },
} as unknown as Artifacts;

function config(defaultChainId = 56): DexeConfig {
  const chain = (chainId: number) => ({ chainId, rpcUrl: `http://127.0.0.1:9/${chainId}` });
  return {
    defaultChainId,
    chains: new Map([
      [56, chain(56)],
      [97, chain(97)],
    ]),
  } as unknown as DexeConfig;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { helpers: Record<string, string>; nftContracts: Record<string, string> };
}

/**
 * One connected server for the whole session — the GovAddressResolver (and its
 * cache) lives on the registration, so a fresh server per call would hide
 * exactly the cross-chain bleed under test.
 */
async function govSession(cfg: DexeConfig = config()) {
  const providers = new Map<number, FakeProvider>();
  vi.spyOn(RpcProvider.prototype, "tryProvider").mockImplementation((chainId?: number) => {
    const id = chainId ?? (cfg.defaultChainId as number);
    let p = providers.get(id);
    if (!p) {
      p = fakeProvider(id);
      providers.set(id, p);
    }
    return { ok: p as unknown as JsonRpcProvider };
  });

  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerGovTools(server, { config: cfg, artifacts: noArtifacts } as unknown as ToolContext);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    providers,
    async read(args: Record<string, unknown>): Promise<ToolResult> {
      return (await client.callTool({
        name: "dexe_read_gov_state",
        arguments: { govPool: POOL, ...args },
      })) as unknown as ToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dexe_read_gov_state keys its address cache by the chain it read", () => {
  it("passes the resolved chain id — the resolver never asks the provider for its network", async () => {
    const s = await govSession();
    const res = await s.read({ chainId: 97 });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.helpers.settings.toLowerCase()).toBe(addr(97, 1));
    // Dead-parameter tripwire: unpassed chainId falls back to getNetwork().
    expect(s.providers.get(97)!.getNetwork).not.toHaveBeenCalled();
    await s.close();
  });

  it("returns each chain's own helpers for the same pool address", async () => {
    const s = await govSession();
    const mainnet = await s.read({ chainId: 56 });
    const testnet = await s.read({ chainId: 97 });

    expect(mainnet.structuredContent!.helpers.userKeeper.toLowerCase()).toBe(addr(56, 2));
    expect(testnet.structuredContent!.helpers.userKeeper.toLowerCase()).toBe(addr(97, 2));
    expect(testnet.structuredContent!.nftContracts.expertNft.toLowerCase()).toBe(addr(97, 7));
    // Each chain issued its own pair of calls; neither was served from the other.
    expect(s.providers.get(56)!.calls).toEqual([SELECTORS.helpers, SELECTORS.nfts]);
    expect(s.providers.get(97)!.calls).toEqual([SELECTORS.helpers, SELECTORS.nfts]);
    await s.close();
  });

  it("an omitted chainId is keyed under the resolved default, not left implicit", async () => {
    // Default 56, then an explicit 97 through the same server: if the omitted
    // call cached under a chain-less key, the 97 read would inherit it.
    const s = await govSession(config(56));
    const dflt = await s.read({});
    const testnet = await s.read({ chainId: 97 });

    expect(text(dflt)).toContain("(chain 56)");
    expect(text(testnet)).toContain("(chain 97)");
    expect(dflt.structuredContent!.helpers.validators.toLowerCase()).toBe(addr(56, 3));
    expect(testnet.structuredContent!.helpers.validators.toLowerCase()).toBe(addr(97, 3));
    expect(s.providers.get(56)!.getNetwork).not.toHaveBeenCalled();
    expect(s.providers.get(97)!.getNetwork).not.toHaveBeenCalled();
    await s.close();
  });

  it("repeats on one chain still hit the cache (the fix did not disable it)", async () => {
    const s = await govSession();
    await s.read({ chainId: 56 });
    await s.read({ chainId: 56 });
    expect(s.providers.get(56)!.calls).toEqual([SELECTORS.helpers, SELECTORS.nfts]);
    await s.close();
  });
});

describe("every GovAddressResolver cache is chain-scoped", () => {
  /**
   * Guards the class as a whole, not just the two maps that were fixed: a cache
   * added later must go through cacheKey(). If this fails on a new map, chain-key
   * it — or, if it genuinely cannot collide across chains, exempt it here with the
   * reason written down.
   */
  it("holds one entry per (chain, pool) for the same pool on 56 and 97", async () => {
    const resolver = new GovAddressResolver(noArtifacts);
    const p56 = fakeProvider(56) as unknown as JsonRpcProvider;
    const p97 = fakeProvider(97) as unknown as JsonRpcProvider;

    await resolver.resolveHelpers(POOL, p56, 56);
    await resolver.resolveNftContracts(POOL, p56, 56);
    await resolver.resolveHelpers(POOL, p97, 97);
    await resolver.resolveNftContracts(POOL, p97, 97);

    const maps = Object.entries(resolver).filter(
      (e): e is [string, Map<string, unknown>] => e[1] instanceof Map,
    );
    expect(maps.length).toBeGreaterThan(0);
    for (const [name, map] of maps) {
      expect(`${name}: ${[...map.keys()].join(" | ")}`).toBe(
        `${name}: 56:${POOL} | 97:${POOL}`,
      );
    }
  });
});
