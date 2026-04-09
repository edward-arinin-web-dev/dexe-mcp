import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { ArtifactsMissingError } from "../artifacts.js";

export function registerIntrospectTools(server: McpServer, ctx: ToolContext): void {
  registerListContracts(server, ctx);
  registerGetAbi(server, ctx);
  registerGetSelectors(server, ctx);
  registerFindSelector(server, ctx);
  registerGetNatspec(server, ctx);
  registerGetSource(server, ctx);
}

// All tools here wrap their body in this guard so users get one consistent
// "run dexe_compile first" message instead of a raw stack.
async function guarded<T>(
  ctx: ToolContext,
  fn: () => T | Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; error: string }
> {
  try {
    ctx.artifacts.requireArtifactsExist();
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof ArtifactsMissingError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ---------- dexe_list_contracts ----------

function registerListContracts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_list_contracts",
    {
      title: "List compiled contracts",
      description:
        "Enumerates all compiled DeXe-Protocol contracts. Filter by substring match on name and/or kind (contract/interface/library). Requires dexe_compile to have run at least once.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring match on contract name"),
        kind: z.enum(["contract", "interface", "library"]).optional(),
      },
      outputSchema: {
        count: z.number(),
        contracts: z.array(
          z.object({
            name: z.string(),
            sourceName: z.string(),
            kind: z.enum(["contract", "interface", "library"]),
          }),
        ),
      },
    },
    async (args) => {
      const res = await guarded(ctx, () => ctx.artifacts.list(args));
      if (!res.ok) return errorResult(res.error);
      const records = res.value;
      const structured = {
        count: records.length,
        contracts: records
          .map((r) => ({ name: r.contractName, sourceName: r.sourceName, kind: r.kind }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `${structured.count} contract(s):\n${structured.contracts
              .map((c) => `  [${c.kind.padEnd(9)}] ${c.name}  (${c.sourceName})`)
              .join("\n")}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_get_abi ----------

function registerGetAbi(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_abi",
    {
      title: "Get contract ABI",
      description: "Returns the ABI JSON for a compiled contract by name.",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
      },
      outputSchema: {
        contract: z.string(),
        sourceName: z.string(),
        abi: z.array(z.unknown()),
      },
    },
    async ({ contract }) => {
      const res = await guarded(ctx, () => ctx.artifacts.getOne(contract));
      if (!res.ok) return errorResult(res.error);
      const r = res.value;
      const structured = {
        contract: r.contractName,
        sourceName: r.sourceName,
        abi: r.abi as unknown[],
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `ABI for ${r.contractName} (${r.sourceName}) — ${structured.abi.length} entries`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_get_selectors ----------

function registerGetSelectors(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_selectors",
    {
      title: "Get contract selectors",
      description:
        "Returns all function selectors, event topic hashes, and error selectors for a contract.",
      inputSchema: {
        contract: z.string(),
      },
      outputSchema: {
        contract: z.string(),
        count: z.number(),
        selectors: z.array(
          z.object({
            signature: z.string(),
            selector: z.string(),
            kind: z.enum(["function", "event", "error"]),
          }),
        ),
      },
    },
    async ({ contract }) => {
      const res = await guarded(ctx, () => ctx.selectors.forContract(contract));
      if (!res.ok) return errorResult(res.error);
      const hits = res.value;
      const structured = {
        contract,
        count: hits.length,
        selectors: hits.map((h) => ({
          signature: h.signature,
          selector: h.selector,
          kind: h.kind,
        })),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `${structured.count} selector(s) for ${contract}:\n${structured.selectors
              .slice(0, 50)
              .map((s) => `  ${s.selector}  [${s.kind}]  ${s.signature}`)
              .join("\n")}${structured.count > 50 ? `\n  … ${structured.count - 50} more` : ""}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_find_selector ----------

function registerFindSelector(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_find_selector",
    {
      title: "Reverse selector lookup",
      description:
        "Given a 4-byte selector (function/error, '0x…') or 32-byte event topic hash, returns all matching contracts and signatures across the compiled codebase. Supports collisions.",
      inputSchema: {
        selector: z.string().regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string"),
      },
      outputSchema: {
        selector: z.string(),
        count: z.number(),
        hits: z.array(
          z.object({
            contract: z.string(),
            sourceName: z.string(),
            signature: z.string(),
            kind: z.enum(["function", "event", "error"]),
          }),
        ),
      },
    },
    async ({ selector }) => {
      const res = await guarded(ctx, () => ctx.selectors.find(selector));
      if (!res.ok) return errorResult(res.error);
      const hits = res.value;
      const structured = {
        selector,
        count: hits.length,
        hits: hits.map((h) => ({
          contract: h.contract,
          sourceName: h.sourceName,
          signature: h.signature,
          kind: h.kind,
        })),
      };
      return {
        content: [
          {
            type: "text" as const,
            text:
              hits.length === 0
                ? `No matches for ${selector}`
                : `${hits.length} match(es) for ${selector}:\n${structured.hits
                    .map((h) => `  ${h.contract}.${h.signature}  [${h.kind}]`)
                    .join("\n")}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_get_natspec ----------

function registerGetNatspec(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_natspec",
    {
      title: "Get NatSpec docs",
      description:
        "Reads devdoc/userdoc for a contract from build-info. Optionally scope to a single member (function/event signature or name).",
      inputSchema: {
        contract: z.string(),
        member: z.string().optional().describe("Function/event name or full signature"),
      },
      outputSchema: {
        contract: z.string(),
        devdoc: z.unknown().optional(),
        userdoc: z.unknown().optional(),
      },
    },
    async ({ contract, member }) => {
      const res = await guarded(ctx, () => {
        const record = ctx.artifacts.getOne(contract);
        const info = ctx.artifacts.loadBuildInfoFor(record);
        if (!info) {
          throw new Error(
            `No build-info found for ${contract}. devdoc/userdoc may be disabled in the protocol's hardhat config outputSelection.`,
          );
        }
        const devdoc = (info.devdoc ?? null) as null | { methods?: Record<string, unknown>; kind?: string };
        const userdoc = (info.userdoc ?? null) as null | { methods?: Record<string, unknown>; kind?: string };
        if (member) {
          return {
            devdoc: devdoc?.methods ? filterMember(devdoc.methods, member) : undefined,
            userdoc: userdoc?.methods ? filterMember(userdoc.methods, member) : undefined,
          };
        }
        return { devdoc: devdoc ?? undefined, userdoc: userdoc ?? undefined };
      });
      if (!res.ok) return errorResult(res.error);
      const structured = { contract, ...res.value };
      return {
        content: [
          {
            type: "text" as const,
            text: `NatSpec for ${contract}${member ? `::${member}` : ""}:\n${JSON.stringify(
              { devdoc: structured.devdoc, userdoc: structured.userdoc },
              null,
              2,
            ).slice(0, 4000)}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

function filterMember(methods: Record<string, unknown>, member: string): Record<string, unknown> {
  const m = member.toLowerCase();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(methods)) {
    if (key.toLowerCase().includes(m)) out[key] = value;
  }
  return out;
}

// ---------- dexe_get_source ----------

function registerGetSource(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_source",
    {
      title: "Get contract source",
      description:
        "Returns the source file path for a contract. Optionally slices around a symbol (function/event name) using a naive regex scan — AST-based extraction is a future enhancement.",
      inputSchema: {
        contract: z.string(),
        symbol: z.string().optional(),
      },
      outputSchema: {
        contract: z.string(),
        sourceName: z.string(),
        sourcePath: z.string(),
        snippet: z.string().optional(),
        snippetStartLine: z.number().optional(),
      },
    },
    async ({ contract, symbol }) => {
      const res = await guarded(ctx, () => {
        const record = ctx.artifacts.getOne(contract);
        const sourcePath = isAbsolute(record.sourceName)
          ? record.sourceName
          : join(ctx.config.protocolPath, record.sourceName);

        let snippet: string | undefined;
        let snippetStartLine: number | undefined;
        if (symbol && existsSync(sourcePath)) {
          const src = readFileSync(sourcePath, "utf8");
          const lines = src.split(/\r?\n/);
          const pattern = new RegExp(
            `\\b(function|event|error|modifier)\\s+${escapeRegExp(symbol)}\\b`,
          );
          const idx = lines.findIndex((l) => pattern.test(l));
          if (idx >= 0) {
            const start = Math.max(0, idx - 2);
            const end = Math.min(lines.length, idx + 30);
            snippet = lines.slice(start, end).join("\n");
            snippetStartLine = start + 1;
          }
        }
        return { sourceName: record.sourceName, sourcePath, snippet, snippetStartLine };
      });
      if (!res.ok) return errorResult(res.error);
      const structured = { contract, ...res.value };
      return {
        content: [
          {
            type: "text" as const,
            text: structured.snippet
              ? `${structured.sourcePath}:${structured.snippetStartLine}\n\n${structured.snippet}`
              : structured.sourcePath,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
