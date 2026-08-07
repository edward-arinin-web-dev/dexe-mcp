import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentLedger,
  DAY_MS,
  DEFAULT_MAX_ENTRIES,
  LEDGER_VERSION,
  MAX_MAX_ENTRIES,
  __resetAgentLedgerCache,
  effectiveSpend,
  evaluateBudget,
  getAgentLedger,
  ledgerEnabled,
  maxLedgerEntries,
  normalizeAction,
  resolveLedgerPath,
  summarizeSpend,
  toWeiString,
  type AgentAction,
} from "../../src/lib/agentLedger.js";

/**
 * The ledger is the attribution substrate for 0.32.0 multi-agent orchestration:
 * without it an orchestrator running 8 personas cannot say which agent did what,
 * and SWARM_DAILY_BNB_BUDGET has no number to enforce against. These tests pin
 * the three properties the rest of the release leans on — durability, the
 * retention bound, and the spend arithmetic — plus the degradations that must
 * never throw into a broadcast path.
 */

const dirs: string[] = [];
function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dexe-ledger-"));
  dirs.push(dir);
  return join(dir, "agent-ledger.json");
}

const ENV_KEYS = ["DEXE_AGENT_LEDGER_PATH", "DEXE_AGENT_LEDGER_MAX", "DEXE_AGENT_LEDGER", "DEXE_STATE_PATH"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetAgentLedgerCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const AGENT1 = "0x1111111111111111111111111111111111111111";
const AGENT2 = "0x2222222222222222222222222222222222222222";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function entry(over: Partial<Parameters<AgentLedger["record"]>[0]> = {}) {
  return {
    signerKey: "agent1",
    address: AGENT1,
    chainId: 97,
    tool: "dexe_proposal_create",
    action: "create proposal",
    txHash: hash(1),
    outcome: "broadcast" as const,
    valueWei: 0n,
    gasWei: 1_000n,
    ...over,
  };
}

describe("AgentLedger — durable, attributable record", () => {
  it("records an action and reads it back from a fresh instance (survives the process)", () => {
    const p = tmpLedgerPath();
    const stored = new AgentLedger(p).record(entry({ action: "vote for #3" }));
    expect(stored).not.toBeNull();
    expect(existsSync(p)).toBe(true);

    const reread = new AgentLedger(p).all();
    expect(reread).toHaveLength(1);
    expect(reread[0]).toMatchObject({
      signerKey: "agent1",
      address: AGENT1,
      chainId: 97,
      tool: "dexe_proposal_create",
      action: "vote for #3",
      txHash: hash(1),
      outcome: "broadcast",
    });
    expect(Date.parse(reread[0]!.at)).toBeGreaterThan(0);
  });

  it("keeps the file schema-versioned and leaves no temp files behind", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    l.record(entry());
    l.record(entry({ txHash: hash(2) }));
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.version).toBe(LEDGER_VERSION);
    expect(raw.entries).toHaveLength(2);
    expect(readdirSync(join(p, ".."))).toEqual(["agent-ledger.json"]);
  });

  it("orders newest first", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    l.record(entry({ action: "first" }));
    l.record(entry({ action: "second" }));
    expect(l.all().map((e) => e.action)).toEqual(["second", "first"]);
  });

  it("two instances on one file interleave without losing each other's rows", () => {
    // Proves the read happens INSIDE the write lock: a snapshot taken before the
    // lock would make the second writer publish a state that never saw the first.
    const p = tmpLedgerPath();
    const a = new AgentLedger(p);
    const b = new AgentLedger(p);
    a.record(entry({ signerKey: "agent1", action: "A1" }));
    b.record(entry({ signerKey: "agent2", address: AGENT2, action: "B1" }));
    a.record(entry({ signerKey: "agent1", action: "A2" }));
    expect(new AgentLedger(p).all().map((e) => e.action).sort()).toEqual(["A1", "A2", "B1"]);
  });

  it("caps entries and prunes the oldest (an autonomous fleet writes forever)", () => {
    process.env.DEXE_AGENT_LEDGER_MAX = "12";
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    for (let i = 0; i < 20; i++) l.record(entry({ action: `a${i}`, txHash: hash(i + 1) }));
    const all = l.all();
    expect(all).toHaveLength(12);
    expect(all[0]!.action).toBe("a19");
    expect(all.map((e) => e.action)).not.toContain("a0");
  });

  it("maxLedgerEntries clamps garbage, floors, and ceilings", () => {
    expect(maxLedgerEntries()).toBe(DEFAULT_MAX_ENTRIES);
    process.env.DEXE_AGENT_LEDGER_MAX = "garbage";
    expect(maxLedgerEntries()).toBe(DEFAULT_MAX_ENTRIES);
    process.env.DEXE_AGENT_LEDGER_MAX = "3"; // below the floor
    expect(maxLedgerEntries()).toBe(DEFAULT_MAX_ENTRIES);
    process.env.DEXE_AGENT_LEDGER_MAX = "999999";
    expect(maxLedgerEntries()).toBe(MAX_MAX_ENTRIES);
    process.env.DEXE_AGENT_LEDGER_MAX = "42";
    expect(maxLedgerEntries()).toBe(42);
  });

  it("settles a pending entry with the real outcome and fee (by id and by hash)", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    const rec = l.record(entry({ gasWei: 9_999n }))!;
    l.settle(rec.id, { outcome: "confirmed", gasWei: 2_100n });
    expect(l.all()[0]).toMatchObject({ outcome: "confirmed", gasWei: "2100" });

    l.settle(hash(1), { outcome: "reverted", note: "status 0" });
    const after = l.all()[0]!;
    expect(after.outcome).toBe("reverted");
    expect(after.note).toBe("status 0");
    expect(after.gasWei).toBe("2100");
    expect(l.all()).toHaveLength(1); // settlement updates, never appends
  });

  it("settling an unknown id is a silent no-op", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    l.record(entry());
    l.settle("no-such-id", { outcome: "confirmed" });
    expect(l.all()[0]!.outcome).toBe("broadcast");
  });

  it("degrades to empty on a corrupt or foreign-version file, then republishes", () => {
    const p = tmpLedgerPath();
    writeFileSync(p, "{ not json", "utf8");
    expect(new AgentLedger(p).all()).toEqual([]);
    writeFileSync(p, JSON.stringify({ version: 999, entries: [normalizeAction(entry())] }), "utf8");
    expect(new AgentLedger(p).all()).toEqual([]);
    new AgentLedger(p).record(entry({ action: "after corruption" }));
    expect(new AgentLedger(p).all().map((e) => e.action)).toEqual(["after corruption"]);
  });

  it("never throws when the path is unwritable (a ledger must not fail a landed tx)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ledger-"));
    dirs.push(dir);
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const l = new AgentLedger(join(blocker, "nested", "agent-ledger.json"));
    expect(() => l.record(entry())).not.toThrow();
    expect(l.all()).toEqual([]);
  });

  it("DEXE_AGENT_LEDGER=off disables recording entirely", () => {
    const p = tmpLedgerPath();
    process.env.DEXE_AGENT_LEDGER = "off";
    expect(ledgerEnabled()).toBe(false);
    const l = new AgentLedger(p);
    expect(l.record(entry())).toBeNull();
    expect(existsSync(p)).toBe(false);
    process.env.DEXE_AGENT_LEDGER = "1";
    expect(ledgerEnabled()).toBe(true);
  });

  it("clear() empties the file", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    l.record(entry());
    l.clear();
    expect(l.all()).toEqual([]);
  });
});

describe("AgentLedger.list — filters", () => {
  it("filters by signerKey (case-insensitive), chain, tool, since and limit", () => {
    const l = new AgentLedger(tmpLedgerPath());
    l.record(entry({ signerKey: "agent1", chainId: 97, tool: "dexe_tx_send", action: "a", at: "2026-08-01T00:00:00.000Z" }));
    l.record(
      entry({ signerKey: "agent2", address: AGENT2, chainId: 97, tool: "dexe_agents_fund", action: "b", at: "2026-08-02T00:00:00.000Z" }),
    );
    l.record(entry({ signerKey: "agent1", chainId: 56, tool: "dexe_tx_send", action: "c", at: "2026-08-03T00:00:00.000Z" }));

    expect(l.list({ signerKey: "AGENT1" }).map((e) => e.action).sort()).toEqual(["a", "c"]);
    expect(l.list({ chainId: 56 }).map((e) => e.action)).toEqual(["c"]);
    expect(l.list({ tool: "dexe_agents_fund" }).map((e) => e.action)).toEqual(["b"]);
    expect(l.list({ since: "2026-08-02T00:00:00.000Z" }).map((e) => e.action).sort()).toEqual(["b", "c"]);
    expect(l.list({ limit: 1 })).toHaveLength(1);
  });
});

describe("spend accounting — what a budget guard consults", () => {
  it("sums native value AND gas, per signerKey and in total", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    l.record(entry({ signerKey: "agent1", valueWei: 100n, gasWei: 10n, outcome: "confirmed" }));
    l.record(entry({ signerKey: "agent1", valueWei: 200n, gasWei: 20n, outcome: "confirmed", txHash: hash(2) }));
    l.record(entry({ signerKey: "agent2", address: AGENT2, valueWei: 5n, gasWei: 1n, outcome: "confirmed", txHash: hash(3) }));

    const report = l.spendSince();
    expect(report.total).toMatchObject({ valueWei: "305", gasWei: "31", totalWei: "336", actions: 3 });
    expect(report.byAgent.map((r) => r.signerKey)).toEqual(["agent1", "agent2"]); // biggest spender first
    expect(report.byAgent[0]).toMatchObject({ address: AGENT1, actions: 2, totalWei: "330" });
    expect(report.byAgent[1]).toMatchObject({ signerKey: "agent2", address: AGENT2, totalWei: "6" });
    expect(report.windowMs).toBe(DAY_MS);
  });

  it("charges each outcome honestly: pending counts, revert costs gas only, never-sent costs nothing", () => {
    expect(effectiveSpend({ outcome: "broadcast", valueWei: "10", gasWei: "3" } as AgentAction)).toEqual({ value: 10n, gas: 3n });
    expect(effectiveSpend({ outcome: "confirmed", valueWei: "10", gasWei: "3" } as AgentAction)).toEqual({ value: 10n, gas: 3n });
    expect(effectiveSpend({ outcome: "reverted", valueWei: "10", gasWei: "3" } as AgentAction)).toEqual({ value: 0n, gas: 3n });
    expect(effectiveSpend({ outcome: "failed", valueWei: "10", gasWei: "3" } as AgentAction)).toEqual({ value: 0n, gas: 0n });
  });

  it("excludes entries older than the window and honors a chain filter", () => {
    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    l.record(entry({ valueWei: 1_000n, gasWei: 0n, at: new Date(now - 2 * DAY_MS).toISOString(), outcome: "confirmed" }));
    l.record(entry({ valueWei: 7n, gasWei: 0n, at: new Date(now - 60_000).toISOString(), outcome: "confirmed", txHash: hash(2) }));
    l.record(entry({ valueWei: 9n, gasWei: 0n, chainId: 56, at: new Date(now - 60_000).toISOString(), outcome: "confirmed", txHash: hash(3) }));

    expect(l.spendSince({ now }).total.totalWei).toBe("16"); // the 2-day-old row is out
    expect(l.spendSince({ now, chainId: 97 }).total.totalWei).toBe("7");
    expect(l.spendSince({ now, chainId: 56 }).chainId).toBe(56);
    expect(l.spendSince({ now, windowMs: 3 * DAY_MS }).total.totalWei).toBe("1016");
    expect(l.spendSince({ now }).since).toBe(new Date(now - DAY_MS).toISOString());
  });

  it("summarizeSpend is pure and handles an empty window", () => {
    const r = summarizeSpend([], { since: "2026-08-06T00:00:00.000Z", windowMs: DAY_MS });
    expect(r.total).toMatchObject({ signerKey: "*", actions: 0, totalWei: "0" });
    expect(r.byAgent).toEqual([]);
  });

  it("evaluateBudget makes SWARM_DAILY_BNB_BUDGET enforceable instead of decorative", () => {
    const report = summarizeSpend(
      [{ signerKey: "agent1", outcome: "confirmed", valueWei: "60", gasWei: "0" } as AgentAction],
      { since: "x", windowMs: DAY_MS },
    );
    expect(evaluateBudget(report, 100n)).toMatchObject({
      usedWei: "60",
      remainingWei: "40",
      exceeded: false,
      utilization: 0.6,
    });
    // The tx about to be sent counts BEFORE it is sent — that is the point.
    expect(evaluateBudget(report, 100n, 50n)).toMatchObject({ usedWei: "110", remainingWei: "0", exceeded: true });
    expect(evaluateBudget(report, 60n).exceeded).toBe(false); // exactly at cap is allowed
  });
});

describe("normalization", () => {
  it("normalizes wei from bigint / string / number and refuses negatives", () => {
    expect(toWeiString(5n)).toBe("5");
    expect(toWeiString("42")).toBe("42");
    expect(toWeiString(7)).toBe("7");
    expect(toWeiString(-1n)).toBe("0");
    expect(toWeiString("not-a-number")).toBe("0");
    expect(toWeiString(undefined)).toBe("0");
  });

  it("rejects malformed structure instead of storing it raw", () => {
    const a = normalizeAction({ signerKey: "AGENT 1!", address: "not-an-address", chainId: Number.NaN });
    expect(a.signerKey).toBe("unknown");
    expect(a.address).toBe("");
    expect(a.chainId).toBe(0);
    expect(a.tool).toBe("unknown");
    expect(a.outcome).toBe("broadcast");
    expect(a.id).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("drops a non-hash txHash and clamps runaway text", () => {
    const a = normalizeAction({ signerKey: "agent1", address: AGENT1, chainId: 97, txHash: "0xnope", action: "x".repeat(5_000) });
    expect(a.txHash).toBeUndefined();
    expect(a.action.length).toBeLessThanOrEqual(200);
  });
});

describe("resolveLedgerPath", () => {
  it("prefers the explicit override, then DEXE_AGENT_LEDGER_PATH", () => {
    expect(resolveLedgerPath("/data/l.json")).toBe("/data/l.json");
    process.env.DEXE_AGENT_LEDGER_PATH = "/data/env.json";
    expect(resolveLedgerPath()).toBe("/data/env.json");
  });

  it("otherwise sits next to the state file, so DEXE_STATE_PATH relocates both", () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ledger-"));
    dirs.push(dir);
    process.env.DEXE_STATE_PATH = join(dir, "state.json");
    expect(resolveLedgerPath()).toBe(join(dir, "agent-ledger.json"));
  });

  it("getAgentLedger returns one instance per path", () => {
    const p = tmpLedgerPath();
    expect(getAgentLedger(p)).toBe(getAgentLedger(p));
    expect(getAgentLedger(p)).not.toBe(getAgentLedger(tmpLedgerPath()));
  });
});
