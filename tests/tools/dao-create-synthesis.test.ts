import { describe, it, expect } from "vitest";
import { synthesizeParams, computeSafetyProof, type SimpleConfig } from "../../src/tools/daoCreate.js";
import { checkMinVotesVsDistribution } from "../../src/lib/preflight.js";

const DEPLOYER = "0xdEADBEeF00000000000000000000000000000001";

const base: SimpleConfig = {
  daoName: "Aurora Collective",
  symbol: "AUR",
  totalSupply: "1000000",
  treasuryPercent: 49,
  quorumPercent: 51,
  voteModel: "LINEAR",
  durationSeconds: 86400,
  executionDelaySeconds: 0,
  minVotesTokens: "1",
  earlyCompletion: true,
};

describe("dexe_dao_create — SIMPLE synthesis (frontend-equivalent shape)", () => {
  it("builds a coherent default config: implicit treasury, deployer holds the distributed portion", () => {
    const p = synthesizeParams(base, DEPLOYER);
    // token
    expect(p.tokenParams.name).toBe("Aurora Collective");
    expect(p.tokenParams.symbol).toBe("AUR");
    // fixed supply: cap == mintedTotal (cap MUST be > 0; ERC20Capped rejects 0)
    expect(p.tokenParams.cap).toBe((1_000_000n * 10n ** 18n).toString());
    expect(p.tokenParams.mintedTotal).toBe((1_000_000n * 10n ** 18n).toString());
    // deployer is the ONLY recipient; treasury (49%) is an implicit remainder (govPool NOT in users)
    expect(p.tokenParams.users).toEqual([DEPLOYER]);
    expect(p.tokenParams.amounts).toEqual([(510_000n * 10n ** 18n).toString()]);
    // vote power
    expect(p.votePowerParams.voteType).toBe("LINEAR_VOTES");
    // quorum raw = 51% × 1e25 = 5.1e26
    expect(p.settingsParams.proposalSettings[0]!.quorum).toBe((51n * 10n ** 25n).toString());
    // delegation allowed (contract semantics false = ALLOW), early completion on
    expect(p.settingsParams.proposalSettings[0]!.delegatedVotingAllowed).toBe(false);
    // treasury is not a recipient
    expect(p.tokenParams.users).not.toContain("0x0000000000000000000000000000000000000000");
  });

  it("default 49/51 is reachable (boundary), clears the ≥50 floor", () => {
    const proof = computeSafetyProof(synthesizeParams(base, DEPLOYER));
    expect(proof.feasible).toBe(true);
    expect(proof.reachable).toBe(true);
    expect(proof.votablePct).toBe(51);
    expect(proof.quorumPct).toBe(51);
    expect(proof.floorOk).toBe(true);
  });

  it("flags the Generative Automative mistake: 70% treasury + 50% quorum is unreachable", () => {
    const bad = synthesizeParams({ ...base, treasuryPercent: 70, quorumPercent: 50 }, DEPLOYER);
    const proof = computeSafetyProof(bad);
    expect(proof.feasible).toBe(false);
    expect(proof.reachable).toBe(false);
    expect(proof.votablePct).toBe(30);
    expect(String(proof.message)).toMatch(/UNREACHABLE/);
  });

  it("POLYNOMIAL synthesis attaches the default curve coefficients", () => {
    const p = synthesizeParams({ ...base, voteModel: "POLYNOMIAL" }, DEPLOYER);
    expect(p.votePowerParams.voteType).toBe("POLYNOMIAL_VOTES");
    expect(p.votePowerParams.polynomialCoefficients?.coefficient3).toBe((97n * 10n ** 23n).toString());
  });

  it("default min-votes is 1 token, applied to both voting and creating", () => {
    const s = synthesizeParams(base, DEPLOYER).settingsParams.proposalSettings[0]!;
    expect(s.minVotesForVoting).toBe((10n ** 18n).toString());
    expect(s.minVotesForCreating).toBe((10n ** 18n).toString());
  });

  it("explicit minVotesTokens passes through in 18-dec wei", () => {
    const s = synthesizeParams({ ...base, minVotesTokens: "100" }, DEPLOYER).settingsParams.proposalSettings[0]!;
    expect(s.minVotesForVoting).toBe((100n * 10n ** 18n).toString());
    expect(s.minVotesForCreating).toBe((100n * 10n ** 18n).toString());
  });

  it("default 1-token min-votes clamps to the distributed amount on dust supplies", () => {
    // supply 1 token, 49% treasury → distributable 0.51 token < 1 token
    const s = synthesizeParams({ ...base, totalSupply: "1" }, DEPLOYER).settingsParams.proposalSettings[0]!;
    expect(s.minVotesForVoting).toBe((51n * 10n ** 16n).toString());
  });

  it("explicit minVotesTokens is NOT clamped — left for the builder guard to reject", () => {
    const s = synthesizeParams({ ...base, totalSupply: "1", minVotesTokens: "100" }, DEPLOYER)
      .settingsParams.proposalSettings[0]!;
    expect(s.minVotesForVoting).toBe((100n * 10n ** 18n).toString());
  });

  it("recipients[] splits the votable share and keeps the treasury remainder exact", () => {
    const A = "0xdeadbeef00000000000000000000000000000002";
    const B = "0xdeadbeef00000000000000000000000000000003";
    const p = synthesizeParams(
      { ...base, recipients: [{ address: A, percent: 30 }, { address: B, percent: 21 }] },
      DEPLOYER,
    );
    expect(p.tokenParams.users).toEqual([A, B]);
    expect(p.tokenParams.amounts).toEqual([
      (300_000n * 10n ** 18n).toString(),
      (210_000n * 10n ** 18n).toString(),
    ]);
    // sum(amounts) == distributable exactly (treasury 49% untouched)
    const sum = p.tokenParams.amounts.reduce((a, b) => a + BigInt(b), 0n);
    expect(sum).toBe(510_000n * 10n ** 18n);
    // deployer NOT included unless listed
    expect(p.tokenParams.users).not.toContain(DEPLOYER);
    // safety proof still reads 51% votable
    expect(computeSafetyProof(p).votablePct).toBe(51);
  });

  it("recipients[] refuses percents that do not sum to the votable share", () => {
    const A = "0xdeadbeef00000000000000000000000000000002";
    expect(() =>
      synthesizeParams({ ...base, recipients: [{ address: A, percent: 30 }] }, DEPLOYER),
    ).toThrow(/sum to 30\.00%.*votable share is 51\.00%/s);
  });

  it("recipients[] refuses duplicates and invalid addresses", () => {
    const A = "0xdeadbeef00000000000000000000000000000002";
    expect(() =>
      synthesizeParams(
        { ...base, recipients: [{ address: A, percent: 30 }, { address: A.toLowerCase(), percent: 21 }] },
        DEPLOYER,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      synthesizeParams({ ...base, recipients: [{ address: "0x123", percent: 51 }] }, DEPLOYER),
    ).toThrow(/invalid address/);
  });

  it("recipients[] rounding dust lands on the first recipient (fractional percents)", () => {
    const A = "0xdeadbeef00000000000000000000000000000002";
    const B = "0xdeadbeef00000000000000000000000000000003";
    const C = "0xdeadbeef00000000000000000000000000000004";
    // 17 + 17 + 17 = 51 — but with supply 1e6 and bps math each is exact here,
    // so use a supply that does not divide evenly by bps.
    const p = synthesizeParams(
      {
        ...base,
        totalSupply: "333333",
        recipients: [{ address: A, percent: 17 }, { address: B, percent: 17 }, { address: C, percent: 17 }],
      },
      DEPLOYER,
    );
    const supply = 333_333n * 10n ** 18n;
    const distributable = supply - (supply * 4900n) / 10000n;
    const sum = p.tokenParams.amounts.reduce((a, b) => a + BigInt(b), 0n);
    expect(sum).toBe(distributable);
  });

  it("default 1-token min-votes clamps to the LARGEST recipient allocation", () => {
    const A = "0xdeadbeef00000000000000000000000000000002";
    const B = "0xdeadbeef00000000000000000000000000000003";
    // supply 1 token → largest allocation 0.5 token < 1 token
    const s = synthesizeParams(
      { ...base, totalSupply: "1", recipients: [{ address: A, percent: 50 }, { address: B, percent: 1 }] },
      DEPLOYER,
    ).settingsParams.proposalSettings[0]!;
    expect(s.minVotesForVoting).toBe((50n * 10n ** 16n).toString());
  });

  it("earlyCompletion flag is threaded through", () => {
    expect(synthesizeParams(base, DEPLOYER).settingsParams.proposalSettings[0]!.earlyCompletion).toBe(true);
    expect(
      synthesizeParams({ ...base, earlyCompletion: false }, DEPLOYER).settingsParams.proposalSettings[0]!
        .earlyCompletion,
    ).toBe(false);
  });

  it("F2: the preview-stage preflight rejects minVotes above the largest holder (parity with confirm)", () => {
    // The exact F2 repro: totalSupply 1,000,000 (51% distributed = 510,000)
    // with minVotesTokens 600,000 — the old preview said "config looks
    // coherent" and only the confirm call was blocked by deploy.min-votes.
    // The handler now runs this check in the fast preflight BEFORE the
    // preview, so both calls fail identically.
    const p = synthesizeParams({ ...base, minVotesTokens: "600000" }, DEPLOYER);
    const s = p.settingsParams.proposalSettings[0]!;
    const r = checkMinVotesVsDistribution(
      s.minVotesForVoting,
      s.minVotesForCreating,
      p.tokenParams.amounts,
      p.tokenParams.name.length > 0,
    );
    expect(r.ok).toBe(false);
    expect(r.check).toBe("deploy.min-votes");
  });
});
