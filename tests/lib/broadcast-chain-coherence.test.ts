import { describe, expect, it } from "vitest";
import { assertChainCoherence, BroadcastGuardError } from "../../src/lib/broadcastGuards.js";

/**
 * B11 — wrong-chain broadcast. Builders stamp a `chainId` on every payload, but
 * until 0.30.3 nothing stopped that payload from being handed to `dexe_tx_send`
 * on a different chain. The same address is a different contract (or an EOA, or
 * nobody) per chain, so the outcomes ranged from a revert to a real transfer to
 * a stranger — silently, never a crash.
 *
 * The `getCode` probe is injected so these assertions never touch the network.
 */

const DEST = "0x1111111111111111111111111111111111111111";

/** eth_getCode stub: `code` for any address, or a rejection to model a flaky RPC. */
const codeIs = (code: string) => async () => code;
const codeFails = () => async (): Promise<string> => {
  throw new Error("could not detect network");
};

const CONTRACT_CODE = "0x60806040523480156100";

describe("assertChainCoherence (B11)", () => {
  it("refuses calldata to an address with no code on the send chain", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0xda1c6cfa", chainId: 97 }, codeIs("0x")),
    ).rejects.toThrow(/no contract code on chain 97/);
  });

  it("names B11 and points at the wrong-chain cause", async () => {
    const err = await assertChainCoherence(
      { to: DEST, data: "0xda1c6cfa", chainId: 56 },
      codeIs("0x"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastGuardError);
    expect((err as BroadcastGuardError).guard).toBe("B11");
    expect((err as BroadcastGuardError).message).toMatch(/built for a different chain/);
  });

  it("allows a plain value transfer to an EOA (no calldata, no code expected)", async () => {
    // data "0x" must not even probe — paying an EOA is legitimate.
    await expect(
      assertChainCoherence({ to: DEST, data: "0x", chainId: 56 }, codeIs("0x")),
    ).resolves.toBeUndefined();
    await expect(
      assertChainCoherence({ to: DEST, data: "", chainId: 56 }, codeIs("0x")),
    ).resolves.toBeUndefined();
  });

  it("allows calldata to an address that does have code", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0xda1c6cfa", chainId: 56 }, codeIs(CONTRACT_CODE)),
    ).resolves.toBeUndefined();
  });

  it("refuses a payload/caller chainId mismatch and names BOTH chains", async () => {
    const err = await assertChainCoherence(
      { to: DEST, data: "0xda1c6cfa", chainId: 97, payloadChainId: 56 },
      codeIs(CONTRACT_CODE),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BroadcastGuardError);
    expect((err as BroadcastGuardError).guard).toBe("B11");
    expect((err as BroadcastGuardError).message).toContain("56");
    expect((err as BroadcastGuardError).message).toContain("97");
  });

  it("refuses the mismatch even for a plain value transfer (no calldata to hide behind)", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0x", chainId: 97, payloadChainId: 56 }, codeIs("0x")),
    ).rejects.toThrow(/built for chain 56 .*broadcasting on chain 97/);
  });

  it("passes when the payload chainId matches the send chain", async () => {
    await expect(
      assertChainCoherence(
        { to: DEST, data: "0xda1c6cfa", chainId: 56, payloadChainId: 56 },
        codeIs(CONTRACT_CODE),
      ),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no payload chainId is supplied and the destination has code", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0xda1c6cfa", chainId: 56 }, codeIs(CONTRACT_CODE)),
    ).resolves.toBeUndefined();
  });

  it("fails OPEN when the getCode probe errors — a flaky RPC must not wedge a valid send", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0xda1c6cfa", chainId: 56 }, codeFails()),
    ).resolves.toBeUndefined();
  });

  it("treats an all-zero code response as no code (provider quirk tolerance)", async () => {
    await expect(
      assertChainCoherence({ to: DEST, data: "0xda1c6cfa", chainId: 56 }, codeIs("0x0")),
    ).rejects.toThrow(/no contract code/);
  });
});
