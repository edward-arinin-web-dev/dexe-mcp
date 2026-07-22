import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProtocolPath, isBuildReady } from "./bootstrap.js";
import { resolveStatePath } from "./lib/stateStore.js";
import { parseEnv } from "./env/parse.js";

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
   * GraphQL endpoint URLs for The Graph subgraphs (chain-agnostic in env).
   * Default to the shared DeXe public gateway endpoints (`DEFAULTS.subgraph*`)
   * so reads work zero-config; a user `.env` overrides. Always set.
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
   * ≥1 controlling member voted For. Default 5. Subgraph/mainnet-only.
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
export async function loadConfig(): Promise<DexeConfig> {
  // ---- schema-validate the DEXE_* env surface up front (R5) ---------------
  // parse.ts walks ENV_SPEC; an invalid value (malformed URL, non-integer,
  // bad enum) is a config error the user should see at startup, not a
  // confusing late failure deep inside a tool call. Doctor performs the same
  // validation; this makes startup honest about it too.
  {
    const { issues } = parseEnv();
    const errors = issues.filter((i) => i.severity === "error");
    for (const issue of issues) {
      process.stderr.write(`[dexe-mcp] env ${issue.severity}: ${issue.message}\n`);
    }
    if (errors.length > 0) {
      fatal(
        `invalid environment: ${errors.map((i) => i.key).join(", ")} — fix the value(s) in .env and restart. Run 'npx dexe-mcp doctor' for details.`,
      );
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
      fatal(`DEXE_CHAIN_ID must be a positive integer, got: ${process.env.DEXE_CHAIN_ID}`);
    }
    legacyChainId = n;
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
  let defaultChainId: number;
  const explicitDefault = process.env.DEXE_DEFAULT_CHAIN_ID?.trim();
  if (explicitDefault) {
    const n = Number(explicitDefault);
    if (!Number.isFinite(n) || n <= 0) {
      fatal(`DEXE_DEFAULT_CHAIN_ID must be a positive integer, got: ${explicitDefault}`);
    }
    if (!chains.has(n)) {
      const configured = [...chains.keys()].sort().join(", ") || "none";
      fatal(
        `DEXE_DEFAULT_CHAIN_ID=${n} but no RPC configured for that chain. Configured: [${configured}]. Set DEXE_RPC_URL_${n === 97 ? "TESTNET" : n === 56 ? "MAINNET" : "<chain>"} or legacy DEXE_RPC_URL.`,
      );
    }
    defaultChainId = n;
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
  // Subgraph endpoints + backend URL fall back to the baked public defaults so
  // reads work zero-config. A user `.env` (or a private Graph key embedded in
  // their own URL) overrides.
  const subgraphPoolsUrl = process.env.DEXE_SUBGRAPH_POOLS_URL?.trim() || DEFAULTS.subgraphPoolsUrl;
  const subgraphValidatorsUrl =
    process.env.DEXE_SUBGRAPH_VALIDATORS_URL?.trim() || DEFAULTS.subgraphValidatorsUrl;
  const subgraphInteractionsUrl =
    process.env.DEXE_SUBGRAPH_INTERACTIONS_URL?.trim() || DEFAULTS.subgraphInteractionsUrl;
  const backendApiUrl = process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl;

  const privateKey = process.env.DEXE_PRIVATE_KEY?.trim() || undefined;
  if (privateKey && chains.size === 0) {
    fatal(
      "DEXE_PRIVATE_KEY requires at least one of DEXE_RPC_URL / DEXE_RPC_URL_TESTNET / DEXE_RPC_URL_MAINNET to be set (signing needs an RPC endpoint).",
    );
  }
  if (privateKey) {
    const { Wallet } = await import("ethers");
    const addr = new Wallet(privateKey).address;
    process.stderr.write(`[dexe-mcp] signing enabled for ${addr}\n`);
    process.stderr.write(
      `[dexe-mcp] ⚠️ NOT SAFE: hot key in plaintext on disk — prefer WalletConnect (dexe_wc_connect); use only a throwaway wallet\n`,
    );
  }

  // ---- opt-in agent keyring (DEXE_AGENT_PK_1..16) -------------------------
  // Multi-persona/swarm flows: each key becomes signerKey "agent<n>" on
  // dexe_tx_send + the composites. Requires the primary signer path's RPC
  // preconditions; keys are hex64-validated by the env schema walk above.
  const agentKeys: Record<string, string> = {};
  for (let n = 1; n <= 16; n++) {
    const v = process.env[`DEXE_AGENT_PK_${n}`]?.trim();
    if (v) agentKeys[`agent${n}`] = v;
  }
  if (Object.keys(agentKeys).length > 0) {
    if (chains.size === 0) {
      fatal("DEXE_AGENT_PK_* requires an RPC endpoint (same requirement as DEXE_PRIVATE_KEY).");
    }
    const { Wallet } = await import("ethers");
    const names = Object.keys(agentKeys);
    process.stderr.write(
      `[dexe-mcp] agent keyring: ${names.length} key(s) — ${names
        .map((k) => `${k}=${new Wallet(agentKeys[k]!).address.slice(0, 10)}…`)
        .join(", ")} (select via signerKey)\n`,
    );
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
        fatal(`DEXE_SIGNER_ALLOWLIST contains an invalid address: ${entry}`);
      }
      normalized.push(getAddress(entry).toLowerCase());
    }
    if (normalized.length > 0) signerAllowlist = normalized;
  }

  // ---- signer broadcast guard B7 (value cap) -----------------------------
  let signerMaxValueWei: bigint | undefined;
  const maxValueRaw = process.env.DEXE_SIGNER_MAX_VALUE_WEI?.trim();
  if (maxValueRaw) {
    let parsed: bigint;
    try {
      parsed = BigInt(maxValueRaw);
    } catch {
      fatal(`DEXE_SIGNER_MAX_VALUE_WEI must be a non-negative integer (wei), got: ${maxValueRaw}`);
    }
    if (parsed! < 0n) {
      fatal(`DEXE_SIGNER_MAX_VALUE_WEI must be a non-negative integer (wei), got: ${maxValueRaw}`);
    }
    signerMaxValueWei = parsed!;
  }

  // ---- signer broadcast guard B10 (rate limit) ---------------------------
  let signerMaxBroadcastsPerMin: number | undefined;
  const maxBroadcastsRaw = process.env.DEXE_SIGNER_MAX_BROADCASTS_PER_MIN?.trim();
  if (maxBroadcastsRaw) {
    const n = Number(maxBroadcastsRaw);
    if (!Number.isInteger(n) || n <= 0) {
      fatal(`DEXE_SIGNER_MAX_BROADCASTS_PER_MIN must be a positive integer, got: ${maxBroadcastsRaw}`);
    }
    signerMaxBroadcastsPerMin = n;
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
      fatal(`DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS must be a positive integer (ms), got: ${wcTimeoutRaw}`);
    }
    walletConnectApprovalTimeoutMs = n;
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
      fatal(`DEXE_MIN_SAFE_QUORUM_PCT must be a number between 0 and 100, got: ${minQuorumRaw}`);
    }
    minSafeQuorumPct = n;
  }
  let treasuryGuard: "off" | "warn" = "warn";
  const treasuryGuardRaw = process.env.DEXE_TREASURY_GUARD?.trim().toLowerCase();
  if (treasuryGuardRaw) {
    if (treasuryGuardRaw !== "off" && treasuryGuardRaw !== "warn") {
      fatal(`DEXE_TREASURY_GUARD must be one of off|warn, got: ${treasuryGuardRaw}`);
    }
    treasuryGuard = treasuryGuardRaw;
  }
  let controllingTopN = 5;
  const controllingTopNRaw = process.env.DEXE_CONTROLLING_TOPN?.trim();
  if (controllingTopNRaw) {
    const n = Number(controllingTopNRaw);
    if (!Number.isInteger(n) || n <= 0) {
      fatal(`DEXE_CONTROLLING_TOPN must be a positive integer, got: ${controllingTopNRaw}`);
    }
    controllingTopN = n;
  }

  let forkBlock: number | undefined;
  if (process.env.DEXE_FORK_BLOCK) {
    const n = Number(process.env.DEXE_FORK_BLOCK);
    if (!Number.isFinite(n) || n < 0) {
      fatal(`DEXE_FORK_BLOCK must be a non-negative integer, got: ${process.env.DEXE_FORK_BLOCK}`);
    }
    forkBlock = n;
  }

  // ---- Phase 2 toolset profiles (DEXE_TOOLSETS) --------------------------
  // Comma list of profile names; default is the slim core+proposals surface.
  // Validation (unknown names → fall back to full) happens in applyToolGate,
  // which has the TOOLSETS registry; config.ts stays layer-clean.
  const toolsetsRaw = process.env.DEXE_TOOLSETS?.trim();
  const toolsets = toolsetsRaw
    ? toolsetsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : ["core", "proposals"];

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
    subgraphPoolsUrl,
    subgraphValidatorsUrl,
    subgraphInteractionsUrl,
    backendApiUrl,
    forkBlock,
    privateKey,
    agentKeys,
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

function fatal(msg: string): never {
  // stderr only — stdout is the MCP protocol channel.
  process.stderr.write(`[dexe-mcp] fatal: ${msg}\n`);
  process.exit(1);
}
