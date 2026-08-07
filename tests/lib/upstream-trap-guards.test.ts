import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import {
  ADD_SETTINGS_BLOCKED_CHAINS,
  ADD_SETTINGS_SELECTOR,
  POST_EXECUTE_LOCK_ADVISORY,
  UPSTREAM_DOC,
  VALIDATOR_CANCEL_VOTE_ADVISORY,
  VALIDATOR_VOTE_IRREVOCABLE_ADVISORY,
  VESTING_WITHDRAW_ADVISORY,
  checkAddSettingsTrap,
  executeAddSettingsAdvisory,
  findAddSettingsActions,
  findVestingTiers,
  hasVestingLeg,
  isAddSettingsBlockedChain,
  lockedPowerAdvisory,
  renderAdvisories,
  vestingBlockedReport,
} from "../../src/lib/protocolAdvisories.js";
import { GOV_SETTINGS_FULL_ABI } from "../../src/tools/proposalBuildComplex.js";
import { checkTokensUnlocked } from "../../src/lib/preflight.js";

/**
 * ── Upstream protocol traps are pre-blocked, not post-mortemed ──────────────
 *
 * Every case below is a DEPLOYED-PROTOCOL defect documented in
 * docs/UPSTREAM-ISSUES.md: deterministic, knowable before gas is spent, and
 * previously discovered only from a revert receipt. These pin the guards that
 * turn each one into a build-time refusal or DANGER flag.
 */

describe("advisory shape", () => {
  const all = [
    VESTING_WITHDRAW_ADVISORY,
    VALIDATOR_CANCEL_VOTE_ADVISORY,
    VALIDATOR_VOTE_IRREVOCABLE_ADVISORY,
    executeAddSettingsAdvisory(97)!,
  ];

  it("names the upstream issue and says it is not a dexe-mcp bug", () => {
    for (const a of all) {
      expect(a.text, a.id).toMatch(/UPSTREAM PROTOCOL DEFECT/);
      expect(a.text, a.id).toMatch(/not a dexe-mcp bug/);
      expect(a.upstream, a.id).toContain(UPSTREAM_DOC);
      expect(a.upstream, a.id).toContain(a.id);
    }
  });

  it("tells the caller what to do instead", () => {
    // An advisory that only says "this breaks" leaves the agent to improvise.
    expect(VESTING_WITHDRAW_ADVISORY.text).toMatch(/vestingPercentage/);
    expect(VALIDATOR_CANCEL_VOTE_ADVISORY.text).toMatch(/top-up re-vote/i);
    expect(VALIDATOR_VOTE_IRREVOCABLE_ADVISORY.text).toMatch(/top-up re-vote/i);
    expect(executeAddSettingsAdvisory(97)!.text).toMatch(/settingsIds/);
  });

  it("renderAdvisories drops the empty slots and joins the rest", () => {
    expect(renderAdvisories([null, undefined])).toBeNull();
    const block = renderAdvisories([VESTING_WITHDRAW_ADVISORY, null, VALIDATOR_CANCEL_VOTE_ADVISORY])!;
    expect(block).toContain("F15");
    expect(block).toContain("F12");
  });
});

// ---------------------------------------------------------------- F15 -------

describe("F15 — a vested tier is refused before anything is encoded", () => {
  const tier = (name: string, pct: string) => ({
    name,
    vestingSettings: { vestingPercentage: pct },
  });

  it("treats only a non-zero human percent as a vested leg", () => {
    expect(hasVestingLeg("0")).toBe(false);
    expect(hasVestingLeg("0.0")).toBe(false);
    expect(hasVestingLeg(undefined)).toBe(false);
    expect(hasVestingLeg("not-a-number")).toBe(false);
    expect(hasVestingLeg("0.5")).toBe(true);
    expect(hasVestingLeg("50")).toBe(true);
  });

  it("finds every stranded tier with its index and name", () => {
    const risks = findVestingTiers([tier("Open", "0"), tier("Seed", "40"), tier("Public", "0")]);
    expect(risks).toEqual([{ index: 1, name: "Seed", vestingPercentage: "40" }]);
  });

  it("reports nothing for an all-zero sale", () => {
    expect(findVestingTiers([tier("Open", "0"), tier("Public", "0")])).toEqual([]);
  });

  it("the blocked report carries the tier ids, the reason and the exact opt-in", () => {
    const r = vestingBlockedReport(["2", "3"], "includeVesting: true");
    expect(r.tierIds).toEqual(["2", "3"]);
    expect(r.reason).toMatch(/blocked/i);
    expect(r.upstream).toContain("F15");
    expect(r.overrideWith).toBe("includeVesting: true");
  });
});

// ---------------------------------------------------------------- #36 -------

describe("#36 — addSettings is chain-aware, keyed off the emitted calldata", () => {
  const addSettingsData = `${ADD_SETTINGS_SELECTOR}deadbeef`;
  const editSettingsData = "0x1a2b3c4d0000";

  it("pins the selector against the ABI the builders actually encode with", () => {
    // A struct reorder upstream would move the selector and silently disarm
    // the guard; recompute it from the shipped fragment rather than trusting
    // the constant.
    const fromBuilders = new Interface(GOV_SETTINGS_FULL_ABI as unknown as string[])
      .getFunction("addSettings")!.selector;
    expect(ADD_SETTINGS_SELECTOR).toBe(fromBuilders);
    expect(ADD_SETTINGS_SELECTOR).toBe("0x6a11e769");
  });

  it("knows which chains still block it", () => {
    expect(ADD_SETTINGS_BLOCKED_CHAINS).toContain(97);
    expect(isAddSettingsBlockedChain(97)).toBe(true);
    // Mainnet was allowlisted 2026-07-22 — warning there would be a false alarm.
    expect(isAddSettingsBlockedChain(56)).toBe(false);
  });

  it("locates addSettings actions by selector, whichever builder made them", () => {
    expect(
      findAddSettingsActions([{ data: editSettingsData }, { data: addSettingsData }, { data: null }]),
    ).toEqual([1]);
  });

  it("blocks + DANGER-flags an addSettings proposal on chain 97", () => {
    const t = checkAddSettingsTrap({ chainId: 97, actions: [{ data: addSettingsData }] });
    expect(t.blocked).toBe(true);
    expect(t.actionIndices).toEqual([0]);
    expect(t.advisory!.severity).toBe("DANGER");
    expect(t.advisory!.text).toContain("chain 97");
    expect(t.advisory!.text).toMatch(/editSettings|settingsIds/);
  });

  it("stays quiet on mainnet and on an editSettings proposal", () => {
    expect(checkAddSettingsTrap({ chainId: 56, actions: [{ data: addSettingsData }] }).blocked).toBe(false);
    expect(checkAddSettingsTrap({ chainId: 97, actions: [{ data: editSettingsData }] }).blocked).toBe(false);
    expect(checkAddSettingsTrap({ chainId: 97, actions: [] }).advisory).toBeNull();
  });

  it("names the chain in the execute-side advisory, and only on blocked chains", () => {
    expect(executeAddSettingsAdvisory(97)!.text).toContain("chain 97");
    expect(executeAddSettingsAdvisory(56)).toBeNull();
    expect(executeAddSettingsAdvisory(1)).toBeNull();
  });
});

// ------------------------------------------------- tokens locked after exec --

describe("deposit lock — the preflight guard is live, not dead code", () => {
  it("derives the shipped advisory from checkTokensUnlocked itself", () => {
    // The remedy text has exactly one home. If someone edits the preflight
    // remediation, the advisory moves with it instead of drifting.
    const remedy = checkTokensUnlocked(1n, 0n).remediation!;
    expect(POST_EXECUTE_LOCK_ADVISORY.text).toContain(remedy);
    expect(POST_EXECUTE_LOCK_ADVISORY.text).toMatch(/withdraw/i);
  });

  it("flags a locked deposit when live power figures are available", () => {
    const a = lockedPowerAdvisory(100n, 0n)!;
    expect(a.severity).toBe("DANGER");
    expect(a.text).toMatch(/withdraw/i);
    expect(a.text).toContain("deposited=100");
  });

  it("stays silent when power is available or nothing is deposited", () => {
    expect(lockedPowerAdvisory(100n, 100n)).toBeNull();
    expect(lockedPowerAdvisory(0n, 0n)).toBeNull();
  });
});
