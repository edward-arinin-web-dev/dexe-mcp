import { describe, it, expect } from "vitest";
import {
  quorumAttainmentPct,
  requiredQuorumWeight,
  votesShortOfQuorum,
} from "../../src/lib/quorumRisk.js";

/**
 * D1-1 / D1-3 — the two quorum units, and the conversion between them.
 *
 * DeXe expresses quorum twice:
 *   SETTING — `GovSettings.getDefaultSettings().quorum`, a percentage scaled by
 *             PERCENTAGE_100 = 1e27 (DeXe-Protocol contracts/core/Globals.sol:4),
 *             so 5e25 = 5% and 5e26 = 50%.
 *   TARGET  — `GovPool.getProposalRequiredQuorum(id)`, an ABSOLUTE vote weight
 *             in token wei.
 *
 * The bridge is GovPool.sol:495:
 *   `_govUserKeeper.getTotalPower().ratio(core.settings.quorum, PERCENTAGE_100)`
 *
 * Every vector below is on-chain truth captured read-only during the 2026-09-11
 * audit, so this file fails the moment the conversion drifts from the protocol.
 */

const PCT_5 = 50_000_000_000_000_000_000_000_000n; // 5%  as 1e25-scaled setting
const PCT_30 = 300_000_000_000_000_000_000_000_000n; // 30%
const PCT_50 = 500_000_000_000_000_000_000_000_000n; // 50%
const PCT_100 = 10n ** 27n; // 100%

describe("requiredQuorumWeight mirrors GovPool.getProposalRequiredQuorum", () => {
  const vectors: Array<{
    dao: string;
    totalPower: bigint;
    quorumRaw: bigint;
    expected: bigint;
    /** Where the expected value was read from, live. */
    source: string;
  }> = [
    {
      dao: "DeXe Protocol DAO 0xb562127efdc97b417b3116eff2c23a29857c0f0b (chain 56)",
      totalPower: 22_098_102_605_179_570_000_000_000n,
      quorumRaw: PCT_5,
      expected: 1_104_905_130_258_978_500_000_000n,
      source: "getProposalRequiredQuorum(28)",
    },
    {
      dao: "BOXY 0x927980153ef1743a3e9f3549eb307e06c74b5571 (chain 56)",
      totalPower: 10n ** 28n,
      quorumRaw: PCT_5,
      expected: 500_000_000_000_000_000_000_000_000n,
      source: "getProposalRequiredQuorum(7)",
    },
    {
      dao: "DMT (TEST) 0xfb2a3f5a0516883dc0a3493e25e48b3492e12b42 (chain 56)",
      totalPower: 10n ** 19n,
      quorumRaw: PCT_30,
      expected: 3_000_000_000_000_000_000n,
      source: "getProposalRequiredQuorum(77)",
    },
    {
      dao: "Glacier testnet 0x9820e732799dd73069692C9aC2cD561487ec1C38 (chain 97)",
      totalPower: 1_000_000_000_000_000_000_000_000n,
      quorumRaw: PCT_50,
      expected: 500_000_000_000_000_000_000_000n,
      source: "getProposalRequiredQuorum(1) — proves the formula on the older testnet contract set",
    },
  ];

  it.each(vectors)("$dao → $source", ({ totalPower, quorumRaw, expected }) => {
    expect(requiredQuorumWeight(totalPower, quorumRaw)).toBe(expected);
  });

  it("a 1M-token, 18-decimal DAO at 5% needs 50k tokens of weight", () => {
    const supply = 1_000_000n * 10n ** 18n;
    expect(requiredQuorumWeight(supply, PCT_5)).toBe(50_000n * 10n ** 18n);
  });

  it("100% quorum is the whole power, exactly", () => {
    expect(requiredQuorumWeight(12_345n, PCT_100)).toBe(12_345n);
  });

  it("floors like Solidity `ratio` instead of throwing on a repeating fraction", () => {
    expect(requiredQuorumWeight(3n, 333_333_333_333_333_333_333_333_333n)).toBe(0n);
  });

  it.each([
    ["zero total power (0 must never become a divisor)", 0n, PCT_50],
    ["unknown total power", null, PCT_50],
    ["unknown quorum setting", 10n ** 24n, null],
    ["undefined total power", undefined, PCT_50],
    ["negative quorum setting", 10n ** 24n, -1n],
  ] as Array<[string, bigint | null | undefined, bigint | null]>)("null for %s", (_label, tp, q) => {
    expect(requiredQuorumWeight(tp, q)).toBeNull();
  });
});

describe("quorumAttainmentPct measures votes against the TARGET, never the setting", () => {
  it("the DeXe Protocol DAO forecast that shipped inverted: 185.71%, not 4.1%", () => {
    const pct = quorumAttainmentPct(2_051_925_536_089_401_709_423_372n, 1_104_905_130_258_978_500_000_000n);
    expect(pct).toBeCloseTo(185.71, 1);
  });

  it("BOXY errs the other way: 40.29% of target, not 402.9%", () => {
    const pct = quorumAttainmentPct(201_453_367_961_961_270_282_342_310n, 500_000_000_000_000_000_000_000_000n);
    expect(pct).toBeCloseTo(40.29, 1);
  });

  it.each([
    [50n, 100n, 50],
    [0n, 100n, 0],
    [100n * 10n ** 18n, 100n * 10n ** 18n, 100],
  ] as Array<[bigint, bigint, number]>)("%s of %s → %s%%", (votes, target, expected) => {
    expect(quorumAttainmentPct(votes, target)).toBe(expected);
  });

  it.each([
    ["target 0 (proposal does not exist / has not started)", 5n, 0n],
    ["target null", 5n, null],
    ["target undefined", 5n, undefined],
  ] as Array<[string, bigint, bigint | null | undefined]>)("null for %s", (_l, v, t) => {
    expect(quorumAttainmentPct(v, t)).toBeNull();
  });
});

describe("votesShortOfQuorum tracks the LEADING side — quorum is per-side", () => {
  // GovPoolVote.sol:367-375: quorum is reached when EITHER votesFor OR
  // votesAgainst clears the target, never their sum.
  const TARGET = 500_000_000_000_000_000_000_000n;

  it("an Against-carried proposal is NOT short of quorum", () => {
    expect(votesShortOfQuorum(1n, 600_000_000_000_000_000_000_000n, TARGET)).toBe("0");
  });

  it("a For-carried proposal is not short either", () => {
    expect(votesShortOfQuorum(TARGET, 0n, TARGET)).toBe("0");
  });

  it("the shortfall is measured from the bigger side", () => {
    expect(votesShortOfQuorum(73_528_733_728_891_976_396_172n, 10n, TARGET)).toBe(
      "426471266271108023603828",
    );
  });

  it("the sum of the two sides is never what closes the gap", () => {
    // 60% + 60% of target on opposite sides: quorum IS reached (each side alone
    // clears it), but a naive votesFor+votesAgainst model is not what says so.
    const each = (TARGET * 60n) / 100n;
    expect(votesShortOfQuorum(each, each, TARGET)).toBe(((TARGET * 40n) / 100n).toString());
  });

  it.each([
    ["target 0", 0n],
    ["target null", null],
  ] as Array<[string, bigint | null]>)("null for %s", (_l, t) => {
    expect(votesShortOfQuorum(1n, 2n, t)).toBeNull();
  });
});
