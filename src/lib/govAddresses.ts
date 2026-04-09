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

  async resolveHelpers(govPool: string, provider: Provider): Promise<GovHelpers> {
    const key = govPool.toLowerCase();
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

  async resolveNftContracts(govPool: string, provider: Provider): Promise<GovNftContracts> {
    const key = govPool.toLowerCase();
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
