/**
 * Shrink a JSON-ish value until its serialization fits a byte budget, keeping
 * its shape and saying what was cut.
 *
 * Two modes, because a result's `structuredContent` is validated against the
 * tool's advertised `outputSchema` (with `additionalProperties: false`) by the
 * SDK client:
 *
 *   - `schema-safe` only removes trailing array items and shortens long
 *     strings (a string stays a string). It never adds or removes an object
 *     key, so the shrunk value still matches any schema the original did —
 *     except a `minItems` on an output array, which no tool declares.
 *   - `free` may also drop object keys and leaves visible markers in place
 *     (`"… 120 more item(s)"` as the last array element, a `"…"` key on an
 *     object). For payloads with no schema: tools without `outputSchema`, and
 *     a fetched IPFS document.
 *
 * Arrays are cut first (rows are what grows), then long strings, then — free
 * mode only — wide objects. Each step is uniform across the value so the
 * result is predictable: "every array keeps its first N items".
 */

export type ShrinkMode = "schema-safe" | "free";

export interface CutArray {
  /** JSON path of the array, `$` for the root, e.g. `$.daoPools`. */
  path: string;
  kept: number;
  total: number;
}

export interface ShrinkReport {
  originalBytes: number;
  returnedBytes: number;
  /** The arrays that lost items, largest loss first (at most 5 listed). */
  arrays: CutArray[];
  /** How many strings were shortened. */
  strings: number;
  /** How many object keys were dropped (free mode only). */
  keys: number;
  /** False when even the tightest limits could not reach the budget. */
  fits: boolean;
}

interface Limits {
  arr: number;
  str: number;
  keys: number;
}

/** UTF-8 size of the JSON serialization. bigint → decimal string, like the SDK would need. */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

const STR_FLOOR = 96;
const KEYS_FLOOR = 4;

function apply(
  value: unknown,
  lim: Limits,
  mode: ShrinkMode,
  stats: { arrays: Map<string, CutArray>; strings: number; keys: number },
): unknown {
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") {
      if (v.length <= lim.str) return v;
      stats.strings++;
      return `${v.slice(0, lim.str)}… [${v.length - lim.str} more chars truncated]`;
    }
    if (v === null || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) {
      const kept = v.length > lim.arr ? v.slice(0, lim.arr) : v;
      const out = kept.map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      if (kept.length < v.length) {
        const prev = stats.arrays.get(path.replace(/\[\d+\]/g, "[]"));
        const key = path.replace(/\[\d+\]/g, "[]");
        stats.arrays.set(key, {
          path: key,
          kept: Math.min(prev?.kept ?? Infinity, kept.length),
          total: Math.max(prev?.total ?? 0, v.length),
        });
        if (mode === "free") out.push(`… ${v.length - kept.length} more item(s) truncated`);
      }
      return out;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    const keptEntries = mode === "free" && entries.length > lim.keys ? entries.slice(0, lim.keys) : entries;
    const out: Record<string, unknown> = {};
    for (const [k, val] of keptEntries) out[k] = walk(val, `${path}.${k}`, depth + 1);
    if (keptEntries.length < entries.length) {
      stats.keys += entries.length - keptEntries.length;
      out["…"] = `${entries.length - keptEntries.length} more key(s) truncated`;
    }
    return out;
  };
  return walk(value, "$", 0);
}

function maxima(value: unknown): { arr: number; str: number; keys: number } {
  let arr = 0;
  let str = 0;
  let keys = 0;
  let nodes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > 1_000_000 || depth > 64) return;
    if (typeof v === "string") str = Math.max(str, v.length);
    else if (Array.isArray(v)) {
      arr = Math.max(arr, v.length);
      for (const x of v) walk(x, depth + 1);
    } else if (v !== null && typeof v === "object") {
      const e = Object.values(v as Record<string, unknown>);
      keys = Math.max(keys, e.length);
      for (const x of e) walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return { arr, str, keys };
}

/**
 * Shrink `value` to at most `budgetBytes` of JSON. Returns the value itself
 * (and `fits: true`, nothing cut) when it already fits.
 */
export function shrinkJson(
  value: unknown,
  budgetBytes: number,
  mode: ShrinkMode,
): { value: unknown; report: ShrinkReport } {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= budgetBytes) {
    return { value, report: { originalBytes, returnedBytes: originalBytes, arrays: [], strings: 0, keys: 0, fits: true } };
  }
  const max = maxima(value);
  const run = (lim: Limits) => {
    const stats = { arrays: new Map<string, CutArray>(), strings: 0, keys: 0 };
    const out = apply(value, lim, mode, stats);
    return { out, stats, bytes: jsonBytes(out) };
  };

  // Phase 1: arrays. Halve until it fits (or arrays are down to 1), then
  // binary-search back up between the last cap that fit and the one that did not.
  let lim: Limits = { arr: max.arr, str: Math.max(STR_FLOOR, Math.min(max.str, 16_384)), keys: max.keys };
  let best = run(lim);
  if (best.bytes > budgetBytes && max.arr > 1) {
    let hi = max.arr; // known too big
    let lo = Math.max(1, Math.floor(max.arr / 2));
    let probe = run({ ...lim, arr: lo });
    while (probe.bytes > budgetBytes && lo > 1) {
      hi = lo;
      lo = Math.max(1, Math.floor(lo / 2));
      probe = run({ ...lim, arr: lo });
    }
    if (probe.bytes <= budgetBytes) {
      // lo fits, hi does not: tighten the gap.
      let fit = probe;
      let fitArr = lo;
      for (let i = 0; i < 12 && hi - fitArr > 1; i++) {
        const mid = Math.floor((fitArr + hi) / 2);
        const r = run({ ...lim, arr: mid });
        if (r.bytes <= budgetBytes) {
          fit = r;
          fitArr = mid;
        } else hi = mid;
      }
      best = fit;
      lim = { ...lim, arr: fitArr };
    } else {
      best = probe;
      lim = { ...lim, arr: lo };
    }
  }
  // Phase 2: strings, then (free mode) object width, then arrays down to zero.
  while (best.bytes > budgetBytes) {
    if (lim.str > STR_FLOOR) lim = { ...lim, str: Math.max(STR_FLOOR, Math.floor(lim.str / 2)) };
    else if (mode === "free" && lim.keys > KEYS_FLOOR) lim = { ...lim, keys: Math.max(KEYS_FLOOR, Math.floor(lim.keys / 2)) };
    else if (lim.arr > 0) lim = { ...lim, arr: lim.arr > 1 ? Math.floor(lim.arr / 2) : 0 };
    else break;
    best = run(lim);
  }

  const arrays = [...best.stats.arrays.values()]
    .sort((a, b) => b.total - b.kept - (a.total - a.kept))
    .slice(0, 5);
  return {
    value: best.out,
    report: {
      originalBytes,
      returnedBytes: best.bytes,
      arrays,
      strings: best.stats.strings,
      keys: best.stats.keys,
      fits: best.bytes <= budgetBytes,
    },
  };
}
