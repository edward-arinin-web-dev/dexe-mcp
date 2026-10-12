import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import { READ_TOOLS } from "../editions.js";

/**
 * ── Toolset gating machinery, parameterized by edition ─────────────────────
 *
 * A server registers its tools through a gate that drops every name outside
 * the active allowlist. WHICH names exist, which named profiles group them and
 * which profiles apply when `DEXE_TOOLSETS` is unset is the edition's own
 * `ToolsetTable`:
 *
 *   - the single server this repo ships: src/tools/gate.ts
 *     (`SINGLE_SERVER_TOOLSETS` — core / proposals / read / vote / agents /
 *     governor / dev, default `core`);
 *   - the write edition: the same sets narrowed to WRITE_TOOLS
 *     (`WRITE_EDITION_TOOLSETS`, also src/tools/gate.ts);
 *   - the read edition: `READ_EDITION_TOOLSETS` below — one set holding every
 *     READ tool, and NO gating: `DEXE_TOOLSETS` is not read at all.
 *
 * This file names no tool of its own. It imports READ_TOOLS only to build the
 * read edition's table.
 */

/** What a gateable set ADDS, for `dexe_context`'s hidden-set report. */
export interface ToolsetUnlock {
  /**
   * What this set ADDS. Every `dexe_*` name here must be a member of the set —
   * asserted by tests/tools/context-unlocks-truthfulness.test.ts, because a
   * name in the wrong row sends the user to edit DEXE_TOOLSETS and restart for
   * a tool the session already has.
   */
  unlocks: string;
  /** Cross-reference prose; MAY name tools from other sets. Not asserted. */
  note?: string;
}

/** How `dexe_context` describes a server's toolsets (src/tools/operationalContext.ts describeToolsets). */
export interface ToolsetCatalog {
  /** One "what you're missing" summary per gateable set. */
  unlocks: Readonly<Record<string, ToolsetUnlock>>;
  /**
   * What the default profile already covers, quoted at the head of the enable
   * hint ("Check the `enabled` list first — <this>, so …").
   */
  defaultCovers: string;
}

/** One server's toolset table. */
export interface ToolsetTable {
  /** Profile name → the exact tool names it enables. Sets may overlap. */
  readonly sets: Readonly<Record<string, ReadonlySet<string>>>;
  /** The profiles that apply when `DEXE_TOOLSETS` is unset (or names nothing known). */
  readonly defaults: readonly string[];
  /**
   * True when the server does not gate at all: `DEXE_TOOLSETS` is ignored and
   * the union of `sets` registers. The read edition — 54 tools, no profile to
   * pick.
   */
  readonly ungated?: boolean;
  /** How `dexe_context` describes the sets. Omitted by a server that has no `dexe_context`. */
  readonly catalog?: ToolsetCatalog;
}

export interface ResolvedToolsets {
  /** Active allowlist, or null when everything should register (`full`). */
  names: Set<string> | null;
  /** Set names that weren't recognized. */
  unknown: string[];
  /** True when filtering is bypassed (explicit `full`). */
  full: boolean;
  /** The requested profiles (post-default). */
  requested: string[];
}

/** Every tool the table can register: the union of its sets. */
export function tableSurface(table: ToolsetTable): ReadonlySet<string> {
  const names = new Set<string>();
  for (const set of Object.values(table.sets)) for (const n of set) names.add(n);
  return names;
}

/**
 * The tool names a session sees when `DEXE_TOOLSETS` is unset. Callers that
 * need to answer "is this tool visible by default?" use this instead of
 * hardcoding profile names, so the answer can never drift from the table.
 */
export function defaultToolNames(table: ToolsetTable): ReadonlySet<string> {
  if (table.ungated) return tableSurface(table);
  const names = new Set<string>();
  for (const set of table.defaults) for (const n of table.sets[set] ?? []) names.add(n);
  return names;
}

/**
 * Resolve the requested profiles into a concrete allowlist. Only an explicit
 * `full` bypasses filtering. Unknown set names are DROPPED (loudly, by the
 * caller) and the recognized ones still apply — a typo in one entry must not
 * dump the entire surface plus the sets the user never asked for. When nothing
 * recognizable remains, fall back to the defaults rather than registering
 * nothing. An ungated table ignores `requested` entirely. Pure — no side
 * effects.
 */
export function resolveToolsetsIn(table: ToolsetTable, requested: readonly string[]): ResolvedToolsets {
  if (table.ungated) {
    return { names: new Set(tableSurface(table)), unknown: [], full: false, requested: [...table.defaults] };
  }
  const req = requested.length > 0 ? [...requested] : [...table.defaults];
  const unknown = req.filter((s) => s !== "full" && !(s in table.sets));
  if (req.includes("full")) {
    return { names: null, unknown, full: true, requested: req };
  }
  const known = req.filter((s) => s in table.sets);
  const effective = known.length > 0 ? known : [...table.defaults];
  const names = new Set<string>();
  for (const s of effective) for (const n of table.sets[s]!) names.add(n);
  return { names, unknown, full: false, requested: effective };
}

/**
 * Narrow every set of `table` to `keep`, dropping sets left empty. The write
 * edition's table is the single server's narrowed to WRITE_TOOLS.
 */
export function restrictToolsetTable(
  table: ToolsetTable,
  keep: Iterable<string>,
  catalog?: ToolsetCatalog,
): ToolsetTable {
  const allowed = new Set(keep);
  const sets: Record<string, ReadonlySet<string>> = {};
  for (const [name, members] of Object.entries(table.sets)) {
    const kept = [...members].filter((n) => allowed.has(n));
    if (kept.length > 0) sets[name] = new Set(kept);
  }
  return {
    sets,
    defaults: table.defaults.filter((s) => s in sets),
    ...(table.ungated ? { ungated: true } : {}),
    ...(catalog ? { catalog } : {}),
  };
}

/**
 * The read edition's table: every READ tool, ungated. The read server has no
 * profile to pick — 54 tools, all of them reads — so `DEXE_TOOLSETS` means
 * nothing to it, and `dexe_context` reports one enabled set and nothing hidden.
 */
export const READ_EDITION_TOOLSETS: ToolsetTable = {
  sets: { read: new Set(READ_TOOLS) },
  defaults: ["read"],
  ungated: true,
  catalog: {
    unlocks: { read: { unlocks: "every tool this server has" } },
    defaultCovers: "every tool this server has is already registered",
  },
};

/**
 * Some MCP hosts cap how many tools may be enabled in one request — VS Code /
 * GitHub Copilot Chat rejects a request carrying more than 128 enabled tools,
 * counting its own built-ins and every other connected server. `full` is well
 * past that on its own, so a user who follows an escalation hint to `full`
 * there breaks every chat request instead of gaining tools. Warn at startup
 * rather than letting them discover it as an opaque client-side error.
 *
 * Documented, with the profile combinations that fit, in docs/PROFILES.md.
 */
const CLIENT_TOOL_CAP = 128;

/** The cap warning, or "" when the loaded surface fits any known client. */
function capNote(loaded: number): string {
  if (loaded <= CLIENT_TOOL_CAP) return "";
  return (
    ` NOTE: ${loaded} tools exceeds the ${CLIENT_TOOL_CAP}-enabled-tool cap some hosts` +
    ` (VS Code / GitHub Copilot) apply per chat request — see docs/PROFILES.md for a` +
    ` smaller profile if your client rejects requests.`
  );
}

/** Proxy `server` so `registerTool` / `tool` drop any name outside `allow`. */
function filterRegistrations(server: McpServer, allow: ReadonlySet<string>): McpServer {
  const wrap = (fn: (...a: unknown[]) => unknown) =>
    (name: unknown, ...rest: unknown[]) => {
      if (typeof name === "string" && !allow.has(name)) return undefined;
      return fn(name, ...rest);
    };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool" || prop === "tool") {
        const original = Reflect.get(target, prop, receiver) as
          | ((...a: unknown[]) => unknown)
          | undefined;
        if (typeof original !== "function") return original;
        return wrap(original.bind(target));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as McpServer;
}

/**
 * Wrap `server` so tool registrations for names outside the table's active
 * allowlist are dropped. Returns the original server unchanged when the active
 * profile is `full`. Emits a one-line stderr banner. Call once per server.
 *
 * An ungated table (the read edition) always filters to its own surface, so a
 * register function that also registers another edition's tool cannot leak it.
 */
export function applyToolsetGate(server: McpServer, config: ReadConfig, table: ToolsetTable): McpServer {
  if (table.ungated) {
    const surface = tableSurface(table);
    if (config.toolsets?.length) {
      process.stderr.write(
        `[dexe-mcp] DEXE_TOOLSETS is not used by this server — all ${surface.size} tools are loaded.\n`,
      );
    }
    return filterRegistrations(server, surface);
  }

  const resolved = resolveToolsetsIn(table, config.toolsets ?? [...table.defaults]);
  const setNames = Object.keys(table.sets);

  if (resolved.unknown.length > 0) {
    process.stderr.write(
      `[dexe-mcp] unknown DEXE_TOOLSETS: [${resolved.unknown.join(", ")}] — ignored. ` +
        `Active: [${resolved.full ? "full" : resolved.requested.join(", ")}]. ` +
        `Valid sets: ${setNames.join(", ")}, full.\n`,
    );
  }
  if (resolved.full) {
    const size = tableSurface(table).size;
    process.stderr.write(`[dexe-mcp] toolsets: full — all ${size} tools loaded.${capNote(size)}\n`);
    return server;
  }

  const allow = resolved.names!;
  process.stderr.write(
    `[dexe-mcp] toolsets: [${resolved.requested.join(", ")}] → ${allow.size} tools loaded ` +
      `(set DEXE_TOOLSETS=full to load all, or add sets: ${setNames.join(", ")}).` +
      `${capNote(allow.size)}\n`,
  );
  return filterRegistrations(server, allow);
}
