import { describe, expect, it } from "vitest";
import { loadGovernorConfigs, resolveGovernor } from "../../src/governor/loader.js";
import {
  PROPOSAL_STATE,
  stateName,
  isBravo,
  GOVERNOR_BRAVO_READ_ABI,
  GOVERNOR_OZ_READ_ABI,
} from "../../src/governor/adapter.js";

describe("governor config loader", () => {
  it("accepts the Uniswap fixture", () => {
    const configs = loadGovernorConfigs();
    expect(configs.has("uniswap")).toBe(true);
    const uni = configs.get("uniswap")!;
    expect(uni.chainId).toBe(1);
    expect(uni.governorAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(uni.governorAddress.toLowerCase()).toBe("0x408ed6354d4973f66138c91495f2f2fcbd8724c3");
    expect(uni.votingToken.symbol).toBe("UNI");
    expect(uni.votingToken.type).toBe("ERC20VotesComp");
    // Exact canonical string, not `.toLowerCase()` — a re-typo must fail here.
    expect(uni.timelock?.address).toBe("0x1a9C8182C09F50C8318d769245beA52c32BE35BC");
    expect(uni.votingParams.votingDelay).toBe(13140);
    expect(uni.votingParams.votingPeriod).toBe(40320);
    expect(uni.votingParams.proposalThreshold).toBe("1000000000000000000000000");
    expect(uni.votingParams.quorumNumerator).toBe(4);
    expect(uni.votingParams.quorumDenominator).toBe(100);
    expect(uni.executor.type).toBe("timelock");
  });

  /**
   * Offline pin for the OTHER two fixtures. The live drift check
   * (tests/governor/fixtures-live.test.ts) is env-gated and therefore skipped in
   * default CI, so it cannot be the only guard — a careless fixture edit has to
   * go red with no network.
   *
   * Values re-read from chain on 2026-09-11: Ethereum block 25,955,258 and
   * Optimism block 156,772,080.
   */
  it("pins Compound + Optimism votingParams to their last on-chain verification", () => {
    const cfgs = loadGovernorConfigs();

    const comp = cfgs.get("compound")!;
    expect(comp.governorAddress).toBe("0x309a862bbC1A00e45506cB8A802D1ff10004c8C0");
    expect(comp.governorVersion).toBe("oz-v5");
    expect(comp.votingParams.votingDelay).toBe(13140);
    expect(comp.votingParams.votingPeriod).toBe(19710);
    expect(comp.votingParams.proposalThreshold).toBe("25000000000000000000000");

    const op = cfgs.get("optimism")!;
    expect(op.votingParams.votingDelay).toBe(0);
    expect(op.votingParams.votingPeriod).toBe(259200);
    expect(op.votingParams.proposalThreshold).toBe("0");
    expect(op.quorumSource).toBe("votable-supply");
  });

  it("round-trips quorumCounting and legacyGovernor through the loader", () => {
    // The loader builds its result from an explicit field whitelist, so an
    // un-plumbed JSON key is silently dropped — which is exactly how a bare
    // `"quorumCounting": "for"` would have become a no-op.
    expect(resolveGovernor("compound").quorumCounting).toBe("for");
    expect(resolveGovernor("optimism").quorumCounting).toBe("all");
    expect(resolveGovernor("uniswap").quorumCounting).toBe("for");
    expect(resolveGovernor("compound").legacyGovernor?.maxProposalId).toBe(393);
    expect(resolveGovernor("uniswap").legacyGovernor).toBeUndefined();
  });

  it("resolves by id or by address", () => {
    const byId = resolveGovernor("uniswap");
    const byAddr = resolveGovernor("0x408ED6354d4973f66138C91495F2f2FCbd8724C3");
    expect(byId.id).toBe("uniswap");
    expect(byAddr.id).toBe("uniswap");
  });

  it("rejects unknown governor lookups", () => {
    expect(() => resolveGovernor("does-not-exist")).toThrow(/unknown governor/);
  });
});

describe("governor adapter — family detection + ABI fragments", () => {
  it("flags Uniswap as Bravo (true Bravo deployment)", () => {
    const uni = resolveGovernor("uniswap");
    expect(uni.governorVersion).toBe("bravo-v3");
    expect(isBravo(uni)).toBe(true);
  });

  it("flags Compound as OZ — its live governor has no quorumVotes()/proposals()", () => {
    const comp = resolveGovernor("compound");
    expect(comp.governorVersion).toBe("oz-v5");
    expect(isBravo(comp)).toBe(false);
  });

  it("Bravo ABI exposes quorumVotes + proposals(uint256), drops quorum/snapshot/deadline", () => {
    const bravo = GOVERNOR_BRAVO_READ_ABI.join("\n");
    expect(bravo).toContain("quorumVotes()");
    expect(bravo).toContain("proposals(uint256");
    expect(bravo).not.toContain("function quorum(uint256");
    expect(bravo).not.toContain("proposalSnapshot");
    expect(bravo).not.toContain("proposalDeadline");
  });

  it("OZ ABI exposes quorum(blockNumber) + proposalSnapshot/Deadline, drops Bravo-only surface", () => {
    const oz = GOVERNOR_OZ_READ_ABI.join("\n");
    expect(oz).toContain("function quorum(uint256");
    expect(oz).toContain("proposalSnapshot");
    expect(oz).toContain("proposalDeadline");
    expect(oz).not.toContain("quorumVotes()");
    expect(oz).not.toContain("function proposals(uint256");
  });
});

describe("governor adapter — proposal state enum", () => {
  it("matches OZ canonical order", () => {
    expect(PROPOSAL_STATE).toEqual([
      "Pending",
      "Active",
      "Canceled",
      "Defeated",
      "Succeeded",
      "Queued",
      "Expired",
      "Executed",
    ]);
  });

  it("stateName maps each index", () => {
    expect(stateName(0)).toBe("Pending");
    expect(stateName(7)).toBe("Executed");
    expect(stateName(99)).toMatch(/^Unknown/);
  });
});
