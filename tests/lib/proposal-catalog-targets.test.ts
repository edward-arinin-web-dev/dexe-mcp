import { describe, it, expect } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import { PROPOSAL_CATALOG } from "../../src/lib/proposalCatalog.js";
import { PROPOSAL_BUILDERS } from "../../src/lib/proposalBuilders.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.3 defect 2 — `dexe_proposal_catalog` told agents that
 * external.withdraw_treasury targets
 * `GovPool.withdraw(receiver, amount, nftIds)`. That is bug #30's exact failure
 * re-shipped as guidance: GovPool.withdraw is the PERSONAL deposit-withdraw
 * path (it returns a voter their own deposited tokens) and reverts as a
 * treasury movement. The builder has emitted plain ERC20/ERC721 transfers since
 * that fix, so the catalog was describing a call nothing in the codebase makes —
 * and the catalog is what an agent reads before hand-composing via primitives.
 *
 * The guard is behavioural: read the selectors the builder actually emits and
 * require the catalog text to name those, so the two cannot drift again.
 */

const GOVPOOL = "0xaaaa000000000000000000000000000000000001";
const RECEIVER = "0xbbbb000000000000000000000000000000000002";
const TOKEN = "0xcccc000000000000000000000000000000000003";
const NFT = "0xdddd000000000000000000000000000000000004";

const ERC20_TRANSFER = new Interface(["function transfer(address to, uint256 amount)"]).getFunction(
  "transfer",
)!.selector;
const ERC721_TRANSFER_FROM = new Interface([
  "function transferFrom(address from, address to, uint256 tokenId)",
]).getFunction("transferFrom")!.selector;
/** GovPool.withdraw — the personal deposit-withdraw path. Must never appear. */
const GOVPOOL_WITHDRAW = new Interface([
  "function withdraw(address receiver, uint256 amount, uint256[] nftIds)",
]).getFunction("withdraw")!.selector;

// No rpcUrl → the blacklist precheck short-circuits to "skipped" and the amount
// resolver keeps raw units, so this stays a pure offline encode.
const deps = {
  ctx: { config: { rpcUrl: undefined, chains: new Map() } as unknown as DexeConfig } as unknown as ToolContext,
  govPool: GOVPOOL,
  chainId: 56,
} as unknown as Parameters<(typeof PROPOSAL_BUILDERS)["withdraw_treasury"]["build"]>[1];

const entry = () => PROPOSAL_CATALOG.find((e) => e.id === "external.withdraw_treasury")!;

describe("catalog target for withdraw_treasury matches the emitted calldata", () => {
  it("the builder emits ERC20.transfer / ERC721.transferFrom, never GovPool.withdraw", async () => {
    const b = PROPOSAL_BUILDERS.withdraw_treasury!;
    const out = await b.build(
      b.schema.parse({ receiver: RECEIVER, token: TOKEN, amount: "1000", nftAddress: NFT, nftIds: ["7"] }),
      deps,
    );
    const selectors = out.actionsOnFor.map((a) => a.data.slice(0, 10));
    expect(selectors).toEqual([ERC20_TRANSFER, ERC721_TRANSFER_FROM]);
    expect(selectors).not.toContain(GOVPOOL_WITHDRAW);
    // Executors are the token contracts, not the GovPool.
    expect(out.actionsOnFor.map((a) => a.executor)).toEqual([TOKEN, NFT]);
    expect(out.actionsOnFor.map((a) => a.executor)).not.toContain(GOVPOOL);
  });

  it("the catalog names those two calls and no longer advertises GovPool.withdraw", () => {
    const { target, effect } = entry();
    expect(target).toContain("ERC20.transfer");
    expect(target).toContain("ERC721.transferFrom");
    expect(target).toContain("actionsOnFor");
    // The exact claim that reverted on-chain.
    expect(target).not.toContain("GovPool.withdraw(receiver, amount, nftIds) — treasury lives on GovPool itself");
    expect(`${target} ${effect}`).not.toMatch(/GovPool\.withdraw\(receiver/);
  });

  it("the catalog stops promising native withdrawal the builder cannot do", async () => {
    const b = PROPOSAL_BUILDERS.withdraw_treasury!;
    // Only `token`+`amount` and/or `nftAddress`+`nftIds` exist — there is no
    // native branch, so an empty request is the only possible native outcome.
    await expect(b.build(b.schema.parse({ receiver: RECEIVER }), deps)).rejects.toThrow(
      /Nothing to withdraw/,
    );
    expect(entry().effect).not.toMatch(/native/i);
    // …and points at the type that does handle native value.
    expect(entry().target).toContain("token_transfer");
  });

  it("token_transfer really is the native path the catalog now redirects to", async () => {
    const b = PROPOSAL_BUILDERS.token_transfer!;
    const out = await b.build(b.schema.parse({ recipient: RECEIVER, amount: "500", isNative: true }), deps);
    expect(out.actionsOnFor[0]).toEqual({ executor: RECEIVER, value: "500", data: "0x" });
    const extra = out.metadataExtra as { changes: { proposedChanges: Record<string, unknown> } };
    expect(extra.changes.proposedChanges.tokenAddress).toBe(ZeroAddress);
  });

  it("no catalog entry points at GovPool.withdraw as a treasury movement", () => {
    for (const e of PROPOSAL_CATALOG) {
      expect(`${e.target} ${e.effect}`, `${e.id} must not route treasury via GovPool.withdraw`).not.toMatch(
        /GovPool\.withdraw\(/,
      );
    }
  });
});
