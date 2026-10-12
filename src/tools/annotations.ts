import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ── MCP tool annotations, per edition ──────────────────────────────────────
 *
 * Without `annotations` the MCP spec makes a host assume the WORST about every
 * tool: `readOnlyHint` defaults to false, `destructiveHint` to true,
 * `openWorldHint` to true. So a server that declares nothing tells a
 * conformant client that `dexe_read_treasury` is exactly as dangerous as
 * `dexe_tx_send`. An `AnnotationTable` is the single source of truth that says
 * otherwise, applied by one wrapper at registration time
 * (`applyToolAnnotations(server, table)`, wired by each composition root) so no
 * register file has to remember anything.
 *
 * Tables are per edition:
 *   - `READ_ANNOTATIONS` (this file): the 54 read tools;
 *   - `WRITE_ANNOTATIONS` (./annotationsWrite.ts): the write tools;
 *   - `SINGLE_SERVER_ANNOTATIONS` (./annotationsWrite.ts): both, for the server
 *     this repo ships today.
 *
 * READ-EDITION TOOLS SPELL ALL FOUR HINTS (0.36.0). Connector directories
 * review them as booleans: Anthropic's asks for `readOnlyHint: true` on every
 * read, OpenAI's for explicit `readOnlyHint`, `destructiveHint` and
 * `openWorldHint`. So every READ tool carries `readOnlyHint: true`,
 * `destructiveHint: false`, `idempotentHint: true` and an explicit
 * `openWorldHint` (true: public chain / subgraph / backend / IPFS data; false:
 * the five that compute locally). The spec calls `destructiveHint` and
 * `idempotentHint` meaningful only when `readOnlyHint` is false, so they say
 * nothing a client must act on — they say it explicitly for reviewers.
 *
 * WRITE-EDITION READS KEEP ONE KEY. The calldata builders, simulators and
 * write-side status tools are `readOnlyHint: true` alone (or with
 * `openWorldHint: false`): `tools/list` for the default profile is budgeted
 * (tests/tools/gate.test.ts), and the four-key form costs ~103 B per tool where
 * the one-key form costs 36 B.
 *
 * CLASSIFICATION IS EXHAUSTIVE, NOT DEFAULTED. There is no fall-through: a
 * name absent from a table's `classes` gets NO annotations, which leaves the
 * conservative spec default in place instead of falsely claiming read-only,
 * and tests/tools/annotations.test.ts fails on it by name. Any new tool must
 * be classified by a human.
 */

/** Reads chain / subgraph / backend / IPFS. Open world is the spec default. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

/** Pure compute over local artifacts, the bundled corpus, or the arguments. */
export const LOCAL_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** A read-edition tool over public data: chain, subgraph, backend, IPFS. All four hints explicit. */
export const READ_PUBLIC: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** A read-edition tool that touches no network. All four hints explicit. */
export const READ_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** One edition's annotations: per-tool class, fallback titles, always-loaded tools. */
export interface AnnotationTable {
  /** Every tool name the edition registers → its annotations. */
  readonly classes: Readonly<Record<string, ToolAnnotations>>;
  /**
   * Titles for tools registered through the deprecated
   * `server.tool(name, description, schema, cb)` overload, which has no title
   * slot. Tools registered via `registerTool` carry their own and are never
   * overridden.
   */
  readonly titles: Readonly<Record<string, string>>;
  /** Tools published with `"anthropic/alwaysLoad": true` in `_meta`. */
  readonly alwaysLoaded: ReadonlySet<string>;
}

/**
 * The read edition's classes. Grouped by class; alphabetical within a group.
 */
const READ_CLASSES: Record<string, ToolAnnotations> = {
  // ── READ_LOCAL — no network at all: local artifacts / the bundled ABI
  // snapshot, the bundled knowledge corpus, static catalogs, or pure parsing.
  dexe_decode_calldata: READ_LOCAL,
  dexe_get_config: READ_LOCAL,
  dexe_guide: READ_LOCAL,
  dexe_ipfs_cid_info: READ_LOCAL,
  dexe_list_gov_contract_types: READ_LOCAL,

  // ── READ_PUBLIC — reads chain / subgraph / backend / IPFS and returns.
  dexe_context: READ_PUBLIC,
  dexe_dao_info: READ_PUBLIC,
  dexe_dao_predict_addresses: READ_PUBLIC,
  dexe_dao_registry_lookup: READ_PUBLIC,
  // The single server writes a snapshot under the state dir as a diff baseline
  // — an internal cache, not user state; the read edition stores nothing.
  dexe_dao_report: READ_PUBLIC,
  dexe_decode_proposal: READ_PUBLIC,
  dexe_doctor: READ_PUBLIC,
  dexe_gov_get_proposal: READ_PUBLIC,
  dexe_gov_get_proposal_threshold: READ_PUBLIC,
  dexe_gov_get_quorum: READ_PUBLIC,
  dexe_gov_get_state: READ_PUBLIC,
  dexe_gov_get_voting_power: READ_PUBLIC,
  dexe_gov_has_voted: READ_PUBLIC,
  dexe_gov_list_governors: READ_PUBLIC,
  dexe_gov_simulate_vote_impact: READ_PUBLIC,
  dexe_graph_query: READ_PUBLIC,
  // Live GraphQL introspection against the configured subgraph endpoint
  // (src/tools/subgraph.ts gqlRequest(GRAPH_SCHEMA_QUERY)) — open world, not a
  // bundled reference, whatever its position in the toolset profile.
  dexe_graph_schema: READ_PUBLIC,
  dexe_ipfs_fetch: READ_PUBLIC,
  dexe_proposal_forecast: READ_PUBLIC,
  dexe_proposal_list: READ_PUBLIC,
  dexe_proposal_risk_assess: READ_PUBLIC,
  dexe_proposal_state: READ_PUBLIC,
  dexe_proposal_voters: READ_PUBLIC,
  dexe_read_dao_experts: READ_PUBLIC,
  dexe_read_dao_list: READ_PUBLIC,
  dexe_read_dao_members: READ_PUBLIC,
  dexe_read_dao_stats: READ_PUBLIC,
  dexe_read_delegation_map: READ_PUBLIC,
  dexe_read_distribution_status: READ_PUBLIC,
  dexe_read_expert_status: READ_PUBLIC,
  dexe_read_gov_state: READ_PUBLIC,
  dexe_read_multicall: READ_PUBLIC,
  dexe_read_nfts: READ_PUBLIC,
  dexe_read_privacy_policy_status: READ_PUBLIC,
  dexe_read_protocol_stats: READ_PUBLIC,
  dexe_read_settings: READ_PUBLIC,
  dexe_read_staking_info: READ_PUBLIC,
  dexe_read_token_holders: READ_PUBLIC,
  dexe_read_token_sale_position: READ_PUBLIC,
  dexe_read_token_sale_tiers: READ_PUBLIC,
  dexe_read_token_sale_user: READ_PUBLIC,
  dexe_read_token_sales: READ_PUBLIC,
  dexe_read_treasury: READ_PUBLIC,
  dexe_read_user_activity: READ_PUBLIC,
  dexe_read_validator_list: READ_PUBLIC,
  dexe_read_validators: READ_PUBLIC,
  dexe_user_inbox: READ_PUBLIC,
  dexe_vote_get_votes: READ_PUBLIC,
  dexe_vote_user_power: READ_PUBLIC,
};

/**
 * Fallback titles for the read tools registered through the positional
 * `tool()` overload. A host renders `title ?? name` in its approval dialog.
 *
 * Short noun/verb phrase, sentence case, no trailing period: it is read inside
 * a confirm dialog, not in a docs table.
 */
const READ_TITLES: Record<string, string> = {
  dexe_context: "Session context",
  dexe_doctor: "Diagnose env setup",
  dexe_get_config: "Resolved server config",
  // the read edition's guide serves reference topics only; the single server
  // titles its flow-plan guide in ./annotationsWrite.ts
  dexe_guide: "DAO data reading guide",
};

/**
 * Tools a client should keep loaded instead of deferring behind tool search.
 *
 * Claude Code defers every MCP tool by default: only the tool NAMES and the
 * server instructions reach the model at session start, and a schema is loaded
 * when the model searches for it. The handshake tells the agent to call these
 * two first, so a deferred copy costs a search round-trip on the very first
 * step of every session. `"anthropic/alwaysLoad": true` in a tool's `_meta`
 * exempts that one tool (code.claude.com/docs/en/mcp, "Configure tool search").
 *
 * Deliberately two, not the composites: every always-loaded schema is paid on
 * every turn, and `dexe_proposal_create` alone is ~2 KB of description.
 * Clients that do not know the key ignore it.
 */
const READ_ALWAYS_LOADED: ReadonlySet<string> = new Set(["dexe_context", "dexe_guide"]);

/** The read edition's annotation table. */
export const READ_ANNOTATIONS: AnnotationTable = {
  classes: READ_CLASSES,
  titles: READ_TITLES,
  alwaysLoaded: READ_ALWAYS_LOADED,
};

/**
 * Annotations for `name`, or `undefined` when the tool is not classified.
 * Undefined is deliberate: an unannotated tool keeps the conservative spec
 * default (destructive, open world) instead of being wrongly advertised as a
 * read.
 */
export function annotationsFor(table: AnnotationTable, name: string): ToolAnnotations | undefined {
  return table.classes[name];
}

/** The title to publish for `name` when its registration supplied none. */
export function titleFor(table: AnnotationTable, name: string): string | undefined {
  return table.titles[name];
}

/** `_meta` to publish for `name`, or `undefined` when it carries none. */
export function metaFor(table: AnnotationTable, name: string): Record<string, unknown> | undefined {
  return table.alwaysLoaded.has(name) ? { "anthropic/alwaysLoad": true } : undefined;
}

/** Every name the table classifies — the exhaustiveness test reads it. */
export function classifiedToolNames(table: AnnotationTable): ReadonlySet<string> {
  return new Set(Object.keys(table.classes));
}

/** Every name the table supplies a fallback title for. */
export function titledToolNames(table: AnnotationTable): ReadonlySet<string> {
  return new Set(Object.keys(table.titles));
}

/** Every name published with `anthropic/alwaysLoad`. */
export function alwaysLoadedToolNames(table: AnnotationTable): ReadonlySet<string> {
  return table.alwaysLoaded;
}

/**
 * Fill in `annotations` (and a fallback `title`) on every registration,
 * whatever call shape the register file used, so no register file has to know
 * this module exists.
 *
 * Wrap OUTSIDE the toolset gate: `applyToolsetGate` returns the bare server for
 * `full` and `undefined` for a gated-out name, so this proxy must see the call
 * first and tolerate an undefined return.
 */
export function applyToolAnnotations(server: McpServer, table: AnnotationTable): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" && prop !== "tool") {
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (typeof v !== "function") return v;
      const original = (v as (...a: unknown[]) => unknown).bind(target);
      return (name: unknown, ...rest: unknown[]) => {
        if (typeof name !== "string") return original(name, ...rest);
        const ann = annotationsFor(table, name);
        const title = titleFor(table, name);
        const meta = metaFor(table, name);

        // registerTool(name, config, cb) — merge into the config object. An
        // explicit field in the registration always wins.
        if (prop === "registerTool" && rest[0] !== null && typeof rest[0] === "object") {
          const cfg = rest[0] as {
            annotations?: ToolAnnotations;
            title?: string;
            _meta?: Record<string, unknown>;
          };
          rest[0] = {
            ...cfg,
            ...(ann ? { annotations: { ...ann, ...cfg.annotations } } : {}),
            ...(cfg.title === undefined && title !== undefined ? { title } : {}),
            ...(meta ? { _meta: { ...meta, ...cfg._meta } } : {}),
          };
          return original(name, ...rest);
        }

        // The deprecated tool(...) overloads have no config object and no title
        // slot. `tools/list` reads `title` / `annotations` off the registered
        // tool at request time, so assigning after registration is enough — and
        // it avoids the listChanged notification `update()` would fire during
        // startup. The gate returns undefined for a dropped name.
        const reg = original(name, ...rest) as
          | { annotations?: ToolAnnotations; title?: string; _meta?: Record<string, unknown> }
          | undefined;
        if (reg && typeof reg === "object") {
          if (ann && reg.annotations === undefined) reg.annotations = ann;
          if (title !== undefined && reg.title === undefined) reg.title = title;
          if (meta) reg._meta = { ...meta, ...reg._meta };
        }
        return reg;
      };
    },
  }) as McpServer;
}
