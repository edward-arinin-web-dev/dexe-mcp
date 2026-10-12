/**
 * Ceilings on the array inputs of read-edition tools, in one place.
 *
 * Every array a read tool accepts is a fan-out knob: one `tools/call` with
 * 3,000 `chainIds` used to become 3,001 backend requests. Each ceiling sits
 * well above any real use and is published as `maxItems` in the tool's input
 * schema, so a client sees the limit before it calls and an over-long array is
 * rejected by schema validation before the handler runs. Over a ceiling is a
 * caller error, not a reason to page silently.
 *
 * tests/tools/read-input-bounds.test.ts walks every read tool's published
 * input schema and fails on an array without `maxItems`.
 */

/** `dexe_read_protocol_stats.chainIds` — one leaderboard request per chain. The backend indexes two. */
export const MAX_STATS_CHAINS = 8;

/** `dexe_read_multicall.calls` — one Multicall3 round trip. */
export const MAX_MULTICALL_CALLS = 100;

/** Positional arguments of one call (`dexe_read_multicall.calls[].args`). */
export const MAX_CALL_ARGS = 32;

/** Explicit ERC20 list for `dexe_read_treasury.tokens` (3 view calls per token). */
export const MAX_TOKEN_LIST = 50;

/** NFT contract filter for `dexe_read_nfts.tokens` (sent in one query string). */
export const MAX_NFT_FILTER = 20;

/** Tier / proposal id lists (token-sale and distribution reads). */
export const MAX_ID_LIST = 50;

/** DAOs one `dexe_user_inbox` call scans — the same 50 auto-discovery returns. */
export const MAX_INBOX_DAOS = 50;

/** Wallets one `dexe_read_delegation_map` call filters on. */
export const MAX_DELEGATION_ADDRESSES = 100;

/** Hypothetical actions for `dexe_proposal_risk_assess` / `dexe_proposal_forecast` drafts. */
export const MAX_DRAFT_ACTIONS = 50;

/** Whitelists passed to `dexe_otc_buyer_status` (one per tier). */
export const MAX_WHITELISTS = 50;

/** Addresses in one whitelist — the merkle tree is rebuilt from them locally. */
export const MAX_WHITELIST_USERS = 10_000;
