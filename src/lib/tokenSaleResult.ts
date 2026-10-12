import { untrustedResult } from "./sanitize.js";

/**
 * What the untrusted half of an OTC payload actually is. Opening a sale is
 * permissionless, so `TierMetadata.name` / `.description` and `TierInfo.uri`
 * are free text chosen by whoever opened it — the same class of channel as a
 * DAO name, aimed at an agent that may be holding a signer.
 */
const OTC_UNTRUSTED_LABEL =
  "OTC tier metadata (name / description / uri authored by whoever opened the sale)";

/**
 * Where the provenance sentence lives inside the JSON body. Written last on
 * purpose: a payload key of the same name would be attacker-influenced, and the
 * server-authored value must win the collision.
 */
const PROVENANCE_KEY = "_untrustedContent";

/**
 * THE result funnel for the OTC tools — every one that returns a payload
 * (src/tools/otc.ts and dexe_read_token_sale_position in src/tools/tokenSaleRead.ts)
 * returns it through here, and none of them build a result any other way.
 *
 * All the sanitizing is `untrustedResult`'s, unchanged: NFKC, control-char
 * escaping, zero-width/bidi stripping and fence-marker defanging applied to
 * every string AND every key, plus the provenance sentence. Nothing here
 * reimplements any of it. Before 0.33.0 this helper was a raw `JSON.stringify`,
 * so `dexe_read_token_sale_position` handed back sale-opener text with its zero-width
 * characters and forged fence-closes intact — while `dexe_read_token_sale_tiers`
 * returned the SAME on-chain bytes neutralized.
 *
 * Both channels below are literally the one object `untrustedResult` produced,
 * so "sanitize the prose, leak the rows through `structuredContent`" is not
 * expressible here.
 *
 * The text block stays a single JSON document rather than
 * `untrustedResult`'s summary-above-payload prose: these results carry signable
 * `TxPayload`s and are consumed by `JSON.parse` on that block (scripts,
 * orchestrators, tests). So the provenance line is folded INTO the document as
 * `_untrustedContent` instead of being printed above it.
 */
export function tokenSaleResult(data: Record<string, unknown>) {
  const funnelled = untrustedResult({
    summary: "",
    label: OTC_UNTRUSTED_LABEL,
    structured: data,
  });
  const body = {
    ...funnelled.structuredContent,
    [PROVENANCE_KEY]: funnelled.content[0]!.text.trim(),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}
