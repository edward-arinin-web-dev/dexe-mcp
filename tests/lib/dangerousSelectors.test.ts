import { describe, expect, it } from "vitest";
import { Interface, id } from "ethers";
import {
  dangerousSelectorError,
  findForbiddenSelector,
  forbiddenSelectors,
  selectorOf,
} from "../../src/lib/dangerousSelectors.js";

/**
 * C-2 guardrail coverage. The denylist blocks GovUserKeeper onlyOwner accounting
 * functions from ever being encoded as a proposal action (see
 * docs/security/C2-default-routing-bypass.md). These tests pin the canonical
 * selectors, prove every forbidden signature is detected from realistic
 * calldata, and prove benign calls pass through.
 */

const V = "0x1111111111111111111111111111111111111111"; // victim
const A = "0x2222222222222222222222222222222222222222"; // attacker

describe("dangerousSelectors", () => {
  it("pins the canonical withdrawTokens selector (the C-2 primitive)", () => {
    const sig = "withdrawTokens(address,address,uint256)";
    expect(id(sig).slice(0, 10)).toBe("0x5e35359e");
    const match = findForbiddenSelector(id(sig));
    expect(match?.signature).toBe(sig);
    expect(match?.selector).toBe("0x5e35359e");
  });

  it("lists all 12 GovUserKeeper privileged accounting functions", () => {
    expect(forbiddenSelectors()).toHaveLength(12);
  });

  it("detects every forbidden signature from realistic abi-encoded calldata", () => {
    const cases: [string, string, unknown[]][] = [
      ["withdrawTokens(address,address,uint256)", "withdrawTokens", [V, A, 1n]],
      ["depositTokens(address,address,uint256)", "depositTokens", [V, A, 1n]],
      ["delegateTokens(address,address,uint256)", "delegateTokens", [V, A, 1n]],
      ["undelegateTokens(address,address,uint256)", "undelegateTokens", [V, A, 1n]],
      ["delegateTokensTreasury(address,uint256)", "delegateTokensTreasury", [A, 1n]],
      ["undelegateTokensTreasury(address,uint256)", "undelegateTokensTreasury", [A, 1n]],
      ["withdrawNfts(address,address,uint256[])", "withdrawNfts", [V, A, [1n]]],
      ["depositNfts(address,address,uint256[])", "depositNfts", [V, A, [1n]]],
      ["delegateNfts(address,address,uint256[])", "delegateNfts", [V, A, [1n]]],
      ["undelegateNfts(address,address,uint256[])", "undelegateNfts", [V, A, [1n]]],
      ["delegateNftsTreasury(address,uint256[])", "delegateNftsTreasury", [A, [1n]]],
      ["undelegateNftsTreasury(address,uint256[])", "undelegateNftsTreasury", [A, [1n]]],
    ];
    for (const [sig, method, args] of cases) {
      const data = new Interface([`function ${sig}`]).encodeFunctionData(method, args);
      const match = findForbiddenSelector(data);
      expect(match, `expected ${sig} to be forbidden`).not.toBeNull();
      expect(match?.signature).toBe(sig);
    }
  });

  it("is case-insensitive on the calldata selector", () => {
    const data = id("withdrawTokens(address,address,uint256)");
    expect(findForbiddenSelector(data.toUpperCase().replace("0X", "0x"))).not.toBeNull();
  });

  it("passes benign calls through (no false positives)", () => {
    const benign = [
      new Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [A, 1n]),
      new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [A, 0n]),
      new Interface(["function setX(uint256)"]).encodeFunctionData("setX", [42n]),
    ];
    for (const data of benign) expect(findForbiddenSelector(data)).toBeNull();
  });

  it("ignores malformed / too-short calldata", () => {
    expect(selectorOf("0x")).toBeNull();
    expect(selectorOf("0x1234")).toBeNull();
    expect(selectorOf("not-hex")).toBeNull();
    expect(findForbiddenSelector("0x")).toBeNull();
  });

  it("error message names the function and references C-2", () => {
    const match = findForbiddenSelector(id("withdrawTokens(address,address,uint256)"))!;
    const msg = dangerousSelectorError(match, A);
    expect(msg).toContain("withdrawTokens(address,address,uint256)");
    expect(msg).toContain("C-2");
    expect(msg).toContain(A);
  });
});
