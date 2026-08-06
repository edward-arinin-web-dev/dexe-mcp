import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadConfig } from "../../src/config.js";

/**
 * 0.30.1 — a bad value in an optional DEXE_* var must NEVER kill the process.
 *
 * Before this release every one of these inputs hit `fatal()` → `process.exit(1)`,
 * which left the user with no MCP tools, no in-band diagnostic, and a dead
 * `npx dexe-mcp doctor` (`process.exit` cannot be caught by doctor's `.catch()`).
 * If any of these assertions ever fail by the test RUNNER dying rather than by a
 * normal assertion error, that regression is back.
 */

const TOUCHED = [
  "DEXE_CHAIN_ID",
  "DEXE_DEFAULT_CHAIN_ID",
  "DEXE_TREASURY_GUARD",
  "DEXE_MIN_SAFE_QUORUM_PCT",
  "DEXE_CONTROLLING_TOPN",
  "DEXE_FORK_BLOCK",
  "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS",
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
  "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
  "DEXE_PRIVATE_KEY",
  "DEXE_RPC_URL",
  "DEXE_RPC_URL_MAINNET",
  "DEXE_RPC_URL_TESTNET",
  "DEXE_DISABLE_PUBLIC_RPC",
] as const;

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of TOUCHED) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** Every advisory var: bad value → documented default + a recorded issue. */
describe("optional env values degrade instead of exiting", () => {
  const cases: { key: string; bad: string; assert: (c: Awaited<ReturnType<typeof loadConfig>>) => void }[] = [
    { key: "DEXE_TREASURY_GUARD", bad: "Warn!", assert: (c) => expect(c.treasuryGuard).toBe("warn") },
    { key: "DEXE_MIN_SAFE_QUORUM_PCT", bad: "50%", assert: (c) => expect(c.minSafeQuorumPct).toBe(50) },
    { key: "DEXE_CONTROLLING_TOPN", bad: "-3", assert: (c) => expect(c.controllingTopN).toBe(5) },
    { key: "DEXE_FORK_BLOCK", bad: "abc", assert: (c) => expect(c.forkBlock).toBeUndefined() },
    {
      key: "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS",
      bad: "0",
      assert: (c) => expect(c.walletConnectApprovalTimeoutMs).toBe(120000),
    },
    { key: "DEXE_CHAIN_ID", bad: "not-a-number", assert: (c) => expect(c.defaultChainId).toBeGreaterThan(0) },
  ];

  for (const { key, bad, assert } of cases) {
    it(`${key}="${bad}" → falls back and records a startup issue`, async () => {
      process.env[key] = bad;
      const config = await loadConfig();
      assert(config);
      expect(config.startupIssues.some((i) => i.key === key)).toBe(true);
      const issue = config.startupIssues.find((i) => i.key === key)!;
      expect(issue.message).toContain(key);
      expect(issue.fallback.length).toBeGreaterThan(0);
    });
  }

  it("a clean environment records no startup issues", async () => {
    const config = await loadConfig();
    expect(config.startupIssues).toEqual([]);
  });

  it("DEXE_DEFAULT_CHAIN_ID pointing at an unconfigured chain degrades, not dies", async () => {
    process.env.DEXE_DEFAULT_CHAIN_ID = "424242";
    const config = await loadConfig();
    // Falls through to the normal auto-selection (public BSC fallback → 56).
    expect(config.chains.has(config.defaultChainId)).toBe(true);
    expect(config.startupIssues.some((i) => i.key === "DEXE_DEFAULT_CHAIN_ID")).toBe(true);
  });
});

/**
 * Broadcast guards are the one exception to "fall back to the default": a guard
 * that degrades into *no guard* would silently widen what an autonomous agent is
 * allowed to send. Those fail CLOSED — signing off, server still up.
 */
describe("malformed broadcast guards fail closed", () => {
  const KEY = "0x" + "11".repeat(32);

  const guards: { key: string; bad: string }[] = [
    { key: "DEXE_SIGNER_ALLOWLIST", bad: "0xnot-an-address" },
    { key: "DEXE_SIGNER_MAX_VALUE_WEI", bad: "1.5" },
    { key: "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN", bad: "0" },
  ];

  for (const { key, bad } of guards) {
    it(`${key}="${bad}" disables signing rather than broadcasting unguarded`, async () => {
      process.env.DEXE_RPC_URL_MAINNET = "https://bsc-dataseed.bnbchain.org";
      process.env.DEXE_PRIVATE_KEY = KEY;
      process.env[key] = bad;
      const config = await loadConfig();
      expect(config.privateKey).toBeUndefined();
      expect(config.agentKeys).toEqual({});
      expect(config.startupIssues.some((i) => i.key === key)).toBe(true);
    });
  }

  it("a VALID guard leaves signing enabled", async () => {
    process.env.DEXE_RPC_URL_MAINNET = "https://bsc-dataseed.bnbchain.org";
    process.env.DEXE_PRIVATE_KEY = KEY;
    process.env.DEXE_SIGNER_MAX_BROADCASTS_PER_MIN = "5";
    const config = await loadConfig();
    expect(config.privateKey).toBe(KEY);
    expect(config.signerMaxBroadcastsPerMin).toBe(5);
    expect(config.startupIssues).toEqual([]);
  });
});

/**
 * A key can pass the hex64 shape check and still be rejected by ethers (all
 * zeros, or at/above the curve order) — and `0x000…0` is exactly what gets
 * pasted out of a template. Before this was guarded, that one value cost the
 * user all 165 tools: `new Wallet()` threw out of loadConfig and the server
 * fell back to the 1-tool degraded mode.
 */
describe("a hex-shaped but cryptographically invalid key degrades to readonly", () => {
  it("DEXE_PRIVATE_KEY=0x000…0 → readonly, server keeps its tools", async () => {
    process.env.DEXE_RPC_URL_MAINNET = "https://bsc-dataseed.bnbchain.org";
    process.env.DEXE_PRIVATE_KEY = "0x" + "00".repeat(32);
    const config = await loadConfig();
    expect(config.privateKey).toBeUndefined();
    const issue = config.startupIssues.find((i) => i.key === "DEXE_PRIVATE_KEY");
    expect(issue).toBeDefined();
    expect(issue!.fallback).toContain("readonly");
  });
});

/**
 * The schema pre-pass deletes the rejected value, so the hand-written handler
 * further down never runs and cannot state the consequence. Telling a user
 * "using the built-in default" when signing was actually switched off would
 * have them expect writes to work while every broadcast is refused.
 */
describe("a schema-rejected value reports the RIGHT consequence", () => {
  it("a malformed broadcast guard says signing was disabled, not 'default used'", async () => {
    process.env.DEXE_RPC_URL_MAINNET = "https://bsc-dataseed.bnbchain.org";
    process.env.DEXE_PRIVATE_KEY = "0x" + "11".repeat(32);
    process.env.DEXE_SIGNER_MAX_VALUE_WEI = "1.5"; // rejected by the schema, not by the later handler
    const config = await loadConfig();
    expect(config.privateKey).toBeUndefined();
    const issue = config.startupIssues.find((i) => i.key === "DEXE_SIGNER_MAX_VALUE_WEI")!;
    expect(issue.fallback).toContain("signing disabled");
    expect(issue.fallback).not.toContain("built-in default");
  });
});

/** A hot key with no RPC is unusable — drop to readonly, do not exit. */
describe("signing prerequisites degrade to readonly", () => {
  it("DEXE_PRIVATE_KEY without any RPC → readonly + issue", async () => {
    process.env.DEXE_DISABLE_PUBLIC_RPC = "1";
    process.env.DEXE_PRIVATE_KEY = "0x" + "22".repeat(32);
    const config = await loadConfig();
    expect(config.chains.size).toBe(0);
    expect(config.privateKey).toBeUndefined();
    expect(config.startupIssues.some((i) => i.key === "DEXE_PRIVATE_KEY")).toBe(true);
  });
});
