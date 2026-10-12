import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import { READ_TOOLS } from "../editions.js";
import { formatBytes } from "../lib/boundedBody.js";
import { jsonBytes, shrinkJson, type ShrinkReport } from "../lib/jsonShrink.js";
import { safeErrorMessage } from "../lib/redact.js";
import { RequestCancelledError, runWithRequestSignal } from "../lib/requestScope.js";
import { sanitizeErrorText } from "../lib/sanitize.js";
import { createSecretScrubber, scrubDeep, scrubText, type Replacement } from "../lib/secretScrub.js";
import { redactDeep, stripEnvAdvice, type RemoteRedactor } from "../lib/remoteLabels.js";

/**
 * ── The read-tool result guard ─────────────────────────────────────────────
 *
 * Every read-edition tool (src/editions.ts READ_TOOLS) is wrapped once, at
 * registration, so the properties below hold for all of them on stdio and
 * under `serve-http` alike, whatever an individual handler remembers to do:
 *
 *   1. The handler runs with the request's `extra.signal` as the ambient
 *      cancellation signal (src/lib/requestScope.ts). The IPFS, subgraph,
 *      backend and multicall helpers honour it: a cancelled or timed-out
 *      request stops making upstream calls.
 *   2. A thrown error becomes an `isError` result with a redacted message —
 *      the SDK would otherwise echo `err.message` verbatim.
 *   3. Text and `structuredContent` pass through the secret scrub
 *      (src/lib/secretScrub.ts): configured RPC / subgraph / backend /
 *      gateway URLs and keys are replaced by masked forms.
 *   4. Error text is neutralized like other third-party prose (an upstream
 *      revert string or gateway body can carry bidi controls or a forged
 *      fence marker) and capped.
 *   5. REMOTE servers only (`opts.remote`): configured endpoint hosts become
 *      stable labels (`rpc[56]`, `subgraph:pools`, `backend`,
 *      `ipfs-gateway#1`), network-error peers and IP addresses are masked, an
 *      error's remaining URLs and host:port go too, and error sentences that
 *      tell the reader to set a server variable or restart are dropped
 *      (src/lib/remoteLabels.ts). A caller of a hosted server learns nothing
 *      about the operator's infrastructure and gets no advice it cannot act on.
 *   6. A result larger than the response limit (`DEXE_MAX_RESPONSE_BYTES`,
 *      default 256 KB) is cut down to fit instead of failing: array rows are
 *      dropped from the end and long strings shortened, the first line says
 *      exactly what was cut and how to get the rest, and offset-paged tools
 *      get a corrected `returned` / `nextOffset`. Behaviour under the limit is
 *      byte-for-byte unchanged.
 *
 * Wrapped OUTSIDE the toolset gate and the annotation layer (src/tools/index.ts):
 * those can return `undefined` for a dropped name, which is passed through.
 */

/** Default response limit for one read-tool result (text + structuredContent, serialized). */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_FLOOR = 16 * 1024;
const MAX_RESPONSE_CEILING = 16 * 1024 * 1024;

/** Cap on an error result's text. Remediation text is a few hundred bytes. */
const ERROR_TEXT_MAX_CHARS = 8_000;

/**
 * `DEXE_MAX_RESPONSE_BYTES` (digits only, clamped to 16 KB … 16 MB) or 256 KB.
 * A malformed value falls back to the default; the env spec reports it.
 */
export function resolveMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEXE_MAX_RESPONSE_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(MAX_RESPONSE_CEILING, Math.max(MAX_RESPONSE_FLOOR, Number(raw)));
}

type TextItem = { type: "text"; text: string };
type ToolResultLike = {
  content?: Array<{ type: string; text?: string } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} & Record<string, unknown>;

type AnyFn = (...a: unknown[]) => unknown;

function errorResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function cancelledResult(): ToolResultLike {
  return errorResult(new RequestCancelledError().message);
}

/** Keys the tool's outputSchema declares; null when it declares none (free-form result). */
function outputKeysOf(cfg: unknown): ReadonlySet<string> | null {
  const os = (cfg as { outputSchema?: unknown } | null)?.outputSchema;
  if (!os || typeof os !== "object") return null;
  const shape = (os as { shape?: unknown }).shape;
  return new Set(Object.keys(shape && typeof shape === "object" ? shape : os));
}

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

/** Cut `text` to at most `maxBytes` of UTF-8, marking the cut. */
function cutText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let n = Math.max(0, maxBytes);
  let head = text.slice(0, n);
  while (n > 0 && Buffer.byteLength(head, "utf8") > maxBytes) {
    n = Math.floor(n * 0.9);
    head = text.slice(0, n);
  }
  return `${head}\n… [${text.length - head.length} more characters truncated]`;
}

interface PageFix {
  /** Name of the continuation argument (`offset` or `skip`) and its new value. */
  continueWith?: { key: string; value: number };
  /** True when the result pages by an opaque cursor the cut rows cannot be reached through. */
  cursor: boolean;
}

/**
 * Keep offset-paged results honest after rows were dropped: `returned` drops
 * to what is left, the page is marked truncated, and the next offset starts
 * right after the last row kept — never after rows the caller did not get.
 */
function fixPagination(
  original: Record<string, unknown>,
  shrunk: Record<string, unknown>,
  allowed: (k: string) => boolean,
): PageFix {
  const fix: PageFix = {
    cursor: typeof original.nextPageToken === "string" && original.nextPageToken !== "",
  };
  const returned = original.returned;
  if (typeof returned !== "number") return fix;
  for (const [k, v] of Object.entries(original)) {
    const now = shrunk[k];
    if (!Array.isArray(v) || !Array.isArray(now) || v.length !== returned || now.length >= v.length) continue;
    const kept = now.length;
    shrunk.returned = kept;
    if ("truncated" in original || allowed("truncated")) shrunk.truncated = true;
    if (typeof original.offset === "number" && ("nextOffset" in original || allowed("nextOffset"))) {
      shrunk.nextOffset = original.offset + kept;
      fix.continueWith = { key: "offset", value: original.offset + kept };
    } else if (typeof original.skip === "number" && ("nextSkip" in original || allowed("nextSkip"))) {
      shrunk.nextSkip = original.skip + kept;
      fix.continueWith = { key: "skip", value: original.skip + kept };
    }
    break;
  }
  return fix;
}

function describeCut(report: ShrinkReport): string {
  const parts: string[] = [];
  for (const a of report.arrays) {
    const where = a.path === "$" ? "the result" : a.path.replace(/^\$\.?/, "");
    parts.push(`kept ${a.kept} of ${a.total} item(s) of ${where}`);
  }
  if (report.strings) parts.push(`shortened ${report.strings} long string(s)`);
  if (report.keys) parts.push(`dropped ${report.keys} object key(s)`);
  return parts.length ? parts.join("; ") : "shortened the text";
}

/**
 * Fit `result` into `maxBytes`. Returns it untouched when it already fits.
 * `outputKeys` null = no outputSchema, so markers may be added freely.
 */
export function capToolResult<R extends ToolResultLike>(
  result: R,
  maxBytes: number,
  outputKeys: ReadonlySet<string> | null,
): R {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter((c): c is TextItem & Record<string, unknown> => c.type === "text" && typeof c.text === "string");
  const textBytes = texts.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
  const sc = result.structuredContent;
  const scBytes = sc === undefined ? 0 : jsonBytes(sc);
  const original = textBytes + scBytes;
  if (original <= maxBytes) return result;

  const reserve = 1024; // the marker line
  const textBudget = sc === undefined ? maxBytes - reserve : Math.min(textBytes, Math.floor(maxBytes / 4));
  const allowed = (k: string) => outputKeys === null || outputKeys.has(k);

  let report: ShrinkReport | null = null;
  let page: PageFix = { cursor: false };
  let newSc: Record<string, unknown> | undefined = sc;
  if (sc !== undefined) {
    const scBudget = Math.max(1024, maxBytes - reserve - Math.min(textBytes, textBudget) - 512);
    const shrunk = shrinkJson(sc, scBudget, outputKeys === null ? "free" : "schema-safe");
    report = shrunk.report;
    newSc = shrunk.value as Record<string, unknown>;
    if (newSc !== sc && newSc && typeof newSc === "object" && !Array.isArray(newSc)) {
      page = fixPagination(sc, newSc, allowed);
      if (outputKeys === null) {
        newSc.truncated = true;
        newSc.responseTruncated = {
          limitBytes: maxBytes,
          originalBytes: original,
          arrays: report.arrays,
        };
      } else if (outputKeys.has("truncated") && newSc.truncated === undefined) {
        newSc.truncated = true;
      }
    }
  }

  const how = page.continueWith
    ? `Continue with ${page.continueWith.key}: ${page.continueWith.value} (same other arguments), or ask for fewer rows per page.`
    : page.cursor
      ? "The dropped rows are NOT reachable through nextPageToken: re-run this page with a smaller pageSize."
      : "To get the rest, narrow the request: fewer items, a smaller limit / first / pageSize, or a more specific query or section.";
  const marker =
    `⚠ RESPONSE TRUNCATED: the full result was ${formatBytes(original)}, over the ${formatBytes(maxBytes)} ` +
    `response limit (DEXE_MAX_RESPONSE_BYTES). ${report ? describeCut(report) : "Shortened the text"}. ${how} ` +
    `Do not treat this result as complete.`;

  // Text: keep the head of each item inside the budget, marker first.
  let left = Math.max(256, textBudget);
  const newContent: Array<Record<string, unknown>> = [{ type: "text", text: marker }];
  for (const c of content) {
    if (c.type !== "text" || typeof c.text !== "string") {
      newContent.push(c);
      continue;
    }
    if (left <= 0) continue;
    const cut = cutText(c.text, left);
    left -= Buffer.byteLength(cut, "utf8");
    newContent.push({ ...c, text: cut });
  }
  return {
    ...result,
    content: newContent,
    ...(newSc !== undefined ? { structuredContent: newSc } : {}),
  } as R;
}

// ---------------------------------------------------------------------------
// Scrub
// ---------------------------------------------------------------------------

function scrubResult<R extends ToolResultLike>(result: R, reps: readonly Replacement[]): R {
  const content = Array.isArray(result.content)
    ? result.content.map((c) => {
        if (c.type !== "text" || typeof c.text !== "string") return c;
        let text = reps.length ? scrubText(c.text, reps) : c.text;
        if (result.isError) text = sanitizeErrorText(text, ERROR_TEXT_MAX_CHARS);
        return text === c.text ? c : { ...c, text };
      })
    : result.content;
  const sc = result.structuredContent === undefined ? undefined : scrubDeep(result.structuredContent, reps);
  if (content === result.content && sc === result.structuredContent) return result;
  return { ...result, content, ...(sc !== undefined ? { structuredContent: sc } : {}) } as R;
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** Remote mode (property 5): labels for hosts, masks for peers/IPs, no env advice in errors. */
function redactForRemote<R extends ToolResultLike>(result: R, redactor: RemoteRedactor): R {
  const error = result.isError === true;
  const content = Array.isArray(result.content)
    ? result.content.map((c) => {
        if (c.type !== "text" || typeof c.text !== "string") return c;
        let text = redactor.text(c.text, error);
        if (error) text = stripEnvAdvice(text);
        return text === c.text ? c : { ...c, text };
      })
    : result.content;
  const sc =
    result.structuredContent === undefined
      ? undefined
      : redactDeep(result.structuredContent, (s) => redactor.text(s, error));
  if (content === result.content && sc === result.structuredContent) return result;
  return { ...result, content, ...(sc !== undefined ? { structuredContent: sc } : {}) } as R;
}

/** Wrap one read-tool handler. Exported for tests. */
export function guardReadHandler(
  cb: AnyFn,
  opts: { outputKeys: ReadonlySet<string> | null; scrubber: () => Replacement[]; remote?: RemoteRedactor },
): AnyFn {
  const finish = (r: ToolResultLike): ToolResultLike => {
    const scrubbed = scrubResult(r, opts.scrubber());
    return opts.remote ? redactForRemote(scrubbed, opts.remote) : scrubbed;
  };
  return async (...args: unknown[]) => {
    const extra = args[args.length - 1] as { signal?: unknown } | undefined;
    const signal = extra && typeof extra === "object" && extra.signal instanceof AbortSignal ? extra.signal : undefined;
    if (signal?.aborted) return cancelledResult();
    let result: unknown;
    try {
      result = await runWithRequestSignal(signal, () => cb(...args));
    } catch (err) {
      if (err instanceof RequestCancelledError || signal?.aborted) return cancelledResult();
      return finish(errorResult(safeErrorMessage(err)));
    }
    if (!result || typeof result !== "object") return result;
    const scrubbed = finish(result as ToolResultLike);
    if (scrubbed.isError) return capToolResult(scrubbed, ERROR_TEXT_MAX_CHARS * 2, null);
    return capToolResult(scrubbed, resolveMaxResponseBytes(), opts.outputKeys);
  };
}

/**
 * Wrap every READ_TOOLS registration on `server` with `guardReadHandler`.
 * `config` supplies the endpoints the scrub hides (env is read per call).
 * `remote` (the read server over HTTP) adds property 5.
 */
export function applyReadResultGuard(
  server: McpServer,
  config: Pick<ReadConfig, "chains" | "subgraphUrls" | "backendApiUrl">,
  tools: ReadonlySet<string> = new Set(READ_TOOLS),
  opts: { remote?: RemoteRedactor } = {},
): McpServer {
  const scrubber = createSecretScrubber(config);
  const remote = opts.remote;
  return new Proxy(server, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" && prop !== "tool") {
        return typeof v === "function" ? (v as AnyFn).bind(target) : v;
      }
      if (typeof v !== "function") return v;
      const original = (v as AnyFn).bind(target);
      return (name: unknown, ...rest: unknown[]) => {
        if (typeof name !== "string" || !tools.has(name)) return original(name, ...rest);
        if (prop === "registerTool") {
          if (typeof rest[1] === "function") {
            rest[1] = guardReadHandler(rest[1] as AnyFn, { outputKeys: outputKeysOf(rest[0]), scrubber, remote });
          }
          return original(name, ...rest);
        }
        const last = rest.length - 1;
        if (last >= 0 && typeof rest[last] === "function") {
          rest[last] = guardReadHandler(rest[last] as AnyFn, { outputKeys: null, scrubber, remote });
        }
        return original(name, ...rest);
      };
    },
  }) as McpServer;
}
