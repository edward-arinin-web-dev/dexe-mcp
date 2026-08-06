import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProtocolPath, isBuildReady } from "./bootstrap.js";
import { resolveStatePath } from "./lib/stateStore.js";
import { parseEnv } from "./env/parse.js";
import { PER_CHAIN_SUBGRAPH_URL_RE, subgraphUrlStr } from "./env/schema.js";
import { safeErrorMessage } from "./lib/redact.js";

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
 * These ship publicly on npm + GitHub. The Graph key is billable and the WC id
 * is shared; heavy users should set their own (dexe_doctor advises this).
 * Rotate if abused. See docs/ENVIRONMENT.md.
 */
export const DEFAULTS = {
  backendApiUrl: "https://api.dexe.io",
  walletConnectProjectId: "d3b16069bf12d7cdb9acbc4947b5ed33",
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

/**
 * Broadcast-guard vars. A malformed value here fails CLOSED (signing disabled)
 * rather than falling back to a default — degrading a guard into "no guard"
 * would widen what an autonomous agent may send.
 */
const SIGNER_GUARD_KEYS = new Set([
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
  "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
]);

/**
 * What actually happens when the schema pre-pass rejects `key`. The pre-pass
 * deletes the value, so the specific handler further down never runs and cannot
 * state the consequence itself — it has to be named here or the user is
 * misinformed about whether signing still works.
 */
function schemaRejectionConsequence(key: string): string {
  if (SIGNER_GUARD_KEYS.has(key)) {
    return "signing disabled — a broadcast guard is never silently dropped";
  }
  if (key === "DEXE_PRIVATE_KEY" || /^DEXE_AGENT_(PK_\d+|FUNDER_PK)$/.test(key)) {
    return "that key is ignored — signing falls back to WalletConnect, or readonly";
  }
  return "value ignored, using the built-in default";
}

export interface DexeConfig {
  /** Absolute, normalized path to the DeXe-Protocol checkout (may not exist yet). */
  protocolPath: string;

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
   * See the fallback block in `loadConfig`.
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

  /** Pinata JWT for IPFS uploads (reads work without it via gateway). */
  pinataJwt?: string;
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
  /** Optional fork block pin (Phase B). */
  forkBlock?: number;
  /** Private key for tx signing. When set, `dexe_tx_send` can broadcast. */
  privateKey?: string;
  /**
   * Opt-in agent keyring (swarm / multi-persona flows): `DEXE_AGENT_PK_1..16`
   * → { agent1: "0x…", … }. Selected per call via the `signerKey` param on
   * `dexe_tx_send` and the composite flows. The primary `DEXE_PRIVATE_KEY`
   * stays the default signer; agent keys are never used implicitly.
   */
  agentKeys: Record<string, string>;

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
   * Treasury-safety advisory posture. `off` = silent; `warn` (default) =
   * advisories / alerts everywhere (build, deploy, execute, risk_assess).
   * **Advisory only — it never blocks.** Harm-reduction for an operator/agent
   * configuring a DAO; the durable control is an adequate on-chain quorum
   * threshold configured per DAO.
   */
  treasuryGuard: "off" | "warn";

  /**
   * Number of top token holders (by voting weight) included in the treasury-
   * safety "controlling set" (alongside validators). The advisory checks whether
   * ≥1 controlling member voted For. Default 5. Needs a pools + validators
   * subgraph for the chain being analyzed; unindexed chains yield "unknown".
   * See src/lib/controllingVoters.ts.
   */
  controllingTopN: number;

  /**
   * B6 — destination allowlist for `dexe_tx_send`. Lowercased, checksummed-then-
   * lowercased addresses. Undefined/empty = no restriction.
   */
  signerAllowlist?: string[];
  /** B7 — max wei value per broadcast. Undefined = no cap. */
  signerMaxValueWei?: bigint;
  /** B10 — max broadcasts per rolling minute. Undefined = no limit. */
  signerMaxBroadcastsPerMin?: number;

  /**
   * C12 — WalletConnect project id (Reown cloud.reown.com). When set and
   * `privateKey` is absent, `signerMode` resolves to `walletconnect`: broadcast
   * convenience without a hot key (every tx approved on the operator's phone).
   */
  walletConnectProjectId?: string;
  /** C12 — relay websocket override. Default `wss://relay.walletconnect.com`. */
  walletConnectRelayUrl?: string;
  /** C12 — per-tx phone-approval timeout in ms. Default 120000. */
  walletConnectApprovalTimeoutMs?: number;

  /**
   * Phase 2 — active tool profiles from `DEXE_TOOLSETS` (comma list, lowercased).
   * Default `["core","proposals"]`. An explicit `full` or any unknown set name
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
 * Reads environment and returns a frozen config. **Fast and side-effect-free**
 * — safe to await during MCP `initialize`. Does not clone, install, or shell
 * out. The protocol checkout may not exist yet; `ensureBuildReady` handles
 * that lazily from inside build/test tools.
 */
/**
 * Parse the agent-keyring env vars into a signerKey→privateKey map.
 * `AGENT_PK_<n>` is accepted as an alias for `DEXE_AGENT_PK_<n>` — it is the
 * naming the swarm harness and `.env.example` already use — with the
 * DEXE_-prefixed var winning when both are set. `AGENT_FUNDER_PK` /
 * `DEXE_AGENT_FUNDER_PK` maps to the "funder" slot. Alias values are
 * hex64-validated here (the env schema walk only covers DEXE_-prefixed vars);
 * an invalid alias reports through `onInvalid`.
 */
export function parseAgentKeys(
  env: NodeJS.ProcessEnv,
  onInvalid: (message: string) => void,
): Record<string, string> {
  const agentKeys: Record<string, string> = {};
  const hex64 = /^0x[0-9a-fA-F]{64}$/;
  const takeKey = (slot: string, primaryVar: string, aliasVar: string) => {
    const prim = env[primaryVar]?.trim();
    const alias = env[aliasVar]?.trim();
    const v = prim || alias;
    if (!v) return;
    if (!prim && alias && !hex64.test(alias)) {
      onInvalid(`${aliasVar} must be a 0x-prefixed 64-hex private key.`);
      return;
    }
    agentKeys[slot] = v;
  };
  for (let n = 1; n <= 16; n++) {
    takeKey(`agent${n}`, `DEXE_AGENT_PK_${n}`, `AGENT_PK_${n}`);
  }
  takeKey("funder", "DEXE_AGENT_FUNDER_PK", "AGENT_FUNDER_PK");
  return agentKeys;
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

export async function loadConfig(): Promise<DexeConfig> {
  // ---- degraded-startup collector -----------------------------------------
  // A bad value in ANY optional DEXE_* var used to `process.exit(1)`. That left
  // the user with no MCP tools, no in-band diagnostic, and — because
  // `process.exit` cannot be caught — a dead `npx dexe-mcp doctor`, the exact
  // command every doc points at. Nothing here is unrecoverable, so nothing here
  // exits: record the issue, fall back, and let doctor report it.
  const startupIssues: StartupIssue[] = [];
  const degrade = (key: string, message: string, fallback: string): void => {
    startupIssues.push({ key, message, fallback });
    process.stderr.write(`[dexe-mcp] config issue: ${message} — ${fallback}\n`);
  };
  // Set when a *broadcast guard* var is malformed. A guard that silently
  // degrades into "no guard" would widen what an autonomous agent may send, so
  // those fail CLOSED (readonly) instead of falling back to a default.
  let signerGuardBroken = false;

  // ---- schema-validate the DEXE_* env surface up front (R5) ---------------
  // parse.ts walks ENV_SPEC; an invalid value (malformed URL, non-integer,
  // bad enum) is a config error the user should see at startup, not a
  // confusing late failure deep inside a tool call. Doctor performs the same
  // validation; this makes startup honest about it too.
  {
    const { issues } = parseEnv();
    for (const issue of issues) {
      process.stderr.write(`[dexe-mcp] env ${issue.severity}: ${issue.message}\n`);
    }
    for (const issue of issues.filter((i) => i.severity === "error")) {
      // Drop the rejected value so every downstream `process.env` read falls
      // back to its documented default instead of consuming garbage. That also
      // means the hand-written checks further down never see these values, so
      // the consequence has to be spelled out HERE — telling a user "using the
      // built-in default" when signing was actually switched off would have
      // them expect writes to work while every broadcast is refused.
      delete process.env[issue.key];
      if (SIGNER_GUARD_KEYS.has(issue.key)) signerGuardBroken = true;
      degrade(issue.key, issue.message, schemaRejectionConsequence(issue.key));
    }
  }

  const protocolPath = resolve(resolveProtocolPath());

  // Soft warning only — don't block startup. The lazy bootstrap will either
  // create the checkout (auto-managed path) or surface a clear error when a
  // build tool is actually invoked (DEXE_PROTOCOL_PATH override).
  if (!existsSync(protocolPath)) {
    process.stderr.write(
      `[dexe-mcp] DeXe-Protocol checkout not found at ${protocolPath} — will be prepared on first dexe_compile call.\n`,
    );
  } else if (!isBuildReady(protocolPath)) {
    process.stderr.write(
      `[dexe-mcp] DeXe-Protocol checkout at ${protocolPath} is incomplete (missing node_modules or hardhat.config) — will be prepared on first dexe_compile call.\n`,
    );
  }

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

  const pinataJwt = process.env.DEXE_PINATA_JWT?.trim() || undefined;
  const { urls: subgraphUrls, chainId: subgraphChainId } = resolveSubgraphEndpoints(
    process.env,
    degrade,
  );
  // Flat back-compat aliases = the endpoints for the chain the unsuffixed vars
  // describe. For every config that predates the per-chain vars this is the
  // literal old expression (`DEXE_SUBGRAPH_*_URL` else the baked default), so
  // existing call sites see no change.
  const forLegacyChain = subgraphUrls.get(subgraphChainId);
  const subgraphPoolsUrl = forLegacyChain?.pools;
  const subgraphValidatorsUrl = forLegacyChain?.validators;
  const subgraphInteractionsUrl = forLegacyChain?.interactions;
  const backendApiUrl = process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl;

  let privateKey = process.env.DEXE_PRIVATE_KEY?.trim() || undefined;
  if (privateKey && chains.size === 0) {
    degrade(
      "DEXE_PRIVATE_KEY",
      "DEXE_PRIVATE_KEY requires at least one of DEXE_RPC_URL / DEXE_RPC_URL_TESTNET / DEXE_RPC_URL_MAINNET to be set (signing needs an RPC endpoint).",
      "signing disabled (readonly) — set an RPC URL and restart to re-enable",
    );
    privateKey = undefined;
  }
  if (privateKey) {
    const { Wallet } = await import("ethers");
    // The hex64 shape check upstream is weaker than what ethers accepts: an
    // all-zero key, or one at/above the curve order, matches the regex and then
    // throws here. `0x0000…0` is exactly what gets pasted from a template, and
    // an uncaught throw costs the user every tool. Degrade to readonly instead.
    let addr: string | undefined;
    try {
      addr = new Wallet(privateKey).address;
    } catch (err) {
      degrade(
        "DEXE_PRIVATE_KEY",
        `DEXE_PRIVATE_KEY is not a usable private key: ${safeErrorMessage(err)}`,
        "signing disabled (readonly) — fix the key and restart to re-enable",
      );
      privateKey = undefined;
    }
    if (addr) {
      process.stderr.write(`[dexe-mcp] signing enabled for ${addr}\n`);
      process.stderr.write(
        `[dexe-mcp] ⚠️ NOT SAFE: hot key in plaintext on disk — prefer WalletConnect (dexe_wc_connect); use only a throwaway wallet\n`,
      );
    }
  }

  // ---- opt-in agent keyring (DEXE_AGENT_PK_1..16 / AGENT_PK_1..16) --------
  // Multi-persona/swarm flows: each key becomes signerKey "agent<n>" on
  // dexe_tx_send + the composites; AGENT_FUNDER_PK → signerKey "funder".
  let agentKeys = parseAgentKeys(process.env, (message) =>
    degrade("DEXE_AGENT_PK_*", message, "that key is skipped; the other slots still load"),
  );
  if (Object.keys(agentKeys).length > 0 && chains.size === 0) {
    degrade(
      "DEXE_AGENT_PK_*",
      "Agent keyring keys (DEXE_AGENT_PK_*/AGENT_PK_*) require an RPC endpoint (same requirement as DEXE_PRIVATE_KEY).",
      "agent keyring disabled — set an RPC URL and restart to re-enable",
    );
    agentKeys = {};
  }
  if (Object.keys(agentKeys).length > 0) {
    const { Wallet } = await import("ethers");
    // Same trap as the primary key, multiplied: one hex-shaped but invalid slot
    // must cost that slot, never the whole surface.
    const labels: string[] = [];
    for (const slot of Object.keys(agentKeys)) {
      try {
        labels.push(`${slot}=${new Wallet(agentKeys[slot]!).address.slice(0, 10)}…`);
      } catch (err) {
        degrade(
          `DEXE_AGENT_PK_* (${slot})`,
          `agent keyring slot "${slot}" is not a usable private key: ${safeErrorMessage(err)}`,
          "that slot is dropped; the other slots still load",
        );
        delete agentKeys[slot];
      }
    }
    if (labels.length > 0) {
      process.stderr.write(
        `[dexe-mcp] agent keyring: ${labels.length} key(s) — ${labels.join(", ")} (select via signerKey)\n`,
      );
    }
  }

  // ---- signer broadcast guard B6 (destination allowlist) -----------------
  // Opt-in; only meaningful in signer mode. Parses to undefined when unset,
  // leaving the default posture unchanged.
  let signerAllowlist: string[] | undefined;
  const allowlistRaw = process.env.DEXE_SIGNER_ALLOWLIST?.trim();
  if (allowlistRaw) {
    const { isAddress, getAddress } = await import("ethers");
    const normalized: string[] = [];
    for (const entry of allowlistRaw.split(",").map(s => s.trim()).filter(Boolean)) {
      if (!isAddress(entry)) {
        degrade(
          "DEXE_SIGNER_ALLOWLIST",
          `DEXE_SIGNER_ALLOWLIST contains an invalid address: ${entry}`,
          "signing disabled — a destination allowlist is never applied partially",
        );
        signerGuardBroken = true;
        continue;
      }
      normalized.push(getAddress(entry).toLowerCase());
    }
    if (normalized.length > 0) signerAllowlist = normalized;
  }

  // ---- signer broadcast guard B7 (value cap) -----------------------------
  let signerMaxValueWei: bigint | undefined;
  const maxValueRaw = process.env.DEXE_SIGNER_MAX_VALUE_WEI?.trim();
  if (maxValueRaw) {
    let parsed: bigint | undefined;
    try {
      parsed = BigInt(maxValueRaw);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || parsed < 0n) {
      degrade(
        "DEXE_SIGNER_MAX_VALUE_WEI",
        `DEXE_SIGNER_MAX_VALUE_WEI must be a non-negative integer (wei), got: ${maxValueRaw}`,
        "signing disabled — a value cap is never silently dropped",
      );
      signerGuardBroken = true;
    } else {
      signerMaxValueWei = parsed;
    }
  }

  // ---- signer broadcast guard B10 (rate limit) ---------------------------
  let signerMaxBroadcastsPerMin: number | undefined;
  const maxBroadcastsRaw = process.env.DEXE_SIGNER_MAX_BROADCASTS_PER_MIN?.trim();
  if (maxBroadcastsRaw) {
    const n = Number(maxBroadcastsRaw);
    if (!Number.isInteger(n) || n <= 0) {
      degrade(
        "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
        `DEXE_SIGNER_MAX_BROADCASTS_PER_MIN must be a positive integer, got: ${maxBroadcastsRaw}`,
        "signing disabled — a rate limit is never silently dropped",
      );
      signerGuardBroken = true;
    } else {
      signerMaxBroadcastsPerMin = n;
    }
  }

  // ---- C12 WalletConnect signer mode ------------------------------------
  // Parse + expose config only. No relay connection until dexe_wc_connect.
  // Falls back to the baked shared project id so phone-approval signing is
  // available out of the box; a user `.env` overrides with their own.
  const wcFromEnv = process.env.DEXE_WALLETCONNECT_PROJECT_ID?.trim() || undefined;
  const walletConnectProjectId = wcFromEnv || DEFAULTS.walletConnectProjectId;
  const walletConnectRelayUrl =
    process.env.DEXE_WALLETCONNECT_RELAY_URL?.trim() || "wss://relay.walletconnect.com";
  let walletConnectApprovalTimeoutMs = 120000;
  const wcTimeoutRaw = process.env.DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS?.trim();
  if (wcTimeoutRaw) {
    const n = Number(wcTimeoutRaw);
    if (!Number.isInteger(n) || n <= 0) {
      degrade(
        "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS",
        `DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS must be a positive integer (ms), got: ${wcTimeoutRaw}`,
        "using the default 120000 ms",
      );
    } else {
      walletConnectApprovalTimeoutMs = n;
    }
  }
  if (privateKey) {
    // WC id present (env or default) but a hot key takes precedence — stay quiet
    // beyond the "signing enabled" line already emitted above.
  } else if (wcFromEnv) {
    process.stderr.write("[dexe-mcp] WalletConnect signing available (project id from env)\n");
  } else {
    process.stderr.write(
      "[dexe-mcp] WalletConnect signing available (shared default project id) — connect a wallet with dexe_wc_connect; set DEXE_WALLETCONNECT_PROJECT_ID to use your own.\n",
    );
  }

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
  let treasuryGuard: "off" | "warn" = "warn";
  const treasuryGuardRaw = process.env.DEXE_TREASURY_GUARD?.trim().toLowerCase();
  if (treasuryGuardRaw) {
    if (treasuryGuardRaw !== "off" && treasuryGuardRaw !== "warn") {
      degrade(
        "DEXE_TREASURY_GUARD",
        `DEXE_TREASURY_GUARD must be one of off|warn, got: ${treasuryGuardRaw}`,
        "using the default 'warn' (advisories stay on)",
      );
    } else {
      treasuryGuard = treasuryGuardRaw;
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

  let forkBlock: number | undefined;
  if (process.env.DEXE_FORK_BLOCK) {
    const n = Number(process.env.DEXE_FORK_BLOCK);
    if (!Number.isFinite(n) || n < 0) {
      degrade(
        "DEXE_FORK_BLOCK",
        `DEXE_FORK_BLOCK must be a non-negative integer, got: ${process.env.DEXE_FORK_BLOCK}`,
        "ignored, forking from the latest block",
      );
    } else {
      forkBlock = n;
    }
  }

  // ---- Phase 2 toolset profiles (DEXE_TOOLSETS) --------------------------
  // Comma list of profile names; default is the slim core+proposals surface.
  // Validation (unknown names → fall back to full) happens in applyToolGate,
  // which has the TOOLSETS registry; config.ts stays layer-clean.
  const toolsetsRaw = process.env.DEXE_TOOLSETS?.trim();
  const toolsets = toolsetsRaw
    ? toolsetsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : ["core", "proposals"];

  // ---- fail closed on a malformed broadcast guard -------------------------
  // Falling back to "no guard" would silently widen what an autonomous agent is
  // allowed to broadcast, which is the opposite of what the operator asked for
  // by setting the var at all. Drop to readonly instead — the server stays up
  // and doctor explains exactly which var to fix.
  if (signerGuardBroken && (privateKey || Object.keys(agentKeys).length > 0)) {
    process.stderr.write(
      "[dexe-mcp] signing disabled: a broadcast-guard variable is malformed (see the config issues above). " +
        "Fix it and restart, or run 'npx dexe-mcp doctor'.\n",
    );
    privateKey = undefined;
    agentKeys = {};
  }

  const statePath = resolveStatePath();

  const defaultChain = chains.get(defaultChainId);

  return Object.freeze({
    protocolPath,
    chains: Object.freeze(new Map(chains)),
    defaultChainId,
    usingPublicRpcFallback: usedPublicFallback,
    chainId: defaultChainId,
    rpcUrl: defaultChain?.rpcUrl,
    registryOverride: defaultChain?.registryOverride ?? registryOverride,
    pinataJwt,
    subgraphUrls: Object.freeze(subgraphUrls),
    subgraphChainId,
    subgraphPoolsUrl,
    subgraphValidatorsUrl,
    subgraphInteractionsUrl,
    backendApiUrl,
    forkBlock,
    privateKey,
    agentKeys,
    startupIssues,
    minSafeQuorumPct,
    treasuryGuard,
    controllingTopN,
    signerAllowlist,
    signerMaxValueWei,
    signerMaxBroadcastsPerMin,
    walletConnectProjectId,
    walletConnectRelayUrl,
    walletConnectApprovalTimeoutMs,
    toolsets,
    statePath,
  }) as DexeConfig;
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
export function resolveChain(config: DexeConfig, chainId?: number): ChainConfig {
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

