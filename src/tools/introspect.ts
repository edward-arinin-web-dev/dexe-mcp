import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { FunctionFragment, id as keccakId } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { ArtifactsMissingError } from "../artifacts.js";
import { safeErrorMessage } from "../lib/redact.js";

export function registerIntrospectTools(server: McpServer, ctx: ToolContext): void {
  registerListContracts(server, ctx);
  registerGetAbi(server, ctx);
  registerGetMethods(server, ctx);
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
    return { ok: false, error: safeErrorMessage(err) };
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
        "Read-only, local. Lists the compiled DeXe-Protocol contracts; filter by name substring and/or kind.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring match on contract name"),
        kind: z
          .enum(["contract", "interface", "library"])
          .optional()
          .describe("Return only artifacts of this kind."),
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

/**
 * Soft ceiling on an ABI response, in chars of `JSON.stringify(abi)`.
 *
 * `structuredContent` is what the model actually receives, so the compact
 * `content[].text` one-liner bought nothing: GovPool's ABI alone is ~21.8k
 * chars (~6k tokens). Only three of the 128 compiled artifacts exceed this —
 * GovPool 21,758; TokenSaleProposal 21,541; TokenSaleProposalMock 21,697 — and
 * IGovPool sits at 15,888, so the bar is deliberately above the ordinary
 * interface rather than at it.
 *
 * NOT a refusal. `kind:"function"` does not bring GovPool under any sane cap
 * (functions-only is still 20,169 chars), and `dexe_get_methods` is LARGER than
 * the raw ABI (~21.8k) — so a hard refusal would name two remedies that also
 * fail, on the flagship contract, in a tool literally called "get ABI". Instead
 * the oversized response is served with the filters that DO work named in the
 * text, and `dexe_get_selectors` (~2.4-5k for GovPool) pointed at as the one
 * genuinely compact alternative.
 */
const ABI_SOFT_CAP_CHARS = 16_000;

function registerGetAbi(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_abi",
    {
      title: "Get contract ABI",
      description:
        "Read-only, local. Contract ABI JSON from the local compile output; run dexe_compile " +
        "(needs DEXE_TOOLSETS=core,dev) once per session first. Narrow with `kind`/`nameFilter` " +
        "(GovPool ABI ~21.8k chars).",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
        kind: z
          .enum(["function", "event", "error", "constructor", "fallback", "receive"])
          .optional()
          .describe("Return only ABI entries of this type."),
        nameFilter: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the entry name, e.g. 'vote'."),
      },
      outputSchema: {
        contract: z.string(),
        sourceName: z.string(),
        abi: z.array(z.unknown()),
        /** Entries before `kind`/`nameFilter` narrowed the result. */
        totalEntries: z.number().optional(),
        /** True when a filter dropped entries — `abi` is a subset. */
        filtered: z.boolean().optional(),
      },
    },
    async ({ contract, kind, nameFilter }) => {
      const res = await guarded(ctx, () => ctx.artifacts.getOne(contract));
      if (!res.ok) return errorResult(res.error);
      const r = res.value;
      const all = r.abi as Array<{ type?: string; name?: string }>;
      const needle = nameFilter?.toLowerCase();
      const abi = all.filter(
        (e) =>
          (!kind || e.type === kind) &&
          (!needle || (e.name ?? "").toLowerCase().includes(needle)),
      );
      const structured = {
        contract: r.contractName,
        sourceName: r.sourceName,
        abi: abi as unknown[],
        totalEntries: all.length,
        filtered: abi.length < all.length,
      };
      const size = JSON.stringify(abi).length;
      const sizeNote =
        size > ABI_SOFT_CAP_CHARS
          ? `\n⚠ ${size} chars of JSON — this whole payload is in your context. Narrow it with ` +
            `kind:"function" and/or nameFilter:"<substring>", or call dexe_get_selectors instead ` +
            `(signature → 4-byte map, a fraction of the size). dexe_get_methods is NOT smaller — it ` +
            `carries full structured inputs/outputs.`
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `ABI for ${r.contractName} (${r.sourceName}) — ${abi.length} entries` +
              (structured.filtered ? ` (filtered from ${all.length})` : "") +
              sizeNote,
          },
        ],
        structuredContent: structured,
      };
    },
  );
}

// ---------- dexe_get_methods ----------

type AbiParam = {
  name?: string;
  type: string;
  internalType?: string;
  components?: AbiParam[];
};

type AbiFunction = {
  type: "function";
  name: string;
  stateMutability: "view" | "pure" | "nonpayable" | "payable";
  inputs?: AbiParam[];
  outputs?: AbiParam[];
};

type AbiEvent = {
  type: "event";
  name: string;
  anonymous?: boolean;
  inputs?: (AbiParam & { indexed?: boolean })[];
};

type AbiError = {
  type: "error";
  name: string;
  inputs?: AbiParam[];
};

// Recursive Param shape — kept loose because zod's recursive inference doesn't
// play well with output schemas exposed via MCP. Consumers should treat
// `components` as `Param[] | undefined`.
const paramSchema: z.ZodType<unknown> = z.lazy(() => z.record(z.unknown()));

function normalizeParam(p: AbiParam): {
  name: string;
  type: string;
  internalType?: string;
  components?: ReturnType<typeof normalizeParam>[];
} {
  const out: {
    name: string;
    type: string;
    internalType?: string;
    components?: ReturnType<typeof normalizeParam>[];
  } = {
    name: p.name ?? "",
    type: p.type,
  };
  if (p.internalType) out.internalType = p.internalType;
  if (p.components && p.components.length > 0) {
    out.components = p.components.map(normalizeParam);
  }
  return out;
}

function registerGetMethods(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_methods",
    {
      title: "Get contract methods (read/write)",
      description:
        "Read-only, local. Per-function metadata split into read (view/pure) and write (nonpayable/payable), with canonical signatures, 4-byte selectors and `internalType` kept for tuples.",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
        kind: z
          .enum(["read", "write", "all"])
          .optional()
          .describe("Filter: 'read' = view/pure, 'write' = nonpayable/payable, 'all' (default) returns both"),
        includeEvents: z.boolean().optional().describe("Include events array (default false)"),
        includeErrors: z.boolean().optional().describe("Include errors array (default false)"),
      },
      outputSchema: {
        contract: z.string(),
        sourceName: z.string(),
        counts: z.object({
          read: z.number(),
          write: z.number(),
          events: z.number().optional(),
          errors: z.number().optional(),
        }),
        read: z
          .array(
            z.object({
              name: z.string(),
              signature: z.string(),
              selector: z.string(),
              stateMutability: z.enum(["view", "pure", "nonpayable", "payable"]),
              inputs: z.array(paramSchema),
              outputs: z.array(paramSchema),
            }),
          )
          .optional(),
        write: z
          .array(
            z.object({
              name: z.string(),
              signature: z.string(),
              selector: z.string(),
              stateMutability: z.enum(["view", "pure", "nonpayable", "payable"]),
              inputs: z.array(paramSchema),
              outputs: z.array(paramSchema),
            }),
          )
          .optional(),
        events: z
          .array(
            z.object({
              name: z.string(),
              signature: z.string(),
              topicHash: z.string(),
              anonymous: z.boolean(),
              inputs: z.array(z.record(z.unknown())),
            }),
          )
          .optional(),
        errors: z
          .array(
            z.object({
              name: z.string(),
              signature: z.string(),
              selector: z.string(),
              inputs: z.array(paramSchema),
            }),
          )
          .optional(),
      },
    },
    async ({ contract, kind, includeEvents, includeErrors }) => {
      const wantKind: "read" | "write" | "all" = kind ?? "all";
      const res = await guarded(ctx, () => ctx.artifacts.getOne(contract));
      if (!res.ok) return errorResult(res.error);
      const record = res.value;
      const abi = record.abi as readonly unknown[];

      type MethodEntry = NonNullable<ReturnType<typeof buildMethodEntry>>;
      type EventEntry = NonNullable<ReturnType<typeof buildEventEntry>>;
      type ErrorEntry = NonNullable<ReturnType<typeof buildErrorEntry>>;
      const read: MethodEntry[] = [];
      const write: MethodEntry[] = [];
      const events: EventEntry[] = [];
      const errors: ErrorEntry[] = [];

      for (const item of abi) {
        if (!item || typeof item !== "object") continue;
        const entry = item as { type?: string };
        if (entry.type === "function") {
          const fn = item as AbiFunction;
          const built = buildMethodEntry(fn);
          if (!built) continue;
          if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
            read.push(built);
          } else {
            write.push(built);
          }
        } else if (entry.type === "event" && includeEvents) {
          const ev = buildEventEntry(item as AbiEvent);
          if (ev) events.push(ev);
        } else if (entry.type === "error" && includeErrors) {
          const er = buildErrorEntry(item as AbiError);
          if (er) errors.push(er);
        }
      }

      const cmp = (a: { name: string; signature: string }, b: { name: string; signature: string }) =>
        a.name.localeCompare(b.name) || a.signature.localeCompare(b.signature);
      read.sort(cmp);
      write.sort(cmp);
      events.sort(cmp);
      errors.sort(cmp);

      const structured: {
        contract: string;
        sourceName: string;
        counts: { read: number; write: number; events?: number; errors?: number };
        read?: typeof read;
        write?: typeof write;
        events?: typeof events;
        errors?: typeof errors;
      } = {
        contract: record.contractName,
        sourceName: record.sourceName,
        counts: {
          read: read.length,
          write: write.length,
        },
      };
      if (wantKind !== "write") structured.read = read;
      if (wantKind !== "read") structured.write = write;
      if (includeEvents) {
        structured.events = events;
        structured.counts.events = events.length;
      }
      if (includeErrors) {
        structured.errors = errors;
        structured.counts.errors = errors.length;
      }

      const summaryParts = [
        `${record.contractName} (${record.sourceName})`,
        `read=${read.length}`,
        `write=${write.length}`,
      ];
      if (includeEvents) summaryParts.push(`events=${events.length}`);
      if (includeErrors) summaryParts.push(`errors=${errors.length}`);

      const sample = (entries: typeof read, label: string) =>
        entries.length === 0
          ? ""
          : `\n${label}:\n${entries
              .slice(0, 20)
              .map((e) => `  ${e.selector}  ${e.signature}`)
              .join("\n")}${entries.length > 20 ? `\n  … ${entries.length - 20} more` : ""}`;

      const text =
        summaryParts.join("  ") +
        (wantKind !== "write" ? sample(read, "read") : "") +
        (wantKind !== "read" ? sample(write, "write") : "");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured,
      };
    },
  );
}

function buildMethodEntry(fn: AbiFunction):
  | {
      name: string;
      signature: string;
      selector: string;
      stateMutability: "view" | "pure" | "nonpayable" | "payable";
      inputs: ReturnType<typeof normalizeParam>[];
      outputs: ReturnType<typeof normalizeParam>[];
    }
  | null {
  let frag: FunctionFragment;
  try {
    frag = FunctionFragment.from(fn);
  } catch {
    return null;
  }
  return {
    name: fn.name,
    signature: frag.format("sighash"),
    selector: frag.selector,
    stateMutability: fn.stateMutability,
    inputs: (fn.inputs ?? []).map(normalizeParam),
    outputs: (fn.outputs ?? []).map(normalizeParam),
  };
}

function buildEventEntry(ev: AbiEvent): {
  name: string;
  signature: string;
  topicHash: string;
  anonymous: boolean;
  inputs: (ReturnType<typeof normalizeParam> & { indexed?: boolean })[];
} | null {
  // Compute canonical signature manually so we can preserve indexed flags + internalType.
  const params = (ev.inputs ?? []).map((p) => normalizeParam(p));
  const sigParams = (ev.inputs ?? []).map((p) => canonicalType(p)).join(",");
  const signature = `${ev.name}(${sigParams})`;
  let topicHash: string;
  try {
    // Use ethers id() via FunctionFragment? Easier: import keccak via ethers.
    // We avoid extra import by computing through a temporary throwaway: just rely on selectors index? No — independent.
    // Use a tiny inline keccak: actually we have ethers already imported, use id().
    topicHash = keccakId(signature);
  } catch {
    return null;
  }
  return {
    name: ev.name,
    signature,
    topicHash,
    anonymous: ev.anonymous ?? false,
    inputs: params.map((p, i) => ({
      ...p,
      indexed: (ev.inputs ?? [])[i]?.indexed ?? false,
    })),
  };
}

function buildErrorEntry(er: AbiError): {
  name: string;
  signature: string;
  selector: string;
  inputs: ReturnType<typeof normalizeParam>[];
} | null {
  const sigParams = (er.inputs ?? []).map((p) => canonicalType(p)).join(",");
  const signature = `${er.name}(${sigParams})`;
  let selector: string;
  try {
    selector = keccakId(signature).slice(0, 10);
  } catch {
    return null;
  }
  return {
    name: er.name,
    signature,
    selector,
    inputs: (er.inputs ?? []).map(normalizeParam),
  };
}

function canonicalType(p: AbiParam): string {
  // Solidity canonical type: tuples become "(t1,t2,...)" with array suffix preserved.
  if (p.type.startsWith("tuple")) {
    const inner = (p.components ?? []).map(canonicalType).join(",");
    const arraySuffix = p.type.slice("tuple".length); // "", "[]", "[2]", "[][]", etc.
    return `(${inner})${arraySuffix}`;
  }
  return p.type;
}

// ---------- dexe_get_selectors ----------

function registerGetSelectors(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_get_selectors",
    {
      title: "Get contract selectors",
      description:
        "Read-only, local. Function/event/error selectors from the local compile output; run dexe_compile (needs DEXE_TOOLSETS=core,dev) once per session first.",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
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
        "Read-only, local. Maps a 4-byte selector or 32-byte event topic to every matching contract and signature in the compiled codebase; collisions included.",
      inputSchema: {
        selector: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string")
          .describe("4-byte function/error selector or 32-byte event topic, 0x-hex."),
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
        "Read-only, local. devdoc/userdoc from build-info; optionally scoped to one member.",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
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
        "Read-only, local. Source file path for a contract; optionally slices around a symbol via a naive regex scan.",
      inputSchema: {
        contract: z.string().describe("Contract name, e.g. 'GovPool'"),
        symbol: z.string().optional().describe("Function/event name to slice the source around."),
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
