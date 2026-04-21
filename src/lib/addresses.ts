import { Contract, JsonRpcProvider, ZeroAddress } from "ethers";

/**
 * Per-chain `ContractsRegistry` root addresses. Every other DeXe protocol
 * contract is resolved through `ContractsRegistry.getContract(name)` at
 * runtime, so we only need to know the root per chain. Users can override with
 * `DEXE_CONTRACTS_REGISTRY`.
 *
 * NOTE: the BSC mainnet address below matches the value shipped in the DeXe
 * frontend env. Add more chains as they come online.
 */
export const CONTRACTS_REGISTRY_BY_CHAIN: Record<number, string> = {
  56: "0x46B46629B674b4C0b48B111DEeB0eAfd9F84A1c0",
};

/**
 * Canonical contract names used as keys inside `ContractsRegistry`. Mirrors
 * constants in `contracts/core/ContractsRegistry.sol` and
 * `contracts/factory/PoolRegistry.sol` (DeXe-Protocol).
 */
export const CONTRACT_NAMES = {
  POOL_FACTORY: "POOL_FACTORY",
  POOL_REGISTRY: "POOL_REGISTRY",
  USER_REGISTRY: "USER_REGISTRY",
  CORE_PROPERTIES: "CORE_PROPERTIES",
  NETWORK_PROPERTIES: "NETWORK_PROPERTIES",
  PRICE_FEED: "PRICE_FEED",
  TREASURY: "TREASURY",
  DEXE: "DEXE",
  WETH: "WETH",
  USD: "USD",
  BABT: "BABT",
  DEXE_EXPERT_NFT: "DEXE_EXPERT_NFT",
  TOKEN_ALLOCATOR: "TOKEN_ALLOCATOR",
} as const;

export type ContractName = (typeof CONTRACT_NAMES)[keyof typeof CONTRACT_NAMES];

const REGISTRY_ABI = [
  "function getContract(string memory name) external view returns (address)",
  "function hasContract(string memory name) external view returns (bool)",
] as const;

export interface AddressBookConfig {
  readonly provider: JsonRpcProvider;
  readonly chainId: number;
  /** Optional override for the `ContractsRegistry` root. */
  readonly registryOverride?: string;
}

/**
 * Lazy, cached resolver for DeXe core contract addresses on a given chain.
 * First call for each name hits RPC; subsequent calls return from the in-memory
 * cache.
 */
export class AddressBook {
  private readonly cache = new Map<string, string>();
  private readonly registry: Contract;
  readonly registryAddress: string;
  readonly provider: JsonRpcProvider;
  readonly chainId: number;

  constructor(private readonly cfg: AddressBookConfig) {
    this.provider = cfg.provider;
    this.chainId = cfg.chainId;
    const addr = cfg.registryOverride ?? CONTRACTS_REGISTRY_BY_CHAIN[cfg.chainId];
    if (!addr) {
      throw new Error(
        `No ContractsRegistry address known for chainId=${cfg.chainId}. ` +
          `Set DEXE_CONTRACTS_REGISTRY or pick a supported chain (${Object.keys(
            CONTRACTS_REGISTRY_BY_CHAIN,
          ).join(", ")}).`,
      );
    }
    this.registryAddress = addr;
    this.registry = new Contract(addr, REGISTRY_ABI, cfg.provider);
  }

  /** Resolve a canonical contract name to its deployed address on this chain. */
  async resolve(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const addr: string = await this.registry.getFunction("getContract").staticCall(name);
    if (!addr || addr === ZeroAddress) {
      throw new Error(
        `ContractsRegistry has no entry for "${name}" on chainId=${this.cfg.chainId}. ` +
          `Double-check the name — see CONTRACT_NAMES in src/lib/addresses.ts.`,
      );
    }
    this.cache.set(name, addr);
    return addr;
  }

  /** Resolve many at once (sequential — registry getContract is cheap). */
  async resolveMany(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of names) out[n] = await this.resolve(n);
    return out;
  }
}
