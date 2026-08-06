import { safeErrorMessage } from "./redact.js";

/**
 * Actionable-error layer (v0.22). Every catch-all in the composite flows, the
 * read tools, and the `dexe_tx_send` broadcast routes through
 * `toActionableError` so the model/user gets "what happened + what to do next"
 * instead of a raw ethers dump. The remedy table is exported so
 * `npm run gen:knowledge` renders it into docs/PLAYBOOK.md — one source
 * (drift-checked by gen:knowledge:check in prepublishOnly).
 *
 * `toActionableError` goes through `safeErrorMessage`, so it is also a safe
 * sink for the W36 credential leak: no call site that uses it can print a keyed
 * RPC URL. Reaching for the raw `err.message` instead is what
 * tests/lib/no-raw-error-echo.test.ts exists to stop.
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
    // `Pinata JWT is required` is what PinataClient throws when constructed
    // without a key — same root cause as a missing DEXE_PINATA_JWT, so it must
    // land here and not on the transient `pinata-failed` entry below.
    match: /DEXE_PINATA_JWT|Pinata JWT is required/i,
    slug: "pinata-missing",
    what: "IPFS uploads need a Pinata JWT and none is configured.",
    remedy:
      "1) Create a free API key at https://app.pinata.cloud/developers/api-keys with pinJSONToIPFS + pinFileToIPFS permissions. " +
      "2) Add DEXE_PINATA_JWT=<jwt> to the .env at the dexe-mcp root (never .claude.json). " +
      "3) Restart Claude Code (the .env is read once at startup). Or run /dexe-setup for a guided walkthrough.",
  },
  {
    // Bounded gap so the IPFS-gateway message ("…set a dedicated Pinata
    // gateway…") can't be mistaken for a pinning failure.
    match: /Pinata [\w ]{0,24}(failed|timed out)/i,
    slug: "pinata-failed",
    what:
      "Pinata (the IPFS pinning service) rejected or never answered the upload, so the metadata was NOT pinned.",
    remedy:
      "HTTP 401/403 means the DEXE_PINATA_JWT is wrong, revoked, or lacks the pinJSONToIPFS/pinFileToIPFS scopes — " +
      "mint a fresh key at https://app.pinata.cloud/developers/api-keys, put it in .env, and restart. " +
      "A 429 or a timeout is transient (check status.pinata.cloud): wait ~30s and re-run the SAME call — " +
      "the flow ledger skips the steps that already landed, so nothing is paid for twice.",
  },
  {
    // Every subgraph failure funnels through the `Subgraph …` messages in
    // src/lib/subgraph.ts. Must precede `rpc-flaky`, which would otherwise
    // claim the 429 variant and blame the RPC instead of the indexer.
    match: /\bSubgraph (HTTP \d{3}|errors:|returned empty data|request to )/i,
    slug: "subgraph-failed",
    what:
      "The subgraph (indexer) failed, so this read returned NO data — that is NOT the same as 'the DAO has none'. Do not report an empty result.",
    remedy:
      "Re-run once (429/5xx/timeouts are usually transient). If it persists, read the same facts on-chain instead — " +
      "dexe_read_gov_state / dexe_proposal_list / dexe_read_multicall need no indexer. " +
      "A 401/403/429 on the shipped default endpoint means you are sharing the packaged Graph key: get a free one at " +
      "thegraph.com/studio, set DEXE_SUBGRAPH_POOLS_URL / _VALIDATORS_URL / _INTERACTIONS_URL in .env, and restart. " +
      "Entity/field names for a hand-written query live in the dexe://graph-schema resource.",
  },
  {
    // DeXe backend (api.dexe.io) — treasury/NFT/holder reads and the off-chain
    // proposal + auth surface.
    match: /backend HTTP \d{3}|backend request timed out|DeXe backend[^\n]{0,40}(failed|unreachable)/i,
    slug: "backend-failed",
    what:
      "The DeXe backend API (api.dexe.io) failed or timed out — the enriched answer (USD prices, token discovery, off-chain proposals) is unavailable.",
    remedy:
      "For reads, re-run: tools that can fall back serve the same call on-chain and report `degraded: true` (no token auto-discovery, no USD). " +
      "For off-chain proposals/votes there is no on-chain fallback — the backend is the system of record, so wait and retry. " +
      "A 401 means the Bearer token expired: re-run dexe_auth_login to mint a new one. " +
      "Point DEXE_BACKEND_API_URL at another host only if you run your own.",
  },
  {
    // A deadline fired. Distinct from `rpc-flaky`: the endpoint did not refuse
    // us, it went silent, and the fix is a different endpoint far more often
    // than a retry. Must precede `rpc-flaky` (which also matches ETIMEDOUT).
    match: /timed out after \d|\bETIMEDOUT\b|\bAbortError\b|operation was aborted|aborted due to timeout/i,
    slug: "rpc-timeout",
    what:
      "The endpoint accepted the connection and then went silent until the deadline fired. The call was abandoned, not answered.",
    remedy:
      "No state was changed by a timed-out READ — re-run it. If a WRITE timed out while waiting for a receipt, do NOT re-send blindly: " +
      "check it with dexe_tx_status first, it may still land. A public endpoint that keeps stalling will not improve: set your own " +
      "DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET (Alchemy/QuickNode/Ankr) in .env and restart. " +
      "The receipt-wait budget is tunable via DEXE_TX_WAIT_TIMEOUT_MS.",
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
