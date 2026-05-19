import { describe, expect, it } from "vitest";
import { loadGovernorConfigs, resolveGovernor } from "../../src/governor/loader.js";
import { isBravo } from "../../src/governor/adapter.js";

describe("Tier-1 fixtures (Uniswap, Compound, Optimism) — AC #1", () => {
  const configs = loadGovernorConfigs();

  it("all three Tier-1 DAOs load without error", () => {
    expect(configs.has("uniswap")).toBe(true);
    expect(configs.has("compound")).toBe(true);
    expect(configs.has("optimism")).toBe(true);
  });

  it("Uniswap: Bravo + ERC20VotesComp (UNI exposes Compound-style getPriorVotes)", () => {
    const c = resolveGovernor("uniswap");
    expect(isBravo(c)).toBe(true);
    expect(c.chainId).toBe(1);
    expect(c.votingToken.type).toBe("ERC20VotesComp");
    expect(c.votingToken.symbol).toBe("UNI");
    expect(c.executor.type).toBe("timelock");
  });

  it("Compound: Bravo + ERC20VotesComp", () => {
    const c = resolveGovernor("compound");
    expect(isBravo(c)).toBe(true);
    expect(c.chainId).toBe(1);
    expect(c.votingToken.type).toBe("ERC20VotesComp");
    expect(c.votingToken.symbol).toBe("COMP");
    expect(c.executor.type).toBe("timelock");
  });

  it("Optimism: OZ v4 + ERC20Votes (OP token, modern)", () => {
    const c = resolveGovernor("optimism");
    expect(isBravo(c)).toBe(false);
    expect(c.governorVersion).toBe("oz-v4");
    expect(c.chainId).toBe(10);
    expect(c.votingToken.type).toBe("ERC20Votes");
    expect(c.votingToken.symbol).toBe("OP");
  });

  it("all governor + token + timelock addresses are checksum-format-valid", () => {
    for (const cfg of configs.values()) {
      expect(cfg.governorAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(cfg.votingToken.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      if (cfg.timelock) expect(cfg.timelock.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }
  });

  it("Tier-1 ids are unique by id and by governor address", () => {
    const ids = new Set<string>();
    const addrs = new Set<string>();
    for (const cfg of configs.values()) {
      expect(ids.has(cfg.id)).toBe(false);
      ids.add(cfg.id);
      const lower = cfg.governorAddress.toLowerCase();
      expect(addrs.has(lower)).toBe(false);
      addrs.add(lower);
    }
  });
});
