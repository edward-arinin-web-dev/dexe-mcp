import { describe, expect, it } from "vitest";
import { assertAllowlistAndValueCap, BroadcastGuardError } from "../../src/lib/broadcastGuards.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * L-1 guardrail. The Safe-TX-Service propose path signed and queued a
 * transaction without applying ANY broadcast guard, so DEXE_SIGNER_ALLOWLIST
 * (B6) and DEXE_SIGNER_MAX_VALUE_WEI (B7) silently didn't protect the Safe
 * route — a false sense of safety. Those two stateless checks are now factored
 * into assertAllowlistAndValueCap and applied on the Safe path too. (B9 sim /
 * B10 rate are broadcast-specific and intentionally not run for a Safe queue.)
 */

const ALLOWED = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function cfg(over: Partial<DexeConfig>): DexeConfig {
  return over as unknown as DexeConfig;
}

describe("assertAllowlistAndValueCap (L-1)", () => {
  it("B6: refuses a destination outside the allowlist", () => {
    const c = cfg({ signerAllowlist: [ALLOWED.toLowerCase()] });
    expect(() => assertAllowlistAndValueCap({ to: OTHER, value: "0" }, c)).toThrow(/DEXE_SIGNER_ALLOWLIST/);
    try {
      assertAllowlistAndValueCap({ to: OTHER, value: "0" }, c);
    } catch (e) {
      expect((e as BroadcastGuardError).guard).toBe("B6");
    }
  });

  it("B6: allows a whitelisted destination", () => {
    const c = cfg({ signerAllowlist: [ALLOWED.toLowerCase()] });
    expect(() => assertAllowlistAndValueCap({ to: ALLOWED, value: "0" }, c)).not.toThrow();
  });

  it("B7: refuses value above the cap", () => {
    const c = cfg({ signerMaxValueWei: 1000n });
    expect(() => assertAllowlistAndValueCap({ to: OTHER, value: "1001" }, c)).toThrow(
      /DEXE_SIGNER_MAX_VALUE_WEI/,
    );
  });

  it("B7: allows value at the cap", () => {
    const c = cfg({ signerMaxValueWei: 1000n });
    expect(() => assertAllowlistAndValueCap({ to: OTHER, value: "1000" }, c)).not.toThrow();
  });

  it("is a no-op when neither guard env is configured (default posture unchanged)", () => {
    expect(() => assertAllowlistAndValueCap({ to: OTHER, value: "999999999" }, cfg({}))).not.toThrow();
  });
});
