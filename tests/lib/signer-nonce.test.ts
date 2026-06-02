import { describe, expect, it } from "vitest";
import { SignerManager } from "../../src/lib/signer.js";
import { txStatusFromLookup } from "../../src/tools/txSend.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * H-12 guardrail. The signer did no nonce management, so two concurrent
 * broadcasts read the same pending nonce and one tx was silently dropped.
 * `withBroadcastLock` serializes broadcasts per chain. `txStatusFromLookup`
 * stops a nonexistent hash from reporting as perpetual "pending".
 */

function newSigner() {
  return new SignerManager({ privateKey: undefined } as unknown as DexeConfig);
}

describe("withBroadcastLock serializes broadcasts per chain (H-12)", () => {
  it("runs same-chain tasks one at a time, in order", async () => {
    const sm = newSigner();
    const order: string[] = [];
    let release1!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((r) => {
      release1 = r;
    });
    const started = new Promise<void>((r) => {
      signalStarted = r;
    });

    const t1 = sm.withBroadcastLock(56, async () => {
      order.push("t1-start");
      signalStarted();
      await gate;
      order.push("t1-end");
      return 1;
    });
    const t2 = sm.withBroadcastLock(56, async () => {
      order.push("t2-start");
      order.push("t2-end");
      return 2;
    });

    await started; // t1 has begun; t2 must still be blocked behind it
    expect(order).toEqual(["t1-start"]);

    release1();
    expect(await Promise.all([t1, t2])).toEqual([1, 2]);
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end"]);
  });

  it("does not block a different chain", async () => {
    const sm = newSigner();
    const order: string[] = [];
    let release56!: () => void;
    const gate = new Promise<void>((r) => {
      release56 = r;
    });

    const a = sm.withBroadcastLock(56, async () => {
      order.push("56-start");
      await gate;
      order.push("56-end");
    });
    const b = sm.withBroadcastLock(97, async () => {
      order.push("97-end");
    });

    await b; // chain 97 finishes without waiting on the gated chain 56
    expect(order).toContain("97-end");
    expect(order).not.toContain("56-end");
    release56();
    await a;
  });

  it("isolates a failing task so the queue keeps flowing", async () => {
    const sm = newSigner();
    await expect(
      sm.withBroadcastLock(56, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sm.withBroadcastLock(56, async () => 42)).toBe(42);
  });
});

describe("txStatusFromLookup (H-12 tx_status)", () => {
  it("classifies a nonexistent hash as not_found, not perpetual pending", () => {
    expect(txStatusFromLookup(false, false)).toBe("not_found");
  });
  it("classifies an unmined-but-known tx as pending", () => {
    expect(txStatusFromLookup(false, true)).toBe("pending");
  });
  it("classifies a tx with a receipt as mined", () => {
    expect(txStatusFromLookup(true, true)).toBe("mined");
  });
});
