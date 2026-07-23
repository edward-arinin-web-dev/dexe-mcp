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
const IMPL_SELECTOR = "0x5c60da1b"; // keccak256("implementation()")[:4]

const GOVPOOL = "0x3333333333333333333333333333333333333333";
const MULTIPLIER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";
const IMPL_ADDR = "0x5555555555555555555555555555555555555555";
const BEACON_ADDR = "0x6666666666666666666666666666666666666666";
const BEACON_IMPL_ADDR = "0x7777777777777777777777777777777777777777";

// EIP-1967 slots (fixed constants, mirrored from proposalBuildComplex.ts).
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO32 = "0x" + "0".repeat(64);
const slotForAddr = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

// Bytecode fixtures. The mint selector (0xaf2d2333) as a PUSH4 immediate is
// "63af2d2333"; WITHOUT omits it. changeToken (0x4ccc2757) → "634ccc2757".
const CODE_WITHOUT_SELECTOR = "0x60006000";
const CODE_WITH_MINT = "0x60ff63af2d233314600057";
const CODE_WITH_CHANGE_TOKEN = "0x60ff634ccc275714600057";

// Mutable fake-provider config the mocked RpcProvider closes over.
const state = vi.hoisted(() => ({
  code: "0x60006000" as string,
  owner: "0x0000000000000000000000000000000000000000",
  current: "0x0000000000000000000000000000000000000000",
  // Selector-scan controls (Task 1 extension).
  codeByAddr: {} as Record<string, string>,
  implSlot: "0x" + "0".repeat(64),
  beaconSlot: "0x" + "0".repeat(64),
  beaconImpl: "0x0000000000000000000000000000000000000000",
  getStorageThrows: false,
}));

vi.mock("../../src/rpc.js", () => {
  const fakeProvider = {
    async getCode(addr: string) {
      const byAddr = state.codeByAddr[(addr ?? "").toLowerCase()];
      return byAddr ?? state.code;
    },
    async getStorage(_addr: string, slot: string) {
      if (state.getStorageThrows) throw new Error("rpc down");
      if (slot === EIP1967_IMPL_SLOT) return state.implSlot;
      if (slot === EIP1967_BEACON_SLOT) return state.beaconSlot;
      return "0x" + "0".repeat(64);
    },
    async call(tx: { data?: string }) {
      const sel = (tx.data ?? "").slice(0, 10);
      if (sel === OWNER_SELECTOR) return encAddr(state.owner);
      if (sel === IMPL_SELECTOR) return encAddr(state.beaconImpl); // beacon.implementation()
      return encAddr(state.current); // getNftMultiplierAddress()
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
    state.codeByAddr = {};
    state.implSlot = ZERO32;
    state.beaconSlot = ZERO32;
    state.beaconImpl = "0x0000000000000000000000000000000000000000";
    state.getStorageThrows = false;
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

describe("precheckMultiplierContract selector guard (bug #31 class)", () => {
  beforeEach(() => {
    state.code = "0x60006000";
    state.owner = GOVPOOL;
    state.current = MULTIPLIER;
    state.codeByAddr = {};
    state.implSlot = ZERO32;
    state.beaconSlot = ZERO32;
    state.beaconImpl = "0x0000000000000000000000000000000000000000";
    state.getStorageThrows = false;
  });

  it("(a) passes through to the owner check when the target bytecode dispatches mint", async () => {
    state.code = CODE_WITH_MINT;
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "mint",
      },
      97,
    );
    // Selector found → owner()==GovPool & aligned → clean pass.
    expect(r.refuse).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("(a') passes for change_token when bytecode dispatches changeToken", async () => {
    state.code = CODE_WITH_CHANGE_TOKEN;
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "change_token",
      },
      97,
    );
    expect(r.refuse).toBeUndefined();
  });

  it("(b) passes when the mint selector lives behind an EIP-1967 implementation slot", async () => {
    state.code = CODE_WITHOUT_SELECTOR; // proxy shell, no selector
    state.implSlot = slotForAddr(IMPL_ADDR);
    state.codeByAddr = { [IMPL_ADDR.toLowerCase()]: CODE_WITH_MINT };
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "mint",
      },
      97,
    );
    expect(r.refuse).toBeUndefined();
  });

  it("(c) passes via the EIP-1967 beacon → implementation() path (the DeXe shape)", async () => {
    state.code = CODE_WITHOUT_SELECTOR;
    state.beaconSlot = slotForAddr(BEACON_ADDR);
    state.beaconImpl = BEACON_IMPL_ADDR;
    state.codeByAddr = { [BEACON_IMPL_ADDR.toLowerCase()]: CODE_WITH_MINT };
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "mint",
      },
      97,
    );
    expect(r.refuse).toBeUndefined();
  });

  it("(d) refuses when no layer exposes the mint selector", async () => {
    state.code = CODE_WITHOUT_SELECTOR; // impl+beacon slots stay zero
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "mint",
      },
      97,
    );
    expect(r.refuse).toMatch(/0xaf2d2333|does not expose/);
    expect(r.refuse).toMatch(/SucceededFor/);
  });

  it("(e) degrades (no refuse) when a proxy-slot read throws", async () => {
    state.code = CODE_WITHOUT_SELECTOR; // direct scan finds nothing
    state.getStorageThrows = true; // both slot reads error → inconclusive
    const r = await precheckMultiplierContract(
      config,
      {
        govPool: GOVPOOL,
        multiplierContract: MULTIPLIER,
        checkCurrentAddress: true,
        selectorCheck: "mint",
      },
      97,
    );
    expect(r.refuse).toBeUndefined();
  });
});
