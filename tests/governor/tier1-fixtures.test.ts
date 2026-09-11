import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import { loadGovernorConfigs, resolveGovernor } from "../../src/governor/loader.js";
import { isBravo, quorumCountingOf } from "../../src/governor/adapter.js";

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
    expect(c.governorAddress).toBe("0x408ED6354d4973f66138C91495F2f2FCbd8724C3");
    expect(c.votingToken.type).toBe("ERC20VotesComp");
    expect(c.votingToken.symbol).toBe("UNI");
    expect(c.executor.type).toBe("timelock");
    // D5-2: the shipped value was 0x1a9C8182C09F50355CeA8fFF4b7E1649A535498a —
    // EIP-55-invalid and with no contract deployed at it. governor.timelock()
    // returns the address below.
    expect(c.timelock?.address).toBe("0x1a9C8182C09F50C8318d769245beA52c32BE35BC");
    expect(c.timelock?.minDelay).toBe(172800);
    expect(quorumCountingOf(c)).toBe("for");
  });

  it("Compound: OZ v5 + ERC20VotesComp (post-2025 governor migration)", () => {
    const c = resolveGovernor("compound");
    expect(isBravo(c)).toBe(false);
    expect(c.governorVersion).toBe("oz-v5");
    expect(c.chainId).toBe(1);
    expect(c.governorAddress).toBe("0x309a862bbC1A00e45506cB8A802D1ff10004c8C0");
    // D5-1 regression guard: the retired GovernorBravo cannot answer any
    // proposal id >= 394 and is no longer the Timelock admin.
    expect(c.governorAddress.toLowerCase()).not.toBe("0xc0da02939e1441f497fd74f78ce7decb17b66529");
    expect(c.votingToken.type).toBe("ERC20VotesComp");
    expect(c.votingToken.symbol).toBe("COMP");
    expect(c.executor.type).toBe("timelock");
    expect(c.timelock?.address).toBe("0x6d903f6003cca6255D85CcA4D3B5E5146dC33925");
    // COUNTING_MODE is `quorum=for`, NOT the OZ-stock fractional `for,abstain`.
    expect(c.quorumCounting).toBe("for");
    expect(quorumCountingOf(c)).toBe("for");
    expect(c.legacyGovernor).toEqual({
      address: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
      maxProposalId: 393,
      label: "GovernorBravo (retired in the 2025 Compound Governor migration)",
    });
  });

  it("Optimism: OZ v4 + ERC20Votes, timelock-controlled", () => {
    const c = resolveGovernor("optimism");
    expect(isBravo(c)).toBe(false);
    expect(c.governorVersion).toBe("oz-v4");
    expect(c.chainId).toBe(10);
    expect(c.votingToken.type).toBe("ERC20Votes");
    expect(c.votingToken.symbol).toBe("OP");
    // D5-4: the fixture declared `governor-self` and carried no timelock at all,
    // so agents were told to skip dexe_gov_build_queue on a
    // GovernorTimelockControl governor.
    expect(c.executor.type).toBe("timelock");
    expect(c.timelock?.address).toBe("0x0eDd4B2cCCf41453D8B5443FBB96cc577d1d06bF");
    expect(c.timelock?.minDelay).toBe(259200);
    expect(c.votingParams.votingDelay).toBe(0);
    expect(c.votingParams.votingPeriod).toBe(259200);
    expect(c.quorumCounting).toBe("all");
    expect(quorumCountingOf(c)).toBe("all");
  });

  it("all fixture addresses are in canonical EIP-55 checksummed form", () => {
    // Strictly stronger than a hex-shape regex AND than `getAddress` not
    // throwing: `getAddress` accepts all-lowercase, so a mistyped address that
    // was lowercased would still pass. Canonical equality closes that hole for
    // the shipped fixtures without breaking a user's lowercase config at
    // runtime (the loader stays lenient on purpose).
    for (const cfg of configs.values()) {
      expect(getAddress(cfg.governorAddress), `${cfg.id}.governorAddress`).toBe(cfg.governorAddress);
      expect(getAddress(cfg.votingToken.address), `${cfg.id}.votingToken.address`).toBe(
        cfg.votingToken.address,
      );
      if (cfg.timelock) {
        expect(getAddress(cfg.timelock.address), `${cfg.id}.timelock.address`).toBe(cfg.timelock.address);
      }
      if (cfg.legacyGovernor) {
        expect(getAddress(cfg.legacyGovernor.address), `${cfg.id}.legacyGovernor.address`).toBe(
          cfg.legacyGovernor.address,
        );
      }
    }
  });

  it("every fixture with executor.type=timelock also carries a timelock block", () => {
    for (const cfg of configs.values()) {
      if (cfg.executor.type !== "timelock") continue;
      expect(cfg.timelock?.address, `${cfg.id} declares a timelock executor but no timelock`).toMatch(
        /^0x[a-fA-F0-9]{40}$/,
      );
      expect(cfg.timelock!.address).not.toBe("0x0000000000000000000000000000000000000000");
      expect(typeof cfg.timelock!.minDelay).toBe("number");
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
