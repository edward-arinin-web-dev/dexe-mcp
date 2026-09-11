/**
 * Shared `dexe_*` reference matcher.
 *
 * Lifted verbatim from tests/tools/default-profile-references.test.ts so a
 * second guard (the MCP handshake instructions) can use the SAME rules instead
 * of re-deriving them and false-failing on globs. Keep the two in agreement —
 * the regexes below are the repo's convention for how prose names a tool.
 */

/**
 * `dexe_…` in lowercase only. Env vars (`DEXE_TOOLSETS`), the package name
 * (`dexe-mcp`) and resource URIs (`dexe://graph-schema`) are deliberately not
 * matched — none of them is a tool call.
 */
export const TOOL_TOKEN = /dexe_[a-z0-9_]+\*?/g;

/**
 * Fragments that may sit between a name and a trailing shared annotation, so
 * "`dexe_a` or `dexe_b` (needs DEXE_TOOLSETS=core,proposals)" annotates both.
 */
const LIST_GAP =
  /^(?:\s+|[,/;+&|`'"]|\.\.\.|…|—|-|\*|\)|\(|\band\b|\bor\b|\bplus\b|\balso\b|dexe_[a-z0-9_]+\*?)/;
const ANNOTATION = /^\s*\(needs DEXE_TOOLSETS=([a-z,]+)\)/;

/**
 * The toolsets named by the annotation attached to the token ending at `from`,
 * or null when there is none. Scans forward over list punctuation and further
 * tool names so one annotation can cover a run of them.
 */
export function annotationAfter(text: string, from: number): string[] | null {
  let rest = text.slice(from, from + 300);
  for (let hop = 0; hop < 24; hop += 1) {
    const hit = ANNOTATION.exec(rest);
    if (hit) return hit[1]!.split(",").filter(Boolean);
    const gap = LIST_GAP.exec(rest);
    if (!gap) return null;
    rest = rest.slice(gap[0].length);
  }
  return null;
}

export interface ToolRef {
  /** The matched text, e.g. "dexe_gov_*". */
  raw: string;
  /** The name with any trailing `*`/`_` stripped — the prefix for a glob. */
  ref: string;
  /** True when the reference names a FAMILY, not a single call. */
  glob: boolean;
  /** Index just past the match, for annotationAfter(). */
  end: number;
}

/** Every `dexe_*` reference in `text`, normalized. */
export function toolRefs(text: string): ToolRef[] {
  const out: ToolRef[] = [];
  TOOL_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_TOKEN.exec(text)) !== null) {
    const raw = m[0];
    out.push({
      raw,
      ref: raw.replace(/[*_]+$/, ""),
      glob: raw.endsWith("*") || raw.endsWith("_"),
      end: m.index + raw.length,
    });
  }
  return out;
}
