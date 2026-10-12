import type { ReadConfig } from "../configRead.js";
import { maskUrl } from "./redact.js";

/**
 * Last-line scrub for read-tool output: replace the literal values of the
 * operator's configured endpoints and keys with masked forms.
 *
 * `lib/redact.ts` masks URLs where a tool knows it is printing one (error
 * messages, `dexe_get_config`). That misses text that merely CONTAINS a
 * configured value without being a URL token of ours — an upstream error body
 * that echoes the request path (`/api/<graph-key>/subgraphs/id/…`), a gateway
 * that repeats its own URL, a key in a query string. Under `serve-http` any
 * of those hands an anonymous caller the operator's RPC or Graph key.
 *
 * So the read-tool guard (src/tools/readGuard.ts) runs every read result and
 * error through `scrubText` / `scrubDeep` with the replacements built here:
 *
 *   - a configured URL that carries something beyond scheme + host (userinfo,
 *     a path, a query) → `maskUrl(url)` (`https://host/***`);
 *   - its path + query, when long enough to be specific → `/***`;
 *   - any path segment, query value or userinfo part that looks like a key
 *     (16+ chars, not all letters) → `***`;
 *   - configured key/token env values (`DEXE_GRAPH_API_KEY`,
 *     `DEXE_PINATA_GATEWAY_TOKEN`, …) → `***`.
 *
 * Hostnames alone are not replaced: `maskUrl` keeps them, and a bare host is
 * what lets a user tell which endpoint failed. A URL with nothing beyond
 * scheme + host has nothing to hide and produces no replacement.
 */

/** Endpoint env vars read directly by tools (not only through ReadConfig). */
const URL_ENV_KEYS = [
  "DEXE_RPC_URL",
  "DEXE_RPC_URL_MAINNET",
  "DEXE_RPC_URL_TESTNET",
  "DEXE_SUBGRAPH_POOLS_URL",
  "DEXE_SUBGRAPH_VALIDATORS_URL",
  "DEXE_SUBGRAPH_INTERACTIONS_URL",
  "DEXE_BACKEND_API_URL",
  "DEXE_IPFS_GATEWAY",
  "DEXE_IPFS_AVATAR_GATEWAY",
  "DEXE_SAFE_TX_SERVICE_URL",
  "DEXE_WALLETCONNECT_RELAY_URL",
] as const;

/** Per-chain endpoint vars (`DEXE_RPC_URL_<id>`, `DEXE_SUBGRAPH_<KIND>_URL_<id>`). */
const URL_ENV_RE = /^DEXE_(RPC_URL_\d+|SUBGRAPH_(POOLS|VALIDATORS|INTERACTIONS)_URL_\d+)$/;

/** Comma-separated endpoint lists. */
const URL_LIST_ENV_KEYS = ["DEXE_IPFS_GATEWAYS_FALLBACK"] as const;

/** Env vars whose whole value is a credential. */
const SECRET_ENV_RE = /^DEXE_[A-Z0-9_]*(KEY|TOKEN|SECRET|JWT|PASSWORD|_PK|_PK_\d+|PROJECT_ID)$/;

/** Shorter literals are too likely to occur in ordinary text to replace blindly. */
const MIN_SECRET_LEN = 8;
/** A path/query fragment is only replaced whole when it is at least this specific. */
const MIN_FRAGMENT_LEN = 12;
/** Path segments / query values at least this long, and not all letters, look like keys. */
const MIN_KEYLIKE_LEN = 16;

export type Replacement = readonly [literal: string, masked: string];

/** Every configured endpoint URL and credential the scrub must hide. */
export function collectSecretSources(
  config: Pick<ReadConfig, "chains" | "subgraphUrls" | "backendApiUrl"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { urls: string[]; secrets: string[] } {
  const urls = new Set<string>();
  const secrets = new Set<string>();
  const addUrl = (u: unknown) => {
    if (typeof u === "string" && u.trim()) urls.add(u.trim());
  };
  if (config) {
    for (const chain of config.chains?.values() ?? []) for (const u of chain.rpcUrls ?? []) addUrl(u);
    for (const endpoints of config.subgraphUrls?.values() ?? []) {
      for (const u of Object.values(endpoints)) addUrl(u);
    }
    addUrl(config.backendApiUrl);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith("DEXE_")) continue;
    if ((URL_ENV_KEYS as readonly string[]).includes(key) || URL_ENV_RE.test(key)) addUrl(value);
    else if ((URL_LIST_ENV_KEYS as readonly string[]).includes(key)) value.split(",").forEach(addUrl);
    else if (SECRET_ENV_RE.test(key) && value.trim().length >= MIN_SECRET_LEN) secrets.add(value.trim());
  }
  return { urls: [...urls], secrets: [...secrets] };
}

const keyLike = (s: string): boolean => s.length >= MIN_KEYLIKE_LEN && !/^[A-Za-z]+$/.test(s);

/** The replacements for one URL (empty when it has nothing to hide). */
function urlReplacements(raw: string): Replacement[] {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return raw.length >= MIN_FRAGMENT_LEN ? [[raw, "***"]] : [];
  }
  const hasPath = u.pathname !== "" && u.pathname !== "/";
  if (!u.username && !u.password && !hasPath && !u.search) return [];

  const out: Replacement[] = [];
  const masked = maskUrl(withScheme);
  for (const form of new Set([raw, raw.replace(/\/+$/, ""), withScheme, u.toString()])) {
    if (form && form !== masked) out.push([form, masked]);
  }
  const pathAndQuery = `${hasPath ? u.pathname : ""}${u.search}`;
  if (pathAndQuery.length >= MIN_FRAGMENT_LEN) {
    out.push([pathAndQuery, "/***"]);
    const trimmed = pathAndQuery.replace(/\/+$/, "");
    if (trimmed !== pathAndQuery && trimmed.length >= MIN_FRAGMENT_LEN) out.push([trimmed, "/***"]);
  }
  for (const seg of u.pathname.split("/")) {
    if (keyLike(seg)) out.push([seg, "***"]);
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (decoded !== seg && keyLike(decoded)) out.push([decoded, "***"]);
  }
  for (const value of u.searchParams.values()) if (value.length >= MIN_SECRET_LEN) out.push([value, "***"]);
  for (const part of [u.username, u.password]) {
    if (!part) continue;
    out.push([part, "***"]);
    try {
      const d = decodeURIComponent(part);
      if (d !== part) out.push([d, "***"]);
    } catch {
      /* keep raw */
    }
  }
  return out.filter(([lit]) => lit.length >= 4);
}

/** Build the replacement list, longest literal first so a URL is masked before its parts. */
export function buildReplacements(sources: { urls: readonly string[]; secrets: readonly string[] }): Replacement[] {
  const byLiteral = new Map<string, string>();
  for (const url of sources.urls) {
    for (const [lit, masked] of urlReplacements(url)) if (!byLiteral.has(lit)) byLiteral.set(lit, masked);
  }
  for (const s of sources.secrets) if (s.length >= MIN_SECRET_LEN) byLiteral.set(s, "***");
  return [...byLiteral.entries()].sort((a, b) => b[0].length - a[0].length);
}

/** Replace every literal in `text`. Plain substring replacement: no regex, no backtracking. */
export function scrubText(text: string, reps: readonly Replacement[]): string {
  let out = text;
  for (const [lit, masked] of reps) if (out.includes(lit)) out = out.split(lit).join(masked);
  return out;
}

/**
 * `scrubText` over every string value and object key of a JSON-ish value.
 * Returns the input itself when nothing changed, so an untouched result keeps
 * its identity. Bounded like `sanitizeDeep`: past the node budget a subtree
 * is returned as is (the response-size cap runs after this and bounds it).
 */
export function scrubDeep<T>(value: T, reps: readonly Replacement[], maxNodes = 500_000): T {
  if (reps.length === 0) return value;
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 64) return v;
    if (typeof v === "string") return scrubText(v, reps);
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
      const k2 = scrubText(k, reps);
      const v2 = walk(val, depth + 1);
      if (k2 !== k || v2 !== val) changed = true;
      out[k2] = v2;
    }
    return changed ? out : v;
  };
  return walk(value, 0) as T;
}

/**
 * Replacements for the current config + env, rebuilt only when an input
 * changes (tests and `serve-http` change env between servers; a tool call
 * must not pay for a rebuild every time).
 */
export function createSecretScrubber(
  config: Pick<ReadConfig, "chains" | "subgraphUrls" | "backendApiUrl"> | undefined,
): () => Replacement[] {
  let cacheKey = "";
  let cached: Replacement[] = [];
  return () => {
    const sources = collectSecretSources(config, process.env);
    const key = JSON.stringify(sources);
    if (key !== cacheKey) {
      cacheKey = key;
      cached = buildReplacements(sources);
    }
    return cached;
  };
}
