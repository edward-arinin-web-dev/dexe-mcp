import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ── Deprecated tool names, still answered by the single server ─────────────
 *
 * 0.36.0 renamed two read tools so the read edition's catalog says what they
 * do (decision D4): an "OTC buyer status" is a token-sale position, and the
 * sale list is a read like every other `dexe_read_*`. Callers that hard-code
 * the old names — scripts, saved prompts, swarm scenarios — keep working: the
 * single server registers each old name as an ALIAS of the new one, with the
 * same input schema, handler, annotations and output schema, and a
 * description that says it is deprecated and names the replacement.
 *
 * Accounting: an alias is NOT a tool. It is not in READ_TOOLS / WRITE_TOOLS
 * (src/editions.ts), not in any toolset (it follows its target through the
 * gate), not in the documented tool count; it IS in `tools/list` while it
 * exists. The read edition registers none. Remove an entry in a major release
 * and say so in docs/MIGRATION.md.
 *
 * Write side: the read edition never sees the old names.
 */
export const DEPRECATED_ALIASES: Readonly<Record<string, string>> = {
  dexe_otc_buyer_status: "dexe_read_token_sale_position",
  dexe_otc_list_sales_for_dao: "dexe_read_token_sales",
};

/** The release that renamed them, quoted in every alias description. */
const RENAMED_IN = "0.36.0";

/** The effect marker a description opens with ("Read-only." …), reused verbatim by its alias. */
function effectMarker(description: string): string {
  const m = /^[^.]*\.(?=\s)/.exec(description);
  return m ? `${m[0]} ` : "";
}

type ToolConfig = { title?: string; description?: string } & Record<string, unknown>;
type AnyFn = (...a: unknown[]) => unknown;

/**
 * Register every alias next to its target. Wrap INSIDE the annotation and
 * read-result layers (src/tools/index.ts) so the config and handler this proxy
 * copies already carry the annotations, title, `_meta` and the guarded handler.
 * Wrap OUTSIDE the toolset gate: an alias exists exactly when its target was
 * registered, so it is registered on `bare` — the server the gate wraps —
 * instead of being gated a second time.
 *
 * Targets must register through `registerTool` (config object). A target
 * registered through the positional `tool()` overload throws at startup, so a
 * rename can never silently ship without its alias.
 */
export function applyToolAliases(
  gated: McpServer,
  bare: McpServer,
  aliases: Readonly<Record<string, string>> = DEPRECATED_ALIASES,
): McpServer {
  const byTarget = new Map<string, string[]>();
  for (const [oldName, target] of Object.entries(aliases)) {
    byTarget.set(target, [...(byTarget.get(target) ?? []), oldName]);
  }
  return new Proxy(gated, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" && prop !== "tool") {
        return typeof v === "function" ? (v as AnyFn).bind(target) : v;
      }
      if (typeof v !== "function") return v;
      const original = (v as AnyFn).bind(target);
      return (name: unknown, ...rest: unknown[]) => {
        const olds = typeof name === "string" ? byTarget.get(name) : undefined;
        if (!olds) return original(name, ...rest);
        if (prop !== "registerTool" || rest[0] === null || typeof rest[0] !== "object") {
          throw new Error(
            `${String(name)} has a deprecated alias, so it must be registered with registerTool(name, config, cb)`,
          );
        }
        const registered = original(name, ...rest);
        // Gated out: the alias goes with it.
        if (registered === undefined) return registered;
        const cfg = rest[0] as ToolConfig;
        const cb = rest[1];
        for (const oldName of olds) {
          bare.registerTool(
            oldName,
            {
              ...cfg,
              ...(cfg.title ? { title: `${cfg.title} (old name)` } : {}),
              description:
                `${effectMarker(cfg.description ?? "")}Deprecated alias of ${String(name)} (renamed in ${RENAMED_IN}); ` +
                "same input and output.",
            } as Parameters<McpServer["registerTool"]>[1],
            cb as Parameters<McpServer["registerTool"]>[2],
          );
        }
        return registered;
      };
    },
  }) as McpServer;
}

/** Every deprecated name → the tool it now points at. */
export function deprecatedAliases(): ReadonlyMap<string, string> {
  return new Map(Object.entries(DEPRECATED_ALIASES));
}
