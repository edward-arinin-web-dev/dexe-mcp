import { DEFAULTS, loadReadConfig, type ReadConfig } from "../configRead.js";
import type { ReadinessProbe, ReadinessResult } from "./server.js";

/**
 * The remote read server's environment: what `dexe-mcp-read serve-http`
 * keeps from the process env before anything reads it, the config it builds
 * from what is left, the refusal to run a public endpoint on the package's
 * shared defaults, and the `/readyz` probe. No `.env` file is ever loaded on
 * this path (src/read/bin.ts dispatches `serve-http` before any env loading).
 */

/**
 * The env the remote read server keeps — an ALLOWLIST. Everything else is
 * deleted from `process.env` before config loads: signing keys, the agent
 * keyring, Pinata/WalletConnect/Safe credentials (`DEXE_SAFE_API_KEY`
 * included), and any unrelated secret the container happens to carry
 * (`AWS_*`, `FOO_SECRET`, …). Nothing loaded later — config, a tool, a
 * dependency — can read them back. A new read-side var must be added here.
 */
const READ_DEXE_ENV: ReadonlySet<string> = new Set([
  // RPC
  "DEXE_RPC_URL",
  "DEXE_CHAIN_ID",
  "DEXE_RPC_URL_MAINNET",
  "DEXE_RPC_URL_TESTNET",
  "DEXE_RPC_TIMEOUT_MS",
  "DEXE_DEFAULT_CHAIN_ID",
  "DEXE_CONTRACTS_REGISTRY",
  "DEXE_DISABLE_PUBLIC_RPC",
  // subgraph + backend
  "DEXE_SUBGRAPH_POOLS_URL",
  "DEXE_SUBGRAPH_VALIDATORS_URL",
  "DEXE_SUBGRAPH_INTERACTIONS_URL",
  "DEXE_SUBGRAPH_CHAIN_ID",
  "DEXE_GRAPH_API_KEY",
  "DEXE_BACKEND_API_URL",
  // IPFS reads (the gateway token authenticates reads from a dedicated gateway)
  "DEXE_IPFS_GATEWAY",
  "DEXE_IPFS_GATEWAYS_FALLBACK",
  "DEXE_IPFS_DISABLE_PUBLIC_FALLBACK",
  "DEXE_PINATA_GATEWAY_TOKEN",
  "DEXE_IPFS_MAX_BYTES",
  // read-tool result size limit
  "DEXE_MAX_RESPONSE_BYTES",
  // analysis knobs used by read tools
  "DEXE_MIN_SAFE_QUORUM_PCT",
  "DEXE_CONTROLLING_TOPN",
  // diagnostics
  "DEXE_DEBUG",
]);
const READ_DEXE_ENV_PATTERNS: readonly RegExp[] = [
  /^DEXE_HTTP_[A-Z0-9_]+$/,
  /^DEXE_RPC_URL_\d+$/,
  /^DEXE_SUBGRAPH_(POOLS|VALIDATORS|INTERACTIONS)_URL_\d+$/,
];
/** Platform and runtime vars (compared upper-case; Windows env names are case-insensitive). */
const RUNTIME_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "HOSTNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "LANGUAGE",
  "PORT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "UV_THREADPOOL_SIZE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  // Windows adds these to every child process (libuv's required set)
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
]);

export function isReadServerEnvKey(key: string): boolean {
  if (/^DEXE_/i.test(key)) return READ_DEXE_ENV.has(key) || READ_DEXE_ENV_PATTERNS.some((re) => re.test(key));
  const upper = key.toUpperCase();
  return RUNTIME_ENV.has(upper) || upper.startsWith("LC_");
}

/** Delete every var outside the allowlist from `env`, in place. Returns how many went. */
export function scrubEnvToReadAllowlist(env: NodeJS.ProcessEnv = process.env): number {
  let removed = 0;
  for (const key of Object.keys(env)) {
    if (!isReadServerEnvKey(key)) {
      delete env[key];
      removed++;
    }
  }
  return removed;
}

export interface RemoteReadConfig {
  config: ReadConfig;
  /** How many env vars outside the allowlist were removed (count only — names can be telling). */
  removedEnvCount: number;
  /** What config loading reported (chains, RPC fallback, rejected values), for the JSON log. */
  configNotes: string[];
}

/**
 * Config for the remote server: process env only (no .env file is loaded —
 * the caller must not have loaded one either), reduced to the read allowlist
 * first, then the read config loader. Nothing here constructs a Wallet: the
 * read loader never reads a signing key, and none is left in the env to read.
 */
export async function loadRemoteReadConfig(env: NodeJS.ProcessEnv = process.env): Promise<RemoteReadConfig> {
  const removedEnvCount = scrubEnvToReadAllowlist(env);
  // loadReadConfig's body is synchronous, so every banner line it prints is
  // written inside this call and captured for the JSON log.
  const { value: pending, captured } = withStderrCaptured(() => loadReadConfig());
  const config = await pending;
  const configNotes = captured
    .split("\n")
    .map((l) => l.replace(/^\[dexe-mcp\]\s*/, "").trim())
    .filter(Boolean);
  return { config, removedEnvCount, configNotes };
}

export interface SharedDefaultUse {
  /** What the config fell back to. */
  what: string;
  /** Env vars that replace it with the operator's own endpoint/key. */
  setVars: string[];
}

/**
 * Where the effective config still runs on what ships inside the package and
 * is shared by every install: the public BSC RPC fallback, the subgraph URLs
 * carrying the baked Graph API key, the default backend. A public server on
 * these burns a credential and quotas that belong to everyone, so
 * `serve-http` refuses to start on them unless the operator opts in.
 * `env` is the post-scrub process env (an explicit DEXE_BACKEND_API_URL counts
 * as the operator's choice even when it names the default host).
 */
export function findSharedDefaults(config: ReadConfig, env: NodeJS.ProcessEnv = process.env): SharedDefaultUse[] {
  const found: SharedDefaultUse[] = [];
  if (config.usingPublicRpcFallback) {
    found.push({
      what: "the public BSC RPC endpoints built into the package (shared, rate-limited)",
      setVars: ["DEXE_RPC_URL_MAINNET", "DEXE_RPC_URL_TESTNET"],
    });
  }
  const bakedKey = /\/api\/([0-9a-f]{32,})\/subgraphs\//i.exec(DEFAULTS.subgraphPoolsUrl)?.[1];
  const bakedKinds = new Set<string>();
  for (const endpoints of config.subgraphUrls.values()) {
    for (const [kind, url] of Object.entries(endpoints)) {
      if (typeof url === "string" && bakedKey && url.includes(bakedKey)) bakedKinds.add(kind.toUpperCase());
    }
  }
  if (bakedKinds.size > 0) {
    found.push({
      what: "subgraph URLs that carry the Graph API key shipped in the package",
      setVars: [...bakedKinds].sort().map((k) => `DEXE_SUBGRAPH_${k}_URL`),
    });
  }
  if (!env.DEXE_BACKEND_API_URL?.trim()) {
    found.push({ what: `the default DeXe backend (${DEFAULTS.backendApiUrl})`, setVars: ["DEXE_BACKEND_API_URL"] });
  }
  return found;
}

/**
 * Run `fn` with stderr captured instead of written: the config loader prints
 * plain banner lines, and the HTTP server's log is JSON lines. It is
 * synchronous, so nothing else can write in between.
 */
function withStderrCaptured<T>(fn: () => T): { value: T; captured: string } {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), captured };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * `/readyz`: one `eth_blockNumber` against the default chain's RPC list,
 * trying fallbacks inside one overall budget. The answer is cached for a few
 * seconds so a load balancer polling every replica cannot turn health checks
 * into RPC load. Never returns or logs the RPC URL (it may carry an API key).
 */
export function createRpcReadinessProbe(
  config: ReadConfig,
  timeoutMs: number,
  opts: { cacheMs?: number; now?: () => number; fetchImpl?: typeof fetch } = {},
): ReadinessProbe {
  const cacheMs = opts.cacheMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  let cached: { at: number; result: ReadinessResult } | undefined;
  let pending: Promise<ReadinessResult> | undefined;

  const probe = async (): Promise<ReadinessResult> => {
    const chainId = config.defaultChainId;
    const chain = config.chains.get(chainId);
    if (!chain || chain.rpcUrls.length === 0) {
      return { ready: false, detail: { chainId, reason: "no RPC configured for the default chain" } };
    }
    const deadline = now() + timeoutMs;
    let reason = "rpc unreachable";
    for (const url of chain.rpcUrls) {
      const left = deadline - now();
      if (left <= 0) {
        reason = "rpc timeout";
        break;
      }
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          signal: AbortSignal.timeout(left),
        });
        if (!res.ok) {
          reason = `rpc http ${res.status}`;
          continue;
        }
        const body = (await res.json()) as { result?: unknown };
        if (typeof body.result === "string" && /^0x[0-9a-f]+$/i.test(body.result)) {
          return { ready: true, detail: { chainId, blockNumber: Number(BigInt(body.result)) } };
        }
        reason = "rpc returned no block number";
      } catch (err) {
        reason = (err as { name?: string }).name === "TimeoutError" ? "rpc timeout" : "rpc unreachable";
      }
    }
    return { ready: false, detail: { chainId, reason } };
  };

  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.result;
    pending ??= probe().finally(() => {
      pending = undefined;
    });
    const result = await pending;
    cached = { at: now(), result };
    return result;
  };
}
