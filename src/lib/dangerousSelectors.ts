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

/**
 * Find a denylisted `GovUserKeeper` selector anywhere in `data` — as the
 * leading selector, or embedded in an argument, which is exactly how a proposal
 * action carries one: `createProposal(…, actions[{executor, value, data}])`.
 *
 * This file has always published "hard block, no override", but for a long time
 * only the proposal BUILDERS consulted it. 0.32.0 added the check at
 * `dexe_tx_send` — and an adversarial review then proved the identical bytes
 * still reached the chain through `dexe_proposal_create`'s `custom` type, which
 * copies caller-supplied action `data` through verbatim. The scanner lived in a
 * TOOL module, so the shared broadcast guard could not see it.
 *
 * It lives here now and runs inside `runBroadcastGuards`, i.e. at the one gate
 * every broadcast path already passes through. A guard each call site has to
 * remember to call is a guard that will be forgotten — that is the whole reason
 * this defect existed twice.
 *
 * Scan is at 4-byte alignment: an embedded selector begins at
 * `4 (outer selector) + 32·k` bytes, always a multiple of 4. A false positive
 * needs a random 4-byte window to equal one of 12 specific selectors (~1e-8 for
 * a large payload); a false NEGATIVE would let a drain through, so the scan
 * errs toward refusing.
 */
export function scanForbiddenCalldata(data: string): { match: ForbiddenSelector; atByte: number } | null {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const head = findForbiddenSelector(data);
  if (head) return { match: head, atByte: 0 };
  const body = data.slice(2).toLowerCase();
  for (let i = 8; i + 8 <= body.length; i += 8) {
    const hit = FORBIDDEN_BY_SELECTOR.get(`0x${body.slice(i, i + 8)}`);
    if (hit) return { match: hit, atByte: i / 2 };
  }
  return null;
}

/** Refusal text for a denylisted selector found in a payload about to be sent. */
export function forbiddenBroadcastError(hit: { match: ForbiddenSelector; atByte: number }, to: string): string {
  const where = hit.atByte === 0 ? "as the leading selector" : `embedded at byte offset ${hit.atByte}`;
  return (
    `Refusing to broadcast: calldata carries ${hit.match.selector} ` +
    `(GovUserKeeper.${hit.match.signature}) ${where}, targeting ${to}. ` +
    `These are privileged onlyOwner accounting functions whose 'payer'/'delegator' argument is decoupled ` +
    `from the funds' owner, so a call can debit an account that never authorized it. Users deposit / ` +
    `withdraw / delegate their OWN funds through the GovPool entrypoints (dexe_vote_build_deposit, ` +
    `dexe_vote_build_withdraw), never directly and never as a proposal action. Hard block, no override.`
  );
}
