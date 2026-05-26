import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProtocolPath, isBuildReady } from "./bootstrap.js";

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
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
  /** GraphQL endpoint URLs for The Graph subgraphs (chain-agnostic in env). */
  subgraphPoolsUrl?: string;
  subgraphValidatorsUrl?: string;
  subgraphInteractionsUrl?: string;
  /** Optional fork block pin (Phase B). */
  forkBlock?: number;
  /** Private key for tx signing. When set, `dexe_tx_send` can broadcast. */
  privateKey?: string;

  /**
   * B6 — destination allowlist for `dexe_tx_send`. Lowercased, checksummed-then-
   * lowercased addresses. Undefined/empty = no restriction.
   */
  signerAllowlist?: string[];
  /** B7 — max wei value per broadcast. Undefined = no cap. */
  signerMaxValueWei?: bigint;
  /** B10 — max broadcasts per rolling minute. Undefined = no limit. */
  signerMaxBroadcastsPerMin?: number;
}

/**
 * Reads environment and returns a frozen config. **Fast and side-effect-free**
 * — safe to await during MCP `initialize`. Does not clone, install, or shell
 * out. The protocol checkout may not exist yet; `ensureBuildReady` handles
 * that lazily from inside build/test tools.
 */
export async function loadConfig(): Promise<DexeConfig> {
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
    chains.set(97, { chainId: 97, rpcUrl: rpcTestnet });
  }
  const rpcMainnet = process.env.DEXE_RPC_URL_MAINNET?.trim() || undefined;
  if (rpcMainnet) {
    chains.set(56, { chainId: 56, rpcUrl: rpcMainnet });
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
    chains.set(cid, { chainId: cid, rpcUrl: url });
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
    // Resolve legacy chainId. If unset, infer from URL hostname; fall back to 56.
    const inferred = legacyChainId ?? inferChainIdFromRpcUrl(legacyRpc) ?? 56;
    // Apply registryOverride only when this is the legacy chain (per-chain
    // override via DEXE_CONTRACTS_REGISTRY has always been single-chain).
    chains.set(inferred, {
      chainId: inferred,
      rpcUrl: legacyRpc,
      registryOverride,
    });
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
    // Multi-chain without explicit default → prefer testnet for safety, else lowest chainId.
    const sorted = [...chains.keys()].sort((a, b) => a - b);
    defaultChainId = chains.has(97) ? 97 : sorted[0]!;
    process.stderr.write(
      `[dexe-mcp] multiple chains configured without DEXE_DEFAULT_CHAIN_ID; defaulting to ${defaultChainId === 97 ? "testnet (97)" : `chain ${defaultChainId}`} for safety. Set DEXE_DEFAULT_CHAIN_ID to override.\n`,
    );
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
  const subgraphPoolsUrl = process.env.DEXE_SUBGRAPH_POOLS_URL?.trim() || undefined;
  const subgraphValidatorsUrl = process.env.DEXE_SUBGRAPH_VALIDATORS_URL?.trim() || undefined;
  const subgraphInteractionsUrl = process.env.DEXE_SUBGRAPH_INTERACTIONS_URL?.trim() || undefined;

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

  let forkBlock: number | undefined;
  if (process.env.DEXE_FORK_BLOCK) {
    const n = Number(process.env.DEXE_FORK_BLOCK);
    if (!Number.isFinite(n) || n < 0) {
      fatal(`DEXE_FORK_BLOCK must be a non-negative integer, got: ${process.env.DEXE_FORK_BLOCK}`);
    }
    forkBlock = n;
  }

  const defaultChain = chains.get(defaultChainId);

  return Object.freeze({
    protocolPath,
    chains: Object.freeze(new Map(chains)),
    defaultChainId,
    chainId: defaultChainId,
    rpcUrl: defaultChain?.rpcUrl,
    registryOverride: defaultChain?.registryOverride ?? registryOverride,
    pinataJwt,
    subgraphPoolsUrl,
    subgraphValidatorsUrl,
    subgraphInteractionsUrl,
    forkBlock,
    privateKey,
    signerAllowlist,
    signerMaxValueWei,
    signerMaxBroadcastsPerMin,
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
