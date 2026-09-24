import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { classifyGovernanceActions, governanceVerdict } from "../../src/lib/buildAdvisories.js";
import { recommend } from "../../src/tools/risk.js";

/**
 * Live regression, 2026-09-24 (chain 97, Thornfield Millwrights Guild):
 * `dexe_proposal_risk_assess` on a plain `token_transfer` of the DAO's own gov
 * token — built by `dexe_proposal_create` itself — answered
 *
 *   verdict: DANGER
 *   governanceHits: [{ selector: 0xa9059cbb, kind: "unknownPrivileged" }]
 *   "…targeting the DAO's own contract(s) <govToken>. It moves no treasury
 *    value…"  beside  treasuryTouching: true
 *   "HIGH RISK: … under a low quorum"  beside  quorumVerdict: SAFE
 *   two sentences glued with a literal `\x0a\x0a`
 *
 * Three independent defects: the gov token sits in `protocolAddresses`, so a
 * selector the governance table does not know fell through to
 * `unknownPrivileged` even though the treasury table had already scored it; the
 * governance sentence asserted "moves no treasury value" unconditionally; and
 * the treasury sentence was fed the MERGED verdict instead of the treasury
 * leg's own. The newline was `structuredContent` deep-sanitization escaping
 * `\n` — server-authored prose in a sanitized payload must not use it.
 */

const GOVPOOL = "0x1111111111111111111111111111111111111111";
const KEEPER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const USER = "0x4444444444444444444444444444444444444444";

const ERC20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

const protocolAddresses = [GOVPOOL, KEEPER, TOKEN];

describe("classifyGovernanceActions — value-moving calls on the gov token are the treasury table's, not governance hits", () => {
  it("ERC20.transfer on the DAO's own gov token is NOT unknownPrivileged", () => {
    const hits = classifyGovernanceActions(
      [{ executor: TOKEN, data: ERC20.encodeFunctionData("transfer", [USER, 2500n * 10n ** 18n]) }],
      { protocolAddresses },
    );
    expect(hits).toEqual([]);
    expect(governanceVerdict(hits)).toBe("SAFE");
  });

  it("approve / transferFrom on the gov token are likewise left to the treasury classifier", () => {
    for (const data of [
      ERC20.encodeFunctionData("approve", [USER, 1n]),
      ERC20.encodeFunctionData("transferFrom", [GOVPOOL, USER, 1n]),
    ]) {
      expect(classifyGovernanceActions([{ executor: TOKEN, data }], { protocolAddresses })).toEqual([]);
    }
  });

  it("a genuinely unknown selector on the gov token is still unknownPrivileged (mint inflates supply)", () => {
    const hits = classifyGovernanceActions(
      [{ executor: TOKEN, data: ERC20.encodeFunctionData("mint", [USER, 1n]) }],
      { protocolAddresses },
    );
    expect(hits[0]?.kind).toBe("unknownPrivileged");
    expect(governanceVerdict(hits)).toBe("DANGER");
  });
});

describe("recommend() — the two legs describe themselves, not each other", () => {
  const ownedHit = {
    index: 0,
    executor: KEEPER,
    selector: "0x12345678",
    kind: "unknownPrivileged" as const,
    targets: [],
    protocolTargets: [KEEPER],
  };

  it("a plain treasury transfer under a SAFE quorum recommends the SAFE treasury sentence", () => {
    const text = recommend("SAFE", 50, true, []);
    expect(text).toContain("Quorum ≥50%");
    expect(text).not.toContain("HIGH RISK");
    expect(text).not.toContain("moves no treasury value");
  });

  it("governance DANGER beside a treasury hit does not claim the proposal moves no treasury value", () => {
    const text = recommend("DANGER", 50, true, [ownedHit], "SAFE");
    expect(text).toContain("DANGER");
    expect(text).not.toContain("moves no treasury value");
    expect(text).toContain("separate from the treasury movement");
  });

  it("the treasury sentence follows the treasury leg's verdict, not the merged one", () => {
    // Merged = DANGER (governance), treasury leg = SAFE.
    const text = recommend("DANGER", 50, true, [ownedHit], "SAFE");
    expect(text).not.toContain("HIGH RISK");
    expect(text).toContain("Quorum ≥50%");
    // And when the treasury leg IS the danger, it says so.
    const low = recommend("DANGER", 50, true, [], "DANGER");
    expect(low).toContain("HIGH RISK");
  });

  it("with no treasury hit the governance sentence keeps the 'moves no treasury value' framing", () => {
    const text = recommend("DANGER", 50, false, [ownedHit]);
    expect(text).toContain("moves no treasury value");
    expect(text).toContain("UNASSESSED");
  });

  it("never carries a newline — structuredContent sanitization would render it as \\x0a", () => {
    for (const text of [
      recommend("DANGER", 50, true, [ownedHit], "SAFE"),
      recommend("DANGER", 50, false, [ownedHit]),
      recommend("CAUTION", 50, true, [], "CAUTION"),
    ]) {
      expect(text).not.toMatch(/[\r\n]/);
    }
  });
});
