import { Contract, type InterfaceAbi, type Provider } from "ethers";
import type { Artifacts } from "../artifacts.js";

/**
 * Core helper contracts for a single GovPool instance, as returned by
 * `GovPool.getHelperContracts()` on-chain.
 *
 * Note: proposal executors (DistributionProposal, StakingProposal,
 * TokenSaleProposal) are NOT helpers of a pool — they're per-proposal targets
 * referenced by the `executor` field on each ProposalAction. Discover them
 * from the action itself, not from here.
 */
export interface GovHelpers {
  settings: string;
  userKeeper: string;
  validators: string;
  poolRegistry: string;
  votePower: string;
}

/** Secondary NFT contracts exposed by `GovPool.getNftContracts()`. */
export interface GovNftContracts {
  nftMultiplier: string;
  expertNft: string;
  dexeExpertNft: string;
  babt: string;
}

// Hand-written fragment so this module doesn't require GovPool artifacts to be
// compiled. If you later want to swap in the real ABI, `artifacts.getOne("GovPool").abi`
// works the same.
const HELPER_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
];

export class GovAddressResolver {
  private helperCache = new Map<string, GovHelpers>();
  private nftCache = new Map<string, GovNftContracts>();

  constructor(private readonly artifacts: Artifacts) {}

  /**
   * Cache key = chain id + pool address. A GovPool address is NOT unique across
   * chains — deterministic factory deploys land the same DAO config at the same
   * address on 97 and 56, which this project does routinely — so a pool-only key
   * lets a testnet lookup be answered from the mainnet cache (or vice versa),
   * and every downstream read then silently targets the wrong contracts.
   *
   * The id is taken from the provider that will actually perform the read, so it
   * cannot drift from the caller's intent. Callers that already know the chain
   * can pass it to skip the (usually cached) network lookup — but only when it
   * comes from the same resolution that produced `provider` (RpcProvider:
   * `resolveChainId(x)` alongside `tryProvider(x)`), otherwise the entry would be
   * filed under a chain the data did not come from. Kept as a string end-to-end —
   * a chain id never goes through a JS number here.
   *
   * EVERY cache in this class must go through this key. A pool-address-only map
   * added later reintroduces the cross-chain bleed for whatever it holds.
   */
  private async cacheKey(
    govPool: string,
    provider: Provider,
    chainId?: number | bigint,
  ): Promise<string> {
    const id =
      chainId != null ? chainId.toString() : (await provider.getNetwork()).chainId.toString();
    return `${id}:${govPool.toLowerCase()}`;
  }

  async resolveHelpers(
    govPool: string,
    provider: Provider,
    chainId?: number | bigint,
  ): Promise<GovHelpers> {
    const key = await this.cacheKey(govPool, provider, chainId);
    const cached = this.helperCache.get(key);
    if (cached) return cached;

    const abi = this.loadGovPoolAbi() ?? (HELPER_ABI as InterfaceAbi);
    const pool = new Contract(govPool, abi, provider);
    const [settings, userKeeper, validators, poolRegistry, votePower] = await pool.getFunction(
      "getHelperContracts",
    )();
    const helpers: GovHelpers = { settings, userKeeper, validators, poolRegistry, votePower };
    this.helperCache.set(key, helpers);
    return helpers;
  }

  async resolveNftContracts(
    govPool: string,
    provider: Provider,
    chainId?: number | bigint,
  ): Promise<GovNftContracts> {
    const key = await this.cacheKey(govPool, provider, chainId);
    const cached = this.nftCache.get(key);
    if (cached) return cached;

    const abi = this.loadGovPoolAbi() ?? (HELPER_ABI as InterfaceAbi);
    const pool = new Contract(govPool, abi, provider);
    const [nftMultiplier, expertNft, dexeExpertNft, babt] = await pool.getFunction(
      "getNftContracts",
    )();
    const result: GovNftContracts = { nftMultiplier, expertNft, dexeExpertNft, babt };
    this.nftCache.set(key, result);
    return result;
  }

  private loadGovPoolAbi(): InterfaceAbi | null {
    try {
      this.artifacts.requireArtifactsExist();
      const records = this.artifacts.get("GovPool");
      return (records[0]?.abi as InterfaceAbi | undefined) ?? null;
    } catch {
      return null;
    }
  }
}
