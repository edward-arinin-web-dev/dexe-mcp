import { id } from "ethers";

/**
 * C-2 guardrail — forbidden proposal-action selectors.
 *
 * Every function below lives on `GovUserKeeper` and is `onlyOwner` (the owner is
 * the GovPool). GovPool invokes them internally on behalf of users through its
 * own deposit/withdraw/delegate entrypoints — they are NOT meant to be the
 * `executor` + `data` of a raw governance proposal action.
 *
 * They are dangerous as proposal targets because the `payer` / `delegator`
 * argument is decoupled from the funds' owner: e.g.
 * `withdrawTokens(payer, receiver, amount)` debits `_usersInfo[payer]` and pays
 * `receiver`. A proposal can therefore name an arbitrary victim as `payer` and
 * the attacker as `receiver`.
 *
 * The DeXe protocol's INTERNAL allowlist
 * (`GovPoolCreate._handleDataForInternalProposal`) is supposed to make these
 * unreachable-by-proposal, but it only runs when the *last* action's executor is
 * a registered INTERNAL executor. A proposal whose trailing action routes to
 * DEFAULT skips the allowlist entirely, so these selectors slip through —
 * finding C-2. This guard refuses to build any proposal action carrying one of
 * them, regardless of routing. It is harm-reduction at the MCP layer ONLY: the
 * root cause is in the protocol contracts, and an attacker can still hand-craft
 * the calldata. See docs/security/C2-default-routing-bypass.md.
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

/** Human-readable hard-refusal explaining why the selector is blocked (C-2). */
export function dangerousSelectorError(match: ForbiddenSelector, target?: string): string {
  return (
    `Refusing to build: calldata selector ${match.selector} is ` +
    `GovUserKeeper.${match.signature}, a privileged onlyOwner accounting function ` +
    `that must never be a governance proposal action` +
    (target ? ` (target ${target})` : "") +
    `. Encoding it enables finding C-2: a DEFAULT-routed proposal bypasses the ` +
    `GovPoolCreate INTERNAL allowlist and can drain an arbitrary depositor's ` +
    `unlocked balance — the function takes a free 'payer'/'delegator' decoupled ` +
    `from the caller. Users deposit/withdraw/delegate their OWN funds through the ` +
    `GovPool entrypoints, never via a proposal. Hard block, no override.`
  );
}

/** The full denylist — for docs, tests, and introspection. */
export function forbiddenSelectors(): ForbiddenSelector[] {
  return [...FORBIDDEN_BY_SELECTOR.values()];
}
