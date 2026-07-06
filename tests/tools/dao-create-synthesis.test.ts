import { describe, it, expect } from "vitest";
import { synthesizeParams, computeSafetyProof, type SimpleConfig } from "../../src/tools/daoCreate.js";

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
});
