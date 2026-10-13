import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_SERVER_MARK, READ_TOOLS, WRITE_TOOLS } from "../editions.js";

/**
 * ── `(read server)` on every read tool a published description names ──────
 *
 * The write-only server (the 1.0.0 default) registers no READ tool, yet its
 * descriptions name them: write code says "the DAO's GovUserKeeper
 * (dexe_dao_info)", and the parameter texts it shares with the read edition
 * (`GOV_POOL_DESC` → dexe_dao_registry_lookup, …, @dexe-network/dexe-mcp/core)
 * do too. A bare name there promises a tool this server does not have. The
 * read server beside it has every one of them, so the honest wording is the
 * name plus `(read server)` (src/editions.ts READ_SERVER_MARK).
 *
 * Applied to the `tools/list` ANSWER, not to the source texts: the shared
 * parameter descriptions live in the read package, and a description written
 * tomorrow is covered without anyone remembering this rule. Only prose is
 * touched — each tool's `description` and every `description` inside its input
 * and output schemas; names, enums and defaults are not. A name already marked
 * is left alone, so the source may carry the mark too (and does, where it is
 * also true on the standalone server: a read tool IS the read server's tool).
 *
 * Installed like the schema normalizer (`installListToolsNormalizer`): around
 * `setRequestHandler`, before the first tool registers. The standalone server
 * does not install it — every read tool is registered there.
 */
const READ_NAMES = [...READ_TOOLS].sort((a, b) => b.length - a.length);
const MARK_RE = READ_SERVER_MARK.replace(/[()]/g, "\\$&");
// A read tool name, not followed by a word char or `*` (a glob is not a tool),
// not already marked (a closing backtick may sit between the name and the
// mark), capturing that backtick so the mark goes after it.
const UNMARKED = new RegExp(`\\b(${READ_NAMES.join("|")})\\b(?![\\w*])(?!\`?\\s*${MARK_RE})(\`?)`, "g");

// A glob (`dexe_read_*`, `dexe_decode_*`): marked when only read tools match
// its prefix — `dexe_gov_*` or `dexe_ipfs_*` name write tools too and stay bare.
const UNMARKED_GLOB = new RegExp(`\\b(dexe_[a-z0-9_]*)\\*(?!\`?\\s*${MARK_RE})(\`?)`, "g");

function readOnlyFamily(prefix: string): boolean {
  return READ_TOOLS.some((n) => n.startsWith(prefix)) && !WRITE_TOOLS.some((n) => n.startsWith(prefix));
}

/** `text` with every unmarked read tool name (and read-only glob) marked. Idempotent. */
export function markReadTools(text: string): string {
  return text
    .replace(UNMARKED, (_m, name: string, tick: string) => `${name}${tick} ${READ_SERVER_MARK}`)
    .replace(UNMARKED_GLOB, (m, prefix: string, tick: string) =>
      readOnlyFamily(prefix) ? `${prefix}*${tick} ${READ_SERVER_MARK}` : m,
    );
}

function markSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(markSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = k === "description" && typeof v === "string" ? markReadTools(v) : markSchema(v);
  }
  return out;
}

interface ListedTool {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  [k: string]: unknown;
}

export function installReadServerMarks(server: McpServer): void {
  const low = (server as unknown as { server?: { setRequestHandler?: unknown } }).server;
  if (!low || typeof low.setRequestHandler !== "function") return;
  const original = (low.setRequestHandler as (...a: unknown[]) => unknown).bind(low);
  (low as { setRequestHandler: unknown }).setRequestHandler = (schema: unknown, handler: unknown) => {
    const method =
      typeof schema === "string" ? schema : (schema as { shape?: { method?: { value?: unknown } } })?.shape?.method?.value;
    if (method !== "tools/list" || typeof handler !== "function") return original(schema, handler);
    const wrapped = async (...args: unknown[]) => {
      const res = (await (handler as (...a: unknown[]) => unknown)(...args)) as { tools?: ListedTool[] };
      if (!res || !Array.isArray(res.tools)) return res;
      return {
        ...res,
        tools: res.tools.map((t) => ({
          ...t,
          ...(typeof t.description === "string" ? { description: markReadTools(t.description) } : {}),
          ...(t.inputSchema !== undefined ? { inputSchema: markSchema(t.inputSchema) } : {}),
          ...(t.outputSchema !== undefined ? { outputSchema: markSchema(t.outputSchema) } : {}),
        })),
      };
    };
    return original(schema, wrapped);
  };
}
