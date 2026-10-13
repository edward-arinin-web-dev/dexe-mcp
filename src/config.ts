import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProtocolPath, isBuildReady } from "./bootstrap.js";
import {
  applyEnvSpec,
  assembleReadConfig,
  createIssueSink,
  DEFAULTS as READ_DEFAULTS,
  resolveChainSet,
  resolveDataSources,
  resolveRiskSettings,
  resolveStatePath,
  resolveToolsetsEnv,
  safeErrorMessage,
  type ReadConfig,
} from "@dexe-network/dexe-mcp/core";
import { ENV_SPEC } from "./env/schema.js";
import { resolveTreasuryGuardMode, type TreasuryGuardMode } from "./lib/treasuryGate.js";
import {
  ignoredHotKeySentence,
  parseUnattendedChains,
  resolveSignerMode,
  unattendedChainFence,
  type SignerMode,
  type SignerModeSource,
  type IgnoredHotKeys,
} from "./lib/signerMode.js";
import { decryptKeystore, parseKeystoreMeta, selectKeystore, weakKdfReason } from "./lib/keystore.js";

/**
 * The WRITE edition's configuration and the single server's config loader.
 *
 * `WriteConfig` is `ReadConfig` (the read edition's configRead.ts — chains, subgraphs, backend,
 * analysis knobs, toolsets, state path) plus what only a server that signs,
 * broadcasts, pins or runs the dev toolchain needs: signing keys and the agent
 * keyring, the broadcast guards, Pinata, WalletConnect, the treasury guard,
 * and the protocol checkout. `loadConfig()` builds it, running the read
 * loader's phases with the write phases in between, in the order the server
 * has always printed its startup lines.
 *
 * Compatibility surface: everything `config.ts` exported before the read/write
 * split is still exported from here (the read half is re-exported from the
 * read edition, @dexe-network/dexe-mcp/core — all of its config module but
 * `DEFAULTS`, which the merged table below replaces, and `loadReadConfig`),
 * and `DexeConfig` is `WriteConfig`.
 *
 * `loadReadConfig` is deliberately NOT re-exported, nor imported anywhere in
 * src/: it deletes every DEXE_ / AGENT_ / SWARM_ var the read edition does not
 * read from `process.env` — in this process, the signing keys
 * (tests/boundary/import-boundary.test.ts).
 */
export {
  applyEnvSpec,
  assembleReadConfig,
  createIssueSink,
  DEFAULT_SUBGRAPH_CHAIN_ID,
  resolveChain,
  resolveChainSet,
  resolveDataSources,
  resolveRiskSettings,
  resolveSubgraphEndpoints,
  resolveToolsetsEnv,
  SUBGRAPH_KINDS,
  subgraphEnvVar,
  type ChainConfig,
  type ChainSet,
  type ConfigIssueSink,
  type DataSources,
  type ReadConfig,
  type RiskSettings,
  type StartupIssue,
  type SubgraphEndpoints,
  type SubgraphKind,
} from "@dexe-network/dexe-mcp/core";

/**
 * Baked defaults only the write edition uses. Same terms as the read
 * `DEFAULTS` (@dexe-network/dexe-mcp/core): they ship publicly on npm + GitHub, the
 * WalletConnect project id is shared, heavy users set their own (dexe_doctor
 * advises this).
 */
export const WRITE_DEFAULTS = {
  walletConnectProjectId: "d3b16069bf12d7cdb9acbc4947b5ed33",
} as const;

/**
 * The single server's view of every baked default: the read table plus
 * WRITE_DEFAULTS, in place of the read `DEFAULTS` (not re-exported above), so
 * pre-split importers of `DEFAULTS.walletConnectProjectId` keep compiling; the
 * read edition never sees the WC id.
 */
export const DEFAULTS = { ...READ_DEFAULTS, ...WRITE_DEFAULTS } as const;

/** The dev toolchain's fields (dexe_compile, dexe_test, introspection). */
export interface DevConfig {
  /** Absolute, normalized path to the DeXe-Protocol checkout (may not exist yet). */
  protocolPath: string;
  /** Optional fork block pin (Phase B). */
  forkBlock?: number;
}

export interface WriteConfig extends ReadConfig, DevConfig {
  /**
   * `DEXE_WRITE_STANDALONE=1`: register the read tools too (the pre-1.0 single
   * server, for a user who runs no read server). Unset or false: write tools
   * only — the DeXe read server beside this one serves the reads. A config
   * built in code that leaves it out is write-only.
   */
  writeStandalone?: boolean;
  /** Pinata JWT for IPFS uploads (reads work without it via gateway). */
  pinataJwt?: string;
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
   * Treasury-safety posture. `off` = silent; `warn` (the default) = advisories /
   * alerts everywhere (build, deploy, execute, risk_assess) that never stop a
   * broadcast; `block` = the opt-in that turns the note into a control, refusing
   * a deploy/execute whose treasury-safety checks actually FAILED.
   *
   * All three postures are first-class here. Typing this field `off | warn`
   * while `treasuryGuardMode()` returned `block` from the same env var is what
   * made an operator who asked for the strictest posture get a startup warning
   * calling their value invalid — and two halves of the server behaving
   * differently. The value is produced by `resolveTreasuryGuardMode`, the ONE
   * parser every surface funnels through. See src/lib/treasuryGate.ts.
   *
   * Harm-reduction only: the durable control is an adequate on-chain quorum
   * threshold configured per DAO.
   */
  treasuryGuard: TreasuryGuardMode;

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
   * 0.37.0 — how this server signs (src/lib/signerMode.ts): walletconnect |
   * keystore | readonly | unattended. Only `unattended` loads hot keys
   * (`privateKey`, `agentKeys` are empty in every other mode).
   */
  signerMode?: SignerMode;
  /** explicit (DEXE_SIGNER_MODE set) | default (unset or invalid). */
  signerModeSource?: SignerModeSource;
  /** Hot-key env vars present but NOT loaded because DEXE_SIGNER_MODE was unset or invalid (1.0.0). */
  hotKeysIgnored?: IgnoredHotKeys;
  /**
   * Chains unattended signing is allowed on. The env loader always sets it in
   * unattended mode (default [97]) and null otherwise; only a config built in
   * code that leaves it out is unfenced.
   */
  unattendedChains?: number[] | null;
  /** keystore mode: the selected keystore file and the address it holds. */
  keystore?: { file: string; address: string };
  /** keystore mode: how long a tool call blocks waiting for the owner (DEXE_APPROVAL_WAIT_MS). */
  approvalWaitMs?: number;
  /** keystore mode: approval lifetime in seconds (DEXE_APPROVAL_TTL_S). */
  approvalTtlS?: number;
  /** keystore mode: open the approval page in the default browser (DEXE_APPROVAL_OPEN_BROWSER). */
  approvalOpenBrowser?: boolean;
  /** keystore mode: seconds an approved batch may wait to be used before its key is dropped (DEXE_APPROVAL_USE_S). */
  approvalUseS?: number;
}

/**
 * The config the single server runs on. Compatibility alias of `WriteConfig`
 * from before the read/write split — new read code takes `ReadConfig`, new
 * write code `WriteConfig`.
 */
export type DexeConfig = WriteConfig;

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
  if (key === "DEXE_SIGNER_MODE") {
    return "ignored — signing falls back to WalletConnect and hot keys are NOT used until it is fixed (a typo never widens to unattended)";
  }
  if (key === "DEXE_UNATTENDED_CHAINS") {
    return "unattended signing is fenced to chain 97 only until it is fixed";
  }
  return "value ignored, using the built-in default";
}

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
 * Reads environment and returns the frozen WRITE config — the read config plus
 * signing, uploads, WalletConnect, the treasury guard and the dev checkout.
 * **Fast and side-effect-free** — safe to await during MCP `initialize`. Does
 * not clone, install, or shell out. The protocol checkout may not exist yet;
 * `ensureBuildReady` handles that lazily from inside build/test tools.
 *
 * Runs the read loader's phases (the read edition's configRead.ts) with the write phases in
 * between, so the startup lines and `startupIssues` come out in the order they
 * always have.
 */
export async function loadWriteConfig(): Promise<WriteConfig> {
  const sink = createIssueSink();
  const { degrade } = sink;
  // Set when a *broadcast guard* var is malformed. A guard that silently
  // degrades into "no guard" would widen what an autonomous agent may send, so
  // those fail CLOSED (readonly) instead of falling back to a default.
  let signerGuardBroken = false;

  // ---- schema-validate the whole DEXE_* env surface up front (R5) ---------
  // Read, write and dev vars, in display order (src/env/schema.ts).
  const rejected = applyEnvSpec(sink, ENV_SPEC, schemaRejectionConsequence);
  if (rejected.some((key) => SIGNER_GUARD_KEYS.has(key))) signerGuardBroken = true;

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

  const chainSet = resolveChainSet(sink);
  const { chains } = chainSet;

  const pinataJwt = process.env.DEXE_PINATA_JWT?.trim() || undefined;
  const dataSources = resolveDataSources(sink);

  // ---- signer mode (0.37.0) ------------------------------------------------
  // Decided ONCE, here, before any key is read: only `unattended` loads hot
  // keys, and only when DEXE_SIGNER_MODE says so — a hot key in the
  // environment never picks the mode (it did, implicitly, before 1.0.0). An
  // invalid DEXE_SIGNER_MODE was already rejected by the ENV_SPEC pass above
  // (deleted + startup issue) and resolves to WalletConnect.
  const hotKeyVars = hotKeyEnvNames(process.env);
  const modeRes = resolveSignerMode({
    requested: process.env.DEXE_SIGNER_MODE,
    // The shared default project id makes WalletConnect available on every install.
    walletConnectConfigured: true,
  });
  const signerMode: SignerMode = modeRes.mode;
  const signerModeSource: SignerModeSource = modeRes.source;
  // Hot keys present while the mode is unset or invalid: the pre-1.0 setup
  // that signed unattended. Recorded so the doctor, dexe_write_context and
  // every no-signer write response can say WHY nothing signs.
  const hotKeysIgnored: IgnoredHotKeys | undefined =
    signerModeSource === "default" && hotKeyVars.length > 0
      ? { vars: hotKeyVars, reason: rejected.includes("DEXE_SIGNER_MODE") ? "invalid" : "unset" }
      : undefined;
  if (hotKeysIgnored) {
    process.stderr.write(`[dexe-mcp] ⚠️ ${ignoredHotKeySentence(hotKeysIgnored)}\n`);
  } else if (signerMode !== "unattended" && hotKeyVars.length > 0) {
    process.stderr.write(
      `[dexe-mcp] ${hotKeyVars.join(", ")} ${hotKeyVars.length === 1 ? "is" : "are"} IGNORED: DEXE_SIGNER_MODE=${signerMode} ` +
        "never signs with a hot key. Move the key into the encrypted keystore with `dexe-mcp key import --from-env` " +
        "(it removes the plaintext line), or set DEXE_SIGNER_MODE=unattended to sign with it unattended.\n",
    );
  }

  let privateKey = signerMode === "unattended" ? process.env.DEXE_PRIVATE_KEY?.trim() || undefined : undefined;

  // Unattended/CI only: the primary key may come from the keystore, unlocked
  // with DEXE_KEYSTORE_PASSWORD_FILE. Keystore mode NEVER reads this file —
  // there the password is typed by the owner, per batch, on the approval page.
  const passwordFile = process.env.DEXE_KEYSTORE_PASSWORD_FILE?.trim() || undefined;
  if (signerMode === "unattended" && !privateKey && passwordFile) {
    const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: process.env.DEXE_KEYSTORE_ADDRESS });
    if ("error" in sel) {
      degrade("DEXE_KEYSTORE_PASSWORD_FILE", `DEXE_KEYSTORE_PASSWORD_FILE is set but ${sel.error}`, "no primary key loaded");
    } else {
      try {
        const password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
        privateKey = (await decryptKeystore(readFileSync(sel.file, "utf8"), password, sel.address)).privateKey;
        process.stderr.write(`[dexe-mcp] unattended primary key unlocked from keystore ${sel.address} (password file)\n`);
      } catch (err) {
        degrade(
          "DEXE_KEYSTORE_PASSWORD_FILE",
          `could not unlock ${sel.file} with DEXE_KEYSTORE_PASSWORD_FILE: ${safeErrorMessage(err)}`,
          "no primary key loaded",
        );
      }
    }
  } else if (signerMode !== "unattended" && passwordFile) {
    process.stderr.write(
      `[dexe-mcp] DEXE_KEYSTORE_PASSWORD_FILE is ignored in ${signerMode} mode — the keystore password is only ever ` +
        "typed by its owner on the approval page.\n",
    );
  }

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
  // Hot keys load in unattended mode only (see the signer-mode block above).
  let agentKeys =
    signerMode === "unattended"
      ? parseAgentKeys(process.env, (message) =>
          degrade("DEXE_AGENT_PK_*", message, "that key is skipped; the other slots still load"),
        )
      : {};
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
  const walletConnectProjectId = wcFromEnv || WRITE_DEFAULTS.walletConnectProjectId;
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
  if (signerMode !== "walletconnect") {
    // Another mode signs; WalletConnect stays available for dexe_wc_connect /
    // message signing but is not the dispatch path. The mode lines below say so.
  } else if (wcFromEnv) {
    process.stderr.write("[dexe-mcp] WalletConnect signing available (project id from env)\n");
  } else {
    process.stderr.write(
      "[dexe-mcp] WalletConnect signing available (shared default project id) — connect a wallet with dexe_wc_connect; set DEXE_WALLETCONNECT_PROJECT_ID to use your own.\n",
    );
  }

  // ---- unattended chain fence (0.37.0) -------------------------------------
  // A malformed DEXE_UNATTENDED_CHAINS was deleted by the ENV_SPEC pass; it
  // must fail CLOSED (testnet only), never fall through to "no fence".
  const parsedChains = parseUnattendedChains(process.env.DEXE_UNATTENDED_CHAINS);
  const fenceRejected =
    rejected.includes("DEXE_UNATTENDED_CHAINS") || (parsedChains !== null && !Array.isArray(parsedChains));
  const unattendedChains: number[] | null =
    signerMode !== "unattended"
      ? null
      : fenceRejected
        ? [97]
        : unattendedChainFence(Array.isArray(parsedChains) ? parsedChains : null);
  if (signerMode === "unattended" && (privateKey || Object.keys(agentKeys).length > 0)) {
    process.stderr.write(
      `[dexe-mcp] signer mode: unattended — hot keys sign with NO human confirmation, on chain(s) ${
        unattendedChains?.join(", ") ?? "any"
      } only (DEXE_UNATTENDED_CHAINS).\n`,
    );
  }

  // ---- keystore mode (0.37.0) ----------------------------------------------
  let keystore: { file: string; address: string } | undefined;
  if (signerMode === "keystore") {
    const sel = selectKeystore({ path: process.env.DEXE_KEYSTORE_PATH, address: process.env.DEXE_KEYSTORE_ADDRESS });
    if ("error" in sel) {
      degrade(
        "DEXE_KEYSTORE_PATH",
        `DEXE_SIGNER_MODE=keystore but ${sel.error}.`,
        "keystore signing unavailable — write tools return unsigned payloads until a keystore exists",
      );
    } else if (chains.size === 0) {
      degrade(
        "DEXE_KEYSTORE_PATH",
        "keystore signing requires at least one of DEXE_RPC_URL / DEXE_RPC_URL_TESTNET / DEXE_RPC_URL_MAINNET (signing needs an RPC endpoint).",
        "keystore signing unavailable — set an RPC URL and restart",
      );
    } else if (keystoreWeakness(sel.file)) {
      degrade(
        "DEXE_KEYSTORE_PATH",
        keystoreWeakness(sel.file)!,
        "keystore signing refused — write tools return unsigned payloads until the keystore is re-encrypted",
      );
    } else {
      keystore = sel;
      process.stderr.write(
        `[dexe-mcp] signer mode: keystore (${sel.address}) — every batch waits for the owner's password on a local approval page\n`,
      );
    }
  }
  const approvalWaitMs = boundedInt(process.env.DEXE_APPROVAL_WAIT_MS, 120_000, 0, 600_000);
  const approvalTtlS = boundedInt(process.env.DEXE_APPROVAL_TTL_S, 900, 60, 3600);
  const approvalUseS = boundedInt(process.env.DEXE_APPROVAL_USE_S, 120, 10, approvalTtlS);
  const approvalOpenBrowser = !/^(0|false|no|off)$/i.test(process.env.DEXE_APPROVAL_OPEN_BROWSER?.trim() ?? "");
  const writeStandalone = isWriteStandalone(process.env);

  const risk = resolveRiskSettings(sink);
  // DEXE_TREASURY_GUARD resolves through `resolveTreasuryGuardMode` — the same
  // function the ENV_SPEC validator refines with and `treasuryGuardMode()` calls
  // at tool time, so startup, doctor and every call site read one raw value the
  // same way. The hand-written copy that used to stand here knew only
  // `off|warn`: it rejected `block` as MALFORMED and degraded to `warn` while
  // the runtime honoured it, so an operator who asked for the strictest posture
  // got a warning saying their value was invalid and two halves of the server
  // behaving differently.
  //
  // No second rejection branch here on purpose. A malformed value has already
  // been recorded as a startup issue AND deleted from `process.env` by the
  // ENV_SPEC pass above (0.30.1: degrade, never exit), so it arrives as
  // `undefined` and lands on the SAFE default — `warn`, never `off`, because a
  // typo must not silence the guard. Re-checking it here would be a branch that
  // can never run, which is how a "guard" becomes decoration.
  const treasuryGuard: TreasuryGuardMode = resolveTreasuryGuardMode(
    process.env.DEXE_TREASURY_GUARD,
  ).mode;

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

  const toolsets = resolveToolsetsEnv();

  // ---- fail closed on a malformed broadcast guard -------------------------
  // Falling back to "no guard" would silently widen what an autonomous agent is
  // allowed to broadcast, which is the opposite of what the operator asked for
  // by setting the var at all. Drop to readonly instead — the server stays up
  // and doctor explains exactly which var to fix.
  if (signerGuardBroken && (privateKey || Object.keys(agentKeys).length > 0 || keystore)) {
    process.stderr.write(
      "[dexe-mcp] signing disabled: a broadcast-guard variable is malformed (see the config issues above). " +
        "Fix it and restart, or run 'npx dexe-mcp doctor'.\n",
    );
    privateKey = undefined;
    agentKeys = {};
    keystore = undefined;
  }

  const read = assembleReadConfig({
    ...chainSet,
    ...dataSources,
    ...risk,
    startupIssues: sink.startupIssues,
    toolsets,
    statePath: resolveStatePath(),
  });

  // Field order is the pre-split `DexeConfig` order, so anything that walks
  // the object sees the same shape.
  return Object.freeze({
    protocolPath,
    chains: read.chains,
    defaultChainId: read.defaultChainId,
    usingPublicRpcFallback: read.usingPublicRpcFallback,
    chainId: read.chainId,
    rpcUrl: read.rpcUrl,
    registryOverride: read.registryOverride,
    pinataJwt,
    subgraphUrls: read.subgraphUrls,
    subgraphChainId: read.subgraphChainId,
    subgraphPoolsUrl: read.subgraphPoolsUrl,
    subgraphValidatorsUrl: read.subgraphValidatorsUrl,
    subgraphInteractionsUrl: read.subgraphInteractionsUrl,
    backendApiUrl: read.backendApiUrl,
    forkBlock,
    privateKey,
    agentKeys,
    startupIssues: read.startupIssues,
    minSafeQuorumPct: read.minSafeQuorumPct,
    treasuryGuard,
    controllingTopN: read.controllingTopN,
    signerAllowlist,
    signerMaxValueWei,
    signerMaxBroadcastsPerMin,
    walletConnectProjectId,
    walletConnectRelayUrl,
    walletConnectApprovalTimeoutMs,
    toolsets: read.toolsets,
    statePath: read.statePath,
    signerMode,
    signerModeSource,
    hotKeysIgnored,
    unattendedChains,
    keystore,
    approvalWaitMs,
    approvalTtlS,
    approvalOpenBrowser,
    approvalUseS,
    writeStandalone,
  });
}

/**
 * `DEXE_WRITE_STANDALONE` as the server reads it: `1` / `true` register the
 * read tools too, anything else (unset, `0`, `false`, a value the env spec
 * rejected and deleted at startup) is write-only. Also read by the degraded
 * startup server (src/index.ts), which runs when `loadConfig` itself failed.
 */
export function isWriteStandalone(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true)$/i.test(env.DEXE_WRITE_STANDALONE?.trim() ?? "");
}

/** Env var names that hold a hot key (set and non-empty). DEXE_-prefixed and swarm aliases both count. */
export function hotKeyEnvNames(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const has = (k: string) => !!env[k]?.trim();
  if (has("DEXE_PRIVATE_KEY")) out.push("DEXE_PRIVATE_KEY");
  for (let n = 1; n <= 16; n++) {
    if (has(`DEXE_AGENT_PK_${n}`)) out.push(`DEXE_AGENT_PK_${n}`);
    else if (has(`AGENT_PK_${n}`)) out.push(`AGENT_PK_${n}`);
  }
  if (has("DEXE_AGENT_FUNDER_PK")) out.push("DEXE_AGENT_FUNDER_PK");
  else if (has("AGENT_FUNDER_PK")) out.push("AGENT_FUNDER_PK");
  return out;
}

/** Why the keystore file is refused for keystore mode (weak KDF / unreadable), or null. */
function keystoreWeakness(file: string): string | null {
  try {
    return weakKdfReason(parseKeystoreMeta(readFileSync(file, "utf8")));
  } catch (err) {
    return `the keystore ${file} could not be read: ${safeErrorMessage(err)}`;
  }
}

/** Digits-only integer clamped to [min, max]; anything else → `fallback` (the env spec reports a bad value). */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const t = raw?.trim();
  if (!t || !/^\d+$/.test(t)) return fallback;
  return Math.min(max, Math.max(min, Number(t)));
}

/** The single server's config loader — `loadWriteConfig`, under its pre-split name. */
export function loadConfig(): Promise<WriteConfig> {
  return loadWriteConfig();
}
