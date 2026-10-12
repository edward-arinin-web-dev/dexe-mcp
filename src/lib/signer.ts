import { getAddress, Wallet } from "ethers";
import { resolveChain, type DexeConfig } from "../config.js";
import { createChainProvider } from "../rpc.js";
import { hintFor, type EnvGuardResult } from "./requireEnv.js";
import { ENV_SPEC } from "../env/schema.js";
import { safeErrorMessage } from "./redact.js";
import { attachBroadcastRecorder, registerLedgerSecrets } from "./agentLedger.js";
import { type SignerMode, type SignerModeSource } from "./signerMode.js";
import { ApprovalManager } from "./approval/index.js";

export {
  resolveSignerMode,
  signerDispatch,
  humanConfirms,
  IMPLICIT_UNATTENDED_DEPRECATION,
  type SignerMode,
  type SignerModeSource,
} from "./signerMode.js";

/**
 * Thrown by {@link SignerManager} when no signing key is configured for the
 * requested slot. A marker class so callers branch on the CAUSE rather than on
 * a substring of the message — the message is remediation prose and will change.
 */
export class NoSignerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSignerKeyError";
  }
}

/**
 * Thrown when a hot-key path asks for a wallet the mode does not allow:
 * keystore mode never hands out a Wallet (it signs only through an approved
 * batch), and unattended mode refuses chains outside DEXE_UNATTENDED_CHAINS.
 */
export class SignerModeRefusal extends Error {
  constructor(
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "SignerModeRefusal";
  }
}

/** One message for "keystore mode does not do this yet" (Safe typed data, EIP-191). */
export const KEYSTORE_NO_MESSAGE_SIGNING =
  "Keystore mode signs transactions only (each batch approved on the local page). Message and typed-data " +
  "signatures (off-chain login, Safe transactions) are not supported in keystore mode yet - connect a phone " +
  "wallet with dexe_wc_connect for this step, or take the unsigned payload and sign it in your own wallet.";

/**
 * Signer registry. The primary key (`DEXE_PRIVATE_KEY`) is the default; the
 * opt-in agent keyring (`DEXE_AGENT_PK_1..16` → signerKey "agent1"…"agent16")
 * backs multi-persona/swarm flows. Keys are chain-agnostic; only the provider
 * differs per chain, so wallets are cached per (signer, chain).
 *
 * **Attribution (0.32.0).** Resolving a key used to record nothing, so a fleet
 * of personas produced a pile of unattributable transactions. Every wallet this
 * class hands out is instrumented at creation
 * (`attachBroadcastRecorder`), which means a broadcast is logged to the agent
 * ledger from *any* call site — present or future — instead of from the ones
 * that remembered to. `dexe_agents_fund` shipped with every broadcast guard
 * missing; a logging call would have been forgotten in exactly the same way.
 *
 * The keys themselves never reach the ledger: only the slot label and the
 * resolved address are recorded, and the constructor hands the ledger's
 * scrubber a SHA-256 of each configured key so a key that arrives through some
 * *other* field can be recognized and dropped without ever being stored.
 */
export class SignerManager {
  private readonly cache = new Map<string, Wallet>();
  /** Per-(chain, signer-address) broadcast serialization queue (H-12 nonce guard). */
  private readonly broadcastQueues = new Map<string, Promise<unknown>>();
  private readonly key: string | undefined;
  private readonly agentKeys: Record<string, string>;
  private readonly config: DexeConfig;
  /** How this server signs (src/lib/signerMode.ts). */
  readonly mode: SignerMode;
  readonly modeSource: SignerModeSource;
  /** keystore mode: the file and the address it holds. Never the key. */
  private readonly keystore: { file: string; address: string } | undefined;
  private approvalManager: ApprovalManager | undefined;

  constructor(config: DexeConfig) {
    this.config = config;
    // A config built by hand (tests, embedders) carries no mode: infer the
    // pre-0.37 behaviour - keys sign unattended, no key means WalletConnect.
    const hasHot = !!config.privateKey || Object.keys(config.agentKeys ?? {}).length > 0;
    this.mode = config.signerMode ?? (hasHot ? "unattended" : "walletconnect");
    this.modeSource =
      config.signerModeSource ?? (config.signerMode ? "explicit" : hasHot ? "implicit-hot-key" : "default");
    // Hot keys exist ONLY in unattended mode. The config loader already drops
    // them in every other mode; this is the second lock on the same door.
    this.key = this.mode === "unattended" ? config.privateKey : undefined;
    this.agentKeys = this.mode === "unattended" ? (config.agentKeys ?? {}) : {};
    this.keystore = this.mode === "keystore" ? config.keystore : undefined;
    // Digests only — the ledger scrubber can then recognize a key that arrives
    // through a free-text or hash-shaped field (a tx hash and a private key are
    // byte-identical in shape) without anything holding the key itself.
    registerLedgerSecrets([this.key, ...Object.values(this.agentKeys)]);
  }

  /** The chains unattended mode may sign on; null = no fence (transitional implicit mode). */
  get unattendedChains(): number[] | null {
    return this.mode === "unattended" ? (this.config.unattendedChains ?? null) : null;
  }

  /** keystore mode: the approval flow (created on first use). Undefined in every other mode. */
  get approvals(): ApprovalManager | undefined {
    if (this.mode !== "keystore" || !this.keystore) return undefined;
    if (!this.approvalManager) {
      const ks = this.keystore;
      this.approvalManager = new ApprovalManager({
        keystoreFile: ks.file,
        address: ks.address,
        waitMs: this.config.approvalWaitMs ?? 120_000,
        ttlMs: (this.config.approvalTtlS ?? 900) * 1000,
        openBrowser: this.config.approvalOpenBrowser ?? true,
        storeOptions: { useWindowMs: (this.config.approvalUseS ?? 120) * 1000 },
        connect: (pk, chainId) => this.walletFor(pk, chainId, "keystore"),
        lock: (chainId, task) => this.withBroadcastLock(chainId, task, ks.address),
        log: (line) => void process.stderr.write(`${line}\n`),
      });
    }
    return this.approvalManager;
  }

  /** A provider-bound, ledger-instrumented wallet for `pk` on `chainId`. Never cached. */
  private walletFor(pk: string, chainId: number, label: string): Wallet {
    const chain = resolveChain(this.config, chainId);
    const wallet = new Wallet(pk, createChainProvider(chain, this.config));
    attachBroadcastRecorder(wallet, { signerKey: label, address: wallet.address, chainId: chain.chainId });
    return wallet;
  }

  /**
   * `signerKey` semantics everywhere in this class:
   *   undefined      → the primary DEXE_PRIVATE_KEY signer
   *   "agent<n>"     → keyring slot (case-insensitive)
   *   an 0x address  → whichever configured key (primary or agent) derives it
   */
  private resolveKey(signerKey?: string): string | undefined {
    if (!signerKey) return this.key;
    const norm = signerKey.trim().toLowerCase();
    const byName = this.agentKeys[norm];
    if (byName) return byName;
    if (norm.startsWith("0x") && norm.length === 42) {
      for (const k of [this.key, ...Object.values(this.agentKeys)]) {
        if (k && new Wallet(k).address.toLowerCase() === norm) return k;
      }
      this.failUnknownSigner(signerKey);
    }
    this.failUnknownSigner(signerKey);
  }

  /**
   * Canonical slot label for a resolved key: "primary", a keyring slot
   * ("agent1"…, "funder"), or "unknown" for a key that is somehow neither.
   *
   * The requested name wins when it names a real slot, so a key that is BOTH
   * `DEXE_PRIVATE_KEY` and `AGENT_PK_1` is attributed to whichever identity the
   * caller acted as. Comparison is on the key values, which never leave this
   * object.
   */
  private labelFor(key: string, requested?: string): string {
    const norm = requested?.trim().toLowerCase();
    if (norm && this.agentKeys[norm]) return norm;
    const k = key.toLowerCase();
    if (this.key && this.key.toLowerCase() === k) return "primary";
    for (const [slot, pk] of Object.entries(this.agentKeys)) {
      if (pk.toLowerCase() === k) return slot;
    }
    return "unknown";
  }

  /**
   * Who a `signerKey` resolves to — the label the agent ledger attributes to,
   * plus the address. Lets an orchestrating tool report "agent3 (0xabc…) did
   * X" without touching key material. Throws if the key is not configured.
   */
  describeSigner(signerKey?: string): { signerKey: string; address: string } {
    if (this.mode === "keystore") {
      if (this.keystoreMatches(signerKey)) return { signerKey: "keystore", address: this.keystore!.address };
      this.failNoKey();
    }
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    return { signerKey: this.labelFor(key, signerKey), address: new Wallet(key).address };
  }

  /** Registered keyring entries (never the keys themselves). */
  listAgents(): Array<{ signerKey: string; address: string }> {
    return Object.entries(this.agentKeys).map(([signerKey, pk]) => ({
      signerKey,
      address: new Wallet(pk).address,
    }));
  }

  hasAgents(): boolean {
    return Object.keys(this.agentKeys).length > 0;
  }

  hasSigner(signerKey?: string): boolean {
    if (this.mode === "keystore") return this.keystoreMatches(signerKey);
    if (!signerKey) return !!this.key;
    try {
      return !!this.resolveKey(signerKey);
    } catch {
      return false;
    }
  }

  /** The config this signer was built from — lets broadcast paths reach the guard env. */
  getConfig(): DexeConfig {
    return this.config;
  }

  /**
   * Address of a configured signer (chain-agnostic — same EOA across chains).
   * Throws if the requested key is not configured.
   */
  getAddress(signerKey?: string): string {
    if (this.mode === "keystore") {
      if (this.keystoreMatches(signerKey)) return this.keystore!.address;
      this.failNoKey();
    }
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    return new Wallet(key).address;
  }

  /**
   * Return a signer bound to the requested chain's RPC. When `chainId` is
   * omitted the default chain is used; when `signerKey` is omitted the
   * primary key is used.
   */
  requireSigner(chainId?: number, signerKey?: string): Wallet {
    if (this.mode === "keystore") {
      // The keystore key is never handed out as a Wallet: it signs only inside
      // an ApprovedSigner, for a batch the owner approved with the password.
      throw new SignerModeRefusal(
        "Keystore mode signs only through an approved batch (dexe_tx_send and the composites ask the owner on a " +
          "local approval page). Nothing on this path may sign with the keystore.",
        "Use dexe_tx_send or a composite; for message / Safe signatures connect WalletConnect (dexe_wc_connect).",
      );
    }
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    const chain = resolveChain(this.config, chainId);
    const fence = this.unattendedChains;
    if (fence && !fence.includes(chain.chainId)) {
      throw new SignerModeRefusal(
        `Unattended signing is fenced to chain(s) ${fence.join(", ")} (DEXE_UNATTENDED_CHAINS) - refusing to sign ` +
          `on chain ${chain.chainId}. Nothing was signed.`,
        `To sign on chain ${chain.chainId} with a human confirming each batch, use DEXE_SIGNER_MODE=keystore or ` +
          `walletconnect. To let hot keys sign there unattended, add it deliberately: ` +
          `DEXE_UNATTENDED_CHAINS=${[...fence, chain.chainId].join(",")} (and set DEXE_SIGNER_ALLOWLIST / ` +
          "DEXE_SIGNER_MAX_VALUE_WEI caps), then restart.",
      );
    }
    const cacheKey = `${chain.chainId}:${signerKey ? new Wallet(key).address : "primary"}`;
    let wallet = this.cache.get(cacheKey);
    if (!wallet) {
      // Shared resilient factory (R1): the signer's reads (nonce, gas
      // estimate, receipt polling) get the same retry + URL-rotation + hint
      // behavior as every read tool. Broadcasts themselves are never retried
      // at the transport layer (see ResilientRpcProvider).
      const provider = createChainProvider(chain, this.config);
      wallet = new Wallet(key, provider);
      // Attribution hook: instrument the wallet ONCE, here, where every signer
      // in the process is born. Doing it at the broadcast call sites would make
      // the record optional, and an optional record is a missing record.
      attachBroadcastRecorder(wallet, {
        signerKey: this.labelFor(key, signerKey),
        address: wallet.address,
        chainId: chain.chainId,
      });
      this.cache.set(cacheKey, wallet);
    }
    return wallet;
  }

  /**
   * Soft variant of `requireSigner` — returns a structured `{error, remediation}`
   * instead of throwing when the key or RPC is missing. Hot tool paths use
   * this so missing env surfaces as a clean MCP error with fix instructions
   * instead of a thrown stack trace.
   */
  trySigner(chainId?: number, signerKey?: string): EnvGuardResult<Wallet> {
    try {
      return { ok: this.requireSigner(chainId, signerKey) };
    } catch (err) {
      return {
        error: safeErrorMessage(err),
        // The no-key message already carries the full hintFor() remedy, so
        // repeating it here printed the same three sentences twice wherever a
        // caller joins `error` + `remediation` (sendOrCollect does). Every
        // OTHER cause (unknown signerKey, provider construction) still needs it.
        remediation:
          err instanceof SignerModeRefusal
            ? err.remediation
            : err instanceof NoSignerKeyError
              ? "Run dexe_doctor to confirm which .env this server loaded, then restart Claude Code after editing it."
              : hintFor(["DEXE_PRIVATE_KEY"], ENV_SPEC),
      };
    }
  }

  /**
   * Sign an arbitrary message (EIP-191 personal_sign) with a configured EOA
   * key. Used for off-chain backend auth (nonce login) — the same opt-in signer
   * surface as `requireSigner`/`dexe_tx_send`, so an AI agent never has to
   * extract the key into its own signing code. Chain-agnostic (no provider
   * needed for message signing). Throws if the key is not configured.
   */
  async signMessage(message: string, signerKey?: string, forChainId?: number): Promise<string> {
    if (this.mode === "keystore") throw new SignerModeRefusal(KEYSTORE_NO_MESSAGE_SIGNING, "dexe_wc_connect");
    const key = this.resolveKey(signerKey);
    if (!key) this.failNoKey();
    // The unattended fence covers signatures too: a backend login for chain 56
    // is as much a mainnet act as a mainnet transaction. A message with no
    // stated chain is refused while a fence is on (fail closed).
    const fence = this.unattendedChains;
    if (fence && (forChainId === undefined || !fence.includes(forChainId))) {
      throw new SignerModeRefusal(
        `Unattended signing is fenced to chain(s) ${fence.join(", ")} (DEXE_UNATTENDED_CHAINS) — refusing to sign a ` +
          `message for ${forChainId === undefined ? "an unspecified chain" : `chain ${forChainId}`}. Nothing was signed.`,
        `Add ${forChainId ?? "the chain"} to DEXE_UNATTENDED_CHAINS deliberately, or sign this with WalletConnect (dexe_wc_connect).`,
      );
    }
    return new Wallet(key).signMessage(message);
  }

  /**
   * Serialize broadcasts per (chain, signer address). Concurrent
   * `dexe_tx_send` / composite-flow calls that share ONE EOA would otherwise
   * invoke `sendTransaction` at the same time, both read the same pending
   * nonce, and one transaction is silently dropped (or hangs until timeout) —
   * H-12. Distinct agent signers have independent nonces, so they get
   * independent queues and still broadcast concurrently. Task failures are
   * isolated so a queue keeps flowing.
   */
  async withBroadcastLock<T>(chainId: number, task: () => Promise<T>, signerAddress?: string): Promise<T> {
    const queueKey = `${chainId}:${(signerAddress ?? "primary").toLowerCase()}`;
    const prev = this.broadcastQueues.get(queueKey) ?? Promise.resolve();
    const run = prev.then(
      () => task(),
      () => task(),
    );
    this.broadcastQueues.set(
      queueKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * The one message a zero-config user sees when they ask for anything that
   * needs a key — a broadcast, an EIP-191 auth signature, a Safe typed-data
   * signature, or just "who am I".
   *
   * It must name `.env` and NOTHING else. The MCP host's own `env` block (in
   * Claude Code, `.claude.json`) SHADOWS `.env` silently, because
   * `process.loadEnvFile()` never overrides a key that is already set — the
   * invariant src/index.ts is built around and the startup banner exists to
   * explain. The old text said "configure it in MCP server env", i.e. it walked
   * the user straight into that trap, and contradicted the `hintFor` remedy
   * `trySigner` prints two lines below it.
   *
   * It also must not enumerate `process.env`: the shape of the environment is
   * not the user's next step (~20 names on a real machine, including every
   * DEXE_AGENT_PK_* slot), and `dexe_doctor` reports it properly.
   */
  /** keystore mode: does `signerKey` (omitted, "keystore"/"primary", or the keystore address) name the keystore? */
  private keystoreMatches(signerKey?: string): boolean {
    if (!this.keystore) return false;
    const k = signerKey?.trim().toLowerCase();
    if (!k || k === "keystore" || k === "primary") return true;
    try {
      return getAddress(k) === this.keystore.address;
    } catch {
      return false;
    }
  }

  private failNoKey(): never {
    if (this.mode === "keystore") {
      throw new NoSignerKeyError(
        "Keystore mode is on but no usable keystore was found, so this call cannot sign. Reads work without one.\n" +
          "Create one in a terminal (not through the AI): `npx dexe-mcp key create` (or `key import`), then restart " +
          "Claude Code. Run dexe_doctor for the exact path and problem.",
      );
    }
    if (this.mode === "readonly") {
      throw new NoSignerKeyError(
        "DEXE_SIGNER_MODE=readonly - this server never signs. Write tools return unsigned payloads for your own " +
          "wallet; set DEXE_SIGNER_MODE=walletconnect (or keystore) and restart to sign from here.",
      );
    }
    throw new NoSignerKeyError(
      "No signing key is configured, so this call cannot sign. Reads work without one.\n" +
        hintFor(["DEXE_PRIVATE_KEY"], ENV_SPEC) +
        "\nPrefer WalletConnect (keys stay on your phone): set DEXE_WALLETCONNECT_PROJECT_ID in .env, then run " +
        "dexe_wc_connect. Run dexe_doctor to see which values this server loaded and from where, or /dexe-setup " +
        "for a guided walkthrough.",
    );
  }

  private failUnknownSigner(signerKey: string): never {
    if (this.mode !== "unattended") {
      throw new Error(
        `signerKey "${signerKey}" selects a hot key, and hot keys sign only in DEXE_SIGNER_MODE=unattended ` +
          `(this server is in ${this.mode} mode). Omit signerKey.`,
      );
    }
    const known = Object.keys(this.agentKeys);
    throw new Error(
      `Unknown signerKey "${signerKey}". Configured keyring: ${
        known.length ? known.join(", ") : "(empty — set DEXE_AGENT_PK_1..16 or AGENT_PK_1..16 / AGENT_FUNDER_PK)"
      }; the primary signer is selected by omitting signerKey.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Hot-key posture — one string, every broadcast surface
// ---------------------------------------------------------------------------

/**
 * Flagged on every hot-key broadcast — a plaintext key on disk is not safe.
 *
 * Until 0.34.0 this lived privately in `src/tools/txSend.ts` and was emitted by
 * `dexe_tx_send` alone, so a user who only ever calls `dexe_dao_create` /
 * `dexe_proposal_create` / `dexe_proposal_vote_and_execute` / the OTC
 * composites — i.e. the documented PRIMARY write path — never saw it. The
 * warning belongs where the key is resolved, not at one of the tools that
 * happens to use it.
 */
export const HOT_KEY_SAFETY =
  "⚠️ NOT SAFE — signed with a hot key (DEXE_PRIVATE_KEY) in plaintext on disk. " +
  "Prefer WalletConnect: run dexe_wc_connect and the phone signs, so the key never touches this machine.";

/**
 * Carried on every keystore broadcast - what the owner's password did and did
 * not protect against (docs/SIGNING.md has the threat model).
 */
export const KEYSTORE_SAFETY =
  "Signed with the encrypted keystore after the owner approved this exact batch with their password on the local " +
  "approval page. That stops prompt injection and mistakes; it does not stop an agent that can drive your browser " +
  "or shell - for such agents WalletConnect (dexe_wc_connect) is the recommended signer.";

/** The note a broadcast in `mode` carries. */
export function safetyForMode(mode: SignerMode | undefined): string {
  return mode === "keystore" ? KEYSTORE_SAFETY : HOT_KEY_SAFETY;
}

/**
 * Spread into a tool response ONLY when this call actually broadcast with a
 * local key. `false`/undefined yields `{}` - a dryRun or a payloads-only
 * return signed nothing, and a warning that fires when it is false is what
 * makes warnings unreadable. `true` means a hot-key broadcast; a string is the
 * signer's own note (`signer.safety` - HOT_KEY_SAFETY or KEYSTORE_SAFETY).
 */
export function hotKeySafetyFields(broadcast: boolean | string | undefined): { safety?: string } {
  if (typeof broadcast === "string") return broadcast ? { safety: broadcast } : {};
  return broadcast ? { safety: HOT_KEY_SAFETY } : {};
}
