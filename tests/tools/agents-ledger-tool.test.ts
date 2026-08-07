import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentTools } from "../../src/tools/agents.js";
import { TOOLSETS, defaultProfileToolNames, resolveToolsets } from "../../src/tools/gate.js";
import {
  getAgentLedger,
  registerLedgerSecrets,
  __resetAgentLedgerCache,
  __resetLedgerSecrets,
  type AgentActionInput,
} from "../../src/lib/agentLedger.js";
import type { DexeConfig } from "../../src/config.js";
import type { SignerManager } from "../../src/lib/signer.js";

/**
 * ── dexe_agents_ledger: the reconciliation half of orchestration ────────────
 *
 * An orchestrator that can launch eight personas and cannot afterwards say
 * which one did what, or what the run cost, has shipped half a feature. The
 * ledger substrate records it; this tool is the only way an agent can read it
 * back, so these tests pin the three questions it must answer:
 *
 *   who did what        → `recent`, attributed per signerKey, newest first
 *   what did it cost    → `spend`, per agent and in total, value + gas
 *   how much is left    → `budget`, the live SWARM_DAILY_BNB_BUDGET remainder
 *
 * It is a pure local read: no RPC, no signer, no keyring required. That matters
 * because reconciliation is exactly what you reach for when something has
 * already gone wrong — possibly with the chain you can no longer reach.
 */

const ADDR = (n: number) => new Wallet(`0x${n.toString(16).padStart(64, "0")}`).address;
const AG1 = ADDR(2);
const AG2 = ADDR(3);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolCb = (args: Record<string, unknown>) => Promise<ToolResult>;

function cfg(defaultChainId = 97): DexeConfig {
  return {
    defaultChainId,
    chainId: defaultChainId,
    chains: new Map([[defaultChainId, { chainId: defaultChainId, rpcUrl: "http://x", rpcUrls: ["http://x"] }]]),
    agentKeys: {},
  } as unknown as DexeConfig;
}

/** No keyring, no key: the ledger tool must not need either. */
const bareSigner = {
  listAgents: () => [],
  hasSigner: () => false,
} as unknown as SignerManager;

function ledgerTool(config: DexeConfig = cfg()): ToolCb {
  const map = new Map<string, ToolCb>();
  const fake = {
    registerTool: (name: string, _c: unknown, cb: ToolCb) => map.set(name, cb),
    tool: (name: string, _d: unknown, _s: unknown, cb: ToolCb) => map.set(name, cb),
  } as unknown as McpServer;
  registerAgentTools(fake, config, bareSigner);
  return map.get("dexe_agents_ledger")!;
}

const json = (r: ToolResult) => JSON.parse(r.content.map((c) => c.text).join("\n")) as Record<string, unknown>;

function seed(...rows: AgentActionInput[]): void {
  // Oldest first, so `newest first` ordering is a real assertion.
  for (const r of rows) getAgentLedger().record(r);
}

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let tmpDir: string;
const ENV_KEYS = ["SWARM_DAILY_BNB_BUDGET", "DEXE_AGENT_LEDGER", "DEXE_AGENT_LEDGER_PATH"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), "dexe-ledger-tool-"));
  process.env.DEXE_AGENT_LEDGER_PATH = join(tmpDir, "ledger.json");
  __resetAgentLedgerCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  __resetAgentLedgerCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the agent tools live in a toolset built for orchestration", () => {
  it("`agents` gates the whole trio — list, fund, reconcile", () => {
    expect([...TOOLSETS.agents!].sort()).toEqual([
      "dexe_agents_fund",
      "dexe_agents_ledger",
      "dexe_agents_list",
    ]);
  });

  it("keeps the two pre-0.32 tools in `vote` as well, so DEXE_TOOLSETS=vote is unchanged", () => {
    expect(TOOLSETS.vote!.has("dexe_agents_list")).toBe(true);
    expect(TOOLSETS.vote!.has("dexe_agents_fund")).toBe(true);
  });

  it("stays out of the default profile — a fleet surface is opt-in", () => {
    const def = defaultProfileToolNames();
    for (const t of TOOLSETS.agents!) expect(def.has(t), `${t} must not be default-visible`).toBe(false);
  });

  it("`core,agents` is the one env var that turns the fleet on", () => {
    const r = resolveToolsets(["core", "agents"]);
    expect(r.full).toBe(false);
    for (const t of TOOLSETS.agents!) expect(r.names!.has(t)).toBe(true);
  });
});

describe("dexe_agents_ledger", () => {
  it("registers under a name an orchestrator can find", () => {
    expect(ledgerTool()).toBeTypeOf("function");
  });

  it("answers 'who did what' — attributed history, newest first", async () => {
    seed(
      {
        signerKey: "agent1",
        address: AG1,
        chainId: 97,
        tool: "dexe_proposal_create",
        action: "create proposal 4",
        outcome: "confirmed",
        at: ago(2 * HOUR),
      },
      {
        signerKey: "agent2",
        address: AG2,
        chainId: 97,
        tool: "dexe_proposal_vote_and_execute",
        action: "vote FOR on 4",
        outcome: "reverted",
        note: "low voting power",
        at: ago(HOUR),
      },
    );

    const out = json(await ledgerTool()({}));
    const recent = out.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(2);
    expect(recent[0]!.signerKey).toBe("agent2");
    expect(recent[0]!.tool).toBe("dexe_proposal_vote_and_execute");
    expect(recent[0]!.outcome).toBe("reverted");
    expect(recent[0]!.note).toBe("low voting power");
    expect(recent[1]!.signerKey).toBe("agent1");
    expect(recent[1]!.address).toBe(AG1);
  });

  it("answers 'what did it cost' — per-agent and total, value plus gas", async () => {
    seed(
      { signerKey: "agent1", address: AG1, chainId: 97, outcome: "confirmed", valueWei: 100n, gasWei: 7n },
      { signerKey: "agent2", address: AG2, chainId: 97, outcome: "confirmed", valueWei: 5n, gasWei: 3n },
      { signerKey: "agent1", address: AG1, chainId: 97, outcome: "reverted", valueWei: 1000n, gasWei: 2n },
    );

    const spend = json(await ledgerTool()({})).spend as Record<string, unknown>;
    const total = spend.total as Record<string, unknown>;
    // agent1: 100 + 7 + (reverted → gas only) 2 = 109; agent2: 8.
    expect(total.totalWei).toBe("117");
    expect(total.actions).toBe(3);
    const byAgent = spend.byAgent as Array<Record<string, unknown>>;
    expect(byAgent.map((a) => a.signerKey)).toEqual(["agent1", "agent2"]);
    expect(byAgent[0]!.totalWei).toBe("109");
    expect(byAgent[0]!.address).toBe(AG1);
    expect(byAgent[1]!.totalWei).toBe("8");
  });

  it("answers 'how much is left' — the live SWARM_DAILY_BNB_BUDGET remainder", async () => {
    process.env.SWARM_DAILY_BNB_BUDGET = "0.05";
    seed({
      signerKey: "funder",
      address: AG1,
      chainId: 97,
      tool: "dexe_agents_fund",
      action: "fund agent1",
      outcome: "confirmed",
      valueWei: 10n ** 16n, // 0.01
    });

    const budget = json(await ledgerTool()({})).budget as Record<string, unknown>;
    expect(budget.enforced).toBe(true);
    expect(budget.source).toBe("env");
    expect(budget.budget).toBe("0.05");
    expect(budget.used).toBe("0.01");
    expect(budget.remaining).toBe("0.04");
    expect(budget.exceeded).toBe(false);
    expect(budget.utilization).toBe(0.2);
  });

  it("reports the budget as unenforced on a faucet testnet, with the reason", async () => {
    const budget = json(await ledgerTool()({})).budget as Record<string, unknown>;
    expect(budget.enforced).toBe(false);
    expect(String(budget.reason)).toMatch(/faucet testnet/);
    expect(budget.env).toBe("SWARM_DAILY_BNB_BUDGET");
  });

  it("surfaces a malformed budget rather than reading as 'no budget'", async () => {
    process.env.SWARM_DAILY_BNB_BUDGET = "heaps";
    const out = json(await ledgerTool()({}));
    expect((out.budget as Record<string, unknown>).enforced).toBe(false);
    expect(String(out.warning)).toMatch(/SWARM_DAILY_BNB_BUDGET/);
  });

  it("filters by signerKey — one persona's actions, not the fleet's", async () => {
    seed(
      { signerKey: "agent1", address: AG1, chainId: 97, action: "a1" },
      { signerKey: "agent2", address: AG2, chainId: 97, action: "a2" },
    );
    const out = json(await ledgerTool()({ signerKey: "AGENT2" }));
    const recent = out.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0]!.action).toBe("a2");
    expect(out.signerKey).toBe("AGENT2");
    // The spend view stays fleet-wide on purpose: a per-agent filter must not
    // make the shared budget look emptier than it is.
    expect((out.spend as Record<string, { actions: number }>).total.actions).toBe(2);
  });

  it("filters by tool — 'what did the funding pass actually do'", async () => {
    seed(
      { signerKey: "funder", address: AG1, chainId: 97, tool: "dexe_agents_fund", action: "fund agent1" },
      { signerKey: "agent1", address: AG1, chainId: 97, tool: "dexe_tx_send", action: "vote" },
    );
    const recent = json(await ledgerTool()({ tool: "dexe_agents_fund" })).recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0]!.action).toBe("fund agent1");
  });

  it("scopes to one chain — testnet noise never inflates a mainnet reconciliation", async () => {
    seed(
      { signerKey: "agent1", address: AG1, chainId: 97, valueWei: 5n, outcome: "confirmed" },
      { signerKey: "agent1", address: AG1, chainId: 56, valueWei: 9n, outcome: "confirmed" },
    );
    const t = ledgerTool();
    expect(((json(await t({})).spend as Record<string, { totalWei: string }>).total).totalWei).toBe("5");
    expect(((json(await t({ chainId: 56 })).spend as Record<string, { totalWei: string }>).total).totalWei).toBe("9");
  });

  it("needs no RPC for the chain it reports on — reconcile what you can no longer reach", async () => {
    seed({ signerKey: "agent1", address: AG1, chainId: 424_242, valueWei: 3n, outcome: "confirmed" });
    // 424242 is absent from the config's chain map; resolveChain would throw.
    const out = json(await ledgerTool()({ chainId: 424_242 }));
    expect(out.chainId).toBe(424_242);
    expect((out.spend as Record<string, { totalWei: string }>).total.totalWei).toBe("3");
  });

  it("honours the window — an action older than it is out of both views", async () => {
    seed(
      { signerKey: "agent1", address: AG1, chainId: 97, valueWei: 4n, outcome: "confirmed", at: ago(48 * HOUR) },
      { signerKey: "agent1", address: AG1, chainId: 97, valueWei: 6n, outcome: "confirmed", at: ago(HOUR) },
    );
    const t = ledgerTool();
    const day = json(await t({}));
    expect((day.recent as unknown[]).length).toBe(1);
    expect((day.spend as Record<string, { totalWei: string }>).total.totalWei).toBe("6");
    expect((day.window as Record<string, unknown>).hours).toBe(24);

    const week = json(await t({ windowHours: 168 }));
    expect((week.recent as unknown[]).length).toBe(2);
    expect((week.spend as Record<string, { totalWei: string }>).total.totalWei).toBe("10");
  });

  it("caps the history with `limit` — a 500-entry fleet log is not a tool result", async () => {
    for (let i = 0; i < 30; i += 1) {
      seed({ signerKey: "agent1", address: AG1, chainId: 97, action: `step ${i}` });
    }
    const out = json(await ledgerTool()({ limit: 5 }));
    expect((out.recent as unknown[]).length).toBe(5);
    // Trimming the history must not trim the accounting.
    expect((out.spend as Record<string, { actions: number }>).total.actions).toBe(30);
  });

  it("says the kill switch is on instead of implying the fleet did nothing", async () => {
    process.env.DEXE_AGENT_LEDGER = "off";
    const out = json(await ledgerTool()({}));
    const ledger = out.ledger as Record<string, unknown>;
    expect(ledger.enabled).toBe(false);
    expect(String(ledger.note)).toMatch(/DEXE_AGENT_LEDGER is off/);
    expect(out.recent).toEqual([]);
  });

  it("reads an empty ledger as empty, not as an error", async () => {
    const out = json(await ledgerTool()({}));
    expect(out.recent).toEqual([]);
    expect((out.spend as Record<string, { totalWei: string }>).total.totalWei).toBe("0");
    expect((out.ledger as Record<string, unknown>).enabled).toBe(true);
  });

  it("returns addresses and slot labels only — a configured key never reaches the output", async () => {
    // The tool is the last hop before key-shaped bytes would land in the model
    // context, so the guarantee has to hold at THIS boundary, not just in the
    // file: register the key the way SignerManager does, then push it through
    // every field a caller controls.
    const pk = `0x${"ab".repeat(32)}`;
    registerLedgerSecrets([pk]);
    try {
      seed({
        signerKey: "agent1",
        address: AG1,
        chainId: 97,
        tool: "dexe_tx_send",
        action: `leaked ${pk}`,
        note: `and again ${pk}`,
        txHash: pk,
      });
      const text = (await ledgerTool()({})).content.map((c) => c.text).join("\n");
      expect(text).toContain(AG1);
      expect(text).not.toContain(pk.slice(2));
      expect(text).not.toContain(pk.slice(2).toUpperCase());
      expect(text).toContain("redacted");
    } finally {
      __resetLedgerSecrets();
    }
  });
});
