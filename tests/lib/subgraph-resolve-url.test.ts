import { describe, it, expect } from "vitest";
import { resolveSubgraphUrl, subgraphChains } from "../../src/lib/subgraph.js";
import type { DexeConfig, SubgraphEndpoints } from "../../src/config.js";

/**
 * 0.30.2 — `resolveSubgraphUrl` is the one place that answers "which subgraph
 * for this chain?", and its contract is: the requested chain or an error.
 *
 * The failure it exists to prevent is silent, not loud — a testnet read served
 * from the mainnet endpoint looks exactly like a successful read, and an agent
 * acts on it. So "throws" is the feature here, and the message has to leave the
 * caller with a next move rather than a dead end.
 */

function cfg(
  urls: Record<number, SubgraphEndpoints>,
  defaultChainId = 56,
): DexeConfig {
  return {
    defaultChainId,
    subgraphUrls: new Map(Object.entries(urls).map(([k, v]) => [Number(k), v])),
  } as unknown as DexeConfig;
}

const MAINNET = { pools: "https://gw.example/56/pools", validators: "https://gw.example/56/validators" };
const TESTNET = { pools: "https://gw.example/97/pools" };

describe("resolveSubgraphUrl", () => {
  it("returns the endpoint for the requested chain and echoes that chain back", () => {
    const r = resolveSubgraphUrl(cfg({ 56: MAINNET, 97: TESTNET }), "pools", 97);
    expect(r).toEqual({ url: TESTNET.pools, chainId: 97 });
  });

  it("uses the config's default chain when chainId is omitted", () => {
    const r = resolveSubgraphUrl(cfg({ 56: MAINNET, 97: TESTNET }, 97), "pools");
    expect(r).toEqual({ url: TESTNET.pools, chainId: 97 });
  });

  it("throws for an unconfigured chain instead of serving another chain's data", () => {
    // The regression in one line: mainnet IS configured here, so the old code
    // had an endpoint to hand back for chain 97. It must refuse instead.
    const config = cfg({ 56: MAINNET });
    expect(() => resolveSubgraphUrl(config, "pools", 97)).toThrow(/chain 97/);
  });

  it("throws per kind — a chain indexed for pools is not indexed for validators", () => {
    const config = cfg({ 56: MAINNET, 97: TESTNET });
    expect(resolveSubgraphUrl(config, "pools", 97).url).toBe(TESTNET.pools);
    expect(() => resolveSubgraphUrl(config, "validators", 97)).toThrow(/validators/);
  });

  it("names the chain, the mainnet alternative, the on-chain fallback, and the env var to set", () => {
    let message = "";
    try {
      resolveSubgraphUrl(cfg({ 56: MAINNET }), "pools", 97);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("chain 97");
    expect(message).toContain("chainId: 56");
    expect(message).toContain("dexe_read_gov_state");
    expect(message).toContain("DEXE_SUBGRAPH_POOLS_URL_97");
  });

  it("does not offer mainnet when mainnet is not configured either", () => {
    let message = "";
    try {
      resolveSubgraphUrl(cfg({ 97: TESTNET }), "validators", 97);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("No validators subgraph is configured for ANY chain");
    expect(message).not.toContain("chainId: 56");
    expect(message).toContain("DEXE_SUBGRAPH_VALIDATORS_URL_97");
  });

  it("throws for a chain absent from the map even when it is the default chain", () => {
    expect(() => resolveSubgraphUrl(cfg({ 56: MAINNET }, 97), "pools")).toThrow(/chain 97/);
  });
});

describe("subgraphChains", () => {
  it("lists only the chains that have the requested kind, ascending", () => {
    const config = cfg({ 97: TESTNET, 56: MAINNET });
    expect(subgraphChains(config, "pools")).toEqual([56, 97]);
    expect(subgraphChains(config, "validators")).toEqual([56]);
    expect(subgraphChains(config, "interactions")).toEqual([]);
  });

  it("without a kind, lists chains covered by any of the three subgraphs", () => {
    expect(subgraphChains(cfg({ 56: MAINNET, 97: TESTNET, 1: {} }))).toEqual([56, 97]);
  });
});
