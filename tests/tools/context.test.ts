import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { StateStore } from "../../src/lib/stateStore.js";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.DEXE_STATE_PATH;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Returns BOTH forms. The wire text is what the model pays for — the tool
 * pretty-prints with `JSON.stringify(result, null, 2)` — so a budget assertion
 * that re-stringifies the parsed object compactly measures ~13% less than
 * reality and would pass a response that busted the budget.
 */
async function callContextRaw(statePath: string, args: Record<string, unknown> = {}) {
  process.env.DEXE_STATE_PATH = statePath;
  const config = await loadConfig();
  const server = new McpServer({ name: "ctx-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = (await client.callTool({
    name: "dexe_context",
    arguments: { includeDepositedPower: false, includeAgentBalances: false, ...args },
  })) as { content: { type: string; text: string }[] };
  const text = res.content[0]!.text;
  await client.close();
  await server.close();
  return { json: JSON.parse(text), text };
}

async function callContext(statePath: string) {
  return (await callContextRaw(statePath)).json;
}

describe("dexe_context persistence (Phase 3 acceptance)", () => {
  it("surfaces a DAO recorded in a prior session, without any lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");

    // "Session 1" — a deploy auto-records the DAO.
    new StateStore(statePath).recordDao({
      name: "Meridian Collective",
      govPool: "0xf113630C0000000000000000000000000000abcd",
      chainId: 97,
      token: "0xToken",
      txHash: "0xdeadbeef",
      deployedAt: "2026-07-04T00:00:00.000Z",
    });

    // "Session 2" — a fresh server + dexe_context reads it back.
    const ctx = await callContext(statePath);
    expect(ctx.knownDaos).toHaveLength(1);
    expect(ctx.knownDaos[0].name).toBe("Meridian Collective");
    expect(ctx.chain.lastUsedChainId).toBe(97);
    // No hot key in tests, but the baked default WalletConnect project id makes
    // WC signing available out of the box → mode is "walletconnect" with no
    // wallet connected yet (address null; actual signing still gated on connect).
    expect(ctx.signer.mode).toBe("walletconnect");
    expect(ctx.signer.address).toBeNull();
    expect(ctx.env).toHaveProperty("toolsets");
    expect(ctx.hint).toContain("Meridian Collective");
  });

  it("reports an empty-but-valid context on a fresh install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-"));
    dirs.push(dir);
    const ctx = await callContext(join(dir, "state.json"));
    expect(ctx.knownDaos).toEqual([]);
    expect(ctx.recentProposals).toEqual([]);
    expect(ctx.hint).toMatch(/No DAOs recorded/);
  });
});

describe("dexe_context response budget", () => {
  /**
   * D12-2. The tool's own description tells every model to call it first, and
   * it dumped the persisted arrays whole: the store's MAX_DAOS=50 /
   * MAX_PROPOSALS=25 are a DISK RETENTION policy, not a response budget. On a
   * machine with 31 recorded DAOs that measured ~18.6k chars of history in an
   * orientation call, paid at the start of most sessions.
   */
  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-budget-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = new StateStore(statePath);
    for (let i = 0; i < 50; i++) {
      store.recordDao({
        name: `d${i}`,
        govPool: `0x${String(i).padStart(40, "0")}`,
        chainId: 97,
        token: `0x${String(i).padStart(40, "f")}`,
        txHash: `0x${String(i).padStart(64, "b")}`,
        deployedAt: "2026-07-04T00:00:00.000Z",
      });
    }
    for (let i = 0; i < 25; i++) {
      store.recordProposal({
        govPool: `0x${String(i).padStart(40, "0")}`,
        chainId: 97,
        title: `Proposal number ${i} — a realistic length title for a DAO vote`,
        descriptionURL: `ipfs://bafybeih${String(i).padStart(45, "q")}`,
        txHash: `0x${String(i).padStart(64, "c")}`,
        createdAt: "2026-07-04T00:00:00.000Z",
      });
    }
    return statePath;
  }

  it("windows a full history to 8 DAOs / 5 proposals and reports the totals", async () => {
    const { json } = await callContextRaw(seeded());
    expect(json.knownDaos).toHaveLength(8);
    expect(json.knownDaosTotal).toBe(50);
    expect(json.knownDaosTruncated).toBe(true);
    expect(json.recentProposals).toHaveLength(5);
    expect(json.recentProposalsTotal).toBe(25);
    expect(json.recentProposalsTruncated).toBe(true);
  });

  it("cuts the orientation payload by more than half on a full history", async () => {
    const p = seeded();
    const windowed = await callContextRaw(p);
    const full = await callContextRaw(p, { daoLimit: 50, proposalLimit: 50 });
    // The ratio is the regression guard (immune to fixture drift); the
    // absolute ceiling catches an unrelated field blowing up.
    expect(windowed.text.length).toBeLessThan(full.text.length / 2);
    expect(windowed.text.length).toBeLessThan(12_000);
  });

  it("returns the most RECENT entries, not the oldest", async () => {
    const { json } = await callContextRaw(seeded());
    expect(json.knownDaos[0].name).toBe("d49");
    expect(json.knownDaos.map((d: { name: string }) => d.name)).not.toContain("d0");
  });

  it("daoLimit:50 returns everything and drops the truncation flag", async () => {
    const { json } = await callContextRaw(seeded(), { daoLimit: 50 });
    expect(json.knownDaos).toHaveLength(50);
    expect(json.knownDaosTruncated).toBeUndefined();
  });

  it("names the remedy in the hint, and only for the list actually trimmed", async () => {
    const { json } = await callContextRaw(seeded());
    expect(json.hint).toContain('dexe_context {"daoLimit":50,"proposalLimit":50}');
    expect(json.hint).toContain("8 most recent DAO(s) of 50");
    expect(json.hint).toContain("5 most recent proposal(s) of 25");
  });

  it("says nothing about a window when nothing was trimmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-small-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    new StateStore(statePath).recordDao({
      name: "Solo",
      govPool: "0xf113630C0000000000000000000000000000abcd",
      chainId: 97,
      deployedAt: "2026-07-04T00:00:00.000Z",
    });
    const { json } = await callContextRaw(statePath);
    expect(json.hint).not.toContain("Showing");
    expect(json.knownDaosTruncated).toBeUndefined();
  });

  it("names only the trimmed list when the other one is empty", async () => {
    // recordProposal does not require a recorded DAO, so 0 DAOs + 25 proposals
    // is reachable — and "the 8 most recent DAO(s) of 0" next to "No DAOs
    // recorded yet." is nonsense.
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-nodao-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = new StateStore(statePath);
    for (let i = 0; i < 25; i++) {
      store.recordProposal({
        govPool: "0xf113630C0000000000000000000000000000abcd",
        chainId: 97,
        title: `p${i}`,
        createdAt: "2026-07-04T00:00:00.000Z",
      });
    }
    const { json } = await callContextRaw(statePath);
    expect(json.hint).toContain("No DAOs recorded yet");
    expect(json.hint).not.toContain("DAO(s) of 0");
    expect(json.hint).toContain("5 most recent proposal(s) of 25");
  });

  it("daoLimit:0 returns an empty list but still reports the total", async () => {
    // `lastDaoPower` and the "Most recent DAO:" hint clause read knownDaos[0]
    // before the slice, by design — they are keyed by govPool, so they are
    // self-describing.
    const { json } = await callContextRaw(seeded(), { daoLimit: 0 });
    expect(json.knownDaos).toEqual([]);
    expect(json.knownDaosTotal).toBe(50);
  });

  it("caps walletLabels in the response even for a state.json written by an older build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-labels-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const labels: Record<string, string> = {};
    for (let i = 0; i < 300; i++) labels[`0x${String(i).padStart(40, "0")}`] = `label-${i}`;
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, knownDaos: [], recentProposals: [], walletLabels: labels }),
      "utf8",
    );
    const { json } = await callContextRaw(statePath);
    expect(Object.keys(json.walletLabels)).toHaveLength(50);
  });
});
