import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { SignerManager } from "../../src/lib/signer.js";
import type { DexeConfig } from "../../src/config.js";
import {
  AgentLedger,
  __resetAgentLedgerCache,
  __resetLedgerSecrets,
  attachBroadcastRecorder,
  currentActionContext,
  inferToolFromStack,
  withActionContext,
} from "../../src/lib/agentLedger.js";

/**
 * Item 3 of the attribution substrate: the signer resolves keys, so the signer
 * is where the record has to be taken.
 *
 * `dexe_agents_fund` shipped broadcasting native + ERC20 transfers with every
 * broadcast guard bypassed, because guarding was something each call site had to
 * remember. A logging call is exactly as forgettable, so attribution is attached
 * to the wallet itself at creation: any call site that ever gets a signer —
 * `dexe_tx_send`, the composite flow loop, `dexe_agents_fund`, an ethers
 * Contract connected to it, anything added later — is recorded without opting
 * in, and cannot opt out by forgetting.
 */

const PK_PRIMARY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const PK_A1 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const PK_A2 = "0x0000000000000000000000000000000000000000000000000000000000000003";
const ADDR = (pk: string) => new Wallet(pk).address;
const HASH = `0x${"12".repeat(32)}`;

const dirs: string[] = [];
function tmpLedger(): AgentLedger {
  const dir = mkdtempSync(join(tmpdir(), "dexe-attrib-"));
  dirs.push(dir);
  return new AgentLedger(join(dir, "agent-ledger.json"));
}

function cfg(partial: Partial<DexeConfig>): DexeConfig {
  return { agentKeys: {}, chains: new Map(), ...partial } as unknown as DexeConfig;
}

let savedPath: string | undefined;
let savedSwitch: string | undefined;
beforeEach(() => {
  savedPath = process.env.DEXE_AGENT_LEDGER_PATH;
  savedSwitch = process.env.DEXE_AGENT_LEDGER;
  delete process.env.DEXE_AGENT_LEDGER_PATH;
  delete process.env.DEXE_AGENT_LEDGER;
  __resetAgentLedgerCache();
  __resetLedgerSecrets();
});
afterEach(() => {
  if (savedPath === undefined) delete process.env.DEXE_AGENT_LEDGER_PATH;
  else process.env.DEXE_AGENT_LEDGER_PATH = savedPath;
  if (savedSwitch === undefined) delete process.env.DEXE_AGENT_LEDGER;
  else process.env.DEXE_AGENT_LEDGER = savedSwitch;
  __resetLedgerSecrets();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Minimal ethers-shaped wallet: enough surface for the recorder, no network. */
function fakeWallet(opts: { fail?: Error; status?: number; gasUsed?: bigint } = {}) {
  const calls: unknown[] = [];
  const wallet = {
    address: ADDR(PK_A1),
    async sendTransaction(tx: { value?: bigint }) {
      calls.push(tx);
      if (opts.fail) throw opts.fail;
      return {
        hash: HASH,
        value: tx?.value ?? 0n,
        gasLimit: 30_000n,
        gasPrice: 1_000_000_000n,
        async wait() {
          return {
            status: opts.status ?? 1,
            gasUsed: opts.gasUsed ?? 21_000n,
            gasPrice: 1_000_000_000n,
            hash: HASH,
          };
        },
      };
    },
  };
  return { wallet, calls };
}

describe("attachBroadcastRecorder — every broadcast is attributable", () => {
  it("records the signerKey, address, chain, hash, tool and description", async () => {
    const ledger = tmpLedger();
    const { wallet } = fakeWallet();
    attachBroadcastRecorder(wallet, { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 }, ledger);

    await withActionContext({ tool: "dexe_agents_fund", action: "top up agent3" }, () =>
      wallet.sendTransaction({ value: 5_000n } as never),
    );

    const [e] = ledger.all();
    expect(e).toMatchObject({
      signerKey: "agent1",
      address: ADDR(PK_A1),
      chainId: 97,
      tool: "dexe_agents_fund",
      action: "top up agent3",
      txHash: HASH,
      outcome: "broadcast",
      valueWei: "5000",
    });
    // Pending gas is the upper bound (gasLimit × price) — over-counting is the
    // safe direction for a budget guard.
    expect(e!.gasWei).toBe((30_000n * 1_000_000_000n).toString());
  });

  it("settles to confirmed with the ACTUAL fee once the receipt lands", async () => {
    const ledger = tmpLedger();
    const { wallet } = fakeWallet({ gasUsed: 21_000n });
    attachBroadcastRecorder(wallet, { signerKey: "agent2", address: ADDR(PK_A2), chainId: 56 }, ledger);

    const tx = (await wallet.sendTransaction({ value: 0n } as never)) as { wait: () => Promise<unknown> };
    expect(ledger.all()[0]!.outcome).toBe("broadcast");
    await tx.wait();

    const [e] = ledger.all();
    expect(e!.outcome).toBe("confirmed");
    expect(e!.gasWei).toBe((21_000n * 1_000_000_000n).toString());
    expect(ledger.all()).toHaveLength(1); // settled in place, not appended
  });

  it("a mined revert costs gas but not value", async () => {
    const ledger = tmpLedger();
    const { wallet } = fakeWallet({ status: 0 });
    attachBroadcastRecorder(wallet, { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 }, ledger);
    const tx = (await wallet.sendTransaction({ value: 1_000n } as never)) as { wait: () => Promise<unknown> };
    await tx.wait();

    expect(ledger.all()[0]!.outcome).toBe("reverted");
    const spend = ledger.spendSince();
    expect(spend.total.valueWei).toBe("0");
    expect(spend.total.gasWei).toBe((21_000n * 1_000_000_000n).toString());
  });

  it("records a broadcast that never left the process, and rethrows it untouched", async () => {
    const ledger = tmpLedger();
    const boom = new Error("insufficient funds for intrinsic transaction cost");
    const { wallet } = fakeWallet({ fail: boom });
    attachBroadcastRecorder(wallet, { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 }, ledger);

    await expect(
      withActionContext({ tool: "dexe_tx_send", action: "vote" }, () => wallet.sendTransaction({ value: 9n } as never)),
    ).rejects.toBe(boom);

    const [e] = ledger.all();
    expect(e).toMatchObject({ outcome: "failed", tool: "dexe_tx_send", action: "vote" });
    expect(e!.note).toContain("insufficient funds");
    // A tx that never left the process spends nothing.
    expect(ledger.spendSince().total.totalWei).toBe("0");
  });

  it("attributes an un-instrumented call site from the stack instead of losing it", async () => {
    const ledger = tmpLedger();
    const { wallet } = fakeWallet();
    attachBroadcastRecorder(wallet, { signerKey: "funder", address: ADDR(PK_PRIMARY), chainId: 97 }, ledger);
    await wallet.sendTransaction({ value: 1n } as never); // no withActionContext

    const [e] = ledger.all();
    expect(e!.signerKey).toBe("funder");
    expect(e!.tool).toBeTruthy(); // "unknown" at worst, never absent
    expect(e!.action).toContain("value 1 wei"); // derived description
  });

  it("inferToolFromStack picks the nearest src/tools frame", () => {
    const stack = [
      "Error",
      "    at sendTransaction (D:\\dev\\dexe-mcp\\src\\lib\\agentLedger.ts:1:1)",
      "    at handler (D:\\dev\\dexe-mcp\\src\\tools\\agents.ts:273:20)",
      "    at run (D:\\dev\\dexe-mcp\\src\\tools\\index.ts:87:5)",
    ].join("\n");
    expect(inferToolFromStack(stack)).toBe("tools/agents");
    expect(inferToolFromStack("no frames here")).toBeUndefined();
  });

  it("is idempotent — re-attaching never double-records", async () => {
    const ledger = tmpLedger();
    const { wallet, calls } = fakeWallet();
    const attribution = { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 };
    attachBroadcastRecorder(wallet, attribution, ledger);
    attachBroadcastRecorder(wallet, attribution, ledger);
    await wallet.sendTransaction({ value: 0n } as never);
    expect(ledger.all()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("a ledger that cannot write never breaks the broadcast", async () => {
    const unwritable = new AgentLedger(join(tmpdir(), "dexe-attrib-missing", "\0bad", "l.json"));
    const { wallet } = fakeWallet();
    attachBroadcastRecorder(wallet, { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 }, unwritable);
    const tx = (await wallet.sendTransaction({ value: 1n } as never)) as { hash: string; wait: () => Promise<unknown> };
    expect(tx.hash).toBe(HASH);
    await expect(tx.wait()).resolves.toBeTruthy();
  });

  it("respects the DEXE_AGENT_LEDGER=off kill switch", async () => {
    const ledger = tmpLedger();
    process.env.DEXE_AGENT_LEDGER = "off";
    const { wallet } = fakeWallet();
    attachBroadcastRecorder(wallet, { signerKey: "agent1", address: ADDR(PK_A1), chainId: 97 }, ledger);
    await wallet.sendTransaction({ value: 1n } as never);
    expect(ledger.all()).toEqual([]);
  });

  it("per-agent attribution separates who spent what", async () => {
    const ledger = tmpLedger();
    for (const [slot, pk, value] of [
      ["agent1", PK_A1, 10n],
      ["agent2", PK_A2, 30n],
    ] as const) {
      const { wallet } = fakeWallet();
      wallet.address = ADDR(pk);
      attachBroadcastRecorder(wallet, { signerKey: slot, address: ADDR(pk), chainId: 97 }, ledger);
      await wallet.sendTransaction({ value } as never);
    }
    const spend = ledger.spendSince({ chainId: 97 });
    expect(spend.byAgent.map((r) => r.signerKey)).toEqual(["agent2", "agent1"]);
    expect(spend.byAgent.find((r) => r.signerKey === "agent1")!.valueWei).toBe("10");
    expect(spend.byAgent.find((r) => r.signerKey === "agent2")!.address).toBe(ADDR(PK_A2));
  });
});

describe("withActionContext", () => {
  it("is async-local: the label survives awaits and does not leak out", async () => {
    expect(currentActionContext()).toBeUndefined();
    const seen = await withActionContext({ tool: "dexe_dao_create", action: "deploy" }, async () => {
      await Promise.resolve();
      return currentActionContext();
    });
    expect(seen).toEqual({ tool: "dexe_dao_create", action: "deploy" });
    expect(currentActionContext()).toBeUndefined();
  });
});

describe("SignerManager.describeSigner — who is acting", () => {
  const sm = new SignerManager(
    cfg({ privateKey: PK_PRIMARY, agentKeys: { agent1: PK_A1, funder: PK_A2 } }),
  );

  it("labels the primary signer, keyring slots, and address selection", () => {
    expect(sm.describeSigner()).toEqual({ signerKey: "primary", address: ADDR(PK_PRIMARY) });
    expect(sm.describeSigner("AGENT1")).toEqual({ signerKey: "agent1", address: ADDR(PK_A1) });
    expect(sm.describeSigner("funder")).toEqual({ signerKey: "funder", address: ADDR(PK_A2) });
    // Selected by address → still resolves to the slot label, not "unknown".
    expect(sm.describeSigner(ADDR(PK_A2).toLowerCase())).toEqual({ signerKey: "funder", address: ADDR(PK_A2) });
    expect(sm.describeSigner(ADDR(PK_PRIMARY))).toEqual({ signerKey: "primary", address: ADDR(PK_PRIMARY) });
  });

  it("a key that is BOTH primary and a keyring slot is attributed to the identity used", () => {
    const dual = new SignerManager(cfg({ privateKey: PK_A1, agentKeys: { agent1: PK_A1 } }));
    expect(dual.describeSigner().signerKey).toBe("primary");
    expect(dual.describeSigner("agent1").signerKey).toBe("agent1");
  });

  it("rejects an unknown slot with the configured list (unchanged behavior)", () => {
    expect(() => sm.describeSigner("agent9")).toThrow(/agent1, funder/);
  });
});

describe("SignerManager.requireSigner — instruments the wallet it hands out", () => {
  it("every wallet leaves this class already attributed", () => {
    const chains = new Map<number, unknown>([
      [97, { chainId: 97, rpcUrl: "http://127.0.0.1:1/never-called", rpcUrls: ["http://127.0.0.1:1/never-called"] }],
    ]);
    const sm = new SignerManager(
      cfg({ privateKey: PK_PRIMARY, agentKeys: { agent1: PK_A1 }, defaultChainId: 97, chains: chains as never }),
    );
    const wallet = sm.requireSigner(97, "agent1");
    expect(wallet.address).toBe(ADDR(PK_A1));
    // Own property = the recorder shadows the prototype method for THIS wallet.
    const own = Object.getOwnPropertyDescriptor(wallet, "sendTransaction");
    expect(typeof own?.value).toBe("function");
    // Still a real ethers Wallet — signing must be untouched by instrumentation.
    expect(wallet).toBeInstanceOf(Wallet);
    expect(sm.requireSigner(97, "agent1")).toBe(wallet); // cached, attached once
  });
});
