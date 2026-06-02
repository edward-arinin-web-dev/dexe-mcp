import { describe, expect, it } from "vitest";
import { Interface, MaxUint256 } from "ethers";
import { buildExactApproval } from "../../src/tools/otc.js";

/**
 * W29 guardrail. `dexe_otc_buyer_buy` used to emit
 * `approve(tokenSaleProposal, MAX_UINT256)` to a spender validated only by
 * `isAddress` (a per-proposal TokenSaleProposal that cannot be registry-resolved).
 * A leftover unlimited allowance to an attacker-supplied spender drains the
 * buyer's full payment-token balance. The approval must be exactly the buy
 * amount. A regression (re-introducing MAX_UINT256) flips these red.
 */

const ERC20 = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const TOKEN = "0x1111111111111111111111111111111111111111";
const TSP = "0x2222222222222222222222222222222222222222";

describe("OTC exact-scope approval (W29)", () => {
  it("approves exactly the buy amount — never MAX_UINT256", () => {
    const amount = 100n * 10n ** 18n;
    const p = buildExactApproval(TOKEN, TSP, amount, 56);
    expect(p.to).toBe(TOKEN);
    expect(p.value).toBe("0");
    expect(p.chainId).toBe(56);
    const [spender, approved] = ERC20.decodeFunctionData("approve", p.data);
    expect(spender.toLowerCase()).toBe(TSP.toLowerCase());
    expect(approved).toBe(amount);
    expect(approved).not.toBe(MaxUint256);
    expect(approved < MaxUint256).toBe(true);
  });

  it("does not widen approval for tiny amounts", () => {
    const p = buildExactApproval(TOKEN, TSP, 1n, 56);
    const [, approved] = ERC20.decodeFunctionData("approve", p.data);
    expect(approved).toBe(1n);
  });

  it("encodes the canonical approve selector 0x095ea7b3", () => {
    const p = buildExactApproval(TOKEN, TSP, 5n, 56);
    expect(p.data.startsWith("0x095ea7b3")).toBe(true);
  });
});
