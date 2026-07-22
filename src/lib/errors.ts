import { safeErrorMessage } from "./redact.js";

/**
 * Actionable-error layer (v0.22). Every catch-all in the composite flows routes
 * through `toActionableError` so the model/user gets "what happened + what to do
 * next" instead of a raw ethers dump. The remedy table is exported so
 * `npm run gen:knowledge` renders it into docs/PLAYBOOK.md — one source
 * (drift-checked by gen:knowledge:check in prepublishOnly).
 */

export interface KnownFailure {
  /** Matched against the raw error message (case-insensitive). */
  match: RegExp;
  /** Stable slug used in PLAYBOOK's error→remedy table. */
  slug: string;
  /** One-sentence statement of what went wrong, in user terms. */
  what: string;
  /** Concrete next step ("do X"), tool names included. */
  remedy: string;
}

/**
 * Known failure signatures across the DeXe flows. Order matters — first match
 * wins. Keep `what`/`remedy` self-contained: they are shown without the
 * surrounding code context.
 */
export const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    match: /insufficient funds for (gas|intrinsic)/i,
    slug: "no-gas",
    what: "The signer wallet has no BNB to pay gas.",
    remedy:
      "Fund the signer address with BNB on the target chain (testnet 97: use a faucet, e.g. https://www.bnbchain.org/en/testnet-faucet), then re-run.",
  },
  {
    match: /nonce (too low|has already been used)|already known|replacement transaction underpriced/i,
    slug: "nonce-conflict",
    what: "A transaction with this nonce is already pending or mined.",
    remedy:
      "A previous broadcast is still settling. Wait ~15s, check it with dexe_tx_status, then re-run — the flow re-checks completed steps and skips them.",
  },
  {
    match: /user rejected|user denied|rejected by user/i,
    slug: "wallet-rejected",
    what: "The transaction was rejected in the wallet.",
    remedy: "Re-run the call and approve the request on the phone/wallet when it appears.",
  },
  {
    match: /DEXE_PINATA_JWT/i,
    slug: "pinata-missing",
    what: "IPFS uploads need a Pinata JWT and none is configured.",
    remedy:
      "1) Create a free API key at https://app.pinata.cloud/developers/api-keys with pinJSONToIPFS + pinFileToIPFS permissions. " +
      "2) Add DEXE_PINATA_JWT=<jwt> to the .env at the dexe-mcp root (never .claude.json). " +
      "3) Restart Claude Code (the .env is read once at startup). Or run /dexe-setup for a guided walkthrough.",
  },
  {
    match: /rate.?limit|\b429\b|SERVER_ERROR|could not detect network|failed to fetch|fetch failed|ETIMEDOUT|ECONNRESET/i,
    slug: "rpc-flaky",
    what: "The RPC endpoint failed or rate-limited mid-call (retries were already attempted).",
    remedy:
      "Re-run the call — completed steps are skipped. For reliability set a private endpoint in .env " +
      "(DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET, e.g. Alchemy/QuickNode/Ankr) and restart.",
  },
  {
    match: /execution reverted|CALL_EXCEPTION|transaction failed|status.*0\b/i,
    slug: "onchain-revert",
    what: "The transaction reverted on-chain (state was NOT changed by this step).",
    remedy:
      "Read the revert reason above if present. Common causes: proposal not in the required state " +
      "(check dexe_proposal_state), tokens locked in an active proposal (withdraw between proposals), " +
      "or a blacklisted recipient. Fix the cause and re-run — earlier landed steps are skipped.",
  },
] as const;

/** Result of classifying an unknown error against the KNOWN_FAILURES table. */
export interface ActionableError {
  message: string;
  slug?: string;
}

/**
 * Wrap a caught error with step context and, when the signature is recognized,
 * a concrete remedy. Falls back to the redacted raw message so nothing is lost.
 */
export function toActionableError(err: unknown, step?: string): ActionableError {
  const raw = safeErrorMessage(err);
  const hit = KNOWN_FAILURES.find((k) => k.match.test(raw));
  const prefix = step ? `${step} failed: ` : "";
  if (!hit) return { message: `${prefix}${raw}` };
  return {
    slug: hit.slug,
    message: `${prefix}${raw}\n\n${hit.what}\nNext step: ${hit.remedy}`,
  };
}
