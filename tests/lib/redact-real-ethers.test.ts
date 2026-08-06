import { describe, it, expect } from "vitest";
import { makeError } from "ethers";
import { redactErrorInPlace, safeErrorMessage } from "../../src/lib/redact.js";

/**
 * These tests build errors with ethers' own `makeError`, NOT `Object.assign`.
 *
 * That distinction is the whole point. `tests/lib/rpc-hardening.test.ts` asserted
 * that `data` survives redaction and passed — but its mock errors had plain
 * writable properties, while ethers declares `shortMessage` as
 * `writable: false`. In strict mode (ESM) assigning to it THROWS, which sent
 * every real error down the copy path and dropped `data` on the floor. A mock
 * that is easier to write than the real thing cannot catch that.
 */

const KEY = "SECRETKEY123";
const KEYED_URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;

describe("redactErrorInPlace against errors ethers actually produces", () => {
  it("keeps `data` on a custom-error revert — simulate.ts reads it to tell a revert from a transport failure", () => {
    const raw = makeError("execution reverted (unknown custom error)", "CALL_EXCEPTION", {
      action: "call",
      data: "0xb0c8f9dc",
      reason: null,
      transaction: { to: "0x" + "11".repeat(20), data: "0x", from: "0x" + "22".repeat(20) },
      invocation: null,
      revert: null,
    });

    const out = redactErrorInPlace(raw) as unknown as Record<string, unknown>;

    expect(out.code).toBe("CALL_EXCEPTION");
    expect(out.data).toBe("0xb0c8f9dc");
  });

  it("shortMessage is non-writable on a real ethers error — the descriptor this bug hinged on", () => {
    const raw = makeError("boom", "SERVER_ERROR", {});
    const d = Object.getOwnPropertyDescriptor(raw, "shortMessage");
    // If ethers ever makes this writable the guard is still correct, but the
    // regression it protects against would no longer be reproducible here.
    expect(d?.writable ?? true).toBe(false);
  });

  it("redacts the key from message, stack and info.requestUrl — not just message", () => {
    const raw = makeError(`server response 500 (url=${KEYED_URL}, ...)`, "SERVER_ERROR", {
      request: { url: KEYED_URL } as never,
      response: { statusCode: 500 } as never,
    });
    (raw as unknown as Record<string, unknown>).info = { requestUrl: KEYED_URL };

    const out = redactErrorInPlace(raw) as unknown as Record<string, unknown>;

    const haystack = [
      out.message,
      out.stack,
      (out.info as Record<string, unknown> | undefined)?.requestUrl,
      out.shortMessage,
    ]
      .filter((v): v is string => typeof v === "string")
      .join("\n");

    expect(haystack).not.toContain(KEY);
    expect(out.code).toBe("SERVER_ERROR");
  });

  it("a frozen error still yields the classifying fields, and still no key", () => {
    const raw = makeError(`server response 500 (url=${KEYED_URL})`, "CALL_EXCEPTION", {
      action: "call",
      data: "0xdeadbeef",
      reason: null,
      transaction: { to: "0x" + "33".repeat(20), data: "0x", from: "0x" + "44".repeat(20) },
      invocation: null,
      revert: null,
    });
    Object.freeze(raw);

    const out = redactErrorInPlace(raw) as unknown as Record<string, unknown>;

    expect(out.code).toBe("CALL_EXCEPTION");
    expect(out.data).toBe("0xdeadbeef");
    expect(String(out.message)).not.toContain(KEY);
  });

  it("safeErrorMessage alone never returns the key", () => {
    const raw = makeError(`server response 500 (url=${KEYED_URL})`, "SERVER_ERROR", {});
    expect(safeErrorMessage(raw)).not.toContain(KEY);
  });
});
