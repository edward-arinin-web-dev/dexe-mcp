/**
 * Scenario template helpers — pure, side-effect-free, importable from tests.
 *
 * Scenario fixtures used to carry absolute unix timestamps (1750000000 =
 * 2025-06-15, 1760000000 = 2025-10-09). The OTC builders validate the sale
 * window against the current time, so those constants turned into hard failures
 * the moment the year rolled over; the staking builder had no such check, so
 * the same rot sat green in S37 while producing a tier the contract would
 * silently reject on execute.
 *
 * `{{now}}` / `{{now+<seconds>}}` / `{{now-<seconds>}}` make the fixtures
 * self-dating. Seconds only — no units, no spaces.
 */

/** Matches the `now`-family templates and nothing else. */
const NOW_RE = /^now(?:([+-])(\d+))?$/;
/** Tokens we CLAIM. Anything else starting with "now" (a capture named
 *  `nowState`, `nowVotes.x`) is not ours and must fall through untouched —
 *  otherwise adding a capture with an unlucky name would start throwing. */
const NOW_CLAIM_RE = /^now(?:[+-].*)?$/;

/**
 * Resolve a `now`-family template token (the text INSIDE `{{…}}`).
 *
 * Returns:
 *  - the seconds as a DECIMAL STRING (every consuming field is `z.string()` —
 *    saleStartTime/saleEndTime, startedAt/deadline — so this is a deliberate
 *    exception to expand()'s whole-value type-preservation rule),
 *  - `null` when the token is not ours (so the caller falls through to
 *    `{{dao}}`, `{{agent:X:address}}`, captures, …),
 *  - and THROWS on a malformed now-template. Resolving `{{now+abc}}` to ""
 *    would make `BigInt("")` = 0n downstream and the operator would see a
 *    "window is in the PAST" error instead of "bad template".
 */
export function resolveTimeTemplate(
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  if (typeof token !== "string" || !NOW_CLAIM_RE.test(token)) return null;
  const m = NOW_RE.exec(token);
  if (!m) {
    throw new Error(
      `Scenario template "{{${token}}}" is malformed. Use {{now}}, {{now+<seconds>}} or ` +
        `{{now-<seconds>}} — e.g. {{now+2592000}} for "30 days from now". Seconds only, no units, no spaces.`,
    );
  }
  if (!m[1]) return String(nowSec);
  const delta = BigInt(m[2]!);
  const base = BigInt(nowSec);
  return String(m[1] === "+" ? base + delta : base - delta);
}

/**
 * Keys the orchestrator can resolve under the `{{dao.*}}` namespace.
 *
 * The first five come from `GovPool.getHelperContracts()`, the next four from
 * `GovPool.getNftContracts()`. The last two are factory-PREDICTED helpers with
 * no forward getter on GovPool at all (grep IGovPool.sol — there is none), so
 * they come from the index-parallel `SWARM_TOKENSALE_<tag>` /
 * `SWARM_DISTRIBUTION_<tag>` allowlists, which preflight validates like every
 * other write target.
 */
export const DAO_TEMPLATE_KEYS = [
  "settings",
  "userKeeper",
  "validators",
  "poolRegistry",
  "votePower",
  "nftMultiplier",
  "expertNft",
  "dexeExpertNft",
  "babt",
  "tokenSale",
  "distributionProposal",
] as const;

export type DaoTemplateKey = (typeof DAO_TEMPLATE_KEYS)[number];

export function isDaoTemplateKey(key: string): key is DaoTemplateKey {
  return (DAO_TEMPLATE_KEYS as readonly string[]).includes(key);
}

/** Refusal text for `{{dao.<typo>}}` — a wrong key used to resolve to "". */
export function unknownDaoKeyMessage(key: string): string {
  return (
    `Scenario template "{{dao.${key}}}" is not a known DAO helper. ` +
    `Known keys: ${DAO_TEMPLATE_KEYS.join(", ")}.`
  );
}
