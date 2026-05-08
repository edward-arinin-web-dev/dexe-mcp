import { Contract, JsonRpcProvider } from "ethers";
import { RpcProvider } from "../rpc.js";
import type { DexeConfig } from "../config.js";

const ERC20_GOV_BLACKLIST_ABI = [
  "function isBlacklisted(address account) view returns (bool)",
] as const;

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
): Promise<BlacklistCheck> {
  if (!config.rpcUrl) {
    return { status: "skipped", reason: "DEXE_RPC_URL not set — skipping blacklist precheck" };
  }
  let provider: JsonRpcProvider;
  try {
    provider = new RpcProvider(config).requireProvider();
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const contract = new Contract(token, ERC20_GOV_BLACKLIST_ABI as unknown as string[], provider) as unknown as {
      isBlacklisted: (account: string) => Promise<boolean>;
    };
    const flag = await contract.isBlacklisted(account);
    return flag
      ? { status: "blacklisted", token, account }
      : { status: "clean", token, account };
  } catch (err) {
    return {
      status: "skipped",
      reason: `isBlacklisted() unavailable on ${token} (${err instanceof Error ? err.message : String(err)})`,
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
