import { resolve as dnsResolve } from "node:dns/promises";
import { existsSync, accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { ENV_REGISTRY, type EnvKey, type EnvEntry, type EnvCategory } from "../env/schema.js";
import { parseEnv } from "../env/parse.js";
import type { DexeConfig } from "../config.js";
import { DEFAULTS } from "../config.js";
import { maskUrl, redactUrlCredentials } from "../lib/redact.js";

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckCategory = EnvCategory | "network" | "process";

export interface CheckResult {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface RunCheckOpts {
  /** When omitted, checks that depend on resolved config are skipped. */
  config?: DexeConfig;
  /** Per-network-check timeout. Defaults to 3000ms. */
  timeoutMs?: number;
}

/**
 * Run every diagnostic check in parallel, gather results.
 *
 * Network checks have a hard timeout that downgrades to `warn`, never `fail` —
 * an offline laptop or VPN flake should not make the doctor scream red.
 */
export async function runAllChecks(opts: RunCheckOpts = {}): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const results: CheckResult[] = [];

  results.push(...envPresenceChecks());

  const network = await Promise.all([
    ...rpcReachabilityChecks(opts.config, timeoutMs),
    pinataJwtCheck(timeoutMs),
    ipfsGatewayDnsCheck(timeoutMs),
    ...subgraphChecks(timeoutMs),
    backendCheck(timeoutMs),
  ]);
  for (const r of network) {
    if (r) results.push(r);
  }

  results.push(...signerGuardConfigCheck());
  results.push(...chainConsistencyCheck(opts.config));
  results.push(...sharedDefaultsCheck(opts.config));
  results.push(...stateStoreCheck(opts.config));

  return results;
}

// ─── persistent state path writability ─────────────────────────────────────

function stateStoreCheck(config: DexeConfig | undefined): CheckResult[] {
  if (!config) return [];
  const p = config.statePath;
  // Probe the nearest existing ancestor for write permission — the default
  // ~/.dexe-mcp dir is created lazily on first write, so it may not exist yet.
  let probe = dirname(p);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    accessSync(probe, constants.W_OK);
    return [{ id: "state.path", category: "process", status: "pass", message: `writable (${p})` }];
  } catch {
    return [
      {
        id: "state.path",
        category: "process",
        status: "warn",
        message: `persistent-state path may not be writable: ${p}`,
        remediation:
          "Set DEXE_STATE_PATH to a writable location. Without it, dexe_context won't persist known DAOs / recent proposals across sessions (tools still work).",
      },
    ];
  }
}

// ─── presence ───────────────────────────────────────────────────────────────

function envPresenceChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const parsed = parseEnv();
  for (const [k, v] of Object.entries(ENV_REGISTRY) as [EnvKey, EnvEntry][]) {
    const set = !!process.env[k]?.trim();
    const issue = parsed.issues.find(i => i.key === k);
    if (issue) {
      out.push({
        id: `env.${k}`,
        category: v.category,
        status: "fail",
        message: issue.message,
        remediation: `Fix ${k} in .env. ${v.doc}`,
      });
    } else if (set) {
      out.push({
        id: `env.${k}`,
        category: v.category,
        status: "pass",
        message: v.secret ? "set (redacted)" : "set",
      });
    } else if (v.required) {
      out.push({
        id: `env.${k}`,
        category: v.category,
        status: "fail",
        message: "not set (required)",
        remediation: `Add ${k}=${v.example} to .env. ${v.doc}`,
      });
    }
    // optional + unset: emit nothing (avoid noise)
  }
  return out;
}

// ─── rpc reachability ──────────────────────────────────────────────────────

function rpcReachabilityChecks(
  config: DexeConfig | undefined,
  timeoutMs: number,
): Promise<CheckResult | null>[] {
  if (!config || config.chains.size === 0) return [];
  const out: Promise<CheckResult | null>[] = [];
  for (const chain of config.chains.values()) {
    out.push(
      (async (): Promise<CheckResult | null> => {
        const res = await fetchJsonWithTimeout(
          chain.rpcUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          },
          timeoutMs,
        );
        if (res.kind === "timeout") {
          return {
            id: `rpc.reachable.${chain.chainId}`,
            category: "network",
            status: "warn",
            message: `RPC ${maskUrl(chain.rpcUrl)} timed out after ${timeoutMs}ms`,
            remediation:
              "Check connectivity. If intermittent, ignore. Otherwise pick a different RPC at https://chainlist.org.",
          };
        }
        if (res.kind === "error") {
          return {
            id: `rpc.reachable.${chain.chainId}`,
            category: "network",
            status: "fail",
            message: `RPC ${maskUrl(chain.rpcUrl)} unreachable: ${redactUrlCredentials(String(res.error))}`,
            remediation:
              "Replace the RPC URL. Browse alternatives at https://chainlist.org and restart the MCP.",
          };
        }
        const expected = `0x${chain.chainId.toString(16)}`;
        const got = (res.body as { result?: string } | undefined)?.result;
        if (got !== expected) {
          return {
            id: `rpc.reachable.${chain.chainId}`,
            category: "network",
            status: "fail",
            message: `RPC returned chainId=${got ?? "?"} but configured chainId=${chain.chainId}`,
            remediation: `RPC at ${maskUrl(chain.rpcUrl)} is for the wrong chain. Replace it.`,
          };
        }
        return {
          id: `rpc.reachable.${chain.chainId}`,
          category: "network",
          status: "pass",
          message: `eth_chainId=${chain.chainId} (${maskUrl(chain.rpcUrl)})`,
        };
      })(),
    );
  }
  return out;
}

// ─── pinata jwt ──────────────────────────────────────────────────────────

async function pinataJwtCheck(timeoutMs: number): Promise<CheckResult | null> {
  const jwt = process.env.DEXE_PINATA_JWT?.trim();
  if (!jwt) return null;
  const res = await fetchJsonWithTimeout(
    "https://api.pinata.cloud/data/testAuthentication",
    { method: "GET", headers: { Authorization: `Bearer ${jwt}` } },
    timeoutMs,
  );
  if (res.kind === "timeout") {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "warn",
      message: `Pinata auth check timed out (${timeoutMs}ms)`,
    };
  }
  if (res.kind === "error") {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "fail",
      message: `Pinata reachability: ${res.error}`,
    };
  }
  if (res.status >= 400) {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "fail",
      message: `Pinata testAuthentication returned HTTP ${res.status}`,
      remediation:
        "Regenerate the JWT at https://app.pinata.cloud/developers/api-keys with `pinning` scope and update DEXE_PINATA_JWT.",
    };
  }
  return { id: "pinata.jwt", category: "ipfs", status: "pass", message: "authenticated" };
}

// ─── ipfs gateway dns ──────────────────────────────────────────────────────

async function ipfsGatewayDnsCheck(timeoutMs: number): Promise<CheckResult | null> {
  const gw = process.env.DEXE_IPFS_GATEWAY?.trim();
  if (!gw) return null;
  let host: string;
  try {
    host = new URL(gw).hostname;
  } catch {
    return {
      id: "ipfs.gateway.dns",
      category: "ipfs",
      status: "fail",
      message: "DEXE_IPFS_GATEWAY is not a valid URL",
      remediation: "Use the form https://<subdomain>.mypinata.cloud",
    };
  }
  try {
    await Promise.race([
      dnsResolve(host),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    return {
      id: "ipfs.gateway.dns",
      category: "ipfs",
      status: "pass",
      message: `resolved ${host}`,
    };
  } catch (err) {
    return {
      id: "ipfs.gateway.dns",
      category: "ipfs",
      status: "fail",
      message: `DNS lookup for ${host} failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Check the hostname in DEXE_IPFS_GATEWAY. Pinata dedicated gateways follow https://<subdomain>.mypinata.cloud.",
    };
  }
}

// ─── subgraph reachability ─────────────────────────────────────────────────

function subgraphChecks(timeoutMs: number): Promise<CheckResult | null>[] {
  const out: Promise<CheckResult | null>[] = [];
  const targets: Array<{ key: "DEXE_SUBGRAPH_POOLS_URL" | "DEXE_SUBGRAPH_VALIDATORS_URL" | "DEXE_SUBGRAPH_INTERACTIONS_URL"; id: string }> = [
    { key: "DEXE_SUBGRAPH_POOLS_URL", id: "subgraph.pools" },
    { key: "DEXE_SUBGRAPH_VALIDATORS_URL", id: "subgraph.validators" },
    { key: "DEXE_SUBGRAPH_INTERACTIONS_URL", id: "subgraph.interactions" },
  ];
  const apiKey = process.env.DEXE_GRAPH_API_KEY?.trim();
  // Baked defaults (key embedded in the URL path) so the doctor validates the
  // endpoints that reads actually use when the operator sets none.
  const DEFAULT_SUBGRAPH_URLS: Record<string, string> = {
    DEXE_SUBGRAPH_POOLS_URL: DEFAULTS.subgraphPoolsUrl,
    DEXE_SUBGRAPH_VALIDATORS_URL: DEFAULTS.subgraphValidatorsUrl,
    DEXE_SUBGRAPH_INTERACTIONS_URL: DEFAULTS.subgraphInteractionsUrl,
  };
  for (const t of targets) {
    const url = process.env[t.key]?.trim() || DEFAULT_SUBGRAPH_URLS[t.key];
    if (!url) continue;
    out.push(
      (async (): Promise<CheckResult | null> => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetchJsonWithTimeout(
          url,
          { method: "POST", headers, body: JSON.stringify({ query: "{ __typename }" }) },
          timeoutMs,
        );
        if (res.kind === "timeout") {
          return {
            id: `${t.id}.reachable`,
            category: "network",
            status: "warn",
            message: `${t.key} timed out`,
          };
        }
        if (res.kind === "error") {
          return {
            id: `${t.id}.reachable`,
            category: "network",
            status: "fail",
            message: `${t.key}: ${res.error}`,
          };
        }
        if (res.status >= 400) {
          return {
            id: `${t.id}.reachable`,
            category: "network",
            status: "fail",
            message: `${t.key} returned HTTP ${res.status}`,
            remediation:
              "Check the URL and DEXE_GRAPH_API_KEY (decentralized gateway requires Bearer auth).",
          };
        }
        return {
          id: `${t.id}.reachable`,
          category: "network",
          status: "pass",
          message: "ok",
        };
      })(),
    );
  }
  return out;
}

// ─── backend ─────────────────────────────────────────────────────────────

async function backendCheck(timeoutMs: number): Promise<CheckResult | null> {
  // Defaults to https://api.dexe.io so the doctor validates the endpoint reads
  // actually use when the operator sets none.
  const url = process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl;
  const target = url.replace(/\/+$/, "") + "/";
  const res = await fetchJsonWithTimeout(target, { method: "GET" }, timeoutMs);
  if (res.kind === "timeout") {
    return {
      id: "backend.reachable",
      category: "network",
      status: "warn",
      message: `${url} timed out`,
    };
  }
  if (res.kind === "error") {
    return {
      id: "backend.reachable",
      category: "network",
      status: "fail",
      message: `${url}: ${res.error}`,
    };
  }
  return {
    id: "backend.reachable",
    category: "network",
    status: "pass",
    message: `HTTP ${res.status}`,
  };
}

// ─── signer broadcast guards ─────────────────────────────────────────────

function signerGuardConfigCheck(): CheckResult[] {
  const out: CheckResult[] = [];

  // Advisory: a hot key is the active signer. Warn (never fail) and steer to
  // WalletConnect, where the phone signs and the key never touches disk.
  if (process.env.DEXE_PRIVATE_KEY?.trim()) {
    out.push({
      id: "signer.hotKey",
      category: "signer",
      status: "warn",
      message:
        "⚠️ NOT SAFE — DEXE_PRIVATE_KEY is the active signer: a hot key in plaintext on disk.",
      remediation:
        "Prefer WalletConnect: unset DEXE_PRIVATE_KEY and run dexe_wc_connect (the phone signs, key never on disk). If you must keep a hot key, use only a throwaway/test wallet.",
    });
  }

  const allow = process.env.DEXE_SIGNER_ALLOWLIST?.trim();
  if (allow) {
    const entries = allow.split(",").map(s => s.trim()).filter(Boolean);
    const bad = entries.filter(e => !/^0x[0-9a-fA-F]{40}$/.test(e));
    if (bad.length) {
      out.push({
        id: "signer.allowlist",
        category: "signer",
        status: "fail",
        message: `invalid address(es): ${bad.join(", ")}`,
      });
    } else {
      out.push({
        id: "signer.allowlist",
        category: "signer",
        status: "pass",
        message: `${entries.length} addr(s) allowed`,
      });
    }
  }

  const maxV = process.env.DEXE_SIGNER_MAX_VALUE_WEI?.trim();
  if (maxV) {
    try {
      BigInt(maxV);
      out.push({
        id: "signer.maxValue",
        category: "signer",
        status: "pass",
        message: `cap=${maxV} wei`,
      });
    } catch {
      out.push({
        id: "signer.maxValue",
        category: "signer",
        status: "fail",
        message: `not a wei integer: ${maxV}`,
      });
    }
  }

  const rate = process.env.DEXE_SIGNER_MAX_BROADCASTS_PER_MIN?.trim();
  if (rate) {
    const n = Number(rate);
    if (Number.isInteger(n) && n > 0) {
      out.push({
        id: "signer.rate",
        category: "signer",
        status: "pass",
        message: `${n}/min`,
      });
    } else {
      out.push({
        id: "signer.rate",
        category: "signer",
        status: "fail",
        message: `not a positive int: ${rate}`,
      });
    }
  }

  return out;
}

// ─── chain consistency ───────────────────────────────────────────────────

function chainConsistencyCheck(config: DexeConfig | undefined): CheckResult[] {
  if (!config) return [];
  const out: CheckResult[] = [];
  if (process.env.DEXE_PRIVATE_KEY?.trim() && config.chains.size === 0) {
    out.push({
      id: "chain.signerNeedsRpc",
      category: "signer",
      status: "fail",
      message: "DEXE_PRIVATE_KEY is set but no RPC is configured — broadcasts will fail.",
      remediation: "Set DEXE_RPC_URL_TESTNET or DEXE_RPC_URL_MAINNET in .env.",
    });
  }
  if (config.usingPublicRpcFallback) {
    out.push({
      id: "chain.publicRpcFallback",
      category: "rpc",
      status: "warn",
      message:
        "No RPC configured — using public BSC fallback (chains 56 + 97, default 56). Reads work; public dataseed nodes rate-limit and lack archive history.",
      remediation:
        "Set DEXE_RPC_URL_MAINNET (and DEXE_RPC_URL_TESTNET) for reliability, or DEXE_DISABLE_PUBLIC_RPC=1 to turn the fallback off.",
    });
  }
  if (config.chains.size > 0) {
    const ids = [...config.chains.keys()].sort((a, b) => a - b);
    out.push({
      id: "chain.consistency",
      category: "rpc",
      status: "pass",
      message: `defaultChainId=${config.defaultChainId} in configured=[${ids.join(", ")}]`,
    });
  }
  return out;
}

// ─── shared public-default advisory ──────────────────────────────────────

/**
 * Warn (never fail) when read surfaces run on the shared PUBLIC defaults rather
 * than the operator's own keys/endpoints. Fine for light use, but the Graph key
 * is billable-shared and the endpoints rate-limit — heavy users should bring
 * their own. Purely advisory.
 */
function sharedDefaultsCheck(config: DexeConfig | undefined): CheckResult[] {
  if (!config) return [];
  const shared: string[] = [];
  if (config.subgraphPoolsUrl === DEFAULTS.subgraphPoolsUrl) shared.push("subgraph (shared Graph API key)");
  if (config.walletConnectProjectId === DEFAULTS.walletConnectProjectId) shared.push("WalletConnect project id");
  if (config.backendApiUrl === DEFAULTS.backendApiUrl) shared.push("backend API");
  if (shared.length === 0) return [];
  return [
    {
      id: "env.sharedDefaults",
      category: "core",
      status: "warn",
      message: `Using shared public defaults for: ${shared.join(", ")}. Fine for light use; rate-limited and billable-shared.`,
      remediation:
        "For production / heavy use set your own: your DEXE_SUBGRAPH_*_URL (with your Graph key, or DEXE_GRAPH_API_KEY) and DEXE_WALLETCONNECT_PROJECT_ID. Run /dexe-setup for a guided walkthrough. See docs/ENVIRONMENT.md.",
    },
  ];
}

// ─── fetch helper with bounded timeout ──────────────────────────────────

type FetchOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "error"; error: string }
  | { kind: "timeout" };

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    let body: unknown = undefined;
    try {
      body = await r.json();
    } catch {
      // not json — ignore
    }
    return { kind: "ok", status: r.status, body };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return { kind: "timeout" };
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
