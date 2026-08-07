import { resolve as dnsResolve } from "node:dns/promises";
import { existsSync, accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import {
  ENV_REGISTRY,
  DYNAMIC_PER_CHAIN_RPC_RE,
  PER_CHAIN_SUBGRAPH_URL_RE,
  type EnvKey,
  type EnvEntry,
  type EnvCategory,
} from "../env/schema.js";
import { parseEnv } from "../env/parse.js";
import { getEnvLoadState, type EnvLoadReport, type EnvSourceState } from "../env/loader.js";
import type { DexeConfig, SubgraphKind } from "../config.js";
import {
  DEFAULTS,
  DEFAULT_SUBGRAPH_CHAIN_ID,
  SUBGRAPH_KINDS,
  resolveSubgraphEndpoints,
  subgraphEnvVar,
} from "../config.js";
import { extractGraphApiKey, isTrustedGraphHost } from "../lib/subgraph.js";
import { maskUrl, redactUrlCredentials } from "../lib/redact.js";
import { safeErrorMessage } from "../lib/redact.js";

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
  /**
   * Ceiling for the whole network phase, however many probes it fans out to.
   * Defaults to `timeoutMs * 4` (so 12s at the 3s default).
   */
  networkBudgetMs?: number;
  /** Override the recorded `.env` resolution. Defaults to what this process loaded. */
  envSource?: EnvSourceState;
}

/**
 * Run every diagnostic check in parallel, gather results.
 *
 * Network checks have a hard timeout that downgrades to `warn`, never `fail` —
 * an offline laptop or VPN flake should not make the doctor scream red.
 */
/** Sentinel for "the deadline won" — distinct from any legitimate result. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Resolve `p`, or `TIMED_OUT` after `ms`. The abandoned promise keeps running
 * to completion in the background; every probe it contains is individually
 * bounded and writes to nothing, so letting it finish unobserved is harmless
 * and cheaper than threading an AbortSignal through every check.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAllChecks(opts: RunCheckOpts = {}): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const results: CheckResult[] = [];

  const envSource = opts.envSource ?? getEnvLoadState();
  // Loudest first: a degraded startup or an unloaded .env explains most of
  // what follows.
  results.push(...startupIssueChecks(opts.config, envSource));
  results.push(...envSourceChecks(envSource));
  results.push(...envPresenceChecks());

  // Every probe below already carries its own `timeoutMs`, but the number of
  // probes now scales with configuration — 0.30.2 made the subgraph check run
  // per chain per kind, so a multi-chain install fans out. An overall deadline
  // keeps doctor's total cost bounded no matter how many endpoints are
  // configured, and matters most in the case doctor exists for: a user whose
  // environment is broken, where several probes are simultaneously slow.
  // A doctor that hangs is a doctor that cannot diagnose the hang.
  // Proportional to the per-probe timeout on purpose: a caller that asks for
  // fast probes (tests, a scripted health check) gets a fast ceiling too. A
  // fixed floor here would make `timeoutMs: 100` mean "up to 12 seconds", which
  // is exactly the surprise this guard is meant to remove.
  const networkBudgetMs = opts.networkBudgetMs ?? timeoutMs * 4;
  const network = await withDeadline(
    Promise.all([
      ...rpcReachabilityChecks(opts.config, timeoutMs),
      pinataJwtCheck(timeoutMs),
      pinataPinQuotaCheck(timeoutMs),
      ipfsGatewayDnsCheck(timeoutMs),
      ...subgraphChecks(opts.config, timeoutMs),
      backendCheck(timeoutMs),
    ]),
    networkBudgetMs,
  );
  if (network === TIMED_OUT) {
    results.push({
      id: "network.probes",
      category: "network",
      status: "warn",
      message: `reachability probes exceeded the ${networkBudgetMs}ms budget and were abandoned — the checks above are complete, the network ones are not.`,
      remediation:
        "Usually a blackholing endpoint or DNS. Re-run with a larger budget, or set DEXE_RPC_TIMEOUT_MS / your own DEXE_RPC_URL_* and DEXE_SUBGRAPH_*_URL to skip the slow endpoint.",
    });
  } else {
    for (const r of network) {
      if (r) results.push(r);
    }
  }

  results.push(...subgraphCoverageCheck(opts.config));
  results.push(...signerGuardConfigCheck(opts.config));
  results.push(...chainConsistencyCheck(opts.config));
  results.push(...sharedDefaultsCheck(opts.config));
  results.push(...stateStoreCheck(opts.config));

  return results;
}

// ─── degraded startup (config fell back instead of exiting) ────────────────

/**
 * Report every env value `loadConfig` rejected. Since 0.30.1 a bad value
 * degrades to its documented default instead of killing the server — an
 * invisible downgrade if doctor stayed green, so each one is a hard `fail`
 * here. A degraded config and a green doctor must not be reachable.
 */
export function startupIssueChecks(
  config: DexeConfig | undefined,
  envSource?: EnvSourceState,
): CheckResult[] {
  if (!config) return [];
  const where = loadedEnvPath(envSource) ?? "your .env";
  if (config.startupIssues.length === 0) {
    return [
      {
        id: "startup.config",
        category: "process",
        status: "pass",
        message: "every env value parsed — nothing was rejected at startup",
      },
    ];
  }
  return config.startupIssues.map(issue => ({
    id: `startup.${issue.key}`,
    category: categoryForKey(issue.key),
    status: "fail" as const,
    message: `${issue.message} The server did NOT exit: ${issue.fallback}.`,
    remediation: `Correct ${issue.key} in ${where}, then restart Claude Code — env is read once, at startup.`,
  }));
}

function categoryForKey(key: string): CheckCategory {
  const entry = (ENV_REGISTRY as Record<string, EnvEntry | undefined>)[key];
  if (entry) return entry.category;
  // The per-chain families carry an open-ended chain-id suffix, so they cannot
  // be enumerated in ENV_SPEC and have no entry to read a category from. Without
  // these, a rejected DEXE_SUBGRAPH_POOLS_URL_97 files under "process" — nowhere
  // near the subgraph rows the user is reading to work out what broke.
  if (PER_CHAIN_SUBGRAPH_URL_RE.test(key)) return "subgraph";
  if (DYNAMIC_PER_CHAIN_RPC_RE.test(key)) return "rpc";
  // Family names (`DEXE_AGENT_PK_*`) have no registry entry of their own.
  if (key.includes("SIGNER") || key.includes("AGENT_PK") || key.includes("PRIVATE_KEY")) {
    return "signer";
  }
  return "process";
}

// ─── which .env was loaded, and what shadows it ────────────────────────────

/** The file that supplied values, if any. */
function winningReport(state: EnvSourceState | undefined): EnvLoadReport | undefined {
  const existing = state?.reports.filter(r => r.envFileExists) ?? [];
  return existing.find(r => r.envFileLoaded) ?? existing[0];
}

function loadedEnvPath(state: EnvSourceState | undefined): string | undefined {
  return winningReport(state)?.envFilePath;
}

function summarizeKeys(keys: string[], max = 12): string {
  return keys.length <= max
    ? keys.join(", ")
    : `${keys.slice(0, max).join(", ")} +${keys.length - max} more`;
}

/**
 * Answer the question CLAUDE.md, docs/SETUP.md and the `/dexe-setup` skill all
 * tell an assisting AI to ask first: which `.env` did this server actually
 * load, and is anything overriding it? `process.loadEnvFile` never overrides a
 * pre-set key, so an MCP host `env` block silently wins over the file the user
 * is editing — the "I changed .env and nothing happened" trap.
 */
export function envSourceChecks(state: EnvSourceState | undefined): CheckResult[] {
  const out: CheckResult[] = [];
  if (!state || (state.candidates.length === 0 && state.reports.length === 0)) {
    return [
      {
        id: "env.file",
        category: "process",
        status: "warn",
        message:
          ".env resolution was not recorded — these checks are running outside the server's startup path, so the file list below would be a guess.",
        remediation:
          "Run `npx dexe-mcp doctor`, or call dexe_doctor inside Claude Code, to see what the server itself loaded.",
      },
    ];
  }

  const winner = winningReport(state);
  const last = state.reports[state.reports.length - 1];

  if (!winner) {
    const hostKeys = last?.preExistingVars ?? [];
    out.push({
      id: "env.file",
      category: "process",
      status: "warn",
      message:
        `no .env file exists — tried, in order: ${state.candidates.join(" → ")}. ` +
        (hostKeys.length
          ? `Every DEXE_* value comes from the MCP host env block instead (${summarizeKeys(hostKeys)}).`
          : "Reads still work zero-config; signing and IPFS uploads do not."),
      remediation:
        "Create one with `npx dexe-mcp init` (writes ~/.dexe-mcp/.env), or set DEXE_ENV_FILE to an absolute path, then restart Claude Code. Editing a .env at any other location — including a repo checkout the server is not launched from — has no effect.",
    });
  } else {
    out.push({
      id: "env.file",
      category: "process",
      status: "pass",
      message:
        `loaded ${winner.envFilePath} — ${winner.keysApplied.length} key(s) applied` +
        (winner.keysApplied.length ? `: ${summarizeKeys(winner.keysApplied)}` : "") +
        ` (Node ${winner.loadedNodeVersion})`,
      remediation: `Edit THIS file for env changes: ${winner.envFilePath}. Restart Claude Code afterwards.`,
    });

    const alsoPresent = state.reports.filter(r => r.envFileExists && r !== winner);
    if (alsoPresent.length) {
      out.push({
        id: "env.file.precedence",
        category: "process",
        status: "warn",
        message: `${alsoPresent.length} lower-precedence .env file(s) also exist and lost: ${alsoPresent
          .map(r => r.envFilePath)
          .join(", ")}. Keys already set by ${winner.envFilePath} are ignored in them.`,
        remediation: `Keep one file. Edit ${winner.envFilePath}, or delete/rename the others, then restart Claude Code.`,
      });
    }

    if (winner.keysShadowed.length) {
      out.push({
        id: "env.shadowedKeys",
        category: "process",
        status: "warn",
        message:
          `${winner.keysShadowed.length} key(s) in ${winner.envFilePath} were SHADOWED by values already in the environment: ` +
          `${summarizeKeys(winner.keysShadowed)}. process.loadEnvFile does not override pre-set keys, so editing them in that file changes nothing.`,
        remediation: `Remove those keys from the MCP host \`env\` block (the \`env\` object in .claude.json / your MCP client config) — or change their values there instead — then restart Claude Code.`,
      });
    }
  }

  // Raw-byte traps: BOM, missing trailing newline, spaces around `=`.
  state.reports
    .filter(r => r.envFileExists)
    .forEach((r, i) => {
      for (const issue of r.parseIssues) {
        out.push({
          id: i === 0 ? `env.parse.${issue.trap}` : `env.parse.${issue.trap}.${i}`,
          category: "process",
          status: issue.severity,
          message: issue.message,
          remediation: issue.remediation,
        });
      }
    });

  if (last?.unknownDexeVars.length) {
    out.push({
      id: "env.unknownVars",
      category: "process",
      status: "warn",
      message: `unrecognized DEXE_* var(s): ${summarizeKeys(
        last.unknownDexeVars,
      )} — nothing reads them (a typo silently disables the feature you set it for).`,
      remediation: `Check the spelling against docs/ENVIRONMENT.md, fix or delete the line in ${
        loadedEnvPath(state) ?? "your .env"
      }, then restart Claude Code.`,
    });
  }

  return out;
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

// ─── pinata pin quota ─────────────────────────────────────────────────────
//
// F3: testAuthentication stays green while the account is blocked for plan
// usage ("Account blocked due to plan usage limit" → HTTP 403 on every pin).
// Probe the ACTUAL pin capability with a tiny deterministic JSON pin — the
// same content re-pins to the same CID, so repeated doctors add no clutter.
async function pinataPinQuotaCheck(timeoutMs: number): Promise<CheckResult | null> {
  const jwt = process.env.DEXE_PINATA_JWT?.trim();
  if (!jwt) return null;
  const res = await fetchJsonWithTimeout(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pinataContent: { probe: "dexe-mcp-doctor-pin-quota" },
        pinataMetadata: { name: "dexe-mcp-doctor-probe" },
      }),
    },
    timeoutMs,
  );
  if (res.kind === "timeout") {
    return { id: "pinata.pinQuota", category: "ipfs", status: "warn", message: `Pin-quota probe timed out (${timeoutMs}ms)` };
  }
  if (res.kind === "error") {
    return { id: "pinata.pinQuota", category: "ipfs", status: "warn", message: `Pin-quota probe unreachable: ${res.error}` };
  }
  if (res.status >= 400) {
    const body = typeof res.body === "string" ? res.body.slice(0, 200) : JSON.stringify(res.body ?? "").slice(0, 200);
    return {
      id: "pinata.pinQuota",
      category: "ipfs",
      status: "fail",
      message: `Pinata pin probe returned HTTP ${res.status}: ${body}`,
      remediation:
        "The JWT authenticates but pinning is blocked (typically the free-plan usage limit). " +
        "Free up pins / upgrade the plan at app.pinata.cloud, or rotate to a different account's JWT. " +
        "Every IPFS-write flow (proposal creation, DAO deploy metadata, uploads) is down until this passes.",
    };
  }
  return { id: "pinata.pinQuota", category: "ipfs", status: "pass", message: "pin capability verified (tiny probe pin)" };
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
      message: `DNS lookup for ${host} failed: ${safeErrorMessage(err)}`,
      remediation:
        "Check the hostname in DEXE_IPFS_GATEWAY. Pinata dedicated gateways follow https://<subdomain>.mypinata.cloud.",
    };
  }
}

// ─── subgraph health ───────────────────────────────────────────────────────

/**
 * Every Graph subgraph exposes `_meta`. Asking for it costs the same round-trip
 * as the old `{ __typename }` and answers the two things `__typename` cannot:
 * how far the indexer has actually got, and whether it hit an indexing error.
 * A subgraph that is reachable but tens of thousands of blocks behind serves
 * stale rows with no outward sign — invisible until this probe reports it.
 */
export const SUBGRAPH_PROBE_QUERY = "{ _meta { block { number } hasIndexingErrors } }";

/**
 * Lag past which stale reads stop being a rounding error. ~1000 BSC blocks is
 * roughly 50 minutes — long enough that a proposal created since then is
 * simply absent from every subgraph-backed answer.
 */
const SUBGRAPH_LAG_WARN_BLOCKS = 1000n;

/** One endpoint to probe, and the single chain it indexes. */
export interface SubgraphProbeTarget {
  kind: SubgraphKind;
  /** The chain this endpoint indexes — a subgraph indexes exactly one. */
  chainId: number;
  url: string;
}

/**
 * Probe every configured (chain, kind) endpoint. Endpoints are per-chain since
 * 0.30.2, so a single global verdict would be a lie the moment the operator
 * configures a second chain: each result names the chain it speaks for.
 */
function subgraphChecks(
  config: DexeConfig | undefined,
  timeoutMs: number,
): Promise<CheckResult | null>[] {
  // Without a config (doctor run outside the server's startup path) resolve the
  // same way `loadConfig` does, so the endpoints probed are the ones reads use.
  const urls = config?.subgraphUrls ?? resolveSubgraphEndpoints(process.env).urls;
  // One head lookup per chain, shared by that chain's three endpoints.
  const heads = new Map<number, Promise<bigint | undefined>>();
  const out: Promise<CheckResult | null>[] = [];
  for (const [chainId, endpoints] of urls) {
    for (const kind of SUBGRAPH_KINDS) {
      const url = endpoints[kind];
      if (!url) continue;
      if (!heads.has(chainId)) heads.set(chainId, chainHeadBlock(config, chainId, timeoutMs));
      out.push(probeSubgraph({ kind, chainId, url }, heads.get(chainId)!, timeoutMs));
    }
  }
  return out;
}

/**
 * Say — before any read is attempted — that the default chain has no indexer.
 * Since 0.30.2 a subgraph read for an unindexed chain errors instead of quietly
 * answering from BSC mainnet, which is the right behavior and also a surprise:
 * doctor names it up front, with the two ways out.
 */
export function subgraphCoverageCheck(config: DexeConfig | undefined): CheckResult[] {
  if (!config) return [];
  const target = config.defaultChainId;
  const endpoints = config.subgraphUrls.get(target);
  const missing = SUBGRAPH_KINDS.filter(k => !endpoints?.[k]);
  if (missing.length === 0) {
    return [
      {
        id: "subgraph.coverage",
        category: "subgraph",
        status: "pass",
        message: `all ${SUBGRAPH_KINDS.length} subgraphs configured for the default chain ${target}`,
      },
    ];
  }
  const elsewhere = [...config.subgraphUrls.keys()].filter(c => c !== target).sort((a, b) => a - b);
  return [
    {
      id: "subgraph.coverage",
      category: "subgraph",
      status: "warn",
      message:
        `no ${missing.join("/")} subgraph for the DEFAULT chain ${target}` +
        (elsewhere.length ? ` (endpoints exist for chain(s): ${elsewhere.join(", ")})` : "") +
        ` — subgraph-backed reads default to chain ${target} and will report that, rather than return another chain's rows.`,
      remediation:
        (elsewhere.length
          ? `Pass chainId: ${elsewhere[0]} on those tools to read an indexed chain, or `
          : "") +
        `set ${missing.map(k => subgraphEnvVar(k, target)).join(" / ")} to your own indexer and restart. ` +
        `Or read chain ${target} on-chain instead: dexe_read_gov_state / dexe_proposal_list / dexe_read_multicall need no subgraph.`,
    },
  ];
}

async function probeSubgraph(
  target: SubgraphProbeTarget,
  headBlock: Promise<bigint | undefined>,
  timeoutMs: number,
): Promise<CheckResult> {
  const [res, head] = await Promise.all([
    fetchJsonWithTimeout(
      target.url,
      {
        method: "POST",
        headers: graphProbeHeaders(target.url),
        body: JSON.stringify({ query: SUBGRAPH_PROBE_QUERY }),
      },
      timeoutMs,
    ),
    headBlock,
  ]);
  return interpretSubgraphProbe(target, res, { timeoutMs, headBlock: head });
}

/**
 * The exact `Authorization` decision `gqlRequest` (src/lib/subgraph.ts) makes.
 * Duplicated rather than shared because that module owns query transport, not
 * diagnostics — but it must stay in step: probing with different credentials
 * than reads send is precisely how doctor ends up green while every read fails.
 */
function graphProbeHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const extracted = extractGraphApiKey(url);
  // `??`, not `||` — gqlRequest uses `??`, so an EMPTY DEXE_GRAPH_API_KEY makes
  // reads send no Authorization at all. `||` would fall through to the URL's own
  // key here and probe with credentials the reads never send: doctor green,
  // every read 401. Same operator, same header, or this check lies.
  const key = process.env.DEXE_GRAPH_API_KEY?.trim() ?? extracted;
  const keyAlreadyInUrl = extracted !== undefined && key === extracted;
  if (key && (keyAlreadyInUrl || isTrustedGraphHost(url))) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Current head of `chainId`, or undefined when it can't be established. */
async function chainHeadBlock(
  config: DexeConfig | undefined,
  chainId: number,
  timeoutMs: number,
): Promise<bigint | undefined> {
  const chain = config?.chains.get(chainId);
  if (!chain) return undefined;
  const res = await fetchJsonWithTimeout(
    chain.rpcUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    },
    timeoutMs,
  );
  if (res.kind !== "ok" || res.status >= 400) return undefined;
  const result = (res.body as { result?: unknown } | undefined)?.result;
  if (typeof result !== "string") return undefined;
  try {
    // Block heights stay bigint end-to-end — a lag figure that rounded would be
    // a diagnostic nobody can trust.
    return BigInt(result);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The gateway's own refusal text, joined; undefined when there is none. */
function graphqlErrorMessages(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const msgs = errors.map(e =>
    isRecord(e) && typeof e.message === "string" ? e.message : JSON.stringify(e),
  );
  return redactUrlCredentials(msgs.join("; ")).slice(0, 300);
}

/** `data._meta.block.number` as a bigint. Undefined when absent or unusable. */
function metaBlockNumber(meta: Record<string, unknown>): bigint | undefined {
  const block = isRecord(meta.block) ? meta.block.number : undefined;
  if (typeof block === "bigint") return block;
  // GraphQL Int arrives as a JS number; refuse anything that lost precision
  // rather than reporting a block height that is quietly wrong.
  if (typeof block === "number") return Number.isSafeInteger(block) ? BigInt(block) : undefined;
  if (typeof block === "string" && /^\d+$/.test(block)) return BigInt(block);
  return undefined;
}

function subgraphRemediation(target: SubgraphProbeTarget): string {
  return (
    `Fix ${subgraphEnvVar(target.kind, target.chainId)} — that is the endpoint doctor just probed for chain ${target.chainId} ` +
    `(the unsuffixed DEXE_SUBGRAPH_${target.kind.toUpperCase()}_URL covers only the chain named by DEXE_SUBGRAPH_CHAIN_ID). ` +
    `Then restart Claude Code — env is read once, at startup.\n` +
    `Auth: DEXE_GRAPH_API_KEY, when set, OVERRIDES the key embedded in the DEXE_SUBGRAPH_*_URL path. ` +
    `A key that doesn't match that URL's subscription is refused by the gateway with HTTP 200 + an errors array — ` +
    `unset DEXE_GRAPH_API_KEY to use the URL's own key, or replace the URL with one issued for your key.`
  );
}

/**
 * Turn one probe response into a verdict.
 *
 * Split out from the fetch so the failure modes are testable without a network:
 * the one that matters is HTTP 200 carrying `errors`. The Graph gateway answers
 * a rejected query — dead subgraph id, unpaid or mismatched API key, removed
 * deployment — with 200 and the refusal in the body. Judging on status alone
 * reported those endpoints as healthy while every subgraph read failed, sending
 * the user to debug the wrong thing.
 *
 * Exported for tests and kept pure.
 */
export function interpretSubgraphProbe(
  target: SubgraphProbeTarget,
  outcome: FetchOutcome,
  opts: { timeoutMs?: number; headBlock?: bigint } = {},
): CheckResult {
  const id = `subgraph.${target.kind}.${target.chainId}.reachable`;
  const where = `${target.kind} subgraph for chain ${target.chainId} (${maskUrl(target.url)})`;
  const base = { id, category: "network" as const };

  if (outcome.kind === "timeout") {
    return {
      ...base,
      status: "warn",
      message: `${where} timed out after ${opts.timeoutMs ?? 0}ms`,
    };
  }
  if (outcome.kind === "error") {
    return {
      ...base,
      status: "fail",
      message: `${where} unreachable: ${redactUrlCredentials(outcome.error)}`,
      remediation: subgraphRemediation(target),
    };
  }

  const gatewayErrors = graphqlErrorMessages(outcome.body);
  if (outcome.status >= 400) {
    return {
      ...base,
      status: "fail",
      message: `${where} returned HTTP ${outcome.status}${gatewayErrors ? `: ${gatewayErrors}` : ""}`,
      remediation: subgraphRemediation(target),
    };
  }
  if (gatewayErrors) {
    return {
      ...base,
      status: "fail",
      message: `${where} answered HTTP ${outcome.status} but the body carries GraphQL errors, so every read against it fails: ${gatewayErrors}`,
      remediation: subgraphRemediation(target),
    };
  }

  const data = isRecord(outcome.body) ? outcome.body.data : undefined;
  if (!isRecord(data)) {
    return {
      ...base,
      status: "fail",
      message: `${where} answered HTTP ${outcome.status} with no \`data\` — not a working GraphQL endpoint.`,
      remediation: subgraphRemediation(target),
    };
  }
  const meta = isRecord(data._meta) ? data._meta : undefined;
  if (!meta) {
    return {
      ...base,
      status: "fail",
      message: `${where} answered HTTP ${outcome.status} but returned no \`_meta\` — the endpoint is not an indexed subgraph (or has never synced a block).`,
      remediation: subgraphRemediation(target),
    };
  }

  const block = metaBlockNumber(meta);
  const concerns: string[] = [];
  if (block === undefined) {
    concerns.push("no usable `_meta.block.number`, so how far it has indexed is unknown");
  }
  if (meta.hasIndexingErrors === true) {
    concerns.push("the indexer reports hasIndexingErrors=true — rows may be missing or wrong");
  }
  let lagNote = "";
  if (opts.headBlock !== undefined && block !== undefined) {
    const lag = opts.headBlock - block;
    if (lag > 0n) lagNote = `, ${lag} block(s) behind head ${opts.headBlock}`;
    if (lag > SUBGRAPH_LAG_WARN_BLOCKS) {
      concerns.push(`indexing is ${lag} blocks behind the chain head — reads answer from stale state`);
    }
  }

  const message = `indexed block ${block ?? "unknown"}${lagNote} — ${where}`;
  if (concerns.length === 0) {
    return { ...base, status: "pass", message };
  }
  return {
    ...base,
    status: "warn",
    message: `${message}; ${concerns.join("; ")}`,
    remediation:
      `Subgraph-backed reads for chain ${target.chainId} may be stale or incomplete — cross-check anything you act on with an on-chain read ` +
      `(dexe_read_gov_state / dexe_proposal_list / dexe_read_multicall need no subgraph). ` +
      `If it persists, the indexer is unhealthy: check its status on The Graph, or point ${subgraphEnvVar(target.kind, target.chainId)} at another endpoint and restart.`,
  };
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

function signerGuardConfigCheck(config?: DexeConfig): CheckResult[] {
  const out: CheckResult[] = [];

  // Report the RESOLVED signer, not the raw env. Since 0.30.1 a malformed
  // broadcast-guard var fails closed (signing off) while the env var it was
  // set from is still present — reading process.env here would tell the user
  // their hot key is "the active signer" while every broadcast is refused.
  const hotKeySet = process.env.DEXE_PRIVATE_KEY?.trim();
  const hotKeyActive = config ? config.privateKey !== undefined : Boolean(hotKeySet);
  if (hotKeySet && hotKeyActive) {
    out.push({
      id: "signer.hotKey",
      category: "signer",
      status: "warn",
      message:
        "⚠️ NOT SAFE — DEXE_PRIVATE_KEY is the active signer: a hot key in plaintext on disk.",
      remediation:
        "Prefer WalletConnect: unset DEXE_PRIVATE_KEY and run dexe_wc_connect (the phone signs, key never on disk). If you must keep a hot key, use only a throwaway/test wallet.",
    });
  } else if (hotKeySet && !hotKeyActive) {
    out.push({
      id: "signer.hotKey",
      category: "signer",
      status: "fail",
      message:
        "DEXE_PRIVATE_KEY is set but signing is DISABLED — the key was rejected, or a broadcast-guard variable is malformed and the server failed closed rather than broadcasting unguarded.",
      remediation:
        "See the startup.* rows above for the offending variable, fix it in .env, then restart Claude Code. Until then every write tool refuses to broadcast.",
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

  // Agent keyring visibility: count configured slots + which naming supplied
  // them (DEXE_AGENT_PK_* vs the AGENT_PK_*/AGENT_FUNDER_PK swarm aliases).
  const slots: string[] = [];
  for (let n = 1; n <= 16; n++) {
    if (process.env[`DEXE_AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}`);
    else if (process.env[`AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}(alias)`);
  }
  if (process.env.DEXE_AGENT_FUNDER_PK?.trim()) slots.push("funder");
  else if (process.env.AGENT_FUNDER_PK?.trim()) slots.push("funder(alias)");
  if (slots.length > 0) {
    // Same resolved-vs-raw distinction as signer.hotKey above: the env vars can
    // be present while the keyring was dropped (no RPC, or a failed-closed guard).
    const loaded = config ? Object.keys(config.agentKeys).length : slots.length;
    out.push(
      loaded > 0
        ? {
            id: "signer.agentKeyring",
            category: "signer",
            status: "pass",
            message: `${loaded} keyring slot(s): ${slots.join(", ")} — select per call via signerKey`,
          }
        : {
            id: "signer.agentKeyring",
            category: "signer",
            status: "fail",
            message: `${slots.length} keyring slot(s) configured (${slots.join(", ")}) but NONE are loaded — signing is disabled.`,
            remediation:
              "See the startup.* rows above: either no RPC is configured, or a broadcast-guard variable is malformed. Fix it in .env and restart Claude Code.",
          },
    );
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
  // Every baked endpoint indexes BSC mainnet, so the shared Graph key can only
  // ever occupy chain 56's slot. The flat alias follows DEXE_SUBGRAPH_CHAIN_ID,
  // so testing it made this advisory disappear whenever the unsuffixed vars were
  // retargeted at another chain — while chain 56 still read on the shared key.
  if (config.subgraphUrls.get(DEFAULT_SUBGRAPH_CHAIN_ID)?.pools === DEFAULTS.subgraphPoolsUrl) {
    shared.push("subgraph (shared Graph API key)");
  }
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

/** Exported so probe-interpretation can be tested without a network. */
export type FetchOutcome =
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
    return { kind: "error", error: safeErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}
