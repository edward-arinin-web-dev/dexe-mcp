import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { SignerManager } from "../../src/lib/signer.js";
import { keyringReport } from "../../src/tools/operationalContext.js";
import { getAgentLedger, __resetAgentLedgerCache } from "../../src/lib/agentLedger.js";

/**
 * ── dexe_context reports the fleet ─────────────────────────────────────────
 *
 * An orchestrating agent cannot plan a multi-persona run it cannot see. Before
 * 0.32.0 the keyring was fully wired — parsed from env, resolvable by
 * `SignerManager`, threaded through every composite — and reported by nothing
 * the model calls at session start. `dexe_context` said "signer: one address".
 *
 * It must show the personas WITHOUT ever showing a key: the whole reason the
 * keyring is safe to expose is that only labels and 20-byte addresses leave the
 * process.
 */

const PK_PRIMARY = "0x0000000000000000000000000000000000000000000000000000000000000021";
const PK_A1 = "0x0000000000000000000000000000000000000000000000000000000000000022";
const PK_A2 = "0x0000000000000000000000000000000000000000000000000000000000000023";
const PK_FUNDER = "0x0000000000000000000000000000000000000000000000000000000000000024";
const ADDR = (pk: string) => new Wallet(pk).address;

const ENV_KEYS = [
  "DEXE_PRIVATE_KEY",
  "DEXE_AGENT_PK_1",
  "DEXE_AGENT_PK_2",
  "DEXE_AGENT_FUNDER_PK",
  "DEXE_STATE_PATH",
  "DEXE_AGENT_LEDGER_PATH",
  "DEXE_DISABLE_PUBLIC_RPC",
];

const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetAgentLedgerCache();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dexe-keyring-"));
  dirs.push(dir);
  process.env.DEXE_STATE_PATH = join(dir, "state.json");
  process.env.DEXE_AGENT_LEDGER_PATH = join(dir, "ledger.json");
  __resetAgentLedgerCache();
  return dir;
}

async function callContext(args: Record<string, unknown> = {}) {
  const config = await loadConfig();
  const server = new McpServer({ name: "keyring-test", version: "0.0.0" }, {});
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
  return { parsed: JSON.parse(text), text };
}

describe("dexe_context — the agent keyring is discoverable", () => {
  it("lists every configured persona with the signerKey to pass and its address", async () => {
    scratch();
    process.env.DEXE_PRIVATE_KEY = PK_PRIMARY;
    process.env.DEXE_AGENT_PK_1 = PK_A1;
    process.env.DEXE_AGENT_PK_2 = PK_A2;
    process.env.DEXE_AGENT_FUNDER_PK = PK_FUNDER;

    const { parsed } = await callContext();
    const k = parsed.keyring;

    expect(k.configured).toBe(4);
    expect(k.signers.map((s: { signerKey: string }) => s.signerKey)).toEqual([
      "primary",
      "agent1",
      "agent2",
      "funder",
    ]);
    expect(k.signers.map((s: { address: string }) => s.address)).toEqual([
      ADDR(PK_PRIMARY),
      ADDR(PK_A1),
      ADDR(PK_A2),
      ADDR(PK_FUNDER),
    ]);
    expect(k.signers[0].role).toBe("primary");
    expect(k.signers[1].role).toBe("keyring");
    // The instruction an orchestrator needs: personas are explicit, never implicit.
    expect(k.hint).toMatch(/omitting signerKey always signs with the primary key/);
    expect(k.hint).toMatch(/3 agent persona\(s\)/);
  });

  it("NEVER emits key material — not a key, not a fragment, in the whole response", async () => {
    scratch();
    process.env.DEXE_PRIVATE_KEY = PK_PRIMARY;
    process.env.DEXE_AGENT_PK_1 = PK_A1;

    const { text } = await callContext();
    for (const pk of [PK_PRIMARY, PK_A1]) {
      expect(text).not.toContain(pk);
      expect(text).not.toContain(pk.slice(2));
      expect(text).not.toContain(pk.slice(2).toUpperCase());
    }
    // …while the addresses ARE there: that is the point of the readout.
    expect(text).toContain(ADDR(PK_A1));
  });

  it("tells a single-signer session how to get a fleet", async () => {
    scratch();
    process.env.DEXE_PRIVATE_KEY = PK_PRIMARY;

    const { parsed } = await callContext();
    expect(parsed.keyring.configured).toBe(1);
    expect(parsed.keyring.signers[0].signerKey).toBe("primary");
    expect(parsed.keyring.hint).toMatch(/No agent keyring configured/);
    expect(parsed.keyring.hint).toMatch(/DEXE_AGENT_PK_1\.\.16/);
    expect(parsed.keyring.hint).toMatch(/dexe_proposal_vote_and_execute/);
  });

  it("reports an empty keyring on a readonly install without inventing a signer", async () => {
    scratch();
    const { parsed } = await callContext();
    expect(parsed.keyring.configured).toBe(0);
    expect(parsed.keyring.signers).toEqual([]);
    expect(parsed.keyring.fundedCount).toBeNull();
  });

  it("lists keyring personas even with no primary key (the fleet is signable, the default is not)", async () => {
    scratch();
    process.env.DEXE_AGENT_PK_1 = PK_A1;

    const { parsed } = await callContext();
    expect(parsed.signer.address).toBeNull();
    expect(parsed.keyring.signers).toHaveLength(1);
    expect(parsed.keyring.signers[0]).toMatchObject({ signerKey: "agent1", address: ADDR(PK_A1), role: "keyring" });
  });

  it("does not list one key twice when a slot IS the primary key", async () => {
    scratch();
    process.env.DEXE_PRIVATE_KEY = PK_A1;
    process.env.DEXE_AGENT_PK_1 = PK_A1;

    const { parsed } = await callContext();
    expect(parsed.keyring.signers).toHaveLength(1);
    expect(parsed.keyring.signers[0].signerKey).toBe("primary");
  });

  it("surfaces per-persona 24h activity from the agent ledger (who did what)", async () => {
    const dir = scratch();
    process.env.DEXE_AGENT_PK_1 = PK_A1;
    process.env.DEXE_AGENT_PK_2 = PK_A2;

    const ledger = getAgentLedger(join(dir, "ledger.json"));
    ledger.record({
      signerKey: "agent1",
      address: ADDR(PK_A1),
      chainId: 97,
      tool: "dexe_proposal_create",
      action: "GovPool.createProposalAndVote",
      outcome: "confirmed",
      valueWei: 0n,
      gasWei: 21_000_000_000_000n,
    });
    ledger.record({
      signerKey: "agent1",
      address: ADDR(PK_A1),
      chainId: 97,
      tool: "dexe_proposal_vote_and_execute",
      action: "GovPool.multicall([vote])",
      outcome: "confirmed",
      valueWei: 0n,
      gasWei: 21_000_000_000_000n,
    });

    const { parsed } = await callContext();
    const byKey = Object.fromEntries(
      parsed.keyring.signers.map((s: { signerKey: string; actions24h: number }) => [s.signerKey, s.actions24h]),
    );
    expect(byKey).toEqual({ agent1: 2, agent2: 0 });
    expect(parsed.keyring.spend24h.actions).toBe(2);
    expect(BigInt(parsed.keyring.spend24h.totalWei)).toBe(42_000_000_000_000n);
    // The ledger itself still holds no key material.
    expect(readFileSync(join(dir, "ledger.json"), "utf8")).not.toContain(PK_A1.slice(2));
  });

  it("skips the balance probe when asked, and reports the skip honestly", async () => {
    scratch();
    process.env.DEXE_AGENT_PK_1 = PK_A1;

    const { parsed } = await callContext({ includeAgentBalances: false });
    expect(parsed.keyring.balanceChainId).toBeNull();
    expect(parsed.keyring.signers[0].balanceWei).toBeNull();
    // `funded: null` is "unknown", never a silently optimistic `false`/`true`.
    expect(parsed.keyring.signers[0].funded).toBeNull();
    expect(parsed.keyring.fundedCount).toBeNull();
  });

  it("has no keyring at all when no RPC is configured (config fails closed — the readout must agree)", async () => {
    scratch();
    process.env.DEXE_AGENT_PK_1 = PK_A1;
    process.env.DEXE_DISABLE_PUBLIC_RPC = "1";

    // config.ts disables the keyring when there is no RPC (a key that cannot
    // broadcast is not a persona). The readout must not claim otherwise.
    const { parsed } = await callContext({ includeAgentBalances: undefined });
    expect(parsed.keyring.configured).toBe(0);
    expect(parsed.keyring.signers).toEqual([]);
  });
});

describe("keyringReport — balance probe degrades, never throws", () => {
  const config = { defaultChainId: 97 } as unknown as import("../../src/config.js").DexeConfig;
  const manager = () =>
    new SignerManager({
      privateKey: PK_PRIMARY,
      agentKeys: { agent1: PK_A1, agent2: PK_A2 },
      chains: new Map(),
    } as unknown as import("../../src/config.js").DexeConfig);

  const rpcWith = (getBalance: (addr: string) => Promise<bigint>) =>
    ({ tryProvider: () => ({ ok: { getBalance } }) }) as unknown as import("../../src/rpc.js").RpcProvider;

  it("marks who can pay for their own gas", async () => {
    scratch();
    const balances: Record<string, bigint> = {
      [ADDR(PK_PRIMARY)]: 5n * 10n ** 16n,
      [ADDR(PK_A1)]: 0n,
      [ADDR(PK_A2)]: 1n,
    };
    const report = await keyringReport(config, manager(), rpcWith(async (a) => balances[a]!), true);

    expect(report.balanceChainId).toBe(97);
    expect(report.signers.map((s) => s.funded)).toEqual([true, false, true]);
    expect(report.fundedCount).toBe(2);
    expect(report.signers[1]!.balanceWei).toBe("0");
  });

  it("reports an unfunded fleet as the blocker it is", async () => {
    scratch();
    const report = await keyringReport(config, manager(), rpcWith(async () => 0n), true);
    expect(report.fundedCount).toBe(0);
    expect(report.hint).toMatch(/NONE of them holds native gas yet/);
  });

  it("a rate-limited endpoint yields unknown balances, not a failed context call", async () => {
    scratch();
    const report = await keyringReport(
      config,
      manager(),
      rpcWith(async () => {
        throw new Error("429 Too Many Requests");
      }),
      true,
    );
    expect(report.signers.map((s) => s.balanceWei)).toEqual([null, null, null]);
    expect(report.signers.map((s) => s.funded)).toEqual([null, null, null]);
    expect(report.fundedCount).toBeNull();
    // Still a usable fleet listing: labels and addresses came from the signer.
    expect(report.signers.map((s) => s.signerKey)).toEqual(["primary", "agent1", "agent2"]);
  });

  it("no provider for the default chain → no balances, and it says so", async () => {
    scratch();
    const rpc = { tryProvider: () => ({ error: "no RPC", remediation: "" }) } as unknown as import("../../src/rpc.js").RpcProvider;
    const report = await keyringReport(config, manager(), rpc, true);
    expect(report.balanceChainId).toBeNull();
    expect(report.signers.every((s) => s.balanceWei === null)).toBe(true);
  });

  it("skipping the probe issues no RPC call at all", async () => {
    scratch();
    let calls = 0;
    const report = await keyringReport(
      config,
      manager(),
      rpcWith(async () => {
        calls += 1;
        return 1n;
      }),
      false,
    );
    expect(calls).toBe(0);
    expect(report.configured).toBe(3);
    expect(report.balanceChainId).toBeNull();
  });
});
