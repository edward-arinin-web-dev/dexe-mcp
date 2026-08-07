import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ── dexe_agents_fund is the one tool that exists to move value to hot keys ──
 *
 * Before 0.32.0 it called NO broadcast guard while docs/SECURITY.md published a
 * table saying B6/B7/B9/B10 applied to every broadcast; it compared a native-
 * scale cap (`DEXE_AGENT_FUND_MAX_WEI`, default 1e17 = "0.1") against a raw
 * ERC20 amount, so a 6-decimals token was capped at 1e17 units — a hundred
 * billion tokens; `SWARM_DAILY_BNB_BUDGET` was documented as an enforced spend
 * guard and read by no code in the repo; and it broadcast on the first call
 * with no confirmation step.
 *
 * These tests are written the way an attacker reads the file: every one asks
 * "does it REFUSE, or does it merely mention?" A guard that returns a warning
 * next to a landed transaction is not a guard.
 *
 * The harness fakes the RPC surface (provider, multicall, eth_call preflight)
 * but runs the REAL `runBroadcastGuards`, so B6/B7/B9/B10/B11 are exercised as
 * shipped rather than through a stub that only proves a function was called.
 */

/* ─────────────────────────────── mocked RPC ───────────────────────────────── */

const rpcState = {
  /** native balances by lowercased address */
  balances: new Map<string, bigint>(),
  /** what `getCode` answers for the B11 probe ("0x" = no contract here) */
  code: "0x60016000",
};

vi.mock("../../src/rpc.js", () => ({
  createChainProvider: () => ({
    getBalance: async (addr: string) => rpcState.balances.get(addr.toLowerCase()) ?? 0n,
  }),
  RpcProvider: class {
    requireProvider() {
      return { getCode: async () => rpcState.code };
    }
  },
}));

const simState = { success: true, networkError: false, revertReason: undefined as string | undefined };

vi.mock("../../src/tools/simulate.js", () => ({
  simulateCalldata: async () => ({ ...simState }),
  registerSimTools: () => {},
}));

const tokenState = {
  /** null = the decimals() call fails; a non-integer models a junk answer */
  decimals: 6 as number | null,
  symbol: "USDX" as string | null,
  balances: new Map<string, bigint>(),
  throwMsg: null as string | null,
};

vi.mock("../../src/lib/multicall.js", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  multicall: async (_p: unknown, calls: Array<{ method: string; args: readonly unknown[] }>) => {
    if (tokenState.throwMsg) throw new Error(tokenState.throwMsg);
    return calls.map((c) => {
      if (c.method === "decimals") {
        return tokenState.decimals === null
          ? { success: false, value: null, raw: "0x" }
          : { success: true, value: tokenState.decimals, raw: "0x" };
      }
      if (c.method === "symbol") {
        return tokenState.symbol === null
          ? { success: false, value: null, raw: "0x" }
          : { success: true, value: tokenState.symbol, raw: "0x" };
      }
      if (c.method === "balanceOf") {
        return {
          success: true,
          value: tokenState.balances.get(String(c.args[0]).toLowerCase()) ?? 0n,
          raw: "0x",
        };
      }
      return { success: false, value: null, raw: "0x" };
    });
  },
}));

import { registerAgentTools, dailyBudget, fundCapInUnits, fundTransferTx } from "../../src/tools/agents.js";
import { __resetBroadcastWindow } from "../../src/lib/broadcastGuards.js";
import {
  currentActionContext,
  getAgentLedger,
  __resetAgentLedgerCache,
} from "../../src/lib/agentLedger.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";

/* ───────────────────────────────── harness ───────────────────────────────── */

const PK = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const FUNDER = new Wallet(PK(1)).address;
const A1 = new Wallet(PK(2)).address;
const A2 = new Wallet(PK(3)).address;
const TOKEN = "0x55d398326f99059fF775485246999027B3197955";

const ONE = 10n ** 18n;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolCb = (args: Record<string, unknown>) => Promise<ToolResult>;

interface SentTx {
  to?: string;
  data?: string;
  value?: bigint;
  ctxTool?: string;
  ctxAction?: string;
}

function cfg(partial: Partial<DexeConfig> = {}): DexeConfig {
  return {
    defaultChainId: 97,
    chainId: 97,
    chains: new Map([
      [97, { chainId: 97, rpcUrl: "http://t", rpcUrls: ["http://t"] }],
      [56, { chainId: 56, rpcUrl: "http://m", rpcUrls: ["http://m"] }],
    ]),
    agentKeys: {},
    ...partial,
  } as unknown as DexeConfig;
}

/**
 * A signer whose wallet records the attribution context it was called under and
 * writes the ledger row the real `attachBroadcastRecorder` hook writes. That is
 * what lets the per-transfer budget recheck be observed for what it is: the
 * second leg of a batch must see the first leg's cost.
 */
function fakeSigner(opts: { keyring?: Array<{ signerKey: string; address: string }>; chainId?: number } = {}) {
  const keyring = opts.keyring ?? [
    { signerKey: "agent1", address: A1 },
    { signerKey: "agent2", address: A2 },
  ];
  const sent: SentTx[] = [];
  let n = 0;
  const wallet = {
    address: FUNDER,
    async sendTransaction(tx: { to?: string; data?: string; value?: bigint }) {
      const ctx = currentActionContext();
      sent.push({ ...tx, ctxTool: ctx?.tool, ctxAction: ctx?.action });
      n += 1;
      const hash = `0x${n.toString(16).padStart(64, "0")}`;
      getAgentLedger().record({
        signerKey: "funder",
        address: FUNDER,
        chainId: opts.chainId ?? 97,
        tool: ctx?.tool ?? "unknown",
        action: ctx?.action ?? "",
        txHash: hash,
        outcome: "confirmed",
        valueWei: tx.value ?? 0n,
        gasWei: 0n,
      });
      return {
        hash,
        chainId: BigInt(opts.chainId ?? 97),
        async wait() {
          return { status: 1, hash };
        },
      };
    },
  };
  const signer = {
    listAgents: () => keyring,
    hasSigner: () => true,
    getAddress: () => FUNDER,
    describeSigner: () => ({ signerKey: "funder", address: FUNDER }),
    trySigner: () => ({ ok: wallet }),
    withBroadcastLock: (_c: number, task: () => Promise<unknown>) => task(),
  } as unknown as SignerManager;
  return { signer, sent };
}

function tools(config: DexeConfig, signer: SignerManager): Map<string, ToolCb> {
  const map = new Map<string, ToolCb>();
  const fake = {
    registerTool: (name: string, _c: unknown, cb: ToolCb) => map.set(name, cb),
    tool: (name: string, _d: unknown, _s: unknown, cb: ToolCb) => map.set(name, cb),
  } as unknown as McpServer;
  registerAgentTools(fake, config, signer);
  return map;
}

const body = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const json = (r: ToolResult) => JSON.parse(body(r)) as Record<string, unknown>;

let tmpDir: string;
const ENV_KEYS = [
  "DEXE_AGENT_FUND_MAX_WEI",
  "SWARM_DAILY_BNB_BUDGET",
  "DEXE_AGENT_LEDGER",
  "DEXE_AGENT_LEDGER_PATH",
  "DEXE_AGENT_LEDGER_MAX",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), "dexe-agents-"));
  process.env.DEXE_AGENT_LEDGER_PATH = join(tmpDir, "ledger.json");
  __resetAgentLedgerCache();
  __resetBroadcastWindow();
  rpcState.balances.clear();
  rpcState.code = "0x60016000";
  tokenState.decimals = 6;
  tokenState.symbol = "USDX";
  tokenState.balances.clear();
  tokenState.throwMsg = null;
  simState.success = true;
  simState.networkError = false;
  simState.revertReason = undefined;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  __resetAgentLedgerCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ──────────────────────────── 1. confirmation ────────────────────────────── */

describe("dexe_agents_fund — nothing broadcasts without an explicit confirm", () => {
  it("the first call is a preview: who, how much each, resolved addresses, total, budget", async () => {
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05" });

    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.mode).toBe("preview");
    expect(out.action).toBe("review-then-confirm");
    expect(sent, "a preview must not sign anything").toHaveLength(0);

    const transfers = out.transfers as Array<Record<string, unknown>>;
    expect(transfers.map((t) => t.signerKey)).toEqual(["agent1", "agent2"]);
    expect(transfers.map((t) => t.to)).toEqual([A1, A2]);
    expect(transfers[0]!.amount).toBe("0.05");
    expect((out.total as Record<string, unknown>).amount).toBe("0.1");
    expect(out.budget).toBeDefined();
    expect(String(out.next)).toMatch(/confirm:true/);
  });

  it("dryRun never broadcasts, even when confirm is also true", async () => {
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.05",
      dryRun: true,
      confirm: true,
    });
    expect(json(res).mode).toBe("dryRun");
    expect(sent).toHaveLength(0);
  });

  it("confirm:true is what actually moves value", async () => {
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.to)).toEqual([A1, A2]);
    expect(sent.map((s) => s.value)).toEqual([ONE / 20n, ONE / 20n]);
    expect((json(res).funded as unknown[]).length).toBe(2);
  });

  it("top-up semantics survive the confirm gate — a funded agent is skipped", async () => {
    rpcState.balances.set(A1.toLowerCase(), ONE / 10n); // already above target
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(sent.map((s) => s.to)).toEqual([A2]);
    expect((json(res).funded as Array<Record<string, unknown>>).map((f) => f.signerKey)).toEqual(["agent2"]);
  });
});

/* ─────────────────────── 2. the broadcast guards REFUSE ──────────────────── */

describe("dexe_agents_fund — every transfer runs the broadcast guards", () => {
  it("B6 refuses a destination outside DEXE_SIGNER_ALLOWLIST (refuses, not warns)", async () => {
    const { signer, sent } = fakeSigner();
    const config = cfg({ signerAllowlist: ["0x00000000000000000000000000000000000000ff"] });
    const res = await tools(config, signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    expect(res.isError, "an allowlist miss must fail the call").toBe(true);
    const out = json(res);
    expect(out.status).toBe("rejected");
    expect(out.guard).toBe("B6");
    expect(sent, "nothing may broadcast once a guard refuses").toHaveLength(0);
    expect(String(out.remediation)).toMatch(/DEXE_SIGNER_ALLOWLIST/);
  });

  it("B6 also refuses at preview — a plan that cannot execute is never shown as a plan", async () => {
    const { signer } = fakeSigner();
    const config = cfg({ signerAllowlist: ["0x00000000000000000000000000000000000000ff"] });
    const res = await tools(config, signer).get("dexe_agents_fund")!({ amount: "0.05" });
    expect(res.isError).toBe(true);
    expect(json(res).guard).toBe("B6");
  });

  it("B7 refuses a value above DEXE_SIGNER_MAX_VALUE_WEI", async () => {
    const { signer, sent } = fakeSigner();
    const config = cfg({ signerMaxValueWei: 1n }); // 1 wei
    const res = await tools(config, signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBe(true);
    expect(json(res).guard).toBe("B7");
    expect(sent).toHaveLength(0);
  });

  it("B9 refuses when the eth_call preflight reverts", async () => {
    simState.success = false;
    simState.networkError = false;
    simState.revertReason = "insufficient funds";
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBe(true);
    expect(json(res).guard).toBe("B9");
    expect(sent).toHaveLength(0);
  });

  it("B9 fails OPEN on a transport failure — a flaky RPC must not wedge funding", async () => {
    simState.success = false;
    simState.networkError = true;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
  });

  it("B10 stops the batch at the rate limit — earlier legs land, the next is refused", async () => {
    const { signer, sent } = fakeSigner();
    const config = cfg({ signerMaxBroadcastsPerMin: 1 });
    const res = await tools(config, signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    expect(res.isError).toBe(true);
    const out = json(res);
    expect(out.guard).toBe("B10");
    expect(sent, "exactly one transfer may pass a 1-per-minute limit").toHaveLength(1);
    expect((out.funded as Array<Record<string, unknown>>).map((f) => f.signerKey)).toEqual(["agent1"]);
    expect((out.blockedTransfer as Record<string, unknown>).signerKey).toBe("agent2");
  });

  it("B11 refuses an ERC20 transfer to an address with no contract code on this chain", async () => {
    rpcState.code = "0x"; // the token does not exist here
    tokenState.balances.set(A1.toLowerCase(), 0n);
    tokenState.balances.set(A2.toLowerCase(), 0n);
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.05",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(json(res).guard).toBe("B11");
    expect(sent).toHaveLength(0);
  });

  it("the guarded transaction is the one that would actually be sent", async () => {
    // B6 keyed on the token contract (not the recipient) for an ERC20 leg is
    // what proves the guard sees the real destination rather than a stand-in.
    const { signer, sent } = fakeSigner();
    const config = cfg({ signerAllowlist: [TOKEN.toLowerCase()] });
    const res = await tools(config, signer).get("dexe_agents_fund")!({
      amount: "0.05",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(sent.map((s) => s.to)).toEqual([TOKEN, TOKEN]);
    expect(sent[0]!.data).toBe(fundTransferTx(A1, 50_000n, TOKEN).data);
  });
});

/* ────────────────────── 3. the cap is in the token's units ───────────────── */

describe("dexe_agents_fund — the per-agent cap is denominated in the token's own units", () => {
  it("fundCapInUnits rescales the native-scale env into a token scale", () => {
    expect(fundCapInUnits(18)).toBe(100_000_000_000_000_000n); // 0.1 native
    expect(fundCapInUnits(6)).toBe(100_000n); // 0.1 of a 6-decimals token
    expect(fundCapInUnits(2)).toBe(10n);
    expect(fundCapInUnits(21)).toBe(100_000_000_000_000_000_000n);
    process.env.DEXE_AGENT_FUND_MAX_WEI = "250000000000000000"; // 0.25
    expect(fundCapInUnits(6)).toBe(250_000n);
  });

  it("REGRESSION: 100,000,000,000 units of a 6-decimals token is refused, not waved through", async () => {
    // 1e17 raw units. Pre-0.32.0 the cap compared 1e17 against 1e17 and passed:
    // a hundred billion tokens described as "0.1".
    tokenState.decimals = 6;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "100000000000000000",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/exceeds the funding cap/);
    expect(body(res)).toMatch(/0\.1 USDX/);
    expect(sent).toHaveLength(0);
  });

  it("one whole 6-decimals token already exceeds the 0.1 cap", async () => {
    tokenState.decimals = 6;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "1.0",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/exceeds the funding cap/);
    expect(sent).toHaveLength(0);
  });

  it("an amount inside the rescaled cap is allowed", async () => {
    tokenState.decimals = 6;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.05",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
  });

  it("native funding still caps in native wei", async () => {
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.2", confirm: true });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/exceeds the funding cap/);
    expect(sent).toHaveLength(0);
  });

  it("an 18-decimals token behaves exactly as before (no silent tightening)", async () => {
    tokenState.decimals = 18;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.1",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
  });
});

describe("dexe_agents_fund — an unreadable decimals() FAILS CLOSED", () => {
  it("refuses when decimals() reverts rather than assuming 18", async () => {
    tokenState.decimals = null;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.05",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/Refusing to fund/);
    expect(body(res)).toMatch(/decimals/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when the decimals() read cannot reach the chain at all", async () => {
    tokenState.throwMsg = "SERVER_ERROR 503";
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "0.05",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/Refusing to fund/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a nonsense decimals() instead of rescaling by it", async () => {
    tokenState.decimals = 255;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "1",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/not a usable token scale/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when the cap rescales to zero units (0-decimals token)", async () => {
    tokenState.decimals = 0;
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({
      amount: "1",
      token: TOKEN,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/rescales to 0 units/);
    expect(sent).toHaveLength(0);
  });
});

/* ─────────────────────── 4. SWARM_DAILY_BNB_BUDGET is real ───────────────── */

describe("dailyBudget policy", () => {
  it("arms the documented 0.05 default where the coin is money", () => {
    const b = dailyBudget(56, {} as NodeJS.ProcessEnv);
    expect(b).toEqual({ mode: "enforced", budgetWei: 50_000_000_000_000_000n, source: "default" });
  });

  it("treats an unrecognized chain as real money (fail closed)", () => {
    expect(dailyBudget(1337, {} as NodeJS.ProcessEnv).mode).toBe("enforced");
  });

  it("stays dormant by default on a faucet testnet, where the coin is free", () => {
    const b = dailyBudget(97, {} as NodeJS.ProcessEnv);
    expect(b.mode).toBe("disabled");
    expect(b.mode === "disabled" && b.reason).toMatch(/faucet testnet/);
  });

  it("an explicit budget is enforced on every chain, testnet included", () => {
    const b = dailyBudget(97, { SWARM_DAILY_BNB_BUDGET: "0.5" } as NodeJS.ProcessEnv);
    expect(b).toEqual({ mode: "enforced", budgetWei: 5n * 10n ** 17n, source: "env" });
  });

  it("'off' removes the cap deliberately; 0 is a real zero budget", () => {
    expect(dailyBudget(56, { SWARM_DAILY_BNB_BUDGET: "off" } as NodeJS.ProcessEnv).mode).toBe("disabled");
    const zero = dailyBudget(56, { SWARM_DAILY_BNB_BUDGET: "0" } as NodeJS.ProcessEnv);
    expect(zero).toEqual({ mode: "enforced", budgetWei: 0n, source: "env" });
  });

  it("a value it cannot parse disables SPENDING, not the guard (0.30.1 posture)", () => {
    for (const raw of ["lots", "-1", "0x05", "1e18", "0.05 BNB"]) {
      const b = dailyBudget(56, { SWARM_DAILY_BNB_BUDGET: raw } as NodeJS.ProcessEnv);
      expect(b.mode, `'${raw}' must not silently disappear`).toBe("invalid");
    }
  });
});

describe("dexe_agents_fund — the daily budget blocks the transfer that would exceed it", () => {
  const mainnet = () => cfg({ defaultChainId: 56, chainId: 56 });

  it("refuses outright when the window is already spent", async () => {
    getAgentLedger().record({
      signerKey: "funder",
      address: FUNDER,
      chainId: 56,
      tool: "dexe_dao_create",
      action: "deploy",
      outcome: "confirmed",
      valueWei: 49n * 10n ** 15n, // 0.049 of the 0.05 default
      gasWei: 0n,
    });
    const { signer, sent } = fakeSigner({ chainId: 56 });
    const res = await tools(mainnet(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    expect(res.isError).toBe(true);
    const out = json(res);
    expect(out.guard).toBe("SWARM_DAILY_BNB_BUDGET");
    expect(String(out.reason)).toMatch(/Daily spend budget exceeded/);
    expect(sent, "the budget must block the broadcast, not annotate it").toHaveLength(0);
    expect(out.funded).toEqual([]);
  });

  it("stops a batch exactly at the boundary — the affordable leg lands, the next is refused", async () => {
    // 0.06 budget, 0.05 per agent: agent1 fits, agent2 crosses.
    process.env.SWARM_DAILY_BNB_BUDGET = "0.06";
    const { signer, sent } = fakeSigner({ chainId: 56 });
    const res = await tools(mainnet(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    expect(res.isError).toBe(true);
    const out = json(res);
    expect(out.guard).toBe("SWARM_DAILY_BNB_BUDGET");
    expect(sent).toHaveLength(1);
    expect((out.funded as Array<Record<string, unknown>>).map((f) => f.signerKey)).toEqual(["agent1"]);
    expect((out.blockedTransfer as Record<string, unknown>).signerKey).toBe("agent2");
  });

  it("an unparseable budget refuses the whole call", async () => {
    process.env.SWARM_DAILY_BNB_BUDGET = "plenty";
    const { signer, sent } = fakeSigner({ chainId: 56 });
    const res = await tools(mainnet(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/Refusing to fund/);
    expect(sent).toHaveLength(0);
  });

  it("'off' lets the same batch through — the operator opted out explicitly", async () => {
    process.env.SWARM_DAILY_BNB_BUDGET = "off";
    const { signer, sent } = fakeSigner({ chainId: 56 });
    const res = await tools(mainnet(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
  });

  it("the preview warns before the confirm rather than failing mid-batch", async () => {
    process.env.SWARM_DAILY_BNB_BUDGET = "0.06";
    const { signer } = fakeSigner({ chainId: 56 });
    const out = json(await tools(mainnet(), signer).get("dexe_agents_fund")!({ amount: "0.05" }));
    const budget = out.budget as Record<string, unknown>;
    expect(budget.enforced).toBe(true);
    // `remaining` is what the window has left BEFORE this plan — nothing has
    // been spent yet, so it is the whole budget.
    expect(budget.remaining).toBe("0.06");
    expect(budget.exceeded).toBe(false);
    // …and the plan view says what it would cost and that it does not fit.
    expect(budget.planCost).toBe("0.1");
    expect(budget.wouldExceed).toBe(true);
    expect(budget.remainingAfterPlan).toBe("0.0");
    expect((out.warnings as string[]).join(" ")).toMatch(/SWARM_DAILY_BNB_BUDGET/);
  });

  it("testnet funding is not blocked by a budget nobody set", async () => {
    const { signer, sent } = fakeSigner();
    const res = await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.1", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    expect((json(res).budget as Record<string, unknown>).enforced).toBe(false);
  });
});

/* ───────────────────────── 5. per-transfer attribution ───────────────────── */

describe("dexe_agents_fund — every transfer is recorded funder → recipient", () => {
  it("broadcasts inside an attribution context naming the tool and the recipient", async () => {
    const { signer, sent } = fakeSigner();
    await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    expect(sent.map((s) => s.ctxTool)).toEqual(["dexe_agents_fund", "dexe_agents_fund"]);
    expect(sent[0]!.ctxAction).toContain("agent1");
    expect(sent[0]!.ctxAction).toContain(A1);
    expect(sent[0]!.ctxAction).toContain("0.05");
    expect(sent[1]!.ctxAction).toContain("agent2");
  });

  it("the ledger reads back one row per transfer, attributed to the funding signer", async () => {
    const { signer } = fakeSigner();
    await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", confirm: true });

    const rows = getAgentLedger().list({ tool: "dexe_agents_fund" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.signerKey === "funder")).toBe(true);
    expect(rows.every((r) => r.address === FUNDER)).toBe(true);
    expect(rows.map((r) => r.action).join(" ")).toContain("agent1");
    expect(rows.map((r) => r.action).join(" ")).toContain("agent2");
    expect(rows.map((r) => r.valueWei)).toEqual([(ONE / 20n).toString(), (ONE / 20n).toString()]);
  });

  it("names the ERC20 recipient too, where the tx `to` is the token", async () => {
    tokenState.decimals = 6;
    const { signer, sent } = fakeSigner();
    await tools(cfg(), signer).get("dexe_agents_fund")!({ amount: "0.05", token: TOKEN, confirm: true });
    expect(sent[0]!.to).toBe(TOKEN);
    expect(sent[0]!.ctxAction).toContain("agent1");
    expect(sent[0]!.ctxAction).toContain("USDX");
  });
});
