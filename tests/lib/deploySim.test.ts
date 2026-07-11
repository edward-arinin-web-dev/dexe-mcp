import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-sign deploy simulation verdict mapping. Policy (user decision):
 *   genuine revert → "reverted" (callers refuse to sign/emit — fail-closed);
 *   transport/RPC failure → "unavailable" (callers proceed with a warning —
 *   fail-open); success → "ok" with gas estimate in the summary.
 */

const simulateCalldata = vi.fn();
vi.mock("../../src/tools/simulate.js", () => ({
  simulateCalldata: (...args: unknown[]) => simulateCalldata(...args),
}));

const { simulateDeployGovPool } = await import("../../src/lib/deploySim.js");

const ARGS = {
  to: "0x3E22B67B9a1D8bF0E2eA2cBb15fBB05E5F2568F0",
  data: "0xdeadbeef",
  deployer: "0x6b1daeD74540e906563B117Ac4d0D9aa39EF7233",
  chainId: 97,
  // Minimal config view — deploySim only reads defaultChainId/chainId and
  // hands the rest to RpcProvider (never dereferenced: simulateCalldata is mocked).
  config: { defaultChainId: 97, chainId: 97 } as never,
};

beforeEach(() => simulateCalldata.mockReset());

describe("simulateDeployGovPool", () => {
  it("success → ok with gas in the summary", async () => {
    simulateCalldata.mockResolvedValue({ success: true, gasEstimate: "6500000" });
    const v = await simulateDeployGovPool(ARGS);
    expect(v.status).toBe("ok");
    expect(v.gasEstimate).toBe("6500000");
    expect(v.summary).toMatch(/simulated OK/);
    expect(v.summary).toContain("97");
  });

  it("genuine revert → reverted, classified against the knowledge base", async () => {
    simulateCalldata.mockResolvedValue({
      success: false,
      revertReason: 'execution reverted: "PoolFactory: pool name is already taken"',
    });
    const v = await simulateDeployGovPool(ARGS);
    expect(v.status).toBe("reverted");
    expect(v.known?.slug).toBe("name-taken");
    expect(v.summary).toMatch(/WOULD REVERT/);
    expect(v.summary).toMatch(/Fix:/);
  });

  it("revert with no reason → reverted with opaque KB fallback", async () => {
    simulateCalldata.mockResolvedValue({ success: false, revertReason: undefined });
    const v = await simulateDeployGovPool(ARGS);
    expect(v.status).toBe("reverted");
    expect(v.known?.slug).toBe("opaque");
    expect(v.known?.known).toBe(false);
  });

  it("transport failure → unavailable, NEVER reverted (fail-open)", async () => {
    simulateCalldata.mockResolvedValue({
      success: false,
      revertReason: "SERVER_ERROR 429",
      networkError: true,
    });
    const v = await simulateDeployGovPool(ARGS);
    expect(v.status).toBe("unavailable");
    expect(v.summary).toMatch(/proceeding unverified/);
  });

  // NOTE: the "simulateCalldata throws" path (belt-and-suspenders catch in
  // deploySim) is not tested here — vitest v4 re-reports a spy-thrown error as
  // a test failure across the module-mock boundary even when the code under
  // test catches it. The real simulateCalldata never throws: it catches
  // internally and returns { success:false, networkError:true } (covered above).

  it("uses the deployer as the eth_call from (predict salt = deployer+name)", async () => {
    simulateCalldata.mockResolvedValue({ success: true });
    await simulateDeployGovPool(ARGS);
    expect(simulateCalldata).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: ARGS.deployer, to: ARGS.to, data: ARGS.data }),
    );
  });
});
