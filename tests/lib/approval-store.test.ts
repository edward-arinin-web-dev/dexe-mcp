import { describe, it, expect, vi } from "vitest";
import { keccak256 } from "ethers";
import {
  ApprovalDeviationError,
  ApprovalStore,
  dataHashOf,
  matchesExpected,
  type NewApproval,
} from "../../src/lib/approval/store.js";
import { ApprovedSigner, type SendCapable } from "../../src/lib/approval/approvedSigner.js";
import { computeBatchHash, fingerprintOf } from "../../src/lib/approval/review.js";

/**
 * 2c Phase A — the approval state machine. A fake clock drives TTLs and
 * lockouts; nothing here touches the network.
 */
const FROM = "0x2222222222222222222222222222222222222222";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x3333333333333333333333333333333333333333";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function batch(over: Partial<NewApproval> = {}): NewApproval {
  const steps = [
    { to: A, value: "0", data: "0x12345678" },
    { to: B, value: "5", data: "0xabcdef01" },
  ];
  const batchHash = computeBatchHash(97, FROM, steps);
  return {
    tool: "dexe_proposal_create",
    chainId: 97,
    from: FROM,
    steps: [],
    expected: steps.map((s) => ({ to: s.to, value: BigInt(s.value), dataHash: dataHashOf(s.data) })),
    prechecks: { guards: "pass", simulation: "pass" },
    batchHash,
    fingerprint: fingerprintOf(batchHash),
    ...over,
  };
}

function holder() {
  return { drop: vi.fn() };
}

describe("batch binding", () => {
  const steps = [
    { to: A, value: "0", data: "0x12345678" },
    { to: B, value: "5", data: "0xabcdef01" },
  ];
  const h = computeBatchHash(97, FROM, steps);

  it("changes with order, recipient, value, calldata, chain and sender", () => {
    expect(computeBatchHash(97, FROM, [steps[1]!, steps[0]!])).not.toBe(h);
    expect(computeBatchHash(97, FROM, [{ ...steps[0]!, to: B }, steps[1]!])).not.toBe(h);
    expect(computeBatchHash(97, FROM, [steps[0]!, { ...steps[1]!, value: "6" }])).not.toBe(h);
    expect(computeBatchHash(97, FROM, [{ ...steps[0]!, data: "0x12345679" }, steps[1]!])).not.toBe(h);
    expect(computeBatchHash(56, FROM, steps)).not.toBe(h);
    expect(computeBatchHash(97, A, steps)).not.toBe(h);
    // Address case does not matter.
    expect(computeBatchHash(97, FROM.toUpperCase().replace("0X", "0x"), steps)).toBe(h);
  });

  it("fingerprints are short, stable and human-comparable", () => {
    expect(fingerprintOf(h)).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(fingerprintOf(h)).toBe(fingerprintOf(h));
  });

  it("matchesExpected compares to/value/calldata exactly", () => {
    const exp = { to: A, value: 0n, dataHash: keccak256("0x12345678") };
    expect(matchesExpected(exp, { to: A.toUpperCase().replace("0X", "0x"), value: "0", data: "0x12345678" })).toBe(true);
    expect(matchesExpected(exp, { to: A, value: "1", data: "0x12345678" })).toBe(false);
    expect(matchesExpected(exp, { to: B, value: "0", data: "0x12345678" })).toBe(false);
    expect(matchesExpected(exp, { to: A, value: "0", data: "0x12345679" })).toBe(false);
    expect(matchesExpected(exp, { to: A, value: "not a number", data: "0x12345678" })).toBe(false);
  });
});

describe("state machine", () => {
  it("pending → approved → executing → consumed, dropping the key at the end", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now });
    const r = store.create(batch());
    expect(r.status).toBe("pending");
    const h = holder();
    expect(store.approve(r.approvalId, h)).toBe(true);
    expect(store.get(r.approvalId)!.status).toBe("approved");
    expect(store.take(r.approvalId)).toBe(h);
    expect(store.get(r.approvalId)!.status).toBe("executing");
    store.finish(r.approvalId);
    expect(store.get(r.approvalId)!.status).toBe("consumed");
    expect(h.drop).toHaveBeenCalled();
  });

  it("is single-use: a consumed approval cannot be taken again (replay)", () => {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const r = store.create(batch());
    store.approve(r.approvalId, holder());
    store.take(r.approvalId);
    store.finish(r.approvalId);
    expect(store.take(r.approvalId)).toBeUndefined();
    expect(store.findByBatch(r.batchHash, "approved")).toBeUndefined();
  });

  it("expires pending AND approved-unused approvals at the TTL, dropping the key", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 60_000, now: c.now });
    const p = store.create(batch());
    const a = store.create(batch({ tool: "dexe_tx_send" }));
    const h = holder();
    store.approve(a.approvalId, h);
    c.advance(60_001);
    expect(store.get(p.approvalId)!.status).toBe("expired");
    expect(store.get(a.approvalId)!.status).toBe("expired");
    expect(h.drop).toHaveBeenCalled();
    expect(store.take(a.approvalId)).toBeUndefined();
  });

  it("five wrong passwords decline the approval and lock password entry, growing each time", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now, baseLockoutMs: 60_000 });
    const r1 = store.create(batch());
    for (let i = 0; i < 4; i++) expect(store.recordFailure(r1.approvalId).declined).toBe(false);
    expect(store.lockedForMs()).toBe(0);
    expect(store.recordFailure(r1.approvalId)).toEqual({ declined: true, remaining: 0, lockedMs: 60_000 });
    expect(store.get(r1.approvalId)!.status).toBe("declined");
    expect(store.lockedForMs()).toBe(60_000);

    c.advance(60_000);
    expect(store.lockedForMs()).toBe(0);
    const r2 = store.create(batch({ tool: "dexe_tx_send" }));
    for (let i = 0; i < 5; i++) store.recordFailure(r2.approvalId);
    expect(store.lockedForMs()).toBe(120_000);
  });

  it("the lockout is GLOBAL: wrong passwords on fresh approvals add up (review bypass: 5 approvals x 4 guesses)", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now, maxPending: 10, maxCreatesPerMinute: 100 });
    const ids = [0, 1, 2, 3, 4].map((i) => store.create(batch({ tool: `t${i}` })).approvalId);
    // One guess on each of five fresh approvals — no per-approval counter reaches 5.
    for (let i = 0; i < 4; i++) {
      expect(store.recordFailure(ids[i]!).lockedMs).toBe(0);
    }
    expect(store.lockedForMs()).toBe(0);
    expect(store.recordFailure(ids[4]!).lockedMs).toBe(60_000);
    expect(store.lockedForMs()).toBe(60_000);
    // None of them was declined — the counter that bit is the global one.
    for (const id of ids) expect(store.get(id)!.status).toBe("pending");
  });

  it("a correct password does not reset the global count, and the lockout keeps doubling for the process lifetime", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now, maxPending: 10, maxCreatesPerMinute: 100 });
    const a = store.create(batch({ tool: "a" })).approvalId;
    for (let i = 0; i < 4; i++) store.recordFailure(a);
    store.approve(a, holder()); // the owner finally types it right
    const b = store.create(batch({ tool: "b" })).approvalId;
    expect(store.recordFailure(b).lockedMs).toBe(60_000); // 5th failure overall, despite the success
    c.advance(60_000);
    for (let i = 0; i < 5; i++) store.recordFailure(b);
    expect(store.lockedForMs()).toBe(120_000);
    c.advance(120_000);
    const d = store.create(batch({ tool: "d" })).approvalId;
    for (let i = 0; i < 5; i++) store.recordFailure(d);
    expect(store.lockedForMs()).toBe(240_000);
  });

  it("caps open approvals and the rate at which new ones are created", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now });
    const r = [0, 1, 2].map((i) => store.create(batch({ tool: `p${i}` })));
    const full = store.admitCreate();
    expect(full.ok).toBe(false);
    expect(!full.ok && full.reason).toMatch(/already waiting/);
    // Declining frees a slot, but only 6 creations per rolling minute.
    for (const x of r) store.decline(x.approvalId);
    for (let i = 0; i < 3; i++) {
      expect(store.admitCreate().ok).toBe(true);
      store.decline(store.create(batch({ tool: `q${i}` })).approvalId);
    }
    const rate = store.admitCreate();
    expect(rate.ok).toBe(false);
    expect(!rate.ok && rate.reason).toMatch(/last minute/);
    c.advance(60_001);
    expect(store.admitCreate().ok).toBe(true);
  });

  it("drops an approved key that is not used within the use window", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now, useWindowMs: 120_000 });
    const r = store.create(batch());
    const h = holder();
    store.approve(r.approvalId, h);
    c.advance(119_999);
    expect(store.get(r.approvalId)!.status).toBe("approved");
    c.advance(2);
    expect(store.get(r.approvalId)!.status).toBe("expired");
    expect(store.get(r.approvalId)!.reason).toMatch(/not used within 120 s/);
    expect(h.drop).toHaveBeenCalled();
    expect(store.take(r.approvalId)).toBeUndefined();
  });

  it("a declined batch is refused for the cooldown, then may be asked again", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 900_000, now: c.now });
    const r = store.create(batch());
    store.decline(r.approvalId);
    expect(store.recentDecline(r.batchHash)?.approvalId).toBe(r.approvalId);
    c.advance(10 * 60_000 - 1);
    expect(store.recentDecline(r.batchHash)).toBeDefined();
    c.advance(2);
    expect(store.recentDecline(r.batchHash)).toBeUndefined();
  });

  it("a newer approval for the same flow supersedes an approved-unused one", () => {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const first = store.create(batch());
    const h1 = holder();
    store.approve(first.approvalId, h1);
    const second = store.create(batch({ batchHash: "0x" + "ab".repeat(32) }));
    store.approve(second.approvalId, holder());
    expect(store.get(first.approvalId)!.status).toBe("revoked");
    expect(h1.drop).toHaveBeenCalled();
  });

  it("revoke remembers what landed for the next approval of the same flow", () => {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const r = store.create(batch());
    store.approve(r.approvalId, holder());
    store.take(r.approvalId);
    store.revoke(r.approvalId, "step 2 failed", [{ label: "ERC20.approve", txHash: "0x" + "1".repeat(64) }]);
    expect(store.resumeNoteFor("dexe_proposal_create", FROM, 97)).toEqual([
      { label: "ERC20.approve", txHash: "0x" + "1".repeat(64) },
    ]);
    expect(store.resumeNoteFor("dexe_tx_send", FROM, 97)).toBeUndefined();
  });

  it("forgets closed approvals long after they stop mattering (memory stays flat)", () => {
    const c = clock();
    const store = new ApprovalStore({ ttlMs: 60_000, now: c.now, useWindowMs: 60_000 });
    const old = store.create(batch());
    store.decline(old.approvalId);
    c.advance(2 * 10 * 60_000 - 1);
    store.create(batch({ tool: "dexe_tx_send" }));
    expect(store.get(old.approvalId)).toBeDefined(); // still inside 2× the cooldown
    c.advance(2);
    store.create(batch({ tool: "dexe_dao_create" }));
    expect(store.get(old.approvalId)).toBeUndefined();
    expect(store.getByToken(old.pathToken)).toBeUndefined();
  });

  it("only a pending approval can be approved", () => {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const r = store.create(batch());
    store.decline(r.approvalId);
    const h = holder();
    expect(store.approve(r.approvalId, h)).toBe(false);
    expect(h.drop).toHaveBeenCalled();
  });
});

describe("ApprovedSigner — ordered-only signing", () => {
  function setup() {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const b = batch();
    const r = store.create(b);
    const sent: Array<{ to: string; data: string; value: bigint }> = [];
    const wallet: SendCapable = {
      address: FROM,
      async sendTransaction(tx) {
        sent.push(tx);
        return { hash: keccak256(tx.data) } as never;
      },
    };
    const connect = vi.fn(() => wallet);
    const signer = new ApprovedSigner(r.approvalId, FROM, "0x" + "9".repeat(64), 97, b.expected, {
      store,
      connect,
      lock: (task) => task(),
    });
    store.approve(r.approvalId, signer);
    store.take(r.approvalId);
    return { store, r, signer, sent, connect };
  }

  it("signs exactly the approved steps, in order, then is spent", async () => {
    const { store, r, signer, sent } = setup();
    await signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97 });
    await signer.send({ to: B, value: "5", data: "0xabcdef01", chainId: 97 });
    signer.finish();
    expect(sent).toHaveLength(2);
    expect(store.get(r.approvalId)!.status).toBe("consumed");
    await expect(signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97 })).rejects.toBeInstanceOf(
      ApprovalDeviationError,
    );
    expect(sent).toHaveLength(2);
  });

  it("a deviation (other calldata) signs nothing, revokes, and drops the key", async () => {
    const { store, r, signer, sent, connect } = setup();
    await expect(signer.send({ to: A, value: "0", data: "0xdeadbeef", chainId: 97 })).rejects.toBeInstanceOf(
      ApprovalDeviationError,
    );
    expect(sent).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(signer.active).toBe(false);
    expect(store.get(r.approvalId)!.status).toBe("revoked");
    // Even the originally approved step is refused afterwards.
    await expect(signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97 })).rejects.toBeInstanceOf(
      ApprovalDeviationError,
    );
  });

  it("out-of-order, wrong-chain and extra transactions are deviations", async () => {
    let s = setup();
    await expect(s.signer.send({ to: B, value: "5", data: "0xabcdef01", chainId: 97 })).rejects.toThrow(/differs/);
    s = setup();
    await expect(s.signer.send({ to: A, value: "0", data: "0x12345678", chainId: 56 })).rejects.toThrow(/chain/);
    s = setup();
    await s.signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97 });
    await s.signer.send({ to: B, value: "5", data: "0xabcdef01", chainId: 97 });
    await expect(s.signer.send({ to: B, value: "5", data: "0xabcdef01", chainId: 97 })).rejects.toThrow(/all were sent/);
    expect(s.sent).toHaveLength(2);
  });

  it("never forwards a caller gas limit; estimates server-side and refuses above the cap", async () => {
    const store = new ApprovalStore({ ttlMs: 900_000 });
    const b = batch();
    const r = store.create(b);
    const sent: Array<Record<string, unknown>> = [];
    let estimate = 50_000n;
    const signer = new ApprovedSigner(r.approvalId, FROM, "0x" + "9".repeat(64), 97, b.expected, {
      store,
      connect: () => ({
        address: FROM,
        async estimateGas() {
          return estimate;
        },
        async sendTransaction(tx) {
          sent.push(tx as unknown as Record<string, unknown>);
          return { hash: "0x" + "1".repeat(64) } as never;
        },
      }),
      lock: (task) => task(),
    });
    store.approve(r.approvalId, signer);
    store.take(r.approvalId);
    // A caller-supplied gasLimit is not even part of the accepted shape.
    await signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97, gasLimit: "999999999" } as never);
    expect(sent[0]!.gasLimit).toBe(60_000n); // 50k estimate + 20%
    estimate = 40_000_000n;
    await expect(signer.send({ to: B, value: "5", data: "0xabcdef01", chainId: 97 })).rejects.toThrow(/above the .* cap/);
    expect(sent).toHaveLength(1);
    expect(store.get(r.approvalId)!.status).toBe("revoked");
  });

  it("never serializes or prints the key", async () => {
    const { signer } = setup();
    const KEY_HEX = "9".repeat(64);
    expect(JSON.stringify({ signer })).not.toContain(KEY_HEX);
    expect(Object.keys(signer).join(",")).not.toMatch(/key/i);
    const { inspect } = await import("node:util");
    expect(inspect(signer, { showHidden: true, depth: 5 })).not.toContain(KEY_HEX);
    expect(inspect(signer)).toMatch(/redacted/);
    expect(JSON.stringify({ ...signer }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(KEY_HEX);
  });

  it("finishing early revokes the unsent remainder", async () => {
    const { store, r, signer } = setup();
    await signer.send({ to: A, value: "0", data: "0x12345678", chainId: 97 });
    signer.finish();
    expect(store.get(r.approvalId)!.status).toBe("revoked");
    expect(signer.active).toBe(false);
  });
});
