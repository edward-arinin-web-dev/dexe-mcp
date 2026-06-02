import { describe, expect, it } from "vitest";
import { refuseIfNotGovPool } from "../../src/tools/flow.js";

/**
 * W10 guardrail. The composite flow trusted a user-supplied `govPool`, read its
 * (attacker-controlled) helper addresses, and auto-approved the reported keeper
 * — letting a fake govPool drain a token via the approve. The flow now verifies
 * `govPool` against the CANONICAL PoolRegistry; a definitive `isGovPool == false`
 * aborts. (The on-chain lookup needs live RPC; this pins the refusal decision,
 * and the companion exact-amount approve is enforced by removing MAX_UINT256.)
 */

const FAKE = "0x000000000000000000000000000000000000dEaD";

describe("refuseIfNotGovPool (W10)", () => {
  it("refuses a govPool the registry rejects (isGovPool === false)", () => {
    expect(() => refuseIfNotGovPool(FAKE, false)).toThrow(/not a registered DeXe GovPool/);
    expect(() => refuseIfNotGovPool(FAKE, false)).toThrow(/W10/);
  });

  it("proceeds for a registered govPool (true)", () => {
    expect(() => refuseIfNotGovPool(FAKE, true)).not.toThrow();
  });

  it("proceeds when verification is inconclusive (null) — exact-approve bounds the risk", () => {
    expect(() => refuseIfNotGovPool(FAKE, null)).not.toThrow();
  });
});
