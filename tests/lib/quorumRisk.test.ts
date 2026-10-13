import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  buildTimeTreasuryAdvisory,
  lowQuorumAdvisory,
  treasuryExecuteAdvisory,
  TREASURY_RISK_ADVISORY,
} from "../../src/lib/treasuryGate.js";

/**
 * Low-quorum governance-safety advisories: the treasury gate and the advisory
 * strings. The quorum-unit math, the treasury-action classifier and the
 * quorum-concentration model under them are the read edition's
 * (@dexe-network/dexe-mcp/core) and are pinned in its copy of this file.
 */

const TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

function enc(sig: string, method: string, args: unknown[]): string {
  return new Interface([`function ${sig}`]).encodeFunctionData(method, args);
}

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
