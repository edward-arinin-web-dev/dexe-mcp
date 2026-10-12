import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  cidForBytes,
  DEFAULT_PUBLIC_READ_GATEWAYS,
  fetchIpfs,
  gatewayLabel,
  parseCid,
  resolveIpfsMaxBytes,
  DEFAULT_IPFS_HOP_TIMEOUT_MS,
} from "../lib/ipfs.js";
import { formatBytes } from "../lib/boundedBody.js";
import { shrinkJson } from "../lib/jsonShrink.js";
import { safeErrorMessage } from "../lib/redact.js";
import { untrustedResult } from "../lib/sanitize.js";
import { toActionableError, type ActionableError } from "../lib/errors.js";

/**
 * The read half of the IPFS tools: `dexe_ipfs_fetch` and `dexe_ipfs_cid_info`,
 * plus the gateway chain and the error sink the upload tools in ./ipfsWrite.ts
 * share. Nothing here pins.
 */
export function registerIpfsReadTools(server: McpServer, ctx: ToolContext): void {
  const gateways = resolveGateways(ctx);

  registerFetch(server, gateways);
  registerCidInfo(server, gateways);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * The one sink every IPFS tool's catch-all goes through.
 *
 * WHY it exists rather than calling `toActionableError` directly at each site:
 * a gateway URL is operator-supplied and may carry credentials in the URL
 * itself (`https://user:pass@gw/…`, or a token in the query). `fetch()` refuses
 * such a URL with "Request cannot be constructed from a URL that includes
 * credentials: <the whole URL>", and `fetchIpfs` aggregates that verbatim into
 * its per-gateway error list — so an echo of the raw message publishes the
 * gateway key into the model context. Both helpers below redact; the raw
 * `err.message` never leaves this file.
 *
 * WHY the `IPFS fetch failed` carve-out: the shared remedy table
 * (src/lib/errors.ts) has no IPFS-gateway entry, so a stalled gateway ("… →
 * timed out after 4000ms") falls through to `rpc-timeout` and would tell the
 * agent to set DEXE_RPC_URL_* and check the tx with dexe_tx_status — the wrong
 * knob and the wrong tool for an IPFS read. `fetchIpfs` already appends the
 * correct hint (set DEXE_IPFS_GATEWAY), so those keep their own advice.
 *
 * `classify` is the remedy table's classifier: the read one by default, the
 * write one (src/lib/writeErrors.ts) for the upload tools.
 */
export function ipfsToolError(
  err: unknown,
  step: string,
  classify: (err: unknown, step: string) => ActionableError = toActionableError,
): string {
  const raw = safeErrorMessage(err);
  if (/IPFS fetch failed|IPFS content too large|client cancelled/i.test(raw)) return `${step} failed: ${raw}`;
  return classify(err, step).message;
}

/**
 * The URL `dexe_ipfs_cid_info` prints for one gateway: scheme + host +
 * `/ipfs/<cid>`, nothing else of the configured value. A gateway URL is
 * operator-supplied and can carry credentials (`user:pass@`), a key in a path
 * prefix or a query, none of which a caller needs to open the content — and
 * under `serve-http` the caller is anyone. `redactUrlCredentials` is the wrong
 * tool here: it collapses the path to `/***`, erasing the `/ipfs/<cid>` the
 * tool exists to show. Never throws.
 */
export function gatewayContentUrl(gateway: string, cid: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(gateway) ? gateway : `https://${gateway}`);
    return `${u.protocol}//${u.host}/ipfs/${cid}`;
  } catch {
    return `https://${gatewayLabel(gateway)}/ipfs/${cid}`;
  }
}

/**
 * Cap on the parsed JSON `dexe_ipfs_fetch` puts in structuredContent. DeXe
 * metadata is a few KB; a document past this is summarized (arrays and long
 * strings cut, markers left in place) with `truncated: true`, and `sizeBytes`
 * still states the original size.
 */
export const IPFS_FETCH_JSON_MAX_BYTES = 128 * 1024;

/**
 * Lowercased hostname of a gateway URL (scheme optional), or null if
 * unparseable. Exported so `src/diag/checks.ts` judges DEXE_IPFS_GATEWAY by
 * exactly the rule the read path uses — a scheme-less host reads fine, so
 * doctor must not call it invalid.
 */
export function gatewayHostname(u: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build the gateway chain used by fetch/cid_info. Primary gateway is a single
 * dedicated endpoint the user configures — public gateways are only added if
 * the user opts in via `DEXE_IPFS_GATEWAYS_FALLBACK`. Returns an empty array
 * if nothing is configured; the fetch tool fails clean in that case.
 */
export function resolveGateways(_ctx: ToolContext): string[] {
  const out: string[] = [];
  const normalize = (raw: string): string => {
    const trimmed = raw.trim().replace(/\/$/, "");
    if (!trimmed) return "";
    // Allow operators to set DEXE_IPFS_GATEWAY=<host> without a scheme — fetch()
    // refuses such URLs with "Failed to parse URL", which masquerades as an
    // IPFS outage. Default to https since every realistic gateway requires it.
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };
  const primary = process.env.DEXE_IPFS_GATEWAY;
  if (primary) {
    const p = normalize(primary);
    if (p) out.push(p);
  }
  const fallback = process.env.DEXE_IPFS_GATEWAYS_FALLBACK;
  if (fallback) {
    for (const g of fallback.split(",").map(normalize)) {
      if (g && !out.includes(g)) out.push(g);
    }
  }
  const disablePublic = process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK === "1";
  // Zero-config default: no dedicated gateway configured → seed the public read
  // gateways so IPFS reads work out of the box. Best-effort; dexe_doctor nudges
  // toward a dedicated gateway. Opt out via DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1.
  if (out.length === 0 && !disablePublic) {
    out.push(...DEFAULT_PUBLIC_READ_GATEWAYS);
  }
  // Auto-fallback: if the primary is a Pinata dedicated gateway AND no gateway
  // key is configured, anonymous reads return 403 and tools like
  // dexe_ipfs_update_dao_metadata hang. Append `https://ipfs.io` as a
  // last-resort public reader so flows keep working out of the box.
  // Parse the hostname (not a substring match) so a URL whose *path* contains
  // "mypinata.cloud" isn't misclassified (js/incomplete-url-substring-sanitization).
  const usesRestrictedPinata = out.some((g) => {
    const host = gatewayHostname(g);
    return host === "mypinata.cloud" || (host?.endsWith(".mypinata.cloud") ?? false);
  });
  const haveGatewayKey = !!process.env.DEXE_PINATA_GATEWAY_TOKEN?.trim();
  if (!disablePublic && usesRestrictedPinata && !haveGatewayKey) {
    const publicFallback = "https://ipfs.io";
    if (!out.some((g) => g === publicFallback)) out.push(publicFallback);
  }
  return out;
}

export const NO_GATEWAY_HINT =
  "No IPFS gateway available — the public read gateways are disabled " +
  "(DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1) and no dedicated gateway is set. " +
  "Set DEXE_IPFS_GATEWAY to a dedicated gateway (Pinata gives one free with your " +
  "JWT — e.g. https://<your-subdomain>.mypinata.cloud — or use Filebase / Quicknode / " +
  "a self-hosted gateway), or remove DEXE_IPFS_DISABLE_PUBLIC_FALLBACK to re-enable " +
  "the public default (ipfs.io, dweb.link, cloudflare-ipfs.com).";

// ---------- dexe_ipfs_fetch ----------

function registerFetch(server: McpServer, defaultGateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_fetch",
    {
      title: "Fetch content by CID (dedicated gateway, optional fallback)",
      description:
        "Read-only. Fetches IPFS content via DEXE_IPFS_GATEWAY (a dedicated gateway, e.g. Pinata's). Public gateways are opt-in via DEXE_IPFS_GATEWAYS_FALLBACK, tried after the primary.",
      inputSchema: {
        cid: z.string().describe("CID (with or without ipfs:// prefix)"),
        timeoutMs: z.number().int().min(500).max(30_000).default(DEFAULT_IPFS_HOP_TIMEOUT_MS).describe("Per-gateway timeout in ms (default 10000)."),
      },
      outputSchema: {
        cid: z.string(),
        /** Host of the gateway that answered — never the configured URL. */
        gateway: z.string(),
        contentType: z.string(),
        /** Size of the fetched content, whatever `json` shows. */
        sizeBytes: z.number(),
        attempts: z.number(),
        json: z.unknown().nullable().optional(),
        /** True when `json` is a cut-down summary of a larger document. */
        truncated: z.boolean().optional(),
      },
    },
    async ({ cid, timeoutMs = DEFAULT_IPFS_HOP_TIMEOUT_MS }, extra) => {
      if (defaultGateways.length === 0) return errorResult(NO_GATEWAY_HINT);
      try {
        const res = await fetchIpfs(cid, {
          gateways: defaultGateways,
          perRequestTimeoutMs: timeoutMs,
          maxBytes: resolveIpfsMaxBytes(),
          signal: extra?.signal,
        });
        const gateway = gatewayLabel(res.gateway);
        // A document past the cap is summarized, not dropped: the caller keeps
        // its shape and the head of every field, and `truncated` + `sizeBytes`
        // say how much was left out.
        let json = res.json;
        let truncated = false;
        if (json != null) {
          const shrunk = shrinkJson(json, IPFS_FETCH_JSON_MAX_BYTES, "free");
          truncated = shrunk.value !== json;
          json = shrunk.value;
        }
        const structured = {
          cid: res.cid,
          gateway,
          contentType: res.contentType,
          sizeBytes: res.bytes.length,
          attempts: res.attempts,
          json,
          ...(truncated ? { truncated: true } : {}),
        };
        const truncNote = truncated
          ? `\n⚠ The JSON is ${formatBytes(res.bytes.length)}; structuredContent.json is a summary cut to ` +
            `${formatBytes(IPFS_FETCH_JSON_MAX_BYTES)} (arrays and long strings shortened, markers show where). ` +
            `Open the CID from a gateway directly for the whole document.`
          : "";
        // Whoever pinned this CID wrote every byte of it, and a descriptionURL
        // an agent follows is chosen by whoever created the DAO/proposal. So the
        // preview is fenced rather than pasted into the summary line, and the
        // parsed JSON in structuredContent is deep-sanitized on the way out.
        return untrustedResult({
          summary: `CID ${res.cid} via ${gateway} (attempts=${res.attempts})${truncNote}`,
          label: `IPFS content of ${res.cid}`,
          body:
            json != null
              ? json
              : `(${res.bytes.length} bytes of ${res.contentType})`,
          structured,
          maxBodyChars: 800,
          // The document is what this tool is for: keep strings whole up to the
          // JSON cap instead of the generic per-string cap.
          limits: { maxStringChars: IPFS_FETCH_JSON_MAX_BYTES },
        });
      } catch (err) {
        return errorResult(ipfsToolError(err, "dexe_ipfs_fetch"));
      }
    },
  );
}

// ---------- dexe_ipfs_cid_info ----------

function registerCidInfo(server: McpServer, gateways: string[]): void {
  server.registerTool(
    "dexe_ipfs_cid_info",
    {
      title: "Parse an IPFS CID (version, codec, gateway URLs)",
      description:
        "Read-only, local. Parses a CIDv0/v1, reports codec + multihash, converts v0↔v1 when legal, and emits a URL per configured gateway.",
      inputSchema: {
        cid: z.string().describe("CID (with or without ipfs:// prefix)"),
      },
      outputSchema: {
        cid: z.string(),
        version: z.number(),
        codec: z.string(),
        multihash: z.string(),
        alternate: z.string().nullable(),
        gatewayUrls: z.array(z.string()),
      },
    },
    async ({ cid }) => {
      try {
        const info = parseCid(cid);
        const gatewayUrls = [...new Set(gateways.map((g) => gatewayContentUrl(g, info.cid)))];
        const structured = { ...info, gatewayUrls };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `CID    : ${info.cid}\n` +
                `Version: v${info.version}\n` +
                `Codec  : ${info.codec}\n` +
                `Multihash (base58btc): ${info.multihash}\n` +
                `Alt    : ${info.alternate ?? "(no legal alternate)"}\n` +
                `Gateway URLs:\n${gatewayUrls.map((u) => `  ${u}`).join("\n")}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(ipfsToolError(err, "dexe_ipfs_cid_info"));
      }
    },
  );
}

// Keep this export so `cidForBytes` isn't flagged as dead code by strict builds;
// tools can opt into it later.
export { cidForBytes };
