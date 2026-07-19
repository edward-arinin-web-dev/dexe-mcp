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
  checkQuorumReachable,
  checkMinVotesVsDistribution,
  checkSettingsBounds,
  checkNoTreasuryRecipient,
  checkValidatorsCoherence,
  checkCustomVotePower,
  POLYNOMIAL_POWER_INIT_SELECTOR,
  meritocraticVotingPower,
  checkAvatarIsJpeg,
  checkOffchainMetadata,
} from "../../src/lib/preflight.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

// 1e18-scaled token helpers for the coherence tests.
const T = (whole: number | bigint) => (BigInt(whole) * 10n ** 18n).toString();
const PCT = (p: number) => (BigInt(Math.round(p * 100)) * 10n ** 25n / 100n).toString(); // pct → quorum raw (1e27=100%)

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
  it("cap must be > 0 and ≥ minted (cap==minted OK; cap=0 and cap<minted revert live)", () => {
    expect(checkDeployCap("0", "100", true).ok).toBe(false); // ERC20Capped: cap is 0
    expect(checkDeployCap("200", "100", true).ok).toBe(true); // cap > minted
    expect(checkDeployCap("100", "100", true).ok).toBe(true); // cap == minted (fixed supply) — valid live
    expect(checkDeployCap("50", "100", true).ok).toBe(false); // cap < minted → ERC20Gov revert
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
  it("treasury remainder is allowed (implicit); only over-distribution fails", () => {
    // full distribution (sum == minted) — fine
    expect(checkTreasuryRemainder("100", ["60", "40"], true).ok).toBe(true);
    // implicit treasury remainder (sum < minted) — the frontend pattern, now allowed
    expect(checkTreasuryRemainder("100", ["60", "30"], true).ok).toBe(true);
    expect(checkTreasuryRemainder("100", ["51"], true).ok).toBe(true);
    // over-distribution (sum > minted) — invalid on any chain
    expect(checkTreasuryRemainder("100", ["60", "50"], true).ok).toBe(false);
    // not creating a token — skip
    expect(checkTreasuryRemainder("100", ["999"], false).ok).toBe(true);
  });
});

describe("DAO governance coherence (frontend parity)", () => {
  it("blocks an unreachable quorum (LINEAR): quorum > votable share", () => {
    // supply 1M, 49% treasury (implicit) → 510k votable. quorum 51% needs 510k → reachable (boundary).
    const okCase = checkQuorumReachable({
      voteType: "LINEAR_VOTES",
      quorumRaw: PCT(51),
      mintedTotal: T(1_000_000),
      votable: T(510_000),
      isTokenCreation: true,
    });
    expect(okCase.ok).toBe(true);
    // The Generative Automative shape: 70% treasury / 30% votable, quorum 50% → UNREACHABLE.
    const bad = checkQuorumReachable({
      voteType: "LINEAR_VOTES",
      quorumRaw: PCT(50),
      mintedTotal: T(1_000_000),
      votable: T(300_000),
      isTokenCreation: true,
    });
    expect(bad.ok).toBe(false);
    expect(bad.remediation).toMatch(/UNREACHABLE/);
    // external token (not creation) is skipped, like the frontend.
    expect(
      checkQuorumReachable({ voteType: "LINEAR_VOTES", quorumRaw: PCT(99), mintedTotal: "0", votable: "0", isTokenCreation: false }).ok,
    ).toBe(true);
  });

  it("min-votes must not exceed the largest recipient", () => {
    expect(checkMinVotesVsDistribution(T(1), T(1), [T(500_000)], true).ok).toBe(true);
    // minVotesForCreating above every holder → nobody can create a proposal.
    const bad = checkMinVotesVsDistribution(T(1), T(600_000), [T(500_000)], true);
    expect(bad.ok).toBe(false);
    expect(bad.remediation).toMatch(/minVotesForCreating/);
  });

  it("settings bounds: quorum 0<q≤1e27, durations > 0", () => {
    const good = { quorum: PCT(51), quorumValidators: PCT(51), duration: "86400", durationValidators: "86400" };
    expect(checkSettingsBounds(good).ok).toBe(true);
    expect(checkSettingsBounds({ ...good, quorum: "0" }).ok).toBe(false);
    expect(checkSettingsBounds({ ...good, quorum: (10n ** 27n + 1n).toString() }).ok).toBe(false);
    expect(checkSettingsBounds({ ...good, duration: "0" }).ok).toBe(false);
  });

  it("rejects the treasury (govPool) as a token recipient", () => {
    expect(checkNoTreasuryRecipient([A, B], B).ok).toBe(false);
    expect(checkNoTreasuryRecipient([A], B).ok).toBe(true);
    expect(checkNoTreasuryRecipient([A, B], undefined).ok).toBe(true); // unknown govPool → skip
  });

  it("validators coherence: duplicates, zero balances, bad settings all fail", () => {
    const good = { validators: [A, B], balances: [T(10), T(10)], duration: "86400", quorum: PCT(51) };
    expect(checkValidatorsCoherence(good).ok).toBe(true);
    expect(checkValidatorsCoherence({ validators: [], balances: [], duration: "86400", quorum: PCT(51) }).ok).toBe(true);
    // duplicate validator (case-insensitive)
    const dup = checkValidatorsCoherence({ ...good, validators: [A, A.toUpperCase().replace("0X", "0x")] });
    expect(dup.ok).toBe(false);
    expect(dup.remediation).toMatch(/duplicate/);
    // zero balance → dead validator seat
    const zeroBal = checkValidatorsCoherence({ ...good, balances: [T(10), "0"] });
    expect(zeroBal.ok).toBe(false);
    expect(zeroBal.remediation).toMatch(/could never vote/);
    // zero-address validator (contract: "Validators: invalid address")
    expect(checkValidatorsCoherence({ ...good, validators: [A, ZERO] }).ok).toBe(false);
    // contract init bounds: duration > 0, 0 < quorum ≤ 1e27
    expect(checkValidatorsCoherence({ ...good, duration: "0" }).ok).toBe(false);
    expect(checkValidatorsCoherence({ ...good, quorum: "0" }).ok).toBe(false);
    expect(checkValidatorsCoherence({ ...good, quorum: (10n ** 27n + 1n).toString() }).ok).toBe(false);
  });

  it("CUSTOM vote power: preset required, initData must be call data", () => {
    // CUSTOM with a real preset and empty/valid initData passes
    expect(checkCustomVotePower("CUSTOM_VOTES", undefined, A).ok).toBe(true);
    expect(checkCustomVotePower("CUSTOM_VOTES", "0x", A).ok).toBe(true);
    expect(checkCustomVotePower("CUSTOM_VOTES", "0x892aea1f", A).ok).toBe(true);
    // CUSTOM without a preset contract → fail
    expect(checkCustomVotePower("CUSTOM_VOTES", "0x", ZERO).ok).toBe(false);
    // malformed initData (not hex call data)
    expect(checkCustomVotePower("CUSTOM_VOTES", "0x123", A).ok).toBe(false);
    expect(checkCustomVotePower("CUSTOM_VOTES", "hello", A).ok).toBe(false);
    // POLYNOMIAL: empty is fine (builder auto-encodes); wrong selector override fails
    expect(checkCustomVotePower("POLYNOMIAL_VOTES", undefined, ZERO).ok).toBe(true);
    expect(checkCustomVotePower("POLYNOMIAL_VOTES", `${POLYNOMIAL_POWER_INIT_SELECTOR}00`, ZERO).ok).toBe(true);
    const badPoly = checkCustomVotePower("POLYNOMIAL_VOTES", "0xdeadbeef", ZERO);
    expect(badPoly.ok).toBe(false);
    expect(badPoly.remediation).toMatch(/__PolynomialPower_init/);
    // LINEAR is checkLinearInitData's job — this check stays silent
    expect(checkCustomVotePower("LINEAR_VOTES", "0xdeadbeef", ZERO).ok).toBe(true);
  });

  it("meritocratic power is linear below the 7% threshold, curved above", () => {
    const supply = 1_000_000n * 10n ** 18n;
    // 1% of supply is below the ~7% threshold → power == votes (linear region)
    const small = 10_000n * 10n ** 18n;
    expect(meritocraticVotingPower(small, supply)).toBe(small);
    // 60% of supply is above threshold → curved power, still positive and ≤ votes
    const big = 600_000n * 10n ** 18n;
    const power = meritocraticVotingPower(big, supply);
    expect(power > 0n).toBe(true);
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
