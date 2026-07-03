import { describe, it, expect } from "vitest";
import {
  PROPOSAL_STATE_NAMES,
  proposalStateName,
  EXECUTABLE_STATES,
  checkProposalMetadata,
  checkProposalHasActions,
  checkApproveTarget,
  checkTokensUnlocked,
  checkDeployCap,
  checkLinearInitData,
  LINEAR_POWER_INIT_SELECTOR,
  checkUserKeeperAsset,
  checkTreasuryRemainder,
  checkAvatarIsJpeg,
  checkOffchainMetadata,
} from "../../src/lib/preflight.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("mode 9 — ProposalState ordering", () => {
  it("keeps Locked after SucceededFor", () => {
    expect(PROPOSAL_STATE_NAMES[4]).toBe("SucceededFor");
    expect(PROPOSAL_STATE_NAMES[5]).toBe("SucceededAgainst");
    expect(PROPOSAL_STATE_NAMES[6]).toBe("Locked");
    expect(proposalStateName(7)).toBe("ExecutedFor");
    expect(proposalStateName(42)).toBe("Unknown(42)");
  });
  it("marks 4/5/6 executable", () => {
    for (const s of [4, 5, 6]) expect(EXECUTABLE_STATES.has(s)).toBe(true);
    expect(EXECUTABLE_STATES.has(0)).toBe(false);
  });
});

describe("mode 2 — canonical proposal metadata", () => {
  it("accepts the canonical shape", () => {
    const r = checkProposalMetadata({
      proposalName: "T",
      proposalDescription: "[]",
      category: "tokenTransfer",
      isMeta: false,
      changes: { proposedChanges: {}, currentChanges: {} },
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing proposalName", () => {
    const r = checkProposalMetadata({ proposalDescription: "[]" });
    expect(r.ok).toBe(false);
    expect(r.remediation).toMatch(/proposalName/);
  });
  it("rejects a malformed changes wrapper", () => {
    const r = checkProposalMetadata({
      proposalName: "T",
      proposalDescription: "[]",
      changes: { proposedChanges: {} }, // missing currentChanges
    });
    expect(r.ok).toBe(false);
  });
});

describe("mode 1 — actions present", () => {
  it("fails on empty actions", () => {
    expect(checkProposalHasActions([]).ok).toBe(false);
    expect(checkProposalHasActions([], { allowEmpty: true }).ok).toBe(true);
    expect(checkProposalHasActions([{ data: "0x" }]).ok).toBe(true);
  });
});

describe("mode 6 — approve UserKeeper not GovPool", () => {
  it("passes for the keeper, fails for the pool", () => {
    expect(checkApproveTarget(A, A, B).ok).toBe(true);
    const bad = checkApproveTarget(B, A, B);
    expect(bad.ok).toBe(false);
    expect(bad.remediation).toMatch(/UserKeeper/);
  });
});

describe("mode 5 — locked tokens", () => {
  it("flags deposited>0 with available=0", () => {
    expect(checkTokensUnlocked(100n, 0n).ok).toBe(false);
    expect(checkTokensUnlocked(100n, 100n).ok).toBe(true);
    expect(checkTokensUnlocked(0n, 0n).ok).toBe(true);
  });
});

describe("mode 7 — deploy guards", () => {
  it("cap must be 0 or > minted", () => {
    expect(checkDeployCap("0", "100", true).ok).toBe(true);
    expect(checkDeployCap("200", "100", true).ok).toBe(true);
    expect(checkDeployCap("100", "100", true).ok).toBe(false);
    expect(checkDeployCap("50", "100", true).ok).toBe(false);
    expect(checkDeployCap("100", "100", false).ok).toBe(true); // no token creation
  });
  it("LINEAR omitted/empty initData passes (builder auto-encodes)", () => {
    // The common/default path: caller omits initData for LINEAR.
    expect(checkLinearInitData("LINEAR_VOTES", undefined).ok).toBe(true);
    expect(checkLinearInitData("LINEAR_VOTES", "").ok).toBe(true);
    expect(checkLinearInitData("LINEAR_VOTES", "0x").ok).toBe(true);
    expect(checkLinearInitData("LINEAR_VOTES", LINEAR_POWER_INIT_SELECTOR).ok).toBe(true);
    // Only a wrong non-empty override is rejected.
    expect(checkLinearInitData("LINEAR_VOTES", "0xdeadbeef").ok).toBe(false);
    expect(checkLinearInitData("CUSTOM_VOTES", "0x").ok).toBe(true);
  });
  it("userKeeper needs a non-zero asset unless creating a token", () => {
    expect(checkUserKeeperAsset(B, ZERO, false).ok).toBe(true);
    expect(checkUserKeeperAsset(ZERO, B, false).ok).toBe(true);
    expect(checkUserKeeperAsset(ZERO, ZERO, false).ok).toBe(false);
    expect(checkUserKeeperAsset(ZERO, ZERO, true).ok).toBe(true);
  });
  it("mainnet treasury remainder must be zero", () => {
    expect(checkTreasuryRemainder("100", ["60", "40"], 56, true).ok).toBe(true);
    expect(checkTreasuryRemainder("100", ["60", "30"], 56, true).ok).toBe(false);
    // testnet tolerates a remainder
    expect(checkTreasuryRemainder("100", ["60", "30"], 97, true).ok).toBe(true);
  });
});

describe("mode 10 — edge cases", () => {
  it("rejects SVG bytes named jpeg", () => {
    const svg = new TextEncoder().encode("<svg xmlns");
    expect(checkAvatarIsJpeg("avatar.jpeg", svg).ok).toBe(false);
  });
  it("accepts a jpeg name", () => {
    expect(checkAvatarIsJpeg("avatar.jpeg").ok).toBe(true);
  });
  it("flags offchain type/quorum mistakes", () => {
    expect(checkOffchainMetadata({ type: "1717171717", quorum: 0.5 }).ok).toBe(false);
    expect(checkOffchainMetadata({ type: "default_single_option_type", quorum: 50 }).ok).toBe(false);
    expect(checkOffchainMetadata({ type: "default_single_option_type", quorum: 0.5 }).ok).toBe(true);
  });
});
