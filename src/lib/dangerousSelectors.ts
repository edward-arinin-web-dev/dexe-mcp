import { id } from "ethers";

/**
 * Forbidden proposal-action selectors — hard guard.
 *
 * Every function below lives on `GovUserKeeper` and is `onlyOwner` (the owner is
 * the GovPool). GovPool invokes them internally on behalf of users through its
 * own deposit/withdraw/delegate entrypoints — they are NOT meant to be the
 * `executor` + `data` of a raw governance proposal action.
 *
 * They are unsafe as proposal targets because the `payer` / `delegator`
 * argument is decoupled from the funds' owner (e.g. `withdrawTokens(payer,
 * receiver, amount)` debits `payer` and pays `receiver`), so a proposal could
 * name an account other than the proposer. This guard refuses to build any
 * proposal action carrying one of these selectors. Defense-in-depth at the MCP
 * layer; users deposit/withdraw/delegate their OWN funds through the GovPool
 * entrypoints, never via a proposal.
 */
const FORBIDDEN_SIGNATURES = [
  "withdrawTokens(address,address,uint256)",
  "depositTokens(address,address,uint256)",
  "delegateTokens(address,address,uint256)",
  "undelegateTokens(address,address,uint256)",
  "delegateTokensTreasury(address,uint256)",
  "undelegateTokensTreasury(address,uint256)",
  "withdrawNfts(address,address,uint256[])",
  "depositNfts(address,address,uint256[])",
  "delegateNfts(address,address,uint256[])",
  "undelegateNfts(address,address,uint256[])",
  "delegateNftsTreasury(address,uint256[])",
  "undelegateNftsTreasury(address,uint256[])",
] as const;

export interface ForbiddenSelector {
  /** 0x-prefixed 4-byte selector, lowercase. */
  selector: string;
  /** Canonical function signature, e.g. "withdrawTokens(address,address,uint256)". */
  signature: string;
}

/**
 * selector -> entry, derived from the signatures at module load so the table can
 * never drift from the canonical names.
 */
const FORBIDDEN_BY_SELECTOR: ReadonlyMap<string, ForbiddenSelector> = new Map(
  FORBIDDEN_SIGNATURES.map((signature) => {
    const selector = id(signature).slice(0, 10).toLowerCase();
    return [selector, { selector, signature }] as const;
  }),
);

/** Extract the 4-byte selector (lowercase, 0x-prefixed) from calldata, or null. */
export function selectorOf(data: string): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase();
}

/**
 * Returns the matched forbidden entry if `data`'s leading selector is
 * denylisted, else null. `data` is raw calldata (0x-hex).
 */
export function findForbiddenSelector(data: string): ForbiddenSelector | null {
  const sel = selectorOf(data);
  if (sel === null) return null;
  return FORBIDDEN_BY_SELECTOR.get(sel) ?? null;
}

/** Human-readable hard-refusal explaining why the selector is blocked. */
export function dangerousSelectorError(match: ForbiddenSelector, target?: string): string {
  return (
    `Refusing to build: calldata selector ${match.selector} is ` +
    `GovUserKeeper.${match.signature}, a privileged onlyOwner accounting function ` +
    `that must never be a governance proposal action` +
    (target ? ` (target ${target})` : "") +
    `. These functions take a 'payer'/'delegator' argument decoupled from the ` +
    `caller; users deposit/withdraw/delegate their OWN funds through the GovPool ` +
    `entrypoints, never via a proposal. Hard block, no override.`
  );
}

/** The full denylist — for docs, tests, and introspection. */
export function forbiddenSelectors(): ForbiddenSelector[] {
  return [...FORBIDDEN_BY_SELECTOR.values()];
}
