import { describe, it, expect } from "vitest";
import {
  assertIndexParallel,
  checkDaosRegistered,
  checkTokenPairing,
  tokenPairingMessage,
  unregisteredFixtureMessage,
} from "../../scripts/swarm/allowlist-guard.js";

// Imports the pure module only: scripts/swarm/preflight.ts and orchestrator.ts
// both call main() at module scope and process.exit() on failure.

const A = "0x081f4b5C88325fBdA757F31b86a15cD3a7DEaEFe";
const B = "0x0fe0474aE9499F4b5da85617e5482Db83714da6b";

describe("checkDaosRegistered", () => {
  it("passes when every allowlisted DAO is a registered GovPool", async () => {
    const v = await checkDaosRegistered([A, B], async () => true);
    expect(v).toEqual({ unregistered: [], verified: true });
  });

  it("reports the offending address when one is not registered", async () => {
    const v = await checkDaosRegistered([A, B], async (d) => d !== A);
    expect(v.verified).toBe(true);
    expect(v.unregistered).toEqual([A]);
  });

  it("fails OPEN when the registry read throws — a flaky RPC must not block a run", async () => {
    const v = await checkDaosRegistered([A, B], async () => {
      throw new Error("could not detect network");
    });
    expect(v).toEqual({ unregistered: [], verified: false });
  });
});

describe("unregisteredFixtureMessage", () => {
  it("names the address, the chain, the guard and the remedy", () => {
    const m = unregisteredFixtureMessage(A, 0, "TESTNET", 97);
    expect(m).toContain(A);
    expect(m).toContain("97");
    expect(m).toContain("not a registered GovPool");
    expect(m).toContain("dexe_dao_create");
    expect(m).toContain("SWARM_TOKENS_TESTNET");
    expect(m).toContain("SWARM_DAOS_TESTNET[0]");
  });
});

describe("assertIndexParallel", () => {
  it("returns null when the lists line up", () => {
    expect(assertIndexParallel([A, B], ["0x1", "0x2"], "TESTNET")).toBeNull();
    expect(assertIndexParallel([], [], "MAINNET")).toBeNull();
  });

  it("names both counts when they do not", () => {
    const m = assertIndexParallel([A], ["0x1", "0x2"], "TESTNET");
    expect(m).toContain("SWARM_DAOS_TESTNET has 1 entry");
    expect(m).toContain("SWARM_TOKENS_TESTNET has 2");
    expect(m).toContain("index-parallel");
  });
});

describe("checkTokenPairing", () => {
  const TOKEN_A = "0xBd1D30e1F0a5F1D06c1F6B0Ee1cBcB9D71a54299";
  const TOKEN_B = "0x752FD3Ef0c16bAAA8859BcB1Bc49AaDaa1E68327";

  it("passes when tokens[i] is daos[i]'s gov token (case-insensitively)", async () => {
    const v = await checkTokenPairing([A, B], [TOKEN_A.toLowerCase(), TOKEN_B], async (d) =>
      d === A ? TOKEN_A : TOKEN_B,
    );
    expect(v).toEqual({ mismatches: [], verified: true });
  });

  it("flags a mis-ordered pair with index, expected and actual", async () => {
    const v = await checkTokenPairing([A, B], [TOKEN_B, TOKEN_A], async (d) =>
      d === A ? TOKEN_A : TOKEN_B,
    );
    expect(v.mismatches).toHaveLength(2);
    expect(v.mismatches[0]).toMatchObject({ index: 0, dao: A, expected: TOKEN_A, actual: TOKEN_B });
    const msg = tokenPairingMessage(v.mismatches[0]!, "TESTNET");
    expect(msg).toContain("SWARM_TOKENS_TESTNET[0]");
    expect(msg).toContain(TOKEN_A);
  });

  it("skips an NFT-only DAO whose UserKeeper reports the zero token", async () => {
    const v = await checkTokenPairing([A], [TOKEN_A], async () => `0x${"0".repeat(40)}`);
    expect(v).toEqual({ mismatches: [], verified: true });
  });

  it("marks the verdict unverified rather than failing when a read throws", async () => {
    const v = await checkTokenPairing([A], [TOKEN_A], async () => {
      throw new Error("call revert exception");
    });
    expect(v).toEqual({ mismatches: [], verified: false });
  });
});
