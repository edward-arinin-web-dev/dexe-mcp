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
    expect(uni.timelock?.address.toLowerCase()).toBe("0x1a9c8182c09f50355cea8fff4b7e1649a535498a");
    expect(uni.votingParams.votingDelay).toBe(1);
    expect(uni.votingParams.votingPeriod).toBe(50400);
    expect(uni.votingParams.quorumNumerator).toBe(4);
    expect(uni.executor.type).toBe("timelock");
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
