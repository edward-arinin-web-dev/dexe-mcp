import { describe, expect, it } from "vitest";

/**
 * Mechanical validator coverage — uses the same address/version/voting checks
 * as loader.ts but exercises them against synthetic inputs without polluting
 * the live config cache. Pulls the private validate path via a tiny re-impl
 * mirror: any divergence between this and loader.ts MUST be treated as a
 * loader bug (the rules are the contract).
 */

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function tryParse(o: any): { ok: true } | { ok: false; reason: string } {
  try {
    if (!o || typeof o !== "object") throw new Error("root must be an object");
    if (typeof o.id !== "string" || !/^[a-z0-9-]+$/.test(o.id)) throw new Error("id");
    if (typeof o.chainId !== "number" || o.chainId < 1) throw new Error("chainId");
    if (typeof o.governorAddress !== "string" || !ADDR_RE.test(o.governorAddress)) throw new Error("governorAddress");
    if (o.governorVersion !== undefined && !["oz-v4", "oz-v5", "bravo-v3"].includes(o.governorVersion))
      throw new Error("governorVersion");
    if (!o.votingToken) throw new Error("votingToken missing");
    if (!ADDR_RE.test(o.votingToken.address)) throw new Error("votingToken.address");
    if (!["ERC20Votes", "ERC20VotesComp"].includes(o.votingToken.type)) throw new Error("votingToken.type");
    if (typeof o.votingToken.symbol !== "string") throw new Error("votingToken.symbol");
    if (!o.votingParams) throw new Error("votingParams missing");
    if (typeof o.votingParams.votingDelay !== "number") throw new Error("votingDelay");
    if (typeof o.votingParams.votingPeriod !== "number") throw new Error("votingPeriod");
    if (typeof o.votingParams.quorumNumerator !== "number") throw new Error("quorumNumerator");
    if (!o.executor || !["timelock", "governor-self"].includes(o.executor.type)) throw new Error("executor.type");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

const VALID = {
  id: "test-dao",
  chainId: 1,
  governorAddress: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3",
  votingToken: { type: "ERC20Votes", address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", symbol: "X" },
  votingParams: { votingDelay: 1, votingPeriod: 50400, quorumNumerator: 4 },
  executor: { type: "timelock" },
};

describe("config schema — required field rejection", () => {
  it("rejects missing id", () => {
    expect(tryParse({ ...VALID, id: undefined }).ok).toBe(false);
  });
  it("rejects bad governorAddress", () => {
    expect(tryParse({ ...VALID, governorAddress: "0x123" }).ok).toBe(false);
  });
  it("rejects bad governorVersion", () => {
    expect(tryParse({ ...VALID, governorVersion: "compound-bravo" }).ok).toBe(false);
  });
  it("rejects bad votingToken.type", () => {
    expect(tryParse({ ...VALID, votingToken: { ...VALID.votingToken, type: "ve-Token" } }).ok).toBe(false);
  });
  it("rejects missing votingPeriod", () => {
    expect(
      tryParse({ ...VALID, votingParams: { votingDelay: 1, quorumNumerator: 4 } as any }).ok,
    ).toBe(false);
  });
  it("rejects bad executor.type", () => {
    expect(tryParse({ ...VALID, executor: { type: "snapshot" } }).ok).toBe(false);
  });
  it("accepts a minimal valid config", () => {
    expect(tryParse(VALID).ok).toBe(true);
  });
});
