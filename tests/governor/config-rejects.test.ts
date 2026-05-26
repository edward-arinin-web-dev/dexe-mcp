import { describe, expect, it } from "vitest";
import { validateGovernorConfig } from "../../src/governor/loader.js";

/**
 * Drives the REAL loader validator (`validateGovernorConfig`) against synthetic
 * inputs. Previously this file mirrored the rules in a re-impl, which could
 * silently drift from loader.ts. Now any rule change in the loader is reflected
 * here directly — the rules are the contract.
 */

const VALID = {
  id: "test-dao",
  chainId: 1,
  governorAddress: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3",
  votingToken: { type: "ERC20Votes", address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", symbol: "X", decimals: 18 },
  votingParams: { votingDelay: 1, votingPeriod: 50400, quorumNumerator: 4, quorumDenominator: 100 },
  executor: { type: "timelock", id: null },
};

function rejects(o: unknown): void {
  expect(() => validateGovernorConfig(o, "test")).toThrow();
}

describe("validateGovernorConfig — required-field rejection", () => {
  it("rejects missing id", () => rejects({ ...VALID, id: undefined }));
  it("rejects id with illegal chars", () => rejects({ ...VALID, id: "Test_DAO" }));
  it("rejects chainId < 1", () => rejects({ ...VALID, chainId: 0 }));
  it("rejects bad governorAddress", () => rejects({ ...VALID, governorAddress: "0x123" }));
  it("rejects bad governorVersion", () => rejects({ ...VALID, governorVersion: "compound-bravo" }));
  it("rejects bad votingToken.type", () =>
    rejects({ ...VALID, votingToken: { ...VALID.votingToken, type: "ve-Token" } }));
  it("rejects missing votingToken.address", () =>
    rejects({ ...VALID, votingToken: { ...VALID.votingToken, address: undefined } }));
  it("rejects missing votingPeriod", () =>
    rejects({ ...VALID, votingParams: { votingDelay: 1, quorumNumerator: 4 } }));
  it("rejects missing quorumNumerator", () =>
    rejects({ ...VALID, votingParams: { votingDelay: 1, votingPeriod: 50400 } }));
  it("rejects bad executor.type", () => rejects({ ...VALID, executor: { type: "snapshot" } }));
  it("rejects timelock present but minDelay missing", () =>
    rejects({ ...VALID, timelock: { address: VALID.governorAddress } }));
});

describe("validateGovernorConfig — accept + normalization", () => {
  it("accepts a minimal valid config", () => {
    const cfg = validateGovernorConfig(VALID, "test");
    expect(cfg.id).toBe("test-dao");
    expect(cfg.governorVersion).toBe("oz-v4"); // defaulted
  });

  it("defaults quorumDenominator to 100 when omitted", () => {
    const cfg = validateGovernorConfig(
      { ...VALID, votingParams: { votingDelay: 1, votingPeriod: 50400, quorumNumerator: 4 } },
      "test",
    );
    expect(cfg.votingParams.quorumDenominator).toBe(100);
  });

  it("defaults votingToken.decimals to 18 and executor.id to null", () => {
    const cfg = validateGovernorConfig(
      { ...VALID, votingToken: { type: "ERC20Votes", address: VALID.votingToken.address, symbol: "X" }, executor: { type: "governor-self" } },
      "test",
    );
    expect(cfg.votingToken.decimals).toBe(18);
    expect(cfg.executor.id).toBeNull();
  });
});
