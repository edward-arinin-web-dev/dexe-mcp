import { resolveStatePath } from "./lib/stateStore.js";
import { parseEnv } from "./env/parse.js";
import { ENV_SPEC_READ, PER_CHAIN_SUBGRAPH_URL_RE, subgraphUrlStr, type EnvSpec } from "./env/schemaRead.js";

/**
 * The READ edition's configuration: chains and RPC endpoints, subgraph and
 * backend endpoints, the analysis knobs read tools use, the tool profile and
 * the state path — and the loader that builds it from the environment.
 *
 * The write edition's config (`WriteConfig` in ./config.ts) extends this with
 * signing keys, the agent keyring, broadcast guards, Pinata, WalletConnect, the
 * treasury guard and the dev toolchain's checkout path. Its loader runs the
 * phases exported here, in the order the single server has always run them,
 * with its own phases in between — so one startup prints one banner and
 * collects one `startupIssues` list.
 *
 * `loadReadConfig()` NEVER looks at a write-edition var: it validates the read
 * spec only, parses no key, constructs no `Wallet`, prints no signer address.
 * A shared `.env` with signing keys in it is invisible to it.
 *
 * Env vars that tools read at the point of use (`DEXE_RPC_TIMEOUT_MS`,
 * `DEXE_IPFS_GATEWAY*`, `DEXE_PINATA_GATEWAY_TOKEN`, `DEXE_DEBUG`) are not
 * config fields; they belong to the read edition through the read env spec
 * (src/env/schemaRead.ts), which validates them here.
 */

/**
 * Split an RPC env value into its endpoint list: `url` or `url1,url2,…`.
 * First entry is the primary; the rest are transport-failure fallbacks.
 */
function splitRpcUrls(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Baked zero-config defaults — public, non-secret endpoints (plus a semi-public
 * WalletConnect project id) so a fresh install works cold with no `.env`. A user
 * `.env` always overrides: each is applied as `process.env.X?.trim() || DEFAULT`.
 *
 * The Graph API key rides INSIDE the subgraph URLs (`extractGraphApiKey` in
 * lib/subgraph.ts picks it up). Do NOT add a separate `DEXE_GRAPH_API_KEY`
 * default — a standalone key that differs from the URL-embedded one produces a
 * Bearer-vs-URL mismatch at the gateway.
 *
 * These ship publicly on npm + GitHub. The Graph key is billable; heavy users
 * should set their own (dexe_doctor advises this). Rotate if abused. See
 * docs/ENVIRONMENT.md.
 *
 * Read-edition defaults only. The shared WalletConnect project id is a write
 * default: `WRITE_DEFAULTS` in ./config.ts.
 */
export const DEFAULTS = {
  backendApiUrl: "https://api.dexe.io",
  // The Graph decentralized gateway (modern host); key embedded in the path.
  subgraphPoolsUrl:
    "https://gateway.thegraph.com/api/b860428fe3ef79a961556cf763ef2b2a/subgraphs/id/2XDP2ZxHc25n4xeDqKWTGBy5FJojS6dw4WM79oof2YLn",
  subgraphInteractionsUrl:
    "https://gateway.thegraph.com/api/b860428fe3ef79a961556cf763ef2b2a/subgraphs/id/CPsXn5AcuVTd48sb3uRuPbxcheLEnWCeoXJkARDoWxoP",
  subgraphValidatorsUrl:
    "https://gateway.thegraph.com/api/b860428fe3ef79a961556cf763ef2b2a/subgraphs/id/9xpPF9EWtSJJUwVYZb7f6D1xcMCyLbmR6ujgnYG8fbQA",
} as const;

/**
 * The chain the built-in `DEFAULTS.subgraph*Url` endpoints index, and the
 * default owner of the unsuffixed `DEXE_SUBGRAPH_*_URL` vars. Every DeXe
 * subgraph we ship or document is BSC mainnet.
 */
export const DEFAULT_SUBGRAPH_CHAIN_ID = 56;

/** The three DeXe subgraphs. One endpoint per kind per chain. */
export type SubgraphKind = "pools" | "validators" | "interactions";

export const SUBGRAPH_KINDS: readonly SubgraphKind[] = ["pools", "validators", "interactions"];

/** Endpoints known for ONE chain. A missing kind means "not indexed here". */
export interface SubgraphEndpoints {
  pools?: string;
  validators?: string;
  interactions?: string;
}

/** `pools` → `DEXE_SUBGRAPH_POOLS_URL`, and `…_URL_<chainId>` per chain. */
export function subgraphEnvVar(kind: SubgraphKind, chainId?: number): string {
  const base = `DEXE_SUBGRAPH_${kind.toUpperCase()}_URL`;
  return chainId === undefined ? base : `${base}_${chainId}`;
}

export interface ChainConfig {
  chainId: number;
  /** Primary RPC endpoint — always `rpcUrls[0]`. Kept for back-compat reads. */
  rpcUrl: string;
  /**
   * Full endpoint list for this chain: primary first, then transport-failure
   * fallbacks (comma-separated in env, or the baked public list). Consumed by
   * `createChainProvider` (src/rpc.ts) for retry + rotation.
   */
  rpcUrls: string[];
  /** Optional `ContractsRegistry` override scoped to this chain. */
  registryOverride?: string;
}

/** A rejected env value and what the server did instead of exiting. */
export interface StartupIssue {
  /** The offending env var (or a `DEXE_AGENT_PK_*` style family name). */
  key: string;
  /** Why the value was rejected — the same text doctor shows. */
  message: string;
  /** What the server fell back to, so the user knows the current behavior. */
  fallback: string;
}

export interface ReadConfig {
  /** All chains configured via env. Empty when no RPC is set. Frozen. */
  chains: ReadonlyMap<number, ChainConfig>;
  /**
   * Default chain id used when a tool call omits `chainId`. Always resolves to
   * a configured chain when `chains` is non-empty. When `chains` is empty,
   * defaults to 56 for legacy single-chain code paths that don't need an RPC.
   */
  defaultChainId: number;

  /**
   * True when the user configured NO RPC and the server seeded public BSC
   * endpoints (chains 56 + 97, default 56) so on-chain reads work zero-config.
   * Public dataseed nodes rate-limit and lack archive history — `dexe_doctor`
   * surfaces this as an advisory. Opt out with `DEXE_DISABLE_PUBLIC_RPC=1`.
   * See `resolveChainSet`.
   */
  usingPublicRpcFallback: boolean;

  /**
   * Back-compat alias for `chains.get(defaultChainId)?.rpcUrl`. Always reflects
   * the default chain's RPC. New code should call `getProvider(chainId)` instead.
   */
  rpcUrl?: string;
  /** Back-compat alias for `defaultChainId`. */
  chainId: number;
  /** Back-compat: registry override resolved against the default chain. */
  registryOverride?: string;

  /**
   * Subgraph endpoints keyed by the chain they index. A subgraph indexes
   * exactly ONE chain, so this map — not the flat fields below — is the honest
   * shape: a chain absent from it has no indexer, and reads for it must fail
   * rather than answer from some other chain's endpoint. Frozen.
   *
   * Resolve through `resolveSubgraphUrl` (src/lib/subgraph.ts); do not index
   * this map directly in tools, so the "no endpoint for this chain" error is
   * written once.
   */
  subgraphUrls: ReadonlyMap<number, SubgraphEndpoints>;
  /**
   * Chain that the unsuffixed `DEXE_SUBGRAPH_*_URL` vars (and the baked
   * defaults) are taken to index — `DEXE_SUBGRAPH_CHAIN_ID`, default 56.
   * Exposed for diagnostics (`dexe_doctor`, `dexe_get_config`) so a user can
   * see which chain their single-endpoint config was filed under.
   */
  subgraphChainId: number;
  /**
   * Back-compat flat aliases: the endpoints for `subgraphChainId`, i.e. the
   * exact values these fields have always held. Kept because many call sites
   * read them; new code takes a chainId and calls `resolveSubgraphUrl`.
   */
  subgraphPoolsUrl?: string;
  subgraphValidatorsUrl?: string;
  subgraphInteractionsUrl?: string;
  /**
   * DeXe backend API root for off-chain proposal flows + backend-first reads
   * (treasury, holders, stats). Defaults to `DEFAULTS.backendApiUrl`
   * (https://api.dexe.io); a user `.env` overrides. Always set.
   */
  backendApiUrl: string;

  /**
   * Env values that failed validation at startup. The server does NOT exit for
   * these — a single typo must never leave the user with no tools and no
   * in-band diagnostic. Each entry records what was rejected and what the
   * server did instead; `dexe_doctor` surfaces them as failures.
   */
  startupIssues: StartupIssue[];

  /**
   * Minimum safe quorum percent (0–100). A DAO whose quorum setting is below
   * this is flagged as a governance-safety risk for treasury-moving proposals
   * (low quorum reduces the participation required to pass). Default 50.
   * See src/lib/quorumRisk.ts.
   */
  minSafeQuorumPct: number;

  /**
   * Number of top token holders (by voting weight) included in the treasury-
   * safety "controlling set" (alongside validators). The advisory checks whether
   * ≥1 controlling member voted For. Default 5. Needs a pools + validators
   * subgraph for the chain being analyzed; unindexed chains yield "unknown".
   * See src/lib/controllingVoters.ts.
   */
  controllingTopN: number;

  /**
   * Phase 2 — active tool profiles from `DEXE_TOOLSETS` (comma list, lowercased).
   * EMPTY means the user did not choose: `resolveToolsets` then applies
   * `DEFAULT_TOOLSETS`, which is the single source of truth for the default
   * profile (src/tools/gate.ts). An explicit `full` or any unknown set name
   * loads every tool. Consumed by `applyToolGate` in src/tools/gate.ts.
   */
  toolsets: string[];

  /**
   * Phase 3 — resolved path to the persistent operational-state JSON
   * (`DEXE_STATE_PATH` override, else `~/.dexe-mcp/state.json`). Records DAOs
   * deployed and proposals broadcast so `dexe_context` can surface them across
   * sessions. See src/lib/stateStore.ts.
   */
  statePath: string;
}

/**
 * Build the per-chain subgraph endpoint map from an env table.
 *
 * A subgraph endpoint indexes exactly ONE chain, so resolution is per
 * (kind, chain) and never falls through to another chain's URL. That silent
 * cross-chain fallback is the bug this replaces: with only the unsuffixed vars,
 * a user on BSC testnet got BSC *mainnet* rows back, labelled as theirs.
 *
 * Per kind, for a given chain:
 *   1. `DEXE_SUBGRAPH_<KIND>_URL_<chainId>` — explicit, wins outright
 *   2. `DEXE_SUBGRAPH_<KIND>_URL`           — applies to `DEXE_SUBGRAPH_CHAIN_ID` ONLY
 *   3. `DEFAULTS.subgraph<Kind>Url`         — chain 56 only; every baked endpoint is BSC mainnet
 * A chain matching none of these is absent from the map, and `resolveSubgraphUrl`
 * turns that absence into an actionable error instead of a wrong answer.
 *
 * Pure: reads `env`, reports rejections through `onIssue`, writes nothing.
 */
export function resolveSubgraphEndpoints(
  env: NodeJS.ProcessEnv,
  onIssue: (key: string, message: string, fallback: string) => void = () => {},
): { urls: Map<number, SubgraphEndpoints>; chainId: number } {
  const urlSchema = subgraphUrlStr();
  /** Returns the URL when it parses; otherwise reports and returns undefined. */
  const validate = (key: string, raw: string, fallback: string): string | undefined => {
    const r = urlSchema.safeParse(raw);
    if (r.success) return raw;
    onIssue(key, `Invalid ${key}=${raw}: ${r.error.issues.map((i) => i.message).join("; ")}`, fallback);
    return undefined;
  };

  // Which chain the unsuffixed DEXE_SUBGRAPH_*_URL vars describe.
  let chainId = DEFAULT_SUBGRAPH_CHAIN_ID;
  const rawChainId = env.DEXE_SUBGRAPH_CHAIN_ID?.trim();
  if (rawChainId) {
    const n = Number(rawChainId);
    // Safe-integer, not merely finite: a chain id that lost precision as a
    // float would file the endpoints under a chain nobody asked about.
    if (!Number.isSafeInteger(n) || n <= 0) {
      onIssue(
        "DEXE_SUBGRAPH_CHAIN_ID",
        `DEXE_SUBGRAPH_CHAIN_ID must be a positive integer chain id, got: ${rawChainId}`,
        `using the default ${DEFAULT_SUBGRAPH_CHAIN_ID} — the unsuffixed DEXE_SUBGRAPH_*_URL vars are treated as BSC mainnet`,
      );
    } else {
      chainId = n;
    }
  }

  const urls = new Map<number, SubgraphEndpoints>();
  const put = (cid: number, kind: SubgraphKind, url: string): void => {
    const entry = urls.get(cid) ?? {};
    entry[kind] = url;
    urls.set(cid, entry);
  };

  // (3) baked defaults — BSC mainnet, and only BSC mainnet.
  const baked: Record<SubgraphKind, string> = {
    pools: DEFAULTS.subgraphPoolsUrl,
    validators: DEFAULTS.subgraphValidatorsUrl,
    interactions: DEFAULTS.subgraphInteractionsUrl,
  };
  for (const kind of SUBGRAPH_KINDS) put(DEFAULT_SUBGRAPH_CHAIN_ID, kind, baked[kind]);

  // (2) unsuffixed vars — for `chainId` only, overriding the baked default
  // when that chain is 56.
  for (const kind of SUBGRAPH_KINDS) {
    const key = subgraphEnvVar(kind);
    const raw = env[key]?.trim();
    if (!raw) continue;
    const url = validate(
      key,
      raw,
      `that endpoint is ignored — chain ${chainId} falls back to the built-in endpoint if it has one`,
    );
    if (url) put(chainId, kind, url);
  }

  // (1) per-chain vars — highest precedence. Scanned the same way config
  // discovers DEXE_RPC_URL_<chainId>, since the suffix set is open-ended.
  for (const [key, val] of Object.entries(env)) {
    const m = PER_CHAIN_SUBGRAPH_URL_RE.exec(key);
    if (!m) continue;
    const raw = val?.trim();
    if (!raw) continue;
    const cid = Number(m[2]);
    if (!Number.isSafeInteger(cid) || cid <= 0) {
      onIssue(
        key,
        `${key} has an unusable chain-id suffix: ${m[2]}`,
        "that endpoint is ignored — rename the var with a plain chain id, e.g. DEXE_SUBGRAPH_POOLS_URL_97",
      );
      continue;
    }
    const url = validate(
      key,
      raw,
      `that endpoint is ignored — subgraph reads for chain ${cid} will report no endpoint instead of guessing`,
    );
    if (url) put(cid, m[1]!.toLowerCase() as SubgraphKind, url);
  }

  return { urls, chainId };
}

// ─── loader phases ─────────────────────────────────────────────────────────
//
// `loadReadConfig` below runs these in order. The write loader (`loadConfig`
// in ./config.ts) runs the same phases with its own in between, in the order
// the single server has always printed its startup lines. Each phase reads
// `process.env`, reports through the shared issue sink, and returns its slice
// of the config.

/**
 * Collects rejected env values. A bad value in ANY optional DEXE_* var used to
 * `process.exit(1)`. That left the user with no MCP tools, no in-band
 * diagnostic, and — because `process.exit` cannot be caught — a dead
 * `npx dexe-mcp doctor`, the exact command every doc points at. Nothing here is
 * unrecoverable, so nothing here exits: record the issue, fall back, and let
 * doctor report it.
 */
export interface ConfigIssueSink {
  readonly startupIssues: StartupIssue[];
  degrade(key: string, message: string, fallback: string): void;
}

export function createIssueSink(): ConfigIssueSink {
  const startupIssues: StartupIssue[] = [];
  return {
    startupIssues,
    degrade(key, message, fallback) {
      startupIssues.push({ key, message, fallback });
      process.stderr.write(`[dexe-mcp] config issue: ${message} — ${fallback}\n`);
    },
  };
}

/** What a rejected read-edition value falls back to. */
const readRejectionConsequence = (): string => "value ignored, using the built-in default";

/**
 * Schema-validate `spec` up front (R5). parse.ts walks the spec; an invalid
 * value (malformed URL, non-integer, bad enum) is a config error the user
 * should see at startup, not a confusing late failure deep inside a tool call.
 * Doctor performs the same validation; this makes startup honest about it too.
 *
 * A rejected value is DELETED from `process.env` so every downstream read falls
 * back to its documented default instead of consuming garbage. The hand-written
 * checks in the later phases therefore never see it, so the consequence has to
 * be spelled out here — `consequence` names it per key (the write loader knows
 * which keys switch signing off).
 *
 * Only `spec`'s keys are looked at. Returns the rejected keys.
 */
export function applyEnvSpec(
  sink: ConfigIssueSink,
  spec: EnvSpec,
  consequence: (key: string) => string = readRejectionConsequence,
): string[] {
  const { issues } = parseEnv(process.env, spec);
  for (const issue of issues) {
    process.stderr.write(`[dexe-mcp] env ${issue.severity}: ${issue.message}\n`);
  }
  const rejected: string[] = [];
  for (const issue of issues.filter((i) => i.severity === "error")) {
    delete process.env[issue.key];
    rejected.push(issue.key);
    sink.degrade(issue.key, issue.message, consequence(issue.key));
  }
  return rejected;
}

/** The chain set, the default chain and the RPC endpoints behind them. */
export interface ChainSet {
  chains: Map<number, ChainConfig>;
  defaultChainId: number;
  usingPublicRpcFallback: boolean;
  /** `DEXE_CONTRACTS_REGISTRY` as set (applies to the legacy chain only). */
  registryOverride?: string;
}

/**
 * Collect every configured chain, seed the public BSC fallback when none is,
 * resolve the default chain and print the one-line chain summary.
 */
export function resolveChainSet(sink: ConfigIssueSink): ChainSet {
  const { degrade } = sink;
  // ---- collect every configured chain ------------------------------------
  // Priority:
  //   1) DEXE_RPC_URL_TESTNET → chain 97
  //   2) DEXE_RPC_URL_MAINNET → chain 56
  //   3) Legacy DEXE_RPC_URL + DEXE_CHAIN_ID → register that chain
  // All three may coexist; later entries with the same chainId override earlier.
  const chains = new Map<number, ChainConfig>();
  const registryOverride = process.env.DEXE_CONTRACTS_REGISTRY?.trim() || undefined;

  const rpcTestnet = process.env.DEXE_RPC_URL_TESTNET?.trim() || undefined;
  if (rpcTestnet) {
    const urls = splitRpcUrls(rpcTestnet);
    chains.set(97, { chainId: 97, rpcUrl: urls[0]!, rpcUrls: urls });
  }
  const rpcMainnet = process.env.DEXE_RPC_URL_MAINNET?.trim() || undefined;
  if (rpcMainnet) {
    const urls = splitRpcUrls(rpcMainnet);
    chains.set(56, { chainId: 56, rpcUrl: urls[0]!, rpcUrls: urls });
  }

  // Generic per-chain RPC: DEXE_RPC_URL_<chainId> (e.g. DEXE_RPC_URL_1,
  // DEXE_RPC_URL_10). Enables chains beyond BSC — notably the external
  // Governor DAOs, which live on Ethereum (1) and Optimism (10). The numeric
  // suffix never collides with the named *_TESTNET / *_MAINNET vars above.
  for (const [key, val] of Object.entries(process.env)) {
    const m = /^DEXE_RPC_URL_(\d+)$/.exec(key);
    if (!m) continue;
    const url = val?.trim();
    if (!url) continue;
    const cid = Number(m[1]);
    const urls = splitRpcUrls(url);
    chains.set(cid, { chainId: cid, rpcUrl: urls[0]!, rpcUrls: urls });
  }

  // Legacy single-chain env (still supported)
  const legacyRpc = process.env.DEXE_RPC_URL?.trim() || undefined;
  let legacyChainId: number | undefined;
  if (process.env.DEXE_CHAIN_ID) {
    const n = Number(process.env.DEXE_CHAIN_ID);
    if (!Number.isFinite(n) || n <= 0) {
      degrade(
        "DEXE_CHAIN_ID",
        `DEXE_CHAIN_ID must be a positive integer, got: ${process.env.DEXE_CHAIN_ID}`,
        "ignored, inferring the chain from the RPC URL instead",
      );
    } else {
      legacyChainId = n;
    }
  }
  if (legacyRpc) {
    const legacyUrls = splitRpcUrls(legacyRpc);
    // Resolve legacy chainId. If unset, infer from URL hostname; fall back to 56.
    const inferred = legacyChainId ?? inferChainIdFromRpcUrl(legacyUrls[0]!) ?? 56;
    // Apply registryOverride only when this is the legacy chain (per-chain
    // override via DEXE_CONTRACTS_REGISTRY has always been single-chain).
    chains.set(inferred, {
      chainId: inferred,
      rpcUrl: legacyUrls[0]!,
      rpcUrls: legacyUrls,
      registryOverride,
    });
  }

  // ---- zero-config read fallback -----------------------------------------
  // When the user configured NO RPC at all, seed known BSC public endpoints so
  // read tools (dao_info, read_treasury, …) work out of the box — the plugin
  // install path and any client that skips env setup. Calldata builders never
  // needed an RPC; this only helps on-chain reads. Public dataseed nodes
  // rate-limit and lack archive history, so we surface a hint (below) nudging
  // the user to set their own RPC for anything serious. Opt out entirely with
  // DEXE_DISABLE_PUBLIC_RPC=1. When the user set any RPC, this does nothing.
  // Multiple public endpoints per chain: ResilientRpcProvider rotates to the
  // next one when the primary rate-limits (R1), so zero-config reads survive a
  // single flaky dataseed node.
  const PUBLIC_RPC_FALLBACK: Record<number, string[]> = {
    56: [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.bnbchain.org",
      "https://bsc-dataseed2.bnbchain.org",
      "https://bsc-rpc.publicnode.com",
    ],
    97: [
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
      "https://bsc-testnet-rpc.publicnode.com",
    ],
  };
  let usedPublicFallback = false;
  if (process.env.DEXE_DISABLE_PUBLIC_RPC?.trim() !== "1" && chains.size === 0) {
    for (const [cid, urls] of Object.entries(PUBLIC_RPC_FALLBACK)) {
      chains.set(Number(cid), { chainId: Number(cid), rpcUrl: urls[0]!, rpcUrls: urls });
    }
    usedPublicFallback = true;
  }

  // ---- resolve default chain ---------------------------------------------
  let defaultChainId: number | undefined;
  const explicitDefault = process.env.DEXE_DEFAULT_CHAIN_ID?.trim();
  if (explicitDefault) {
    const n = Number(explicitDefault);
    if (!Number.isFinite(n) || n <= 0) {
      degrade(
        "DEXE_DEFAULT_CHAIN_ID",
        `DEXE_DEFAULT_CHAIN_ID must be a positive integer, got: ${explicitDefault}`,
        "ignored, auto-selecting the default chain",
      );
    } else if (!chains.has(n)) {
      const configured = [...chains.keys()].sort().join(", ") || "none";
      degrade(
        "DEXE_DEFAULT_CHAIN_ID",
        `DEXE_DEFAULT_CHAIN_ID=${n} but no RPC configured for that chain. Configured: [${configured}]. Set DEXE_RPC_URL_${n === 97 ? "TESTNET" : n === 56 ? "MAINNET" : "<chain>"} or legacy DEXE_RPC_URL.`,
        "ignored, auto-selecting from the configured chains",
      );
    } else {
      defaultChainId = n;
    }
  }
  if (defaultChainId !== undefined) {
    // resolved from DEXE_DEFAULT_CHAIN_ID above
  } else if (chains.size === 1) {
    defaultChainId = [...chains.keys()][0]!;
  } else if (chains.size > 1) {
    const sorted = [...chains.keys()].sort((a, b) => a - b);
    if (usedPublicFallback) {
      // Zero-config fallback seeded both BSC chains → default to mainnet (56),
      // where real DAOs live; reading them is the point of the fallback.
      defaultChainId = 56;
      process.stderr.write(
        "[dexe-mcp] no RPC configured — using public BSC RPC fallback (default chain 56). " +
          "Public dataseed nodes rate-limit and lack archive history; set DEXE_RPC_URL_MAINNET " +
          "(and DEXE_RPC_URL_TESTNET) for reliability, or DEXE_DISABLE_PUBLIC_RPC=1 to turn it off.\n",
      );
    } else {
      // Multi-chain without explicit default → prefer testnet for safety, else lowest chainId.
      defaultChainId = chains.has(97) ? 97 : sorted[0]!;
      process.stderr.write(
        `[dexe-mcp] multiple chains configured without DEXE_DEFAULT_CHAIN_ID; defaulting to ${defaultChainId === 97 ? "testnet (97)" : `chain ${defaultChainId}`} for safety. Set DEXE_DEFAULT_CHAIN_ID to override.\n`,
      );
    }
  } else {
    // No chains configured — keep legacy fallback so non-RPC tools still load.
    defaultChainId = legacyChainId ?? 56;
  }

  // ---- emit one-line summary of the resolved chain set --------------------
  if (chains.size > 0) {
    const summary = [...chains.values()]
      .sort((a, b) => a.chainId - b.chainId)
      .map(c => `${c.chainId}${c.chainId === defaultChainId ? "*" : ""}`)
      .join(", ");
    process.stderr.write(`[dexe-mcp] chains: [${summary}] (default marked with *)\n`);
  } else {
    process.stderr.write(
      "[dexe-mcp] no RPC configured — read/write tools that touch a chain will fail with a clear error.\n",
    );
  }

  return { chains, defaultChainId, usingPublicRpcFallback: usedPublicFallback, registryOverride };
}

/** Subgraph endpoints and the DeXe backend. */
export interface DataSources {
  subgraphUrls: Map<number, SubgraphEndpoints>;
  subgraphChainId: number;
  subgraphPoolsUrl?: string;
  subgraphValidatorsUrl?: string;
  subgraphInteractionsUrl?: string;
  backendApiUrl: string;
}

export function resolveDataSources(sink: ConfigIssueSink): DataSources {
  const { urls: subgraphUrls, chainId: subgraphChainId } = resolveSubgraphEndpoints(
    process.env,
    sink.degrade,
  );
  // Flat back-compat aliases = the endpoints for the chain the unsuffixed vars
  // describe. For every config that predates the per-chain vars this is the
  // literal old expression (`DEXE_SUBGRAPH_*_URL` else the baked default), so
  // existing call sites see no change.
  const forLegacyChain = subgraphUrls.get(subgraphChainId);
  return {
    subgraphUrls,
    subgraphChainId,
    subgraphPoolsUrl: forLegacyChain?.pools,
    subgraphValidatorsUrl: forLegacyChain?.validators,
    subgraphInteractionsUrl: forLegacyChain?.interactions,
    backendApiUrl: process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl,
  };
}

/** The treasury-safety analysis knobs read tools use (risk assessment, reports). */
export interface RiskSettings {
  minSafeQuorumPct: number;
  controllingTopN: number;
}

export function resolveRiskSettings(sink: ConfigIssueSink): RiskSettings {
  const { degrade } = sink;
  // ---- treasury-safety advisory (low-quorum) -----------------------------
  let minSafeQuorumPct = 50;
  const minQuorumRaw = process.env.DEXE_MIN_SAFE_QUORUM_PCT?.trim();
  if (minQuorumRaw) {
    const n = Number(minQuorumRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      degrade(
        "DEXE_MIN_SAFE_QUORUM_PCT",
        `DEXE_MIN_SAFE_QUORUM_PCT must be a number between 0 and 100, got: ${minQuorumRaw}`,
        "using the default 50",
      );
    } else {
      minSafeQuorumPct = n;
    }
  }
  let controllingTopN = 5;
  const controllingTopNRaw = process.env.DEXE_CONTROLLING_TOPN?.trim();
  if (controllingTopNRaw) {
    const n = Number(controllingTopNRaw);
    if (!Number.isInteger(n) || n <= 0) {
      degrade(
        "DEXE_CONTROLLING_TOPN",
        `DEXE_CONTROLLING_TOPN must be a positive integer, got: ${controllingTopNRaw}`,
        "using the default 5",
      );
    } else {
      controllingTopN = n;
    }
  }
  return { minSafeQuorumPct, controllingTopN };
}

/**
 * Phase 2 toolset profiles (DEXE_TOOLSETS). Comma list of profile names.
 * Unset → [] ("user made no choice"), NOT a literal default: `resolveToolsets`
 * fills in DEFAULT_TOOLSETS. Spelling the default here too made it a second
 * source of truth that silently won — it pinned the pre-0.31.0 core+proposals
 * profile after gate.ts had already moved on. Validation (unknown names) also
 * happens in applyToolGate, which has the TOOLSETS registry; config stays
 * layer-clean.
 */
export function resolveToolsetsEnv(): string[] {
  const toolsetsRaw = process.env.DEXE_TOOLSETS?.trim();
  return toolsetsRaw
    ? toolsetsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
}

/**
 * Freeze the read config from its phases. Also the read-field half of the
 * write config's assembly, which spreads this (see `loadConfig` in ./config.ts).
 */
export function assembleReadConfig(
  parts: ChainSet & DataSources & RiskSettings & {
    startupIssues: StartupIssue[];
    toolsets: string[];
    statePath: string;
  },
): ReadConfig {
  const defaultChain = parts.chains.get(parts.defaultChainId);
  return Object.freeze({
    chains: Object.freeze(new Map(parts.chains)),
    defaultChainId: parts.defaultChainId,
    usingPublicRpcFallback: parts.usingPublicRpcFallback,
    chainId: parts.defaultChainId,
    rpcUrl: defaultChain?.rpcUrl,
    registryOverride: defaultChain?.registryOverride ?? parts.registryOverride,
    subgraphUrls: Object.freeze(parts.subgraphUrls),
    subgraphChainId: parts.subgraphChainId,
    subgraphPoolsUrl: parts.subgraphPoolsUrl,
    subgraphValidatorsUrl: parts.subgraphValidatorsUrl,
    subgraphInteractionsUrl: parts.subgraphInteractionsUrl,
    backendApiUrl: parts.backendApiUrl,
    startupIssues: parts.startupIssues,
    minSafeQuorumPct: parts.minSafeQuorumPct,
    controllingTopN: parts.controllingTopN,
    toolsets: parts.toolsets,
    statePath: parts.statePath,
  });
}

/**
 * Reads the environment and returns the frozen READ config. **Fast and
 * side-effect-free** apart from deleting rejected read values from
 * `process.env` and the startup lines on stderr — safe to await during MCP
 * `initialize`.
 *
 * Validates the read spec only. A write-edition var in the environment — a
 * signing key, an agent key, the Pinata JWT, a WalletConnect or Safe setting —
 * is never read, never validated, never reported and never reaches the
 * returned object; no `Wallet` is constructed.
 *
 * Async for parity with the write loader; the body runs synchronously.
 */
export async function loadReadConfig(): Promise<ReadConfig> {
  const sink = createIssueSink();
  applyEnvSpec(sink, ENV_SPEC_READ);
  const chainSet = resolveChainSet(sink);
  const dataSources = resolveDataSources(sink);
  const risk = resolveRiskSettings(sink);
  return assembleReadConfig({
    ...chainSet,
    ...dataSources,
    ...risk,
    startupIssues: sink.startupIssues,
    toolsets: resolveToolsetsEnv(),
    statePath: resolveStatePath(),
  });
}

/**
 * Best-effort chain-id inference from a JSON-RPC URL. Used only when legacy
 * `DEXE_RPC_URL` is set without `DEXE_CHAIN_ID`. Returns undefined when
 * unknown — caller falls back to 56.
 */
function inferChainIdFromRpcUrl(url: string): number | undefined {
  const u = url.toLowerCase();
  if (u.includes("prebsc") || u.includes("testnet")) return 97;
  if (u.includes("bsc") || u.includes("binance")) return 56;
  return undefined;
}

/**
 * Resolve a chain config given an optional `chainId`. When omitted, returns
 * the default chain. Throws with a clear message when the requested chain is
 * not configured.
 */
export function resolveChain(config: ReadConfig, chainId?: number): ChainConfig {
  const target = chainId ?? config.defaultChainId;
  const chain = config.chains.get(target);
  if (!chain) {
    const configured = [...config.chains.keys()].sort().join(", ") || "none";
    throw new Error(
      `No RPC configured for chainId=${target}. Configured chains: [${configured}]. ` +
        `Set DEXE_RPC_URL_${target === 97 ? "TESTNET" : target === 56 ? "MAINNET" : "<chain>"} in the MCP env block.`,
    );
  }
  return chain;
}
