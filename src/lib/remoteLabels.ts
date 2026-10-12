import type { ReadConfig } from "../configRead.js";

/**
 * ── What a remote caller sees instead of the operator's hosts ──────────────
 *
 * The secret scrub (./secretScrub.ts) masks keys and paths but keeps hostnames
 * on purpose: on a user's own machine a bare host is what tells them which
 * endpoint failed. On a hosted server the caller is anonymous and the hosts
 * are the operator's infrastructure — an internal RPC name, a private IP, a
 * corporate subgraph proxy. So in remote mode the read-result guard
 * (src/tools/readGuard.ts) runs every result through this redactor as well:
 *
 *   - each configured endpoint host — RPC per chain, subgraph per kind, the
 *     backend, operator-configured IPFS gateways — with any scheme, userinfo,
 *     port and path around it, becomes a stable label: `rpc[56]`,
 *     `subgraph:pools`, `backend`, `ipfs-gateway#1`. The public IPFS read
 *     gateways (ipfs.io, dweb.link, …) keep their names: they are public, and
 *     `dexe_ipfs_cid_info` hands them out as links;
 *   - the target of a network error code (`ECONNREFUSED 10.0.0.9:443`,
 *     `getaddrinfo ENOTFOUND internal-rpc`) becomes `<upstream>`;
 *   - IP addresses (with a port) become `<ip>`;
 *   - in ERROR results only — never in data, where a DAO's own links live —
 *     any remaining URL becomes `<url>` and any `host:port` becomes `<host>`.
 *
 * Labels are the same for every caller and every request, so an operator can
 * still read a bug report ("rpc[97] timed out") against their own config.
 */

/** Well-known public IPFS read gateways: public names, and links `dexe_ipfs_cid_info` hands out. */
export const PUBLIC_IPFS_READ_HOSTS: ReadonlySet<string> = new Set([
  "ipfs.io",
  "dweb.link",
  "cloudflare-ipfs.com",
  "cf-ipfs.com",
  "gateway.pinata.cloud",
]);

export interface EndpointLabel {
  /** Lowercased hostname (an IPv6 literal without brackets). */
  host: string;
  label: string;
}

/** Hostname of a URL or bare host, lowercased; null when unparseable. */
export function hostOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The label for every configured endpoint host. A host that serves more than
 * one role (one proxy for RPC and subgraph, one RPC host for two chains)
 * gets the role it has in common, or `upstream`.
 */
export function collectEndpointLabels(
  config: Pick<ReadConfig, "chains" | "subgraphUrls" | "backendApiUrl">,
  ipfsGateways: readonly string[],
): EndpointLabel[] {
  const roles = new Map<string, Set<string>>();
  const add = (url: unknown, role: string) => {
    if (typeof url !== "string") return;
    const host = hostOf(url);
    if (!host) return;
    let set = roles.get(host);
    if (!set) roles.set(host, (set = new Set()));
    set.add(role);
  };
  for (const chain of [...config.chains.values()].sort((a, b) => a.chainId - b.chainId)) {
    for (const u of chain.rpcUrls ?? [chain.rpcUrl]) add(u, `rpc[${chain.chainId}]`);
  }
  for (const endpoints of config.subgraphUrls.values()) {
    for (const [kind, u] of Object.entries(endpoints)) add(u, `subgraph:${kind}`);
  }
  add(config.backendApiUrl, "backend");
  ipfsGateways.forEach((g, i) => {
    const host = hostOf(g);
    if (host && !PUBLIC_IPFS_READ_HOSTS.has(host)) add(g, `ipfs-gateway#${i + 1}`);
  });

  const out: EndpointLabel[] = [];
  for (const [host, set] of roles) {
    const all = [...set];
    let label: string;
    if (all.length === 1) label = all[0]!;
    else if (all.every((r) => r.startsWith("rpc["))) label = "rpc";
    else if (all.every((r) => r.startsWith("subgraph:"))) label = "subgraph";
    else if (all.every((r) => r.startsWith("ipfs-gateway#"))) label = all.sort()[0]!;
    else label = "upstream";
    out.push({ host, label });
  }
  // Longest host first: `rpc.corp.example` before `corp.example`.
  return out.sort((a, b) => b.host.length - a.host.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One regex per host: optional scheme + userinfo, the host (bracketed for
 * IPv6), optional port, optional path/query — the whole URL becomes the label.
 * A host without a dot (a Docker service name like `rpc`) is only matched with
 * a scheme or a port around it, so a plain word is never rewritten.
 */
function hostPattern(host: string): RegExp {
  const h = host.includes(":") ? `\\[${escapeRe(host)}\\]` : escapeRe(host);
  const tail = String.raw`(?::\d{1,5})?(?:[/?#][^\s"'<>,;)\]]*)?`;
  const scheme = String.raw`[a-z][a-z0-9+.-]*://(?:[^\s/@"']*@)?`;
  if (host.includes(".") || host.includes(":")) {
    return new RegExp(String.raw`(?:${scheme})?(?<![\w.-])${h}(?![\w-])${tail}`, "gi");
  }
  return new RegExp(String.raw`(?:${scheme}${h}(?![\w.-])${tail}|(?<![\w.-])${h}:\d{1,5}(?![\w])(?:[/?#][^\s"'<>,;)\]]*)?)`, "gi");
}

/** Node / undici network error codes whose next token is the peer. */
const NET_ERROR_TARGET =
  /\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EADDRNOTAVAIL|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)\s+(?!<)[^\s,;)'"]+/g;
const IPV4 = /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?(?![\w.])/g;
// Needs a colon inside the brackets: `rpc[56]` is a label, not an address.
const IPV6_BRACKETED = /\[[0-9a-f.%]*:[0-9a-f:.%]*\](?::\d{1,5})?/gi;
const URL_ANY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;)\]]+/gi;
// A dotted name or localhost with a port. (A dotless configured host is
// labeled above; a dotless word with a number after a colon — `chainId:56` —
// is not a host.)
const HOST_PORT = /(?<![\w.:/-])(?:(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*|localhost):\d{2,5}(?![\w.])/gi;

export interface RemoteRedactor {
  /** Redact one string. `error`: the text of an error result (URLs and host:port go too). */
  text(s: string, error: boolean): string;
}

export function createRemoteRedactor(labels: () => readonly EndpointLabel[]): RemoteRedactor {
  let cacheKey = "";
  let patterns: Array<[RegExp, string]> = [];
  const compiled = () => {
    const ls = labels();
    const key = ls.map((l) => `${l.host}=${l.label}`).join("|");
    if (key !== cacheKey) {
      cacheKey = key;
      patterns = ls.map((l) => [hostPattern(l.host), l.label]);
    }
    return patterns;
  };
  return {
    text(s: string, error: boolean): string {
      let out = s;
      for (const [re, label] of compiled()) out = out.replace(re, label);
      out = out.replace(NET_ERROR_TARGET, "$1 <upstream>");
      out = out.replace(IPV6_BRACKETED, "<ip>").replace(IPV4, "<ip>");
      if (error) out = out.replace(URL_ANY, "<url>").replace(HOST_PORT, "<host>");
      return out;
    },
  };
}

/** `redactor.text` over every string value of a JSON-ish value; identity when nothing changed. */
export function redactDeep<T>(value: T, redact: (s: string) => string, maxNodes = 500_000): T {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 64) return v;
    if (typeof v === "string") return redact(v);
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const v2 = walk(val, depth + 1);
      if (v2 !== val) changed = true;
      out[k] = v2;
    }
    return changed ? out : v;
  };
  return walk(value, 0) as T;
}

// ─── env advice a remote caller cannot act on ───────────────────────────────

/**
 * A sentence telling someone to edit the server's env or restart it. Variable
 * names are matched case-SENSITIVELY: `dexe_get_config` is a tool a caller can
 * use, `DEXE_RPC_URL` a setting it cannot.
 */
const ENV_NAME = /\bDEXE_[A-Z0-9_*<>]+/;
const ENV_WORDS = /\b(?:and|then)\s+restart\b|\brestart (?:Claude|the MCP|the server|the host)|\.env\b|MCP env block|claude\.json|MCP host env/i;
const ENV_ADVICE = { test: (s: string) => ENV_NAME.test(s) || ENV_WORDS.test(s) };

/**
 * Error text for a remote caller: sentences that tell the reader to set a
 * server variable or restart the server are dropped (the first sentence — what
 * happened — always stays), and one line says why there is no fix to apply.
 * The read tools' own error texts are worded for remote callers at the source
 * (src/lib/audience.ts); this is the net under everything else.
 */
export function stripEnvAdvice(text: string): string {
  if (!ENV_ADVICE.test(text)) return text;
  const lines = text.split("\n").map((line) => {
    if (!ENV_ADVICE.test(line)) return line;
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z(`"'])/);
    const kept = sentences.filter((s, i) => i === 0 || !ENV_ADVICE.test(s));
    if (kept.length === 1 && ENV_ADVICE.test(kept[0]!)) kept[0] = kept[0]!.replace(/\bDEXE_[A-Z0-9_*<>]+/g, "a server setting");
    return kept.join(" ");
  });
  return `${lines.join("\n")}\n(This server's data sources are set by its operator.)`;
}
