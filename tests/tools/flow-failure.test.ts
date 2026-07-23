import { describe, it, expect } from "vitest";
import type { SignerManager } from "../../src/lib/signer.js";
import type { TxPayload } from "../../src/lib/calldata.js";
import { sendOrCollect } from "../../src/tools/flow.js";

/**
 * R2/R3/R7 — composite broadcast failure paths, no network. A fake signer
 * drives sendOrCollect through: revert (status 0), mid-sequence throw, and the
 * happy path, asserting dependent steps never run past a failure and the
 * ledger names what landed.
 */

const CFG = {
  // no B6/B7/B10 guard env → runBroadcastGuards is a no-op
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

interface FakeSendPlan {
  /** per-call behavior: receipt status, or a thrown error */
  results: Array<{ status?: number; throwMsg?: string }>;
}

function fakeSigner(plan: FakeSendPlan): { signer: SignerManager; sent: string[] } {
  const sent: string[] = [];
  let call = 0;
  const wallet = {
    address: "0x000000000000000000000000000000000000dEaD",
    async sendTransaction(tx: { data: string }) {
      const step = plan.results[call++]!;
      sent.push(tx.data);
      if (step.throwMsg) throw new Error(step.throwMsg);
      const hash = `0xhash${call}`;
      return {
        hash,
        chainId: 97n,
        async wait() {
          return { status: step.status ?? 1, hash };
        },
      };
    },
  };
  const signer = {
    hasSigner: () => true,
    getConfig: () => CFG,
    trySigner: () => ({ ok: wallet }),
    withBroadcastLock: (_c: number, task: () => Promise<unknown>) => task(),
  } as unknown as SignerManager;
  return { signer, sent };
}

const payload = (n: number): TxPayload => ({
  to: "0x1111111111111111111111111111111111111111",
  data: `0x0${n}`,
  value: "0",
  chainId: 97,
  description: `step-${n}`,
});

describe("sendOrCollect failure ledger (R7)", () => {
  it("executes all steps on the happy path", async () => {
    const { signer, sent } = fakeSigner({ results: [{ status: 1 }, { status: 1 }] });
    const res = await sendOrCollect(signer, [payload(1), payload(2)]);
    expect(res.mode).toBe("executed");
    expect(res.steps.map((s) => s.txHash)).toEqual(["0xhash1", "0xhash2"]);
    expect(sent).toHaveLength(2);
  });

  it("a REVERTED step (status 0) stops the sequence — dependent step never sent (R3)", async () => {
    const { signer, sent } = fakeSigner({ results: [{ status: 0 }, { status: 1 }] });
    const res = await sendOrCollect(signer, [payload(1), payload(2)]);
    expect(res.mode).toBe("failed");
    expect(sent).toHaveLength(1); // step-2 must NOT broadcast on top of unchanged state
    expect(res.failure?.failedStep).toBe("step-1");
    expect(res.failure?.error).toMatch(/REVERTED on-chain/);
    expect(res.failure?.landedSteps).toHaveLength(0);
    expect(res.failure?.resume).toMatch(/No steps landed/);
  });

  it("a mid-sequence throw reports the landed prefix + resume guidance", async () => {
    const { signer, sent } = fakeSigner({
      results: [{ status: 1 }, { throwMsg: "insufficient funds for gas" }],
    });
    const res = await sendOrCollect(signer, [payload(1), payload(2)]);
    expect(res.mode).toBe("failed");
    expect(sent).toHaveLength(2);
    expect(res.failure?.failedStep).toBe("step-2");
    expect(res.failure?.landedSteps.map((s) => s.txHash)).toEqual(["0xhash1"]);
    expect(res.failure?.resume).toMatch(/1 earlier step\(s\) already landed/);
    // actionable-error layer recognized the signature and appended a remedy
    expect(res.failure?.error).toMatch(/faucet|Fund the signer/i);
  });

  it("no-signer path still returns unsigned payloads (unchanged contract)", async () => {
    const signer = {
      hasSigner: () => false,
    } as unknown as SignerManager;
    const res = await sendOrCollect(signer, [payload(1)]);
    expect(res.mode).toBe("payloads");
    expect(res.steps[0]?.payload).toEqual(payload(1));
  });
});

describe("sendOrCollect postStep hook (bug #35 unbundle race)", () => {
  it("awaits postStep after each confirmed step, before the next send", async () => {
    const { signer, sent } = fakeSigner({ results: [{ status: 1 }, { status: 1 }] });
    const calls: Array<{ index: number; sentAtCall: number }> = [];
    const res = await sendOrCollect(signer, [payload(1), payload(2)], {
      postStep: async (i) => {
        calls.push({ index: i, sentAtCall: sent.length });
      },
    });
    expect(res.mode).toBe("executed");
    // hook fired for step 0 while only 1 tx had been sent (i.e. BEFORE step 2)
    expect(calls).toEqual([
      { index: 0, sentAtCall: 1 },
      { index: 1, sentAtCall: 2 },
    ]);
  });

  it("a throwing postStep never fails the flow", async () => {
    const { signer } = fakeSigner({ results: [{ status: 1 }] });
    const res = await sendOrCollect(signer, [payload(1)], {
      postStep: async () => {
        throw new Error("poll timeout");
      },
    });
    expect(res.mode).toBe("executed");
    expect(res.steps[0]?.txHash).toBe("0xhash1");
  });

  it("postStep does not fire for a failed step", async () => {
    const { signer } = fakeSigner({ results: [{ status: 0 }] });
    const calls: number[] = [];
    const res = await sendOrCollect(signer, [payload(1)], {
      postStep: async (i) => {
        calls.push(i);
      },
    });
    expect(res.mode).toBe("failed");
    expect(calls).toEqual([]);
  });
});
