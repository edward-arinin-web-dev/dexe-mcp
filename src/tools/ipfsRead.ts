import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  cidForBytes,
  DEFAULT_PUBLIC_READ_GATEWAYS,
  fetchIpfs,
  parseCid,
  DEFAULT_IPFS_HOP_TIMEOUT_MS,
} from "../lib/ipfs.js";
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
  if (/IPFS fetch failed/i.test(raw)) return `${step} failed: ${raw}`;
  return classify(err, step).message;
}

/**
 * Drop `user:pass@` from a gateway URL we DELIBERATELY print (the gateway list
 * in `dexe_ipfs_cid_info`), keeping scheme/host/path so the URL still names the
 * CID it resolves. `redactUrlCredentials` is the right tool for error text but
 * the wrong one here — it collapses the path to `/***`, which would erase the
 * `/ipfs/<cid>` the tool exists to show. Never throws.
 *
 * Mirrors the same helper in src/tools/safe.ts; both belong in lib/redact.ts
 * once that file is free to edit.
 */
function stripUrlUserinfo(raw: string): string {
  try {
    const u = new URL(raw);
    // Nothing to strip → return the original: URL.toString() normalizes (adds a
    // trailing slash to a bare origin) and these strings are compared by eye
    // against what the operator configured.
    if (!u.username && !u.password) return raw;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s@]+@/g, "$1");
  }
}

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
        "Read-only. Fetches IPFS content via DEXE_IPFS_GATEWAY (dedicated; Pinata issues one with the JWT). Public gateways are opt-in via DEXE_IPFS_GATEWAYS_FALLBACK, tried after the primary.",
      inputSchema: {
        cid: z.string().describe("CID (with or without ipfs:// prefix)"),
        timeoutMs: z.number().int().min(500).max(30_000).default(DEFAULT_IPFS_HOP_TIMEOUT_MS).describe("Per-gateway timeout in ms (default 10000)."),
      },
      outputSchema: {
        cid: z.string(),
        gateway: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
        attempts: z.number(),
        json: z.unknown().nullable().optional(),
      },
    },
    async ({ cid, timeoutMs = DEFAULT_IPFS_HOP_TIMEOUT_MS }) => {
      if (defaultGateways.length === 0) return errorResult(NO_GATEWAY_HINT);
      try {
        const res = await fetchIpfs(cid, {
          gateways: defaultGateways,
          perRequestTimeoutMs: timeoutMs,
        });
        const structured = {
          cid: res.cid,
          gateway: res.gateway,
          contentType: res.contentType,
          sizeBytes: res.bytes.length,
          attempts: res.attempts,
          json: res.json,
        };
        // Whoever pinned this CID wrote every byte of it, and a descriptionURL
        // an agent follows is chosen by whoever created the DAO/proposal. So the
        // preview is fenced rather than pasted into the summary line, and the
        // parsed JSON in structuredContent is deep-sanitized on the way out.
        return untrustedResult({
          summary: `CID ${res.cid} via ${res.gateway} (attempts=${res.attempts})`,
          label: `IPFS content of ${res.cid}`,
          body:
            res.json != null
              ? res.json
              : `(${res.bytes.length} bytes of ${res.contentType})`,
          structured,
          maxBodyChars: 800,
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
      title: "Parse a CID, show version/codec, compute the alternate version + gateway URLs",
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
        const gatewayUrls = gateways.length
          ? gateways.map((g) =>
              stripUrlUserinfo(`${g.replace(/\/+$/, "").replace(/\/ipfs$/, "")}/ipfs/${info.cid}`),
            )
          : [];
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
