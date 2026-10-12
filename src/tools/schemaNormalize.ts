import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Post-processing for the JSON Schemas that `tools/list` advertises.
 *
 * zod 4's converter differs from zod 3's in two ways that matter to clients:
 *  - a `z.discriminatedUnion` becomes `oneOf`. OpenAI strict function schemas
 *    and Gemini reject `oneOf`; `anyOf` is accepted everywhere and means the
 *    same thing for a discriminated union (exactly one arm can match).
 *  - object schemas no longer carry `additionalProperties: false`. Without it a
 *    client cannot flag a typo such as `chainID`, which the server would
 *    silently drop and then fall back to the default chain.
 *
 * Objects that already state `additionalProperties`, or that are open maps
 * (`propertyNames` / `patternProperties`), are left alone.
 */
export function normalizeJsonSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => normalizeJsonSchema(n)) as T;
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = normalizeJsonSchema(v);

  if (Array.isArray(out.oneOf)) {
    const arms = out.oneOf;
    delete out.oneOf;
    if (Array.isArray(out.anyOf)) {
      // Both present (not produced today): keep both constraints.
      const allOf = Array.isArray(out.allOf) ? out.allOf : [];
      out.allOf = [...allOf, { anyOf: arms }];
    } else {
      out.anyOf = arms;
    }
  }

  if (
    out.type === "object" &&
    out.properties !== null &&
    typeof out.properties === "object" &&
    !("additionalProperties" in out) &&
    !("propertyNames" in out) &&
    !("patternProperties" in out)
  ) {
    out.additionalProperties = false;
  }
  return out as T;
}

interface ListedTool {
  inputSchema?: unknown;
  outputSchema?: unknown;
}

/**
 * Wrap the `tools/list` handler the SDK installs (lazily, on the first tool
 * registration) so every advertised schema passes through
 * {@link normalizeJsonSchema}. Intercepts `setRequestHandler` on the underlying
 * low-level server, so call it BEFORE any tool is registered.
 */
export function installListToolsNormalizer(server: McpServer, opts: { cache?: ListToolsCache } = {}): void {
  const low = (server as unknown as { server?: { setRequestHandler?: unknown } }).server;
  if (!low || typeof low.setRequestHandler !== "function") return;
  const original = (low.setRequestHandler as (...a: unknown[]) => unknown).bind(low);
  const cache = opts.cache;
  (low as { setRequestHandler: unknown }).setRequestHandler = (schema: unknown, handler: unknown) => {
    const method = (schema as { shape?: { method?: { value?: unknown } } })?.shape?.method?.value;
    if (method !== "tools/list" || typeof handler !== "function") return original(schema, handler);
    const wrapped = async (...args: unknown[]) => {
      if (cache?.result !== undefined) return cache.result;
      const res = (await (handler as (...a: unknown[]) => unknown)(...args)) as { tools?: ListedTool[] };
      if (!res || !Array.isArray(res.tools)) return res;
      const normalized = {
        ...res,
        tools: res.tools.map((t) => ({
          ...t,
          ...(t.inputSchema !== undefined ? { inputSchema: normalizeJsonSchema(t.inputSchema) } : {}),
          ...(t.outputSchema !== undefined ? { outputSchema: normalizeJsonSchema(t.outputSchema) } : {}),
        })),
      };
      if (cache) cache.result = normalized;
      return normalized;
    };
    return original(schema, wrapped);
  };
}

/**
 * A `tools/list` answer shared by servers whose tool set is fixed and
 * identical — the read edition's per-request HTTP servers. Converting 54 zod
 * schemas to JSON Schema is most of what a `tools/list` costs; with a cache it
 * happens once per process. Never share one between servers whose tools differ.
 */
export interface ListToolsCache {
  result?: unknown;
}
