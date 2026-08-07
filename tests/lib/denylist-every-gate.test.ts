import { describe, it, expect } from "vitest";
import {
  assertNoForbiddenCalldata,
  BroadcastGuardError,
  type BroadcastTx,
} from "../../src/lib/broadcastGuards.js";
import { forbiddenSelectors, scanForbiddenCalldata } from "../../src/lib/dangerousSelectors.js";

/**
 * B12 lives in `runBroadcastGuards`, not at each call site — and that placement
 * IS the fix.
 *
 * 0.32.0 first added the GovUserKeeper denylist at `dexe_tx_send`. Adversarial
 * review then pushed the identical drain calldata through
 * `dexe_proposal_create { proposalType: "custom" }`, which copies caller-supplied
 * `actionsOnFor[].data` through verbatim, and watched it reach the node:
 *
 *   PATH A  dexe_tx_send  -> refused, 0 txs on the wire
 *   PATH B  sendOrCollect -> executed, 1 tx on the wire, drain calldata included
 *
 * The scanner had been written into a TOOL module, so the shared broadcast guard
 * could not see it. `src/lib/dangerousSelectors.ts` has published "hard block,
 * no override" the whole time; this test pins the claim to the one gate every
 * broadcast path funnels through, so a new entrypoint inherits it instead of
 * having to remember it.
 */

const GOV_POOL = "0x" + "11".repeat(20);

function tx(data: string): BroadcastTx {
  return { to: GOV_POOL, data, value: "0", chainId: 56, from: "0x" + "22".repeat(20) };
}

/** A proposal action embeds its inner calldata at a 32-byte-aligned offset. */
function embedInAction(inner: string, slots: number): string {
  const outer = "0xda1c6cfa"; // createProposalAndVote — the real carrier
  const padding = "00".repeat(32 * slots);
  return outer + padding + inner.slice(2);
}

describe("B12 refuses denylisted calldata at the shared guard", () => {
  const selectors = forbiddenSelectors();

  it("the denylist is not empty — otherwise every assertion below is vacuous", () => {
    expect(selectors.length).toBeGreaterThan(0);
  });

  it.each(selectors.map((s) => [s.selector, s.signature]))(
    "%s (%s) is refused as the leading selector",
    (selector) => {
      expect(() => assertNoForbiddenCalldata(tx(selector + "00".repeat(64)))).toThrow(BroadcastGuardError);
    },
  );

  it.each(selectors.map((s) => [s.selector, s.signature]))(
    "%s (%s) is refused when EMBEDDED in a proposal action",
    (selector) => {
      // This is the shape that reached the chain: not the leading selector, but
      // an inner payload carried inside createProposal's actions array.
      const payload = embedInAction(selector, 4);
      expect(scanForbiddenCalldata(payload)?.match.selector).toBe(selector);
      expect(() => assertNoForbiddenCalldata(tx(payload))).toThrow(BroadcastGuardError);
    },
  );

  it("names B12 and says the block cannot be overridden", () => {
    try {
      assertNoForbiddenCalldata(tx(selectors[0]!.selector));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastGuardError);
      const guardErr = e as BroadcastGuardError;
      expect(guardErr.guard).toBe("B12");
      expect(guardErr.message).toContain("Hard block, no override");
      // The message must say what to do instead, not merely refuse.
      expect(guardErr.message).toContain("dexe_vote_build_deposit");
    }
  });

  it("lets ordinary calldata and plain value transfers through", () => {
    expect(() => assertNoForbiddenCalldata(tx("0xa9059cbb" + "00".repeat(64)))).not.toThrow(); // ERC20 transfer
    expect(() => assertNoForbiddenCalldata(tx("0x"))).not.toThrow();
  });
});

/**
 * The structural half: the scanner must live where the guard can reach it.
 * Keeping it in `src/tools/txSend.ts` is exactly what let the second entrypoint
 * ship unguarded, so assert the dependency direction rather than trusting it.
 */
describe("the denylist scanner is reachable from the guard layer", () => {
  it("is exported from src/lib, not only from a tool module", async () => {
    const lib = await import("../../src/lib/dangerousSelectors.js");
    expect(typeof lib.scanForbiddenCalldata).toBe("function");
    expect(typeof lib.forbiddenBroadcastError).toBe("function");
  });

  it("runBroadcastGuards applies it before any network work", async () => {
    const { runBroadcastGuards } = await import("../../src/lib/broadcastGuards.js");
    // A config whose chains map is empty would make any RPC-touching guard throw
    // something else; B12 must refuse first, on the calldata alone.
    const cfg = { chains: new Map(), defaultChainId: 56 } as never;
    await expect(runBroadcastGuards(tx(selectorsFirst()), cfg, { skipSimulation: true })).rejects.toThrow(
      /B12|Hard block/,
    );
  });
});

function selectorsFirst(): string {
  return forbiddenSelectors()[0]!.selector + "00".repeat(64);
}
