import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  DEFAULTS,
  DEFAULT_SUBGRAPH_CHAIN_ID,
  loadConfig,
  resolveSubgraphEndpoints,
} from "../../src/config.js";
import {
  ENV_REGISTRY,
  PER_CHAIN_SUBGRAPH_URL_RE,
  isKnownEnvKey,
} from "../../src/env/schema.js";

/**
 * 0.30.2 — a subgraph endpoint indexes exactly ONE chain.
 *
 * Before this release the three unsuffixed DEXE_SUBGRAPH_*_URL vars were the
 * whole configuration surface, and their baked defaults index BSC mainnet. A
 * user on BSC testnet (97) therefore got mainnet rows back, presented as
 * theirs. These tests pin the rule that fixes it: an endpoint is resolved per
 * (kind, chain), and a chain with no endpoint gets NO endpoint — never a
 * neighbour's.
 */

const POOLS_97 = "https://indexer.example/testnet/pools";
const POOLS_ENV = "https://indexer.example/legacy/pools";
const VALIDATORS_ENV = "https://indexer.example/legacy/validators";

/** Collect the issues `resolveSubgraphEndpoints` reports, for assertions. */
function withIssues(env: NodeJS.ProcessEnv) {
  const issues: { key: string; message: string; fallback: string }[] = [];
  const result = resolveSubgraphEndpoints(env, (key, message, fallback) =>
    issues.push({ key, message, fallback }),
  );
  return { ...result, issues };
}

describe("resolveSubgraphEndpoints precedence", () => {
  it("the baked defaults cover chain 56 and no other chain", () => {
    const { urls } = withIssues({});
    expect(urls.get(56)).toEqual({
      pools: DEFAULTS.subgraphPoolsUrl,
      validators: DEFAULTS.subgraphValidatorsUrl,
      interactions: DEFAULTS.subgraphInteractionsUrl,
    });
    expect(urls.has(97)).toBe(false);
    expect([...urls.keys()]).toEqual([DEFAULT_SUBGRAPH_CHAIN_ID]);
  });

  it("the unsuffixed var overrides the baked default on chain 56", () => {
    const { urls } = withIssues({ DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV });
    expect(urls.get(56)?.pools).toBe(POOLS_ENV);
    // Untouched kinds keep the baked endpoint.
    expect(urls.get(56)?.validators).toBe(DEFAULTS.subgraphValidatorsUrl);
  });

  it("the per-chain var beats the unsuffixed var on the chain it names", () => {
    const { urls } = withIssues({
      DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV,
      DEXE_SUBGRAPH_POOLS_URL_97: POOLS_97,
    });
    expect(urls.get(97)?.pools).toBe(POOLS_97);
    expect(urls.get(56)?.pools).toBe(POOLS_ENV);
  });

  it("the per-chain var beats both the unsuffixed var and the baked default", () => {
    const own = "https://indexer.example/mainnet/pools";
    const { urls } = withIssues({
      DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV,
      DEXE_SUBGRAPH_POOLS_URL_56: own,
    });
    expect(urls.get(56)?.pools).toBe(own);
  });

  it("a per-chain endpoint never leaks into another chain's entry", () => {
    const { urls } = withIssues({ DEXE_SUBGRAPH_POOLS_URL_97: POOLS_97 });
    expect(urls.get(97)).toEqual({ pools: POOLS_97 });
    expect(urls.get(56)?.pools).toBe(DEFAULTS.subgraphPoolsUrl);
    // 97 has a pools indexer but no validators one — absence must stay absent.
    expect(urls.get(97)?.validators).toBeUndefined();
  });

  it("each kind resolves independently", () => {
    const { urls } = withIssues({
      DEXE_SUBGRAPH_VALIDATORS_URL_97: "https://indexer.example/testnet/validators",
      DEXE_SUBGRAPH_INTERACTIONS_URL_97: "https://indexer.example/testnet/interactions",
    });
    expect(urls.get(97)).toEqual({
      validators: "https://indexer.example/testnet/validators",
      interactions: "https://indexer.example/testnet/interactions",
    });
  });
});

describe("DEXE_SUBGRAPH_CHAIN_ID retargets the unsuffixed vars", () => {
  it("files the unsuffixed endpoints under the declared chain, not 56", () => {
    const { urls, chainId } = withIssues({
      DEXE_SUBGRAPH_CHAIN_ID: "97",
      DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV,
      DEXE_SUBGRAPH_VALIDATORS_URL: VALIDATORS_ENV,
    });
    expect(chainId).toBe(97);
    expect(urls.get(97)).toEqual({ pools: POOLS_ENV, validators: VALIDATORS_ENV });
  });

  it("leaves chain 56 on the baked mainnet endpoints when the unsuffixed vars are retargeted", () => {
    const { urls } = withIssues({
      DEXE_SUBGRAPH_CHAIN_ID: "97",
      DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV,
    });
    expect(urls.get(56)?.pools).toBe(DEFAULTS.subgraphPoolsUrl);
  });

  it("a non-integer chain id falls back to 56 and says so", () => {
    const { chainId, urls, issues } = withIssues({
      DEXE_SUBGRAPH_CHAIN_ID: "bsc-testnet",
      DEXE_SUBGRAPH_POOLS_URL: POOLS_ENV,
    });
    expect(chainId).toBe(56);
    expect(urls.get(56)?.pools).toBe(POOLS_ENV);
    const issue = issues.find((i) => i.key === "DEXE_SUBGRAPH_CHAIN_ID");
    expect(issue?.message).toContain("bsc-testnet");
    expect(issue?.fallback).toContain("56");
  });

  it("a chain id past Number.MAX_SAFE_INTEGER is refused, not silently rounded", () => {
    const { chainId, issues } = withIssues({ DEXE_SUBGRAPH_CHAIN_ID: "9007199254740993" });
    expect(chainId).toBe(56);
    expect(issues.some((i) => i.key === "DEXE_SUBGRAPH_CHAIN_ID")).toBe(true);
  });
});

describe("rejected endpoints are dropped, never applied", () => {
  it("an invalid per-chain URL leaves that chain with no endpoint", () => {
    const { urls, issues } = withIssues({ DEXE_SUBGRAPH_POOLS_URL_97: "pools.example" });
    expect(urls.has(97)).toBe(false);
    const issue = issues.find((i) => i.key === "DEXE_SUBGRAPH_POOLS_URL_97");
    expect(issue?.message).toContain("must be one absolute");
    expect(issue?.message).toContain("e.g.");
    expect(issue?.fallback).toContain("97");
  });

  it("an unusable chain-id suffix is reported and ignored", () => {
    const key = "DEXE_SUBGRAPH_POOLS_URL_99999999999999999999";
    const { urls, issues } = withIssues({ [key]: POOLS_97 });
    expect([...urls.keys()]).toEqual([56]);
    expect(issues.find((i) => i.key === key)?.message).toContain("chain-id suffix");
  });

  it("an invalid unsuffixed URL does not knock chain 56 off the baked default", () => {
    const { urls, issues } = withIssues({ DEXE_SUBGRAPH_POOLS_URL: "not a url" });
    expect(urls.get(56)?.pools).toBe(DEFAULTS.subgraphPoolsUrl);
    expect(issues.some((i) => i.key === "DEXE_SUBGRAPH_POOLS_URL")).toBe(true);
  });
});

describe("loadConfig exposes both shapes", () => {
  const TOUCHED = [
    "DEXE_SUBGRAPH_CHAIN_ID",
    "DEXE_SUBGRAPH_POOLS_URL",
    "DEXE_SUBGRAPH_VALIDATORS_URL",
    "DEXE_SUBGRAPH_INTERACTIONS_URL",
  ];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DEXE_SUBGRAPH_")) saved.set(k, process.env[k]);
    }
    for (const k of TOUCHED) saved.set(k, process.env[k]);
    for (const k of saved.keys()) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it("the flat legacy fields still hold the baked mainnet defaults with nothing set", async () => {
    const config = await loadConfig();
    expect(config.subgraphPoolsUrl).toBe(DEFAULTS.subgraphPoolsUrl);
    expect(config.subgraphValidatorsUrl).toBe(DEFAULTS.subgraphValidatorsUrl);
    expect(config.subgraphInteractionsUrl).toBe(DEFAULTS.subgraphInteractionsUrl);
    expect(config.subgraphChainId).toBe(56);
  });

  it("the flat legacy fields still hold the unsuffixed env values for chain 56", async () => {
    process.env.DEXE_SUBGRAPH_POOLS_URL = POOLS_ENV;
    process.env.DEXE_SUBGRAPH_VALIDATORS_URL = VALIDATORS_ENV;
    const config = await loadConfig();
    expect(config.subgraphPoolsUrl).toBe(POOLS_ENV);
    expect(config.subgraphValidatorsUrl).toBe(VALIDATORS_ENV);
    expect(config.subgraphInteractionsUrl).toBe(DEFAULTS.subgraphInteractionsUrl);
    expect(config.subgraphUrls.get(56)?.pools).toBe(POOLS_ENV);
  });

  it("a per-chain endpoint reaches subgraphUrls without disturbing chain 56", async () => {
    process.env.DEXE_SUBGRAPH_POOLS_URL_97 = POOLS_97;
    const config = await loadConfig();
    expect(config.subgraphUrls.get(97)?.pools).toBe(POOLS_97);
    expect(config.subgraphPoolsUrl).toBe(DEFAULTS.subgraphPoolsUrl);
  });

  it("chains with no endpoint are absent from subgraphUrls", async () => {
    const config = await loadConfig();
    expect(config.subgraphUrls.has(97)).toBe(false);
    expect(config.subgraphUrls.has(1)).toBe(false);
  });
});

describe("env schema recognizes the per-chain family", () => {
  it("PER_CHAIN_SUBGRAPH_URL_RE matches DEXE_SUBGRAPH_<KIND>_URL_<digits> only", () => {
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_POOLS_URL_97")).toBe(true);
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_VALIDATORS_URL_56")).toBe(true);
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_INTERACTIONS_URL_1")).toBe(true);
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_POOLS_URL")).toBe(false);
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_POOLS_URL_TESTNET")).toBe(false);
    expect(PER_CHAIN_SUBGRAPH_URL_RE.test("DEXE_SUBGRAPH_CHAIN_ID")).toBe(false);
  });

  it("captures the kind and the chain id", () => {
    const m = PER_CHAIN_SUBGRAPH_URL_RE.exec("DEXE_SUBGRAPH_VALIDATORS_URL_97");
    expect(m?.[1]).toBe("VALIDATORS");
    expect(m?.[2]).toBe("97");
  });

  it("isKnownEnvKey accepts per-chain subgraph vars so doctor cannot call them typos", () => {
    // env/loader.ts builds `unknownDexeVars` from exactly this predicate.
    expect(isKnownEnvKey("DEXE_SUBGRAPH_POOLS_URL_97")).toBe(true);
    expect(isKnownEnvKey("DEXE_SUBGRAPH_INTERACTIONS_URL_56")).toBe(true);
    expect(isKnownEnvKey("DEXE_RPC_URL_10")).toBe(true);
    // A real typo still has to be caught.
    expect(isKnownEnvKey("DEXE_SUBGRAPH_POOL_URL_97")).toBe(false);
    expect(isKnownEnvKey("DEXE_SUBGRAPH_POOLS_URLL")).toBe(false);
  });

  it("DEXE_SUBGRAPH_CHAIN_ID is registered and documented", () => {
    const entry = ENV_REGISTRY.DEXE_SUBGRAPH_CHAIN_ID;
    expect(entry.category).toBe("subgraph");
    expect(entry.doc).toContain("56");
    expect(entry.schema.safeParse("97").success).toBe(true);
    expect(entry.schema.safeParse("bsc").success).toBe(false);
  });
});
