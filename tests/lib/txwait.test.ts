import { describe, it, expect } from "vitest";
import type { TransactionReceipt, TransactionResponse } from "ethers";
import {
  assertReceiptSuccess,
  waitWithTimeout,
  txWaitTimeoutMs,
  DEFAULT_TX_WAIT_TIMEOUT_MS,
} from "../../src/lib/txWait.js";

const receipt = (status: number, hash = "0xabc"): TransactionReceipt =>
  ({ status, hash }) as unknown as TransactionReceipt;

describe("assertReceiptSuccess (R3)", () => {
  it("passes on status 1", () => {
    expect(() => assertReceiptSuccess(receipt(1), "step")).not.toThrow();
  });
  it("throws with hash + step label on status 0", () => {
    expect(() => assertReceiptSuccess(receipt(0, "0xdead"), "ERC20.approve")).toThrow(
      /ERC20\.approve REVERTED on-chain \(tx 0xdead/,
    );
  });
  it("tolerates a null receipt (timeout path owns that case)", () => {
    expect(() => assertReceiptSuccess(null, "step")).not.toThrow();
  });
});

describe("waitWithTimeout (R2)", () => {
  const fakeTx = (impl: () => Promise<TransactionReceipt | null>): TransactionResponse =>
    ({ hash: "0xfeed", chainId: 97n, wait: impl }) as unknown as TransactionResponse;

  it("returns the receipt when wait resolves", async () => {
    const tx = fakeTx(async () => receipt(1));
    await expect(waitWithTimeout(tx, { timeoutMs: 50 })).resolves.toEqual(receipt(1));
  });

  it("normalizes an ethers TIMEOUT into an actionable dexe_tx_status message", async () => {
    const timeoutErr = Object.assign(new Error("timeout"), { code: "TIMEOUT" });
    const tx = fakeTx(async () => {
      throw timeoutErr;
    });
    await expect(waitWithTimeout(tx, { timeoutMs: 50 })).rejects.toThrow(
      /0xfeed.*not mined within.*dexe_tx_status/s,
    );
  });

  it("passes non-timeout errors through untouched", async () => {
    const tx = fakeTx(async () => {
      throw new Error("boom");
    });
    await expect(waitWithTimeout(tx, { timeoutMs: 50 })).rejects.toThrow(/^boom$/);
  });
});

describe("txWaitTimeoutMs env resolution", () => {
  it("defaults when unset or invalid", () => {
    delete process.env.DEXE_TX_WAIT_TIMEOUT_MS;
    expect(txWaitTimeoutMs()).toBe(DEFAULT_TX_WAIT_TIMEOUT_MS);
    process.env.DEXE_TX_WAIT_TIMEOUT_MS = "nope";
    expect(txWaitTimeoutMs()).toBe(DEFAULT_TX_WAIT_TIMEOUT_MS);
    process.env.DEXE_TX_WAIT_TIMEOUT_MS = "60000";
    expect(txWaitTimeoutMs()).toBe(60000);
    delete process.env.DEXE_TX_WAIT_TIMEOUT_MS;
  });
});
