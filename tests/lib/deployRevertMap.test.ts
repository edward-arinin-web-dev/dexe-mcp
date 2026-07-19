import { describe, expect, it } from "vitest";
import { DEPLOY_KNOWN_REVERTS, mapDeployRevert } from "../../src/lib/deployRevertMap.js";

/**
 * Deploy revert knowledge base — every known deployGovPool revert string maps
 * to a stable slug with a concrete fix; unknown/empty reasons fall back to the
 * `opaque` verdict with the likely-causes list. Match strings mirror the
 * DeXe-Protocol contract sources (require strings verified 2026-07-11).
 */

describe("mapDeployRevert", () => {
  it.each([
    ["PoolFactory: pool name cannot be empty", "name-empty"],
    ["PoolFactory: pool name is already taken", "name-taken"],
    ["Pool Factory: unexpected pool address", "predicted-address-drift"],
    ["PoolFactory: power init failed", "vote-power-init"],
    ["Pool Factory: can't initialize token", "token-init-failed"],
    ["ERC20Capped: cap is 0", "cap-zero"],
    ["ERC20Gov: mintedTotal should not be greater than cap", "cap-lt-minted"],
    ["ERC20Gov: overminting", "over-distribution"],
    ["ERC20Gov: users and amounts lengths mismatch", "users-amounts-mismatch"],
    ["GovSettings: invalid vote duration value", "settings-bounds"],
    ["GovSettings: invalid quorum value", "settings-bounds"],
    ["GovSettings: invalid validator vote duration value", "settings-bounds"],
    ["GovSettings: invalid validator quorum value", "settings-bounds"],
    ["GovUK: zero addresses", "userkeeper-asset"],
    ["Validators: duration is zero", "validators-init"],
    ["Validators: invalid quorum value", "validators-init"],
    ["Validators: invalid array length", "validators-init"],
    ["Validators: invalid address", "validators-init"],
    ["SphereX error: disallowed tx pattern", "spherex-pattern"],
    ["insufficient funds for gas * price + value", "no-gas"],
  ])("%s → %s", (reason, slug) => {
    const v = mapDeployRevert(reason);
    expect(v.slug).toBe(slug);
    expect(v.known).toBe(true);
    expect(v.fix.length).toBeGreaterThan(0);
  });

  it("matches inside a longer ethers error dump (execution reverted: ...)", () => {
    const v = mapDeployRevert(
      'execution reverted: "PoolFactory: pool name is already taken" (action="call", data=...)',
    );
    expect(v.slug).toBe("name-taken");
  });

  it("empty reason → opaque fallback with likely-causes list", () => {
    for (const reason of [undefined, null, "", "   "]) {
      const v = mapDeployRevert(reason);
      expect(v.slug).toBe("opaque");
      expect(v.known).toBe(false);
      expect(v.fix).toMatch(/settings bounds/i);
    }
  });

  it("unknown reason → opaque, quoting the raw reason", () => {
    const v = mapDeployRevert("SomeNewContract: brand new failure");
    expect(v.slug).toBe("opaque");
    expect(v.cause).toContain("SomeNewContract: brand new failure");
  });

  it("every KB entry has a non-empty slug, cause, and fix", () => {
    for (const e of DEPLOY_KNOWN_REVERTS) {
      expect(e.slug.length).toBeGreaterThan(0);
      expect(e.cause.length).toBeGreaterThan(0);
      expect(e.fix.length).toBeGreaterThan(0);
    }
  });
});
