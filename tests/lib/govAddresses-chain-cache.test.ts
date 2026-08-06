import { describe, it, expect } from "vitest";
import { AbiCoder, JsonRpcProvider, Network } from "ethers";
import { GovAddressResolver } from "../../src/lib/govAddresses.js";
import type { Artifacts } from "../../src/artifacts.js";

/**
 * 0.30.2 — GovAddressResolver keyed its helper/NFT caches by pool address ONLY.
 * Deterministic factory deploys put the same GovPool address on more than one
 * chain (this project deploys the same DAO configs to 97 and 56), so a lookup on
 * one chain could be answered from the other chain's cache and every downstream
 * read would then target the wrong contracts — silently. The key now carries the
 * chain id.
 */

// All-lowercase on purpose: ethers rejects a mixed-case address that isn't
// correctly checksummed, and this literal is a stand-in, not a real deploy.
const POOL = "0x9820abcdef0123456789abcdef01234567891c38";

const coder = AbiCoder.defaultAbiCoder();

/** Deterministic per-chain address so a cache cross-hit is visible in a diff. */
const addr = (chainId: number, n: number) =>
  `0x${chainId.toString(16).padStart(8, "0")}${n.toString(16).padStart(32, "0")}`;

/**
 * JsonRpcProvider whose `send` is fully stubbed — `staticNetwork` means
 * `getNetwork()` (which the cache key uses) resolves with no round-trip, and
 * every `eth_call` returns canned data. `sends` proves cache hits: a cached
 * lookup performs zero.
 */
class StubProvider extends JsonRpcProvider {
  sends = 0;
  constructor(
    chainId: number,
    private readonly returns: string,
  ) {
    const network = Network.from(chainId);
    super("http://127.0.0.1:9/never-dialed", network, { staticNetwork: network });
  }
  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    if (method === "eth_call") {
      this.sends++;
      return this.returns;
    }
    throw new Error(`StubProvider: unexpected RPC ${method} ${JSON.stringify(params)}`);
  }
}

const helpersFor = (chainId: number) =>
  coder.encode(
    ["address", "address", "address", "address", "address"],
    [addr(chainId, 1), addr(chainId, 2), addr(chainId, 3), addr(chainId, 4), addr(chainId, 5)],
  );

const nftsFor = (chainId: number) =>
  coder.encode(
    ["address", "address", "address", "address"],
    [addr(chainId, 6), addr(chainId, 7), addr(chainId, 8), addr(chainId, 9)],
  );

/** Forces the hand-written HELPER_ABI path (no compiled artifacts needed). */
const noArtifacts = {
  requireArtifactsExist() {
    throw new Error("no artifacts compiled");
  },
  get() {
    return [];
  },
} as unknown as Artifacts;

describe("GovAddressResolver cache is keyed per chain", () => {
  it("returns different helpers for the same pool address on two chain ids", async () => {
    const resolver = new GovAddressResolver(noArtifacts);
    const p97 = new StubProvider(97, helpersFor(97));
    const p56 = new StubProvider(56, helpersFor(56));

    const testnet = await resolver.resolveHelpers(POOL, p97);
    const mainnet = await resolver.resolveHelpers(POOL, p56);

    expect(testnet.settings.toLowerCase()).toBe(addr(97, 1));
    expect(mainnet.settings.toLowerCase()).toBe(addr(56, 1));
    expect(mainnet.userKeeper).not.toBe(testnet.userKeeper);
    expect(p97.sends).toBe(1);
    expect(p56.sends).toBe(1); // chain 56 was NOT served from the chain 97 entry

    p97.destroy();
    p56.destroy();
  });

  it("returns different NFT contracts for the same pool address on two chain ids", async () => {
    const resolver = new GovAddressResolver(noArtifacts);
    const p97 = new StubProvider(97, nftsFor(97));
    const p56 = new StubProvider(56, nftsFor(56));

    const testnet = await resolver.resolveNftContracts(POOL, p97);
    const mainnet = await resolver.resolveNftContracts(POOL, p56);

    expect(testnet.expertNft.toLowerCase()).toBe(addr(97, 7));
    expect(mainnet.expertNft.toLowerCase()).toBe(addr(56, 7));
    expect(p97.sends).toBe(1);
    expect(p56.sends).toBe(1);

    p97.destroy();
    p56.destroy();
  });

  it("still caches within one chain (no extra RPC on repeat lookups)", async () => {
    const resolver = new GovAddressResolver(noArtifacts);
    const p97 = new StubProvider(97, helpersFor(97));

    const first = await resolver.resolveHelpers(POOL, p97);
    const second = await resolver.resolveHelpers(POOL.toUpperCase().replace("0X", "0x"), p97);

    expect(second).toBe(first); // same object — served from cache
    expect(p97.sends).toBe(1);

    p97.destroy();
  });

  it("accepts an explicit chainId and keys on it without a getNetwork round-trip", async () => {
    const resolver = new GovAddressResolver(noArtifacts);
    const p56 = new StubProvider(56, helpersFor(56));

    // Warm the cache under chain 56, then ask for 97 through the SAME provider:
    // a pool-address-only key would hand back the 56 entry.
    const mainnet = await resolver.resolveHelpers(POOL, p56, 56);
    const testnet = await resolver.resolveHelpers(POOL, p56, 97);

    expect(mainnet).not.toBe(testnet);
    expect(p56.sends).toBe(2);

    p56.destroy();
  });
});
