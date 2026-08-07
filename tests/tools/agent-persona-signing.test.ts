import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Network, Transaction, Wallet } from "ethers";

/**
 * ── Per-agent signing, end to end through the composite loop ────────────────
 *
 * `signerKey` has been threaded through `sendOrCollect` since the keyring
 * landed, and until 0.32.0 nothing verified that the named persona is the
 * account that actually SIGNS. The unit tests covered `resolveKey`; the swarm
 * harness deliberately bypasses the MCP path; so the multi-agent feature users
 * are told about was the least exercised code in the server.
 *
 * These tests close that loop the only way that proves anything: they let a
 * real `ethers.Wallet` sign a real transaction and recover the sender from the
 * signature. `Transaction.from(signedTx).from` is ecrecover — it cannot be
 * satisfied by plumbing that merely passes a label around.
 *
 * The network is the only thing faked: `src/rpc.js` is mocked so
 * `createChainProvider` hands the signer a provider that answers the four calls
 * `populateTransaction` makes and captures the signed payload instead of
 * broadcasting it.
 */

const h = vi.hoisted(() => ({
  /** Every serialized signed transaction that reached the "network". */
  broadcasts: [] as string[],
  chainId: 97,
}));

vi.mock("../../src/rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rpc.js")>();
  const provider = {
    getNetwork: async () => new Network("fake", BigInt(h.chainId)),
    getTransactionCount: async () => 7,
    estimateGas: async () => 21_000n,
    getFeeData: async () => ({ gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null }),
    getBalance: async () => 0n,
    getCode: async () => "0x",
    broadcastTransaction: async (signed: string) => {
      h.broadcasts.push(signed);
      const parsed = Transaction.from(signed);
      const gasPrice = parsed.gasPrice ?? 0n;
      const receipt = {
        hash: parsed.hash,
        status: 1,
        blockNumber: 1,
        gasUsed: 21_000n,
        gasPrice,
        fee: 21_000n * gasPrice,
        logs: [],
      };
      return {
        hash: parsed.hash,
        from: parsed.from,
        chainId: parsed.chainId,
        value: parsed.value,
        gasLimit: parsed.gasLimit,
        gasPrice,
        wait: async () => receipt,
      };
    },
  };
  return {
    ...actual,
    createChainProvider: () => provider,
    // No real RPC anywhere: the B11 code probe fails open on a throw, which is
    // exactly the posture a broadcast with an unreachable node should have.
    RpcProvider: class {
      requireProvider(): never {
        throw new Error("no RPC in this test");
      }
      tryProvider() {
        return { error: "no RPC in this test", remediation: "" };
      }
      resolveChainId() {
        return h.chainId;
      }
    },
  };
});

const { SignerManager } = await import("../../src/lib/signer.js");
const { sendOrCollect, describeBroadcaster } = await import("../../src/tools/flow.js");
const { getAgentLedger, __resetAgentLedgerCache, withActionContext } = await import("../../src/lib/agentLedger.js");
const { __resetBroadcastWindow } = await import("../../src/lib/broadcastGuards.js");
type DexeConfig = import("../../src/config.js").DexeConfig;
type TxPayload = import("../../src/lib/calldata.js").TxPayload;

const PK_PRIMARY = "0x0000000000000000000000000000000000000000000000000000000000000011";
const PK_A1 = "0x0000000000000000000000000000000000000000000000000000000000000012";
const PK_A2 = "0x0000000000000000000000000000000000000000000000000000000000000013";
const ADDR = (pk: string) => new Wallet(pk).address;

const TARGET = "0x1111111111111111111111111111111111111111";

function cfg(agentKeys: Record<string, string> = { agent1: PK_A1, agent2: PK_A2 }): DexeConfig {
  return {
    privateKey: PK_PRIMARY,
    agentKeys,
    defaultChainId: h.chainId,
    chains: new Map([[h.chainId, { chainId: h.chainId, rpcUrl: "http://localhost:0" }]]),
  } as unknown as DexeConfig;
}

function payload(description = "ERC20.approve(0x…)"): TxPayload {
  return {
    to: TARGET,
    data: "0xa9059cbb",
    value: "0",
    chainId: h.chainId,
    description,
  } as unknown as TxPayload;
}

/** The account that cryptographically signed the Nth captured broadcast. */
const senderOf = (i: number) => Transaction.from(h.broadcasts[i]!).from;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexe-persona-"));
  process.env.DEXE_AGENT_LEDGER_PATH = join(dir, "ledger.json");
  __resetAgentLedgerCache();
  __resetBroadcastWindow();
  h.broadcasts.length = 0;
});
afterEach(() => {
  delete process.env.DEXE_AGENT_LEDGER_PATH;
  __resetAgentLedgerCache();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("composite signing — the named persona is the account that signs", () => {
  it("signs with the requested keyring persona, NOT the primary key", async () => {
    const signer = new SignerManager(cfg());
    const res = await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent2" });

    expect(res.mode).toBe("executed");
    expect(h.broadcasts).toHaveLength(1);
    expect(senderOf(0)).toBe(ADDR(PK_A2));
    expect(senderOf(0)).not.toBe(ADDR(PK_PRIMARY));
    expect(res.signer).toEqual({ signerKey: "agent2", address: ADDR(PK_A2) });
  });

  it("omitting signerKey keeps the primary key as the default signer", async () => {
    const signer = new SignerManager(cfg());
    const res = await sendOrCollect(signer, [payload()], { chainId: h.chainId });

    expect(senderOf(0)).toBe(ADDR(PK_PRIMARY));
    expect(res.signer).toEqual({ signerKey: "primary", address: ADDR(PK_PRIMARY) });
  });

  it("selects a persona by address as well as by slot name", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: ADDR(PK_A1).toLowerCase() });
    expect(senderOf(0)).toBe(ADDR(PK_A1));
  });

  it("two personas in one sequence stay distinct (no cached-wallet bleed)", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent1" });
    await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent2" });
    await sendOrCollect(signer, [payload()], { chainId: h.chainId });

    expect([senderOf(0), senderOf(1), senderOf(2)]).toEqual([ADDR(PK_A1), ADDR(PK_A2), ADDR(PK_PRIMARY)]);
  });

  it("every payload in a multi-step flow signs as the same persona", async () => {
    const signer = new SignerManager(cfg());
    const res = await sendOrCollect(
      signer,
      [payload("ERC20.approve"), payload("GovPool.deposit"), payload("GovPool.createProposalAndVote")],
      { chainId: h.chainId, signerKey: "agent1" },
    );

    expect(res.steps).toHaveLength(3);
    expect(h.broadcasts.map((_, i) => senderOf(i))).toEqual([ADDR(PK_A1), ADDR(PK_A1), ADDR(PK_A1)]);
  });

  it("rejects an unknown signerKey with the configured slot list, before broadcasting", async () => {
    const signer = new SignerManager(cfg());
    await expect(
      sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent9" }),
    ).rejects.toThrow(/Unknown signerKey "agent9".*agent1, agent2/s);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("an unknown signerKey names the empty keyring when none is configured", async () => {
    const signer = new SignerManager(cfg({}));
    await expect(sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent1" })).rejects.toThrow(
      /empty — set DEXE_AGENT_PK_1\.\.16/,
    );
  });

  it("a signerKey makes the flow broadcast even when no primary key is set", async () => {
    // The no-signer branch must not swallow an explicitly named persona: with a
    // keyring but no DEXE_PRIVATE_KEY, sendOrCollect used to return payloads.
    const bare = { ...cfg(), privateKey: undefined } as unknown as DexeConfig;
    const signer = new SignerManager(bare);
    const res = await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent1" });
    expect(res.mode).toBe("executed");
    expect(senderOf(0)).toBe(ADDR(PK_A1));
  });
});

describe("attribution — the ledger records which persona did what", () => {
  it("records the signing persona, the tool and the step description", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload("GovPool.deposit(100)")], {
      chainId: h.chainId,
      signerKey: "agent2",
      tool: "dexe_proposal_create",
    });

    const entries = getAgentLedger().all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      signerKey: "agent2",
      address: ADDR(PK_A2),
      chainId: h.chainId,
      tool: "dexe_proposal_create",
      action: "GovPool.deposit(100)",
      outcome: "confirmed",
    });
    expect(entries[0]!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("inherits the tool label from the enclosing handler (how the composites set it)", async () => {
    // dexe_proposal_create / dexe_proposal_vote_and_execute wrap their whole
    // handler in withActionContext and pass no `tool` down. Everything they
    // broadcast — including steps several helpers deep — must still be labelled.
    const signer = new SignerManager(cfg());
    await withActionContext({ tool: "dexe_proposal_vote_and_execute" }, async () => {
      await sendOrCollect(signer, [payload("GovPool.multicall([vote(3)])")], {
        chainId: h.chainId,
        signerKey: "agent1",
      });
    });

    expect(getAgentLedger().all()[0]).toMatchObject({
      tool: "dexe_proposal_vote_and_execute",
      action: "GovPool.multicall([vote(3)])",
      signerKey: "agent1",
    });
  });

  it("labels an unwrapped call site from the stack rather than losing it", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent1" });
    expect(getAgentLedger().all()[0]!.tool).not.toBe("unknown");
  });

  it("separates a fleet's spend per persona", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload("a"), payload("b")], { chainId: h.chainId, signerKey: "agent1" });
    await sendOrCollect(signer, [payload("c")], { chainId: h.chainId, signerKey: "agent2" });

    const report = getAgentLedger().spendSince({ windowMs: 60_000 });
    const byKey = Object.fromEntries(report.byAgent.map((r) => [r.signerKey, r.actions]));
    expect(byKey).toEqual({ agent1: 2, agent2: 1 });
    expect(report.total.actions).toBe(3);
  });

  it("writes no key material into the ledger file", async () => {
    const signer = new SignerManager(cfg());
    await sendOrCollect(signer, [payload()], { chainId: h.chainId, signerKey: "agent1" });

    const raw = JSON.stringify(getAgentLedger().all());
    for (const pk of [PK_PRIMARY, PK_A1, PK_A2]) {
      expect(raw).not.toContain(pk);
      expect(raw).not.toContain(pk.slice(2));
    }
    expect(raw).toContain(ADDR(PK_A1));
  });
});

describe("describeBroadcaster", () => {
  it("labels the primary, a slot, and an address selection", () => {
    const signer = new SignerManager(cfg());
    const wallet = { address: ADDR(PK_PRIMARY) };
    expect(describeBroadcaster(signer, wallet)).toEqual({ signerKey: "primary", address: ADDR(PK_PRIMARY) });
    expect(describeBroadcaster(signer, wallet, "agent1")).toEqual({ signerKey: "agent1", address: ADDR(PK_A1) });
    expect(describeBroadcaster(signer, wallet, ADDR(PK_A2))).toEqual({ signerKey: "agent2", address: ADDR(PK_A2) });
  });

  it("falls back to the wallet's own address rather than throwing", () => {
    const signer = new SignerManager(cfg({}));
    // An unlabelable signer still has to be reported — attribution degrades, it
    // does not fail the broadcast that already happened.
    expect(describeBroadcaster(signer, { address: TARGET }, "ghost")).toEqual({
      signerKey: "ghost",
      address: TARGET,
    });
  });
});
