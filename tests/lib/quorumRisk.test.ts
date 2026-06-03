import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  classifyTreasuryActions,
  quorumPctFromRaw,
  judgeQuorum,
  quorumConcentration,
  worstRisk,
  buildTimeTreasuryAdvisory,
  treasurySelectors,
  lowQuorumAdvisory,
  treasuryExecuteAdvisory,
  TREASURY_RISK_ADVISORY,
} from "../../src/lib/quorumRisk.js";

/**
 * Low-quorum governance-safety advisories. Pins the quorum-unit math, the
 * treasury-action classifier (incl. best-effort decode + never-throw), the
 * quorum-concentration model, and the advisory strings.
 */

const TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

function enc(sig: string, method: string, args: unknown[]): string {
  return new Interface([`function ${sig}`]).encodeFunctionData(method, args);
}

describe("quorumPctFromRaw", () => {
  it("converts 5e26 (raw) to 50%", () => {
    expect(quorumPctFromRaw("500000000000000000000000000")).toBe(50);
    expect(quorumPctFromRaw(5n * 10n ** 26n)).toBe(50);
  });
  it("converts 1e27 to 100% and 0 to 0%", () => {
    expect(quorumPctFromRaw(10n ** 27n)).toBe(100);
    expect(quorumPctFromRaw(0n)).toBe(0);
  });
  it("keeps 2-decimal precision (51% = 5.1e26)", () => {
    expect(quorumPctFromRaw(51n * 10n ** 25n)).toBe(51);
  });
  it("returns NaN for unparseable input", () => {
    expect(Number.isNaN(quorumPctFromRaw("not-a-number"))).toBe(true);
  });
});

describe("judgeQuorum", () => {
  it("SAFE at/above floor", () => {
    expect(judgeQuorum(50, 50)).toBe("SAFE");
    expect(judgeQuorum(75, 50)).toBe("SAFE");
  });
  it("CAUTION within 0.8×floor", () => {
    expect(judgeQuorum(45, 50)).toBe("CAUTION"); // 0.8×50 = 40
    expect(judgeQuorum(40, 50)).toBe("CAUTION");
  });
  it("DANGER well below floor", () => {
    expect(judgeQuorum(39, 50)).toBe("DANGER");
    expect(judgeQuorum(5, 50)).toBe("DANGER");
  });
  it("DANGER on NaN", () => {
    expect(judgeQuorum(NaN, 50)).toBe("DANGER");
  });
});

describe("worstRisk", () => {
  it("picks the most dangerous level", () => {
    expect(worstRisk("SAFE", "CAUTION", "DANGER")).toBe("DANGER");
    expect(worstRisk("SAFE", "CAUTION")).toBe("CAUTION");
    expect(worstRisk("SAFE", "SAFE")).toBe("SAFE");
    expect(worstRisk()).toBe("SAFE");
  });
});

describe("classifyTreasuryActions", () => {
  it("detects approve / transfer / transferFrom / increaseAllowance with decoded recipient+amount", () => {
    const actions = [
      { executor: TOKEN, value: "0", data: enc("approve(address,uint256)", "approve", [TO, 100n]) },
      { executor: TOKEN, value: "0", data: enc("transfer(address,uint256)", "transfer", [TO, 200n]) },
      { executor: TOKEN, value: "0", data: enc("transferFrom(address,address,uint256)", "transferFrom", [TOKEN, TO, 300n]) },
      { executor: TOKEN, value: "0", data: enc("increaseAllowance(address,uint256)", "increaseAllowance", [TO, 400n]) },
    ];
    const hits = classifyTreasuryActions(actions);
    expect(hits.map((h) => h.kind)).toEqual(["approve", "transfer", "transferFrom", "increaseAllowance"]);
    expect(hits[0]!.recipient?.toLowerCase()).toBe(TO);
    expect(hits[0]!.amount).toBe("100");
    expect(hits[2]!.recipient?.toLowerCase()).toBe(TO); // `to` arg, not `from`
    expect(hits[2]!.amount).toBe("300");
  });

  it("flags ERC721 safeTransferFrom overloads as nftTransfer", () => {
    const a = enc("safeTransferFrom(address,address,uint256)", "safeTransferFrom", [TOKEN, TO, 7n]);
    const b = enc("safeTransferFrom(address,address,uint256,bytes)", "safeTransferFrom", [TOKEN, TO, 8n, "0x"]);
    const hits = classifyTreasuryActions([
      { executor: TOKEN, value: "0", data: a },
      { executor: TOKEN, value: "0", data: b },
    ]);
    expect(hits.every((h) => h.kind === "nftTransfer")).toBe(true);
  });

  it("flags native value transfer (value > 0) regardless of data", () => {
    const hits = classifyTreasuryActions([{ executor: TO, value: "1000", data: "0x" }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("nativeValue");
    expect(hits[0]!.amount).toBe("1000");
  });

  it("yields two hits for a native-value ERC20 call", () => {
    const data = enc("transfer(address,uint256)", "transfer", [TO, 1n]);
    const hits = classifyTreasuryActions([{ executor: TOKEN, value: "5", data }]);
    expect(hits.map((h) => h.kind).sort()).toEqual(["nativeValue", "transfer"]);
  });

  it("ignores benign / unknown selectors", () => {
    const data = enc("setX(uint256)", "setX", [42n]);
    expect(classifyTreasuryActions([{ executor: TOKEN, value: "0", data }])).toHaveLength(0);
  });

  it("never throws on malformed calldata; leaves decoded fields null", () => {
    // correct approve selector, truncated args → decode fails, hit still recorded
    const selector = treasurySelectors().find((s) => s === "0x095ea7b3")!;
    const hits = classifyTreasuryActions([{ executor: TOKEN, value: "0", data: selector }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("approve");
    expect(hits[0]!.recipient).toBeNull();
    expect(hits[0]!.amount).toBeNull();
  });

  it("tolerates non-numeric value without throwing", () => {
    expect(() => classifyTreasuryActions([{ executor: TO, value: "abc", data: "0x" }])).not.toThrow();
  });
});

describe("quorumConcentration", () => {
  it("uses on-chain requiredWeight / totalSupply when present", () => {
    // requiredWeight 30 of supply 100 → 30% needed → below 50 floor → DANGER
    const r = quorumConcentration({ quorumPct: 50, floorPct: 50, totalSupply: 100n, requiredWeight: 30n });
    expect(r.pctOfSupplyForQuorum).toBe(30);
    expect(r.verdict).toBe("DANGER");
  });
  it("derives requiredWeight from quorumPct × totalVoteWeight when no on-chain weight", () => {
    // 50% of 1000 = 500; supply 1000 → 50% → SAFE
    const r = quorumConcentration({ quorumPct: 50, floorPct: 50, totalSupply: 1000n, totalVoteWeight: 1000n });
    expect(r.requiredWeight).toBe(500n);
    expect(r.pctOfSupplyForQuorum).toBe(50);
    expect(r.verdict).toBe("SAFE");
  });
  it("returns CAUTION (unknown ≠ safe) when supply unknown", () => {
    const r = quorumConcentration({ quorumPct: 50, floorPct: 50 });
    expect(r.pctOfSupplyForQuorum).toBeNull();
    expect(r.verdict).toBe("CAUTION");
  });
});

describe("buildTimeTreasuryAdvisory", () => {
  const transfer = { executor: TOKEN, value: "0", data: enc("transfer(address,uint256)", "transfer", [TO, 1n]) };
  it("returns the advisory when an action moves treasury and guard is on", () => {
    expect(buildTimeTreasuryAdvisory([transfer], "warn")).toBe(TREASURY_RISK_ADVISORY);
  });
  it("returns null when guard is off", () => {
    expect(buildTimeTreasuryAdvisory([transfer], "off")).toBeNull();
  });
  it("returns null when no treasury action present", () => {
    const benign = { executor: TOKEN, value: "0", data: enc("setX(uint256)", "setX", [1n]) };
    expect(buildTimeTreasuryAdvisory([benign], "warn")).toBeNull();
  });
});

describe("advisory strings", () => {
  it("lowQuorumAdvisory names the pct and floor", () => {
    const msg = lowQuorumAdvisory(5, 50);
    expect(msg).toContain("5%");
    expect(msg).toContain("50%");
    expect(msg).toContain("governance-safety advisory");
  });
  it("treasuryExecuteAdvisory is advisory (no block wording) and names the reasons", () => {
    const msg = treasuryExecuteAdvisory(["quorum below floor"]);
    expect(msg).toContain("advisory");
    expect(msg).toContain("quorum below floor");
    expect(msg).not.toContain("Refusing");
    expect(msg).not.toContain("acknowledgeRisk");
  });
});
