import { Contract, JsonRpcProvider } from "ethers";
import { RpcProvider } from "../rpc.js";
import type { DexeConfig } from "../config.js";

// F20b: ERC20Gov has NO isBlacklisted(address) — the real interface is the
// enumerable pair below (see DeXe-Protocol contracts/gov/ERC20/ERC20Gov.sol).
// The old single-call probe reverted on every real token, so the guard
// silently degraded to `skipped` since inception.
const ERC20_GOV_BLACKLIST_ABI = [
  "function totalBlacklistAccounts() view returns (uint256)",
  "function getBlacklistAccounts(uint256 offset, uint256 limit) view returns (address[])",
] as const;

const BLACKLIST_PAGE = 100n;

export type BlacklistCheck =
  | { status: "blacklisted"; token: string; account: string }
  | { status: "clean"; token: string; account: string }
  | { status: "skipped"; reason: string };

/**
 * Best-effort `isBlacklisted(account)` lookup. Returns `skipped` when the RPC
 * is unset or the call reverts (e.g. token isn't ERC20Gov). Build steps that
 * use this should treat `skipped` as "go ahead" and only block on
 * `blacklisted`.
 */
export async function checkBlacklist(
  config: DexeConfig,
  token: string,
  account: string,
  /**
   * Chain the transaction will broadcast on. REQUIRED for correctness on
   * non-default chains: without it the probe hits the default chain, where the
   * token usually has no code, and the guard silently degrades to `skipped`
   * (F20). Omit only in chain-less standalone build tools.
   */
  chainId?: number,
): Promise<BlacklistCheck> {
  if (!config.rpcUrl) {
    return { status: "skipped", reason: "DEXE_RPC_URL not set — skipping blacklist precheck" };
  }
  let provider: JsonRpcProvider;
  try {
    if (chainId !== undefined) {
      const pr = new RpcProvider(config).tryProvider(chainId);
      if ("error" in pr) return { status: "skipped", reason: `${pr.error} ${pr.remediation}` };
      provider = pr.ok;
    } else {
      provider = new RpcProvider(config).requireProvider();
    }
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const contract = new Contract(token, ERC20_GOV_BLACKLIST_ABI as unknown as string[], provider) as unknown as {
      totalBlacklistAccounts: () => Promise<bigint>;
      getBlacklistAccounts: (offset: bigint, limit: bigint) => Promise<string[]>;
    };
    const total = await contract.totalBlacklistAccounts();
    const needle = account.toLowerCase();
    for (let offset = 0n; offset < total; offset += BLACKLIST_PAGE) {
      const page = await contract.getBlacklistAccounts(offset, BLACKLIST_PAGE);
      if (page.some((a) => a.toLowerCase() === needle)) {
        return { status: "blacklisted", token, account };
      }
    }
    return { status: "clean", token, account };
  } catch (err) {
    return {
      status: "skipped",
      reason: `blacklist getters unavailable on ${token} — not an ERC20Gov? (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

export function blacklistError(token: string, account: string): string {
  return (
    `Refusing to build: recipient ${account} is blacklisted on ERC20Gov ${token}. ` +
    `If broadcast, GovPool.execute would revert with "ERC20Gov: account is blacklisted" ` +
    `and the proposal would sit in SucceededFor permanently. Un-blacklist first ` +
    `(dexe_proposal_build_blacklist with isBlacklisted=false) or pick a different recipient.`
  );
}
