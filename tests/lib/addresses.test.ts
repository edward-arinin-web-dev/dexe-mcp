import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import { CONTRACTS_REGISTRY_BY_CHAIN } from "../../src/lib/addresses.js";

/**
 * K1 guard: chain 97 must be baked into DEFAULTS so a zero-config install can
 * read AND deploy on BSC testnet (the repo's mandated validation chain).
 * DeXe deployed ContractsRegistry at the same deterministic address on 56/97 —
 * verified live via getContract(POOL_FACTORY/POOL_REGISTRY) on chain 97.
 */
describe("CONTRACTS_REGISTRY_BY_CHAIN defaults (K1)", () => {
  it("covers BSC mainnet and testnet", () => {
    expect(CONTRACTS_REGISTRY_BY_CHAIN[56]).toBeDefined();
    expect(CONTRACTS_REGISTRY_BY_CHAIN[97]).toBeDefined();
  });

  it("uses the deterministic registry address on both chains, checksummed", () => {
    const expected = "0x46B46629B674b4C0b48B111DEeB0eAfd9F84A1c0";
    for (const chain of [56, 97]) {
      const addr = CONTRACTS_REGISTRY_BY_CHAIN[chain]!;
      expect(addr).toBe(expected);
      expect(getAddress(addr)).toBe(addr); // valid checksum
    }
  });
});
