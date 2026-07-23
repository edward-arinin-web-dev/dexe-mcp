import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbiCoder } from "ethers";

/**
 * Bug #31 ownership pre-check (Task 1). `precheckMultiplierContract` probes an
 * RPC to confirm the ERC721 multiplier is deployed AND owned by the GovPool
 * before a mint/change_token/set_token_uri action is built — GovPool.execute →
 * mint reverts onlyOwner otherwise, stranding the proposal in SucceededFor.
 *
 * We mock `../../src/rpc.js` so the precheck talks to a fake provider whose
 * eth_getCode / eth_call responses we control. This file mocks the RPC module,
 * so it is kept SEPARATE from proposalBuilders.test.ts (which relies on the
 * real, RPC-less degrade path).
 */

const abi = AbiCoder.defaultAbiCoder();
const encAddr = (a: string) => abi.encode(["address"], [a]);
const OWNER_SELECTOR = "0x8da5cb5b"; // keccak256("owner()")[:4]

const GOVPOOL = "0x3333333333333333333333333333333333333333";
const MULTIPLIER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";

// Mutable fake-provider config the mocked RpcProvider closes over.
const state = vi.hoisted(() => ({
  code: "0x60006000" as string,
  owner: "0x0000000000000000000000000000000000000000",
  current: "0x0000000000000000000000000000000000000000",
}));

vi.mock("../../src/rpc.js", () => {
  const fakeProvider = {
    async getCode() {
      return state.code;
    },
    async call(tx: { data?: string }) {
      const sel = (tx.data ?? "").slice(0, 10);
      // owner() → owner addr; anything else (getNftMultiplierAddress) → current
      return sel === OWNER_SELECTOR ? encAddr(state.owner) : encAddr(state.current);
    },
  };
  return {
    RpcProvider: class {
      constructor(_config: unknown) {}
      requireProvider() {
        return fakeProvider;
      }
      tryProvider() {
        return { ok: fakeProvider };
      }
    },
  };
});

// Import AFTER the mock is registered.
const { precheckMultiplierContract } = await import("../../src/tools/proposalBuildComplex.js");

const config = { rpcUrl: "http://localhost:8545" } as never;

describe("precheckMultiplierContract (bug #31)", () => {
  beforeEach(() => {
    state.code = "0x60006000";
    state.owner = GOVPOOL;
    state.current = MULTIPLIER;
  });

  it("refuses when there is no contract code at the address", async () => {
    state.code = "0x";
    const r = await precheckMultiplierContract(
      config,
      { govPool: GOVPOOL, multiplierContract: MULTIPLIER, checkCurrentAddress: true },
      97,
    );
    expect(r.refuse).toMatch(/no contract at/);
  });

  it("refuses when the multiplier is not owned by the GovPool", async () => {
    state.owner = OTHER;
    const r = await precheckMultiplierContract(
      config,
      { govPool: GOVPOOL, multiplierContract: MULTIPLIER, checkCurrentAddress: true },
      97,
    );
    expect(r.refuse).toMatch(/not owned by this GovPool/);
    expect(r.refuse).toMatch(/onlyOwner/);
  });

  it("passes (no refusal, no warnings) when owned and active-address aligned", async () => {
    const r = await precheckMultiplierContract(
      config,
      { govPool: GOVPOOL, multiplierContract: MULTIPLIER, checkCurrentAddress: true },
      97,
    );
    expect(r.refuse).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("warns (does not refuse) when getNftMultiplierAddress != this contract", async () => {
    state.current = OTHER;
    const r = await precheckMultiplierContract(
      config,
      { govPool: GOVPOOL, multiplierContract: MULTIPLIER, checkCurrentAddress: true },
      97,
    );
    expect(r.refuse).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/getNftMultiplierAddress/);
  });

  it("skips the active-address check for set_token_uri (checkCurrentAddress=false)", async () => {
    state.current = OTHER; // would warn if checked
    const r = await precheckMultiplierContract(
      config,
      { govPool: GOVPOOL, multiplierContract: MULTIPLIER, checkCurrentAddress: false },
      97,
    );
    expect(r.refuse).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });
});
