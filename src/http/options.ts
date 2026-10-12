/**
 * Options for `dexe-mcp-read serve-http` (the read edition over HTTP; pre-release).
 *
 * Everything comes from CLI flags or process env. Nothing is read from a .env
 * file: the remote server is configured by whoever runs the container, and a
 * stray file in the working directory must never change what a public
 * endpoint does.
 *
 * Parsing is pure (argv + env in, options or a list of errors out) so tests can
 * drive every branch without starting a server. Bad values are startup errors,
 * never silent fallbacks: an operator who sets a rate limit wants that limit.
 */

export interface RateLimitOptions {
  /** Sustained requests per minute per client IP. 0 disables the limiter. */
  perMinute: number;
  /** Bucket size: how many requests a client may make back to back. */
  burst: number;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  /**
   * Hostnames (no port) the Host header may name, lowercase. `null` disables
   * the check (operator passed `*`).
   */
  allowedHosts: readonly string[] | null;
  /**
   * Exact origins (`scheme://host[:port]`, lowercase) a browser `Origin` header
   * may carry. Requests WITHOUT an Origin header (server-to-server clients such
   * as the Claude.ai and ChatGPT backends, curl, SDK clients) are always
   * allowed. `null` allows any origin (operator passed `*`).
   */
  allowedOrigins: readonly string[] | null;
  /**
   * How many reverse-proxy hops in front of this server to trust for
   * `X-Forwarded-For`. 0 = ignore the header and use the socket address.
   */
  trustProxyHops: number;
  maxBodyBytes: number;
  rateLimit: RateLimitOptions;
  /** Concurrent MCP requests across all clients; over it the server answers 503. */
  maxInflight: number;
  /**
   * Budget to RECEIVE the body once headers are in (slow-body guard; 408).
   * A request does not occupy an in-flight slot until its body is complete.
   */
  bodyTimeoutMs: number;
  /** Budget for the MCP work, from a complete body to the response (504). */
  requestTimeoutMs: number;
  /** Budget for the RPC probe behind `/readyz`. */
  readyTimeoutMs: number;
  /** One JSON line per request on stdout. */
  accessLog: boolean;
  /**
   * Start even though the config falls back to the endpoints and API key that
   * ship in the package (shared by every install). Local testing only.
   */
  allowSharedDefaults: boolean;
}

export const HTTP_DEFAULTS = {
  port: 8080,
  host: "127.0.0.1",
  trustProxyHops: 0,
  maxBodyBytes: 256 * 1024,
  rateLimitPerMinute: 300,
  rateLimitBurst: 60,
  maxInflight: 32,
  bodyTimeoutMs: 10_000,
  requestTimeoutMs: 120_000,
  readyTimeoutMs: 3_000,
  /** Node's own limit for receiving the request headers (slow-loris guard). */
  headersTimeoutMs: 15_000,
} as const;

/** Env vars this mode reads. Listed once so the help text and docs cannot drift. */
export const HTTP_ENV_VARS = [
  "PORT",
  "DEXE_HTTP_HOST",
  "DEXE_HTTP_ALLOWED_HOSTS",
  "DEXE_HTTP_ALLOWED_ORIGINS",
  "DEXE_HTTP_TRUST_PROXY",
  "DEXE_HTTP_MAX_BODY_BYTES",
  "DEXE_HTTP_RATE_LIMIT_PER_MIN",
  "DEXE_HTTP_RATE_LIMIT_BURST",
  "DEXE_HTTP_MAX_INFLIGHT",
  "DEXE_HTTP_REQUEST_TIMEOUT_MS",
  "DEXE_HTTP_BODY_TIMEOUT_MS",
  "DEXE_HTTP_READY_TIMEOUT_MS",
  "DEXE_HTTP_ACCESS_LOG",
  "DEXE_HTTP_ALLOW_SHARED_DEFAULTS",
] as const;

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host.trim().toLowerCase());
}

export type ParseResult =
  | { kind: "options"; options: HttpServerOptions }
  | { kind: "help" }
  | { kind: "error"; errors: string[] };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `--port 8080`, `--port=8080`, `--host 0.0.0.0`, `--help`. Unknown flags are
 * errors: a typo such as `--prot` silently falling back to 8080 is exactly the
 * "documented no-op" class of bug the stdio CLI already refuses.
 */
function parseFlags(argv: readonly string[]): { flags: Map<string, string>; help: boolean; errors: string[] } {
  const flags = new Map<string, string>();
  const errors: string[] = [];
  let help = false;
  const known = new Set(["--port", "--host"]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help" || raw === "-h" || raw === "help") {
      help = true;
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    if (!known.has(name)) {
      errors.push(`unknown option '${raw}' (valid: --port <n>, --host <addr>, --help)`);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = raw.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        errors.push(`${name} needs a value`);
        continue;
      }
      i++;
    }
    flags.set(name, value);
  }
  return { flags, help, errors };
}

function intIn(
  label: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) {
    errors.push(`${label} must be a whole number from ${min} to ${max}, got '${raw}'`);
    return fallback;
  }
  const n = Number(t);
  if (n < min || n > max) {
    errors.push(`${label} must be from ${min} to ${max}, got ${n}`);
    return fallback;
  }
  return n;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalise one allowed-host entry to the form the request check compares
 * against: lowercase hostname, no port, IPv6 in brackets. Accepts `host`,
 * `host:port` and a full URL (people paste those).
 */
export function normalizeHostEntry(entry: string): string | null {
  const t = entry.trim().toLowerCase();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `http://${t}`);
    return u.hostname || null;
  } catch {
    return null;
  }
}

/** Origins compare as `scheme://host[:port]`, lowercase, no path or trailing slash. */
export function normalizeOriginEntry(entry: string): string | null {
  const t = entry.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseHttpOptions(argv: readonly string[], env: Env): ParseResult {
  const { flags, help, errors } = parseFlags(argv);
  if (help) return { kind: "help" };

  // 0 = let the OS pick (tests, smoke runs); the bound port is in the startup log.
  const port = intIn("port (--port / PORT)", flags.get("--port") ?? env.PORT, HTTP_DEFAULTS.port, 0, 65535, errors);
  const host = (flags.get("--host") ?? env.DEXE_HTTP_HOST ?? HTTP_DEFAULTS.host).trim() || HTTP_DEFAULTS.host;

  // ── Host allowlist ─────────────────────────────────────────────────────────
  // DNS-rebinding protection. A public bind with no allowlist is refused at
  // startup instead of silently accepting any Host: the operator knows the
  // public hostname, and forgetting it should be loud, not a quiet open door.
  let allowedHosts: string[] | null;
  const hostsRaw = env.DEXE_HTTP_ALLOWED_HOSTS?.trim();
  if (hostsRaw === "*") {
    allowedHosts = null;
  } else if (hostsRaw) {
    allowedHosts = [];
    for (const entry of csv(hostsRaw)) {
      const h = normalizeHostEntry(entry);
      if (h) allowedHosts.push(h);
      else errors.push(`DEXE_HTTP_ALLOWED_HOSTS: '${entry}' is not a hostname`);
    }
  } else if (isLoopbackBind(host)) {
    allowedHosts = [...LOOPBACK_HOSTNAMES];
  } else {
    allowedHosts = [];
    errors.push(
      `DEXE_HTTP_ALLOWED_HOSTS is required when binding to ${host}: set it to the public hostname(s) ` +
        "clients use, e.g. DEXE_HTTP_ALLOWED_HOSTS=mcp.example.com (comma-separated). " +
        "Use * to turn the Host check off (not recommended).",
    );
  }

  // ── Origin allowlist ───────────────────────────────────────────────────────
  let allowedOrigins: string[] | null;
  const originsRaw = env.DEXE_HTTP_ALLOWED_ORIGINS?.trim();
  if (originsRaw === "*") {
    allowedOrigins = null;
  } else {
    allowedOrigins = [];
    for (const entry of csv(originsRaw)) {
      const o = normalizeOriginEntry(entry);
      if (o) allowedOrigins.push(o);
      else errors.push(`DEXE_HTTP_ALLOWED_ORIGINS: '${entry}' is not an origin like https://app.example.com`);
    }
  }

  // ── Proxy trust ────────────────────────────────────────────────────────────
  // `true` means one hop (the usual single reverse proxy / load balancer).
  const tp = env.DEXE_HTTP_TRUST_PROXY?.trim().toLowerCase();
  let trustProxyHops: number = HTTP_DEFAULTS.trustProxyHops;
  if (tp === "true" || tp === "yes") trustProxyHops = 1;
  else if (tp === "false" || tp === "no" || tp === "" || tp === undefined) trustProxyHops = 0;
  else trustProxyHops = intIn("DEXE_HTTP_TRUST_PROXY", tp, 0, 0, 10, errors);

  const maxBodyBytes = intIn(
    "DEXE_HTTP_MAX_BODY_BYTES",
    env.DEXE_HTTP_MAX_BODY_BYTES,
    HTTP_DEFAULTS.maxBodyBytes,
    1024,
    16 * 1024 * 1024,
    errors,
  );
  const perMinute = intIn(
    "DEXE_HTTP_RATE_LIMIT_PER_MIN",
    env.DEXE_HTTP_RATE_LIMIT_PER_MIN,
    HTTP_DEFAULTS.rateLimitPerMinute,
    0,
    1_000_000,
    errors,
  );
  const burst = intIn(
    "DEXE_HTTP_RATE_LIMIT_BURST",
    env.DEXE_HTTP_RATE_LIMIT_BURST,
    HTTP_DEFAULTS.rateLimitBurst,
    1,
    1_000_000,
    errors,
  );
  const maxInflight = intIn(
    "DEXE_HTTP_MAX_INFLIGHT",
    env.DEXE_HTTP_MAX_INFLIGHT,
    HTTP_DEFAULTS.maxInflight,
    1,
    10_000,
    errors,
  );
  const requestTimeoutMs = intIn(
    "DEXE_HTTP_REQUEST_TIMEOUT_MS",
    env.DEXE_HTTP_REQUEST_TIMEOUT_MS,
    HTTP_DEFAULTS.requestTimeoutMs,
    1_000,
    600_000,
    errors,
  );
  const bodyTimeoutMs = intIn(
    "DEXE_HTTP_BODY_TIMEOUT_MS",
    env.DEXE_HTTP_BODY_TIMEOUT_MS,
    HTTP_DEFAULTS.bodyTimeoutMs,
    100,
    120_000,
    errors,
  );
  const readyTimeoutMs = intIn(
    "DEXE_HTTP_READY_TIMEOUT_MS",
    env.DEXE_HTTP_READY_TIMEOUT_MS,
    HTTP_DEFAULTS.readyTimeoutMs,
    100,
    60_000,
    errors,
  );
  const logRaw = env.DEXE_HTTP_ACCESS_LOG?.trim().toLowerCase();
  const accessLog = !(logRaw === "0" || logRaw === "false" || logRaw === "off" || logRaw === "no");
  const sharedRaw = env.DEXE_HTTP_ALLOW_SHARED_DEFAULTS?.trim().toLowerCase();
  const allowSharedDefaults = sharedRaw === "1" || sharedRaw === "true" || sharedRaw === "yes";

  if (errors.length > 0) return { kind: "error", errors };
  return {
    kind: "options",
    options: {
      port,
      host,
      allowedHosts,
      allowedOrigins,
      trustProxyHops,
      maxBodyBytes,
      rateLimit: { perMinute, burst },
      maxInflight,
      bodyTimeoutMs,
      requestTimeoutMs,
      readyTimeoutMs,
      accessLog,
      allowSharedDefaults,
    },
  };
}

/** `dexe-mcp-read serve-http --help`. Says PRE-RELEASE in the first line on purpose. */
export function serveHttpUsage(version: string): string {
  return [
    `dexe-mcp-read ${version} — serve-http (PRE-RELEASE)`,
    "",
    "Serve the read edition (every tool read-only) over MCP Streamable HTTP, stateless, for",
    "remote clients (Claude.ai custom connectors, ChatGPT developer mode, MCP Inspector).",
    "No signing, no uploads, no .env file loading, nothing written to disk.",
    "Pre-release until the connector-directory submission: flags and env names may still change.",
    "",
    "USAGE",
    "  dexe-mcp-read serve-http [--port <n>] [--host <addr>]",
    "  (dexe-mcp serve-http starts the same server)",
    "",
    "ENDPOINTS",
    "  POST /mcp      MCP Streamable HTTP (JSON responses, no sessions); GET/DELETE answer 405",
    "  GET  /healthz  process is up",
    "  GET  /readyz   one RPC call to the default chain, with a timeout",
    "",
    "ENV (process env only)",
    `  PORT                          listen port (default ${HTTP_DEFAULTS.port}; --port wins)`,
    `  DEXE_HTTP_HOST                bind address (default ${HTTP_DEFAULTS.host}; --host wins)`,
    "  DEXE_HTTP_ALLOWED_HOSTS       Host header allowlist, comma-separated; REQUIRED off loopback; * = off",
    "  DEXE_HTTP_ALLOWED_ORIGINS     browser Origin allowlist; requests without Origin always pass; * = any",
    "  DEXE_HTTP_TRUST_PROXY         reverse-proxy hops to trust for X-Forwarded-For (true = 1; default off)",
    `  DEXE_HTTP_MAX_BODY_BYTES      request body cap (default ${HTTP_DEFAULTS.maxBodyBytes})`,
    `  DEXE_HTTP_RATE_LIMIT_PER_MIN  per-IP sustained rate (default ${HTTP_DEFAULTS.rateLimitPerMinute}; 0 = off)`,
    `  DEXE_HTTP_RATE_LIMIT_BURST    per-IP burst (default ${HTTP_DEFAULTS.rateLimitBurst})`,
    `  DEXE_HTTP_MAX_INFLIGHT        concurrent MCP requests before 503 (default ${HTTP_DEFAULTS.maxInflight})`,
    `  DEXE_HTTP_BODY_TIMEOUT_MS     time to receive the body after the headers; 408 (default ${HTTP_DEFAULTS.bodyTimeoutMs})`,
    `  DEXE_HTTP_REQUEST_TIMEOUT_MS  MCP work after the body is in; 504 (default ${HTTP_DEFAULTS.requestTimeoutMs})`,
    `  DEXE_HTTP_READY_TIMEOUT_MS    /readyz RPC budget (default ${HTTP_DEFAULTS.readyTimeoutMs})`,
    "  DEXE_HTTP_ACCESS_LOG          0 turns the JSON access log off",
    "  DEXE_HTTP_ALLOW_SHARED_DEFAULTS  1 = start on the shared built-in RPC/subgraph/backend defaults",
    "                                (LOCAL TESTING ONLY; otherwise set your own endpoints, see below)",
    "  Data sources: DEXE_RPC_URL_MAINNET / _TESTNET, DEXE_SUBGRAPH_{POOLS,VALIDATORS,INTERACTIONS}_URL,",
    "  DEXE_BACKEND_API_URL, IPFS vars — same names as stdio mode (docs/ENVIRONMENT.md).",
    "  Env vars outside the read-server allowlist are removed from the process at startup.",
    "",
    "DOCS  docs/REMOTE.md",
    "",
  ].join("\n");
}
