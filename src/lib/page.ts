/**
 * One pagination contract for every offset-paged list tool.
 *
 * Before this, a list tool echoed the `offset`/`limit` it was handed and
 * nothing else, so a full page of 20 rows out of a 104-member DAO was
 * indistinguishable in the payload from a 20-member DAO — and an agent
 * reported the page as the complete list. The only reliable cue available to
 * the caller (`rows.length === limit`) was never spelled out.
 *
 * Three invariants, each of which kills a failure observed live on BSC mainnet:
 *
 *  - `returned === 0` is never `truncated`. `dexe_read_dao_experts` on BOXY DAO
 *    returns 0 experts while the pool's `votersCount` is 104; a total-driven
 *    rule would emit `truncated: true, nextOffset: 0` and instruct the caller
 *    to re-issue the identical call forever.
 *  - A `total` that disagrees with the rows (a stale or lagging index) degrades
 *    to the page-full heuristic rather than overriding it, and is dropped from
 *    the payload rather than echoed as a number the caller might believe.
 *  - `nextOffset` is emitted only when it strictly advances.
 *
 * `total` must count THE SAME FILTERED SET as `returned`. `votersCount` is a
 * correct total for a DAO's members and a fabrication for its experts.
 */

export interface PageInput {
  offset: number;
  limit: number;
  returned: number;
  /** Total rows for the same filtered set as `returned`. Omit unless proven equal. */
  total?: number;
}

export interface PageMeta {
  offset: number;
  limit: number;
  returned: number;
  /** True when this page may not be the whole set. */
  truncated: boolean;
  /** Present only when the source reports a usable count for this filtered set. */
  total?: number;
  /** Offset to pass for the next page; present only when it advances. */
  nextOffset?: number;
}

export function pageMeta(o: PageInput): PageMeta {
  const pageFull = o.returned >= o.limit;
  // An over-counting total (index lag, pruned rows) would page into an empty
  // page forever; an under-counting one would declare a full page complete.
  // Trust it only when it is consistent with what we actually got back.
  const totalUsable = o.total != null && Number.isFinite(o.total) && o.offset + o.returned <= o.total;
  const truncated =
    o.returned === 0 ? false : totalUsable ? o.offset + o.returned < o.total! || pageFull : pageFull;
  const nextOffset = o.offset + o.returned;
  return {
    offset: o.offset,
    limit: o.limit,
    returned: o.returned,
    truncated,
    ...(totalUsable ? { total: o.total } : {}),
    ...(truncated && nextOffset > o.offset ? { nextOffset } : {}),
  };
}

/**
 * The one line that tells the caller this is a page, in the tool's OWN cursor
 * parameter names. `dexe_proposal_voters` pages by `first`/`skip`, and its
 * published input schema is `additionalProperties: false`, so a remediation
 * that says "call again with offset:" is not merely unhelpful — it is rejected.
 *
 * Returns "" when nothing is truncated, so callers can append unconditionally.
 */
export function truncationNote(
  m: PageMeta,
  tool: string,
  noun: string,
  keys: { offsetKey?: string; limitKey?: string } = {},
): string {
  if (!m.truncated || m.nextOffset == null) return "";
  const ok = keys.offsetKey ?? "offset";
  const lk = keys.limitKey ?? "limit";
  const of =
    m.total != null ? `${m.offset + m.returned} of ${m.total}` : `${m.returned} (total unknown)`;
  return (
    `\n⚠ PARTIAL LIST — showing ${of} ${noun}(s). Call ${tool} again with the SAME arguments plus ` +
    `${ok}: ${m.nextOffset} (same ${lk}) for the next page. Do NOT report this page as the complete ` +
    `${noun} list.`
  );
}
