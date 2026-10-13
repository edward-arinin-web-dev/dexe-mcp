import { readFileSync } from "node:fs";
import { getAddress, keccak256, TypedDataEncoder, type TypedDataDomain, type TypedDataField } from "ethers";
import { registerLedgerSecrets } from "../agentLedger.js";
import {
  decryptKeystore,
  isWrongPasswordError,
  KeystoreAddressMismatchError,
  parseKeystoreMeta,
  weakKdfReason,
} from "../keystore.js";
import { renderUntrusted } from "@dexe-network/dexe-mcp/core";
import { ApprovalServer, type ApproveAttempt } from "./server.js";
import {
  ApprovalStore,
  dataHashOf,
  type ApprovalKind,
  type ApprovalRecord,
  type KeyHolder,
  type NewApproval,
  type StoreOptions,
} from "./store.js";
import { ApprovedSigner, type SendCapable } from "./approvedSigner.js";
import {
  computeBatchHash,
  fingerprintOf,
  chainLabel,
  isMainnet,
  type Prechecks,
  type ReviewPayload,
  type ReviewStep,
  type RiskFlag,
} from "./review.js";
import {
  ApprovedSignature,
  assertSignableTypedData,
  MESSAGE_MAX_BYTES,
  messageBindingHash,
  reviewMessage,
  segmentsToText,
  SignatureRefusal,
  typedDataBindingHash,
} from "./signing.js";
import type { SafeReview } from "./safeReview.js";
import { ControlChannel } from "./control.js";
import { openBrowser as defaultOpenBrowser } from "./openBrowser.js";
import { ApprovalHaltError, type ApprovalHalt } from "./scope.js";

export { ApprovalStore } from "./store.js";
export { ApprovedSigner } from "./approvedSigner.js";
export { ApprovedSignature, SignatureRefusal } from "./signing.js";
export { ApprovalHaltError, approvalHaltResult, applyApprovalScope, currentToolScope } from "./scope.js";
export { buildReview, computeBatchHash, fingerprintOf } from "./review.js";

/**
 * ── ApprovalManager: one per keystore-mode server ──────────────────────────
 *
 * `request()` (a transaction batch) and `requestSignature()` (an EIP-191
 * message or a Safe SafeTx) are the whole contract the signing paths see:
 *
 *   1. an approved, unused approval bound to exactly this batch / message /
 *      digest → take it (the "re-run the same call" path);
 *   2. a decline of exactly this in the last 10 minutes → declined, no new
 *      page (the owner is not worn down by retries);
 *   3. otherwise reuse the pending approval, or create one, print + open its
 *      page, start the terminal channel, and wait up to `waitMs` for the owner.
 *
 * They return an {@link ApprovedSigner} / {@link ApprovedSignature} or throw
 * {@link ApprovalHaltError} (pending / declined / expired). The owner decides
 * on the loopback page OR in a terminal (`dexe-mcp approve`); both reach the
 * one password check below, serialized and under one global lockout. There is
 * no method that approves without the password, and nothing reads a password
 * from env, a file or a tool argument.
 */

export interface ApprovalManagerOptions {
  /** The keystore file and the address it must hold. Re-read on every password attempt. */
  keystoreFile: string;
  address: string;
  waitMs: number;
  ttlMs: number;
  openBrowser: boolean;
  /** Wallet for a decrypted key on `chainId` (provider + ledger recorder). */
  connect(privateKey: string, chainId: number): SendCapable;
  /** Per-(chain, sender) broadcast lock. */
  lock<T>(chainId: number, task: () => Promise<T>): Promise<T>;
  log?: (line: string) => void;
  opener?: (url: string) => boolean;
  readKeystore?: () => string;
  storeOptions?: Partial<StoreOptions>;
  /** The terminal channel (`dexe-mcp approve`): where its rendezvous file goes. Omitted / false = off. */
  terminal?: { runDir: string; version?: string } | false;
}

export interface ApprovalRequest {
  tool: string;
  chainId: number;
  from: string;
  payloads: readonly ReviewPayload[];
  steps: ReviewStep[];
  prechecks: Prechecks;
}

export interface MessageSignatureRequest {
  kind: "message";
  tool: string;
  /** The chain the signature is used for (shown; part of the binding). */
  chainId: number;
  from: string;
  /** The exact bytes that will be signed (EIP-191). */
  message: Uint8Array;
  /** Server-written: what the signature is for. Never model text. */
  purpose: string;
  /** Server-derived flags shown first (e.g. a login going to a non-default backend). */
  serverRisks?: RiskFlag[];
}

export interface SafeTxSignatureRequest {
  kind: "safeTx";
  tool: string;
  chainId: number;
  from: string;
  typedData: { domain: TypedDataDomain; types: Record<string, TypedDataField[]>; message: Record<string, unknown> };
  /** From buildSafeTxReview (on-chain checked). */
  safe: SafeReview;
  steps: ReviewStep[];
  prechecks: Prechecks;
}

export type SignatureRequest = MessageSignatureRequest | SafeTxSignatureRequest;

export interface RequestOptions {
  waitMs?: number;
  signal?: AbortSignal;
  progress?: (message: string) => Promise<void>;
}

/** Progress heartbeat while blocking on the owner. */
const HEARTBEAT_MS = 15_000;

interface AcquireSpec {
  binding: string;
  tool: string;
  chainId: number;
  from: string;
  /** "3 transaction(s)", "a message signature", … */
  what: string;
  /** Short labels, for a throttled halt (no record exists then). */
  labels: string[];
  create(): NewApproval;
}

export class ApprovalManager {
  readonly store: ApprovalStore;
  readonly server: ApprovalServer;
  private readonly control: ControlChannel | undefined;
  private readonly holders = new Map<string, KeyHolder>();
  /** One password check at a time, page and terminal alike — scrypt is the rate limit, never run in parallel. */
  private attemptChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ApprovalManagerOptions) {
    this.store = new ApprovalStore({ ttlMs: opts.ttlMs, ...(opts.storeOptions ?? {}) });
    this.server = new ApprovalServer({
      store: this.store,
      attemptApprove: (r, pw) => this.passwordAttempt(r, pw),
      // The page mentions `dexe-mcp approve` only when the channel is really up.
      terminalAvailable: () => this.control?.started ?? false,
      log: opts.log,
    });
    this.control = opts.terminal
      ? new ControlChannel({
          store: this.store,
          address: getAddress(opts.address),
          runDir: opts.terminal.runDir,
          version: opts.terminal.version ?? "",
          attemptApprove: (r, pw) => this.passwordAttempt(r, pw),
          reviewOf: (r) => this.reviewOf(r),
          log: opts.log,
        })
      : undefined;
  }

  get address(): string {
    return this.opts.address;
  }

  /** The terminal channel, when configured (tests, diagnostics). */
  get terminal(): ControlChannel | undefined {
    return this.control;
  }

  /**
   * The ONE entry for a typed password, from the page or the terminal:
   * refused while password entry is locked, serialized, and re-checked for
   * the lockout inside the queue — guesses queued before a lockout never run
   * after it, whichever channel they came through.
   */
  private passwordAttempt(record: ApprovalRecord, password: string): Promise<ApproveAttempt> {
    const locked = this.store.lockedForMs();
    if (locked > 0) return Promise.resolve({ kind: "locked", retryAfterMs: locked });
    const attempt = this.attemptChain.then((): Promise<ApproveAttempt> => {
      const lockedNow = this.store.lockedForMs();
      if (lockedNow > 0) return Promise.resolve({ kind: "locked", retryAfterMs: lockedNow });
      return record.status === "pending"
        ? this.attemptApprove(record, password)
        : Promise.resolve({ kind: "error", message: `this approval is already ${record.status}` });
    });
    this.attemptChain = attempt.catch(() => undefined);
    return attempt;
  }

  /** Decrypt with the password and approve. The only path from `pending` to `approved`. */
  private async attemptApprove(record: ApprovalRecord, password: string): Promise<ApproveAttempt> {
    const locked = this.store.lockedForMs();
    if (locked > 0) return { kind: "locked", retryAfterMs: locked };
    let json: string;
    try {
      json = this.opts.readKeystore ? this.opts.readKeystore() : readFileSync(this.opts.keystoreFile, "utf8");
    } catch {
      return { kind: "error", message: "The keystore file could not be read — nothing was signed." };
    }
    // The file may have been swapped since startup: a cheap KDF turns each
    // guess into microseconds, so it is refused here as well.
    try {
      const weak = weakKdfReason(parseKeystoreMeta(json));
      if (weak) return { kind: "error", message: `${weak} Nothing was signed.` };
    } catch {
      return { kind: "error", message: "The keystore file is not a keystore v3 file — nothing was signed." };
    }
    let account: { address: string; privateKey: string };
    try {
      account = await decryptKeystore(json, password, record.from);
    } catch (e) {
      if (isWrongPasswordError(e)) {
        const f = this.store.recordFailure(record.approvalId);
        this.opts.log?.(`[dexe-mcp] approval ${record.approvalId}: wrong password${f.declined ? " — auto-declined" : ""}`);
        return { kind: "wrong-password", remaining: f.remaining, declined: f.declined, lockedMs: f.lockedMs };
      }
      if (e instanceof KeystoreAddressMismatchError) {
        this.store.decline(record.approvalId, e.message);
        return { kind: "error", message: e.message };
      }
      return { kind: "error", message: "The keystore could not be decrypted — nothing was signed." };
    }
    // Digest only: lets the ledger scrubber recognise this key if it ever
    // surfaced in some free-text field, as it does for hot keys.
    registerLedgerSecrets([account.privateKey]);
    const holder: KeyHolder =
      record.kind === "tx-batch"
        ? new ApprovedSigner(record.approvalId, account.address, account.privateKey, record.chainId, record.expected, {
            store: this.store,
            connect: (pk) => this.opts.connect(pk, record.chainId),
            lock: (task) => this.opts.lock(record.chainId, task),
          })
        : new ApprovedSignature(record.approvalId, account.address, account.privateKey, record.kind, record.chainId, record.batchHash, {
            store: this.store,
            ...(record.signing?.kind === "safeTx" ? { verifyingContract: record.signing.safe.safe } : {}),
          });
    if (!this.store.approve(record.approvalId, holder)) {
      return { kind: "error", message: `this approval is already ${record.status}` };
    }
    this.holders.set(record.approvalId, holder);
    this.opts.log?.(`[dexe-mcp] approval ${record.approvalId} approved by the owner`);
    return { kind: "approved" };
  }

  private haltOf(r: ApprovalRecord, status: ApprovalHalt["status"], message: string, url?: string): ApprovalHalt {
    return {
      status,
      approvalId: r.approvalId,
      ...(url ? { url } : {}),
      fingerprint: r.fingerprint,
      expiresAt: new Date(r.expiresAt).toISOString(),
      chainId: r.chainId,
      from: r.from,
      steps: summaryOf(r),
      message,
    };
  }

  private takeApproved(r: ApprovalRecord): KeyHolder | undefined {
    const holder = this.store.take(r.approvalId);
    const mine = this.holders.get(r.approvalId);
    this.holders.delete(r.approvalId);
    if (!holder || !mine || holder !== mine) {
      // Never leave it "executing" with a key and no one to finish it.
      holder?.drop();
      mine?.drop();
      this.store.revoke(r.approvalId, "internal: the approved key holder could not be handed over");
      return undefined;
    }
    return holder;
  }

  /** Start the page server and (when configured) the terminal channel. */
  private async startChannels(): Promise<boolean> {
    await this.server.start();
    return this.control ? this.control.start() : false;
  }

  /** The shared request flow. Returns the approved key holder, or throws ApprovalHaltError. */
  private async acquire(spec: AcquireSpec, ro: RequestOptions): Promise<KeyHolder> {
    const approved = this.store.findByBatch(spec.binding, "approved");
    if (approved) {
      const h = this.takeApproved(approved);
      if (h) return h;
    }

    const declined = this.store.recentDecline(spec.binding);
    if (declined) {
      throw new ApprovalHaltError({
        ...this.haltOf(declined, "declined", "The owner declined exactly this recently; nothing was signed."),
        retryAfter: new Date(this.store.cooldownEndsAt(declined)).toISOString(),
      });
    }

    const executing = this.store.findByBatch(spec.binding, "executing");
    if (executing) {
      throw new ApprovalHaltError(
        this.haltOf(executing, "executing", "Exactly this is being signed by another call right now — wait for it, then re-check."),
      );
    }

    let record = this.store.findByBatch(spec.binding, "pending");
    let terminal = false;
    if (!record) {
      const admit = this.store.admitCreate();
      if (!admit.ok) {
        const open = this.store.open().filter((r) => r.status === "pending");
        throw new ApprovalHaltError({
          status: "throttled",
          approvalId: "",
          fingerprint: fingerprintOf(spec.binding),
          chainId: spec.chainId,
          from: spec.from,
          steps: spec.labels,
          message: `Not put up for approval: ${admit.reason}`,
          retryAfter: new Date(Date.now() + admit.retryAfterMs).toISOString(),
          open: open.map((r) => ({
            approvalId: r.approvalId,
            fingerprint: r.fingerprint,
            ...(this.server.started ? { url: this.server.urlFor(r) } : {}),
          })),
        });
      }
      record = this.store.create(spec.create());
      terminal = await this.startChannels();
      const url = this.server.urlFor(record);
      this.opts.log?.(
        `[dexe-mcp] APPROVAL NEEDED — ${spec.tool}: ${spec.what} on ${chainLabel(spec.chainId)} from ${spec.from}. ` +
          `Open ${url}${terminal ? " (or run `npx dexe-mcp approve` in a terminal)" : ""} and check fingerprint ${record.fingerprint}.`,
      );
      if (this.opts.openBrowser) (this.opts.opener ?? defaultOpenBrowser)(url);
    } else {
      terminal = await this.startChannels();
    }
    const url = this.server.urlFor(record);
    const where = `${url}${terminal ? " or with `npx dexe-mcp approve` in a terminal" : ""}`;

    const waitMs = Math.max(0, Math.min(ro.waitMs ?? this.opts.waitMs, record.expiresAt - Date.now()));
    const deadline = Date.now() + waitMs;
    await ro.progress?.(`Waiting for the owner to approve ${spec.what} at ${where} (fingerprint ${record.fingerprint}).`);
    let current: ApprovalRecord | undefined = record;
    while (current?.status === "pending" && Date.now() < deadline && !ro.signal?.aborted) {
      current = await this.store.waitForDecision(record.approvalId, Math.min(HEARTBEAT_MS, deadline - Date.now()), ro.signal);
      if (current?.status === "pending" && Date.now() < deadline) {
        await ro.progress?.(`Still waiting for approval at ${where} (fingerprint ${record.fingerprint}).`);
      }
    }

    const r = current ?? record;
    if (r.status === "approved") {
      const h = this.takeApproved(r);
      if (h) return h;
    }
    if (r.status === "declined") {
      this.opts.log?.(`[dexe-mcp] approval ${r.approvalId} declined: ${r.reason ?? "by the owner"}`);
      throw new ApprovalHaltError({
        ...this.haltOf(r, "declined", r.reason ?? "The owner declined; nothing was signed."),
        retryAfter: new Date(this.store.cooldownEndsAt(r)).toISOString(),
      });
    }
    if (r.status === "expired") {
      throw new ApprovalHaltError(
        this.haltOf(r, "expired", "The approval window ended before the owner approved; nothing was signed. Re-run the call for a fresh link."),
      );
    }
    throw new ApprovalHaltError(
      this.haltOf(
        r,
        "pending",
        `Waiting for the owner to approve ${spec.what} on ${chainLabel(r.chainId)} in the browser` +
          `${terminal ? " or the terminal" : ""} (fingerprint ${r.fingerprint}). Nothing was signed yet.`,
        url,
      ),
    );
  }

  /** Get an ApprovedSigner for this transaction batch, or throw ApprovalHaltError. */
  async request(req: ApprovalRequest, ro: RequestOptions = {}): Promise<ApprovedSigner> {
    const batchHash = computeBatchHash(req.chainId, req.from, req.payloads);
    const h = await this.acquire(
      {
        binding: batchHash,
        tool: req.tool,
        chainId: req.chainId,
        from: req.from,
        what: `${req.steps.length} transaction(s)`,
        labels: stepLabels(req.steps),
        create: () => {
          const resumeNote = this.store.resumeNoteFor(req.tool, req.from, req.chainId);
          return {
            kind: "tx-batch",
            tool: req.tool,
            chainId: req.chainId,
            from: req.from,
            steps: req.steps,
            expected: req.payloads.map((p) => ({ to: p.to, value: BigInt(p.value || "0"), dataHash: dataHashOf(p.data) })),
            prechecks: req.prechecks,
            batchHash,
            fingerprint: fingerprintOf(batchHash),
            ...(resumeNote ? { resumeNote } : {}),
          };
        },
      },
      ro,
    );
    if (!(h instanceof ApprovedSigner)) {
      this.abandon(h, "internal: an approval of another kind matched this batch");
      throw new Error("internal: an approval of another kind matched this batch — nothing was signed");
    }
    return h;
  }

  /**
   * Get an ApprovedSignature for exactly this message / SafeTx, or throw
   * ApprovalHaltError. Throws {@link SignatureRefusal} — before any page —
   * for what this path never signs: empty or over-long messages, typed data
   * other than a canonical SafeTx, permits, a domain for another chain.
   */
  async requestSignature(req: SignatureRequest, ro: RequestOptions = {}): Promise<ApprovedSignature> {
    const from = getAddress(req.from);
    let spec: AcquireSpec;
    if (req.kind === "message") {
      if (req.message.length === 0) throw new SignatureRefusal("Refused: the message to sign is empty.");
      if (req.message.length > MESSAGE_MAX_BYTES) {
        throw new SignatureRefusal(
          `Refused: the message is ${req.message.length} bytes. The approval page shows a message in full, so ` +
            `messages over ${MESSAGE_MAX_BYTES} bytes are never put up for signing.`,
        );
      }
      // A login nonce changes on every call, so a per-message cooldown would be
      // worn down by simply calling again: a decline of ANY message of this
      // flow holds for the whole cooldown.
      this.assertNoRecentDecline({ kind: "message", tool: req.tool, from, chainId: req.chainId });
      const binding = messageBindingHash(req.chainId, from, req.message);
      const message = reviewMessage(req.message, { from, purpose: req.purpose, serverRisks: req.serverRisks ?? [] });
      spec = {
        binding,
        tool: req.tool,
        chainId: req.chainId,
        from,
        what: "a message signature",
        labels: [`sign a message (${req.message.length} bytes) — ${req.purpose}`],
        create: () => ({
          kind: "message",
          tool: req.tool,
          chainId: req.chainId,
          from,
          steps: [],
          expected: [],
          prechecks: { guards: "pass", simulation: "skipped" },
          signing: { kind: "message", message },
          batchHash: binding,
          fingerprint: fingerprintOf(binding),
        }),
      };
    } else {
      assertSignableTypedData(
        { domain: req.typedData.domain, types: req.typedData.types, message: req.typedData.message },
        { chainId: req.chainId, verifyingContract: req.safe.safe },
      );
      const digest = TypedDataEncoder.hash(req.typedData.domain, req.typedData.types, req.typedData.message);
      const binding = typedDataBindingHash(req.chainId, from, digest);
      // The Safe itself must compute the same hash (getTransactionHash, read by
      // buildSafeTxReview) — otherwise this is not the transaction it will run.
      if (!req.safe.onChainSafeTxHash || req.safe.onChainSafeTxHash.toLowerCase() !== digest.toLowerCase()) {
        throw new SignatureRefusal(
          `Refused: the Safe's own getTransactionHash (${req.safe.onChainSafeTxHash ?? "unread"}) differs from the ` +
            `SafeTx digest to be signed (${digest}). Nothing was put up for approval.`,
        );
      }
      // What the page shows is derived from the typed data that will be signed,
      // never taken from the caller's review: the SafeTx fields directly, and
      // the reviewed inner call must be exactly the SafeTx's (to, value, data).
      const m = req.typedData.message;
      const step = req.steps[0];
      let sameCall = false;
      try {
        sameCall =
          req.steps.length === 1 &&
          !!step &&
          getAddress(step.to) === getAddress(String(m.to)) &&
          BigInt(step.value) === BigInt(String(m.value)) &&
          step.dataHash.toLowerCase() === keccak256(String(m.data || "0x")).toLowerCase();
      } catch {
        sameCall = false;
      }
      if (!sameCall) {
        throw new SignatureRefusal("Refused: the reviewed call is not the one in the SafeTx to be signed. Nothing was put up for approval.");
      }
      const safe: SafeReview = {
        ...req.safe,
        nonce: String(m.nonce),
        operation: Number(m.operation) === 1 ? 1 : 0,
        safeTxGas: String(m.safeTxGas),
        baseGas: String(m.baseGas),
        gasPrice: String(m.gasPrice),
        gasToken: getAddress(String(m.gasToken)),
        refundReceiver: getAddress(String(m.refundReceiver)),
        safeTxHash: digest,
      };
      spec = {
        binding,
        tool: req.tool,
        chainId: req.chainId,
        from,
        what: "a Safe transaction signature",
        labels: [`sign Safe transaction nonce ${safe.nonce} for Safe ${safe.safe}`],
        create: () => ({
          kind: "safeTx",
          tool: req.tool,
          chainId: req.chainId,
          from,
          steps: req.steps,
          expected: [],
          prechecks: req.prechecks,
          signing: { kind: "safeTx", safe },
          batchHash: binding,
          fingerprint: fingerprintOf(binding),
        }),
      };
    }
    const h = await this.acquire(spec, ro);
    if (!(h instanceof ApprovedSignature) || h.kind !== req.kind) {
      this.abandon(h, "internal: an approval of another kind matched this signature");
      throw new Error("internal: an approval of another kind matched this signature — nothing was signed");
    }
    return h;
  }

  /**
   * Refuse, without a page, when the owner declined an approval of this flow
   * (same kind, tool, signer, chain) within the cooldown. Used for messages,
   * whose bytes change on every call (a login nonce), and by dexe_auth_login
   * before it even asks the backend for a nonce.
   */
  assertNoRecentDecline(q: { kind: ApprovalKind; tool: string; from: string; chainId: number }): void {
    const d = this.store.recentFlowDecline(q.kind, q.tool, getAddress(q.from), q.chainId);
    if (!d) return;
    throw new ApprovalHaltError({
      ...this.haltOf(
        d,
        "declined",
        `The owner declined this ${q.kind === "message" ? "signature request" : "request"} recently; nothing was signed. ` +
          "It is not asked again until the cooldown ends.",
      ),
      retryAfter: new Date(this.store.cooldownEndsAt(d)).toISOString(),
    });
  }

  /** Drop a key holder AND close its record — never leave an approval "executing" with no one to finish it. */
  private abandon(h: KeyHolder, reason: string): void {
    h.drop();
    const id = (h as { approvalId?: unknown }).approvalId;
    if (typeof id === "string") this.store.revoke(id, reason);
  }

  /**
   * The newest open (pending or approved-unused) message approval of a flow —
   * lets dexe_auth_login re-run with the SAME backend nonce it already put up
   * for approval instead of fetching a new one (which would need a new page).
   * The message is what the backend sent, held server-side; never model text.
   */
  findOpenMessage(q: { tool: string; from: string; chainId: number; purpose: string }): Uint8Array | undefined {
    const from = getAddress(q.from);
    const hits = this.store
      .open()
      .filter(
        (r) =>
          r.kind === "message" &&
          r.tool === q.tool &&
          r.from === from &&
          r.chainId === q.chainId &&
          r.signing?.kind === "message" &&
          r.signing.message.purpose === q.purpose,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    const rec = hits[0];
    if (!rec || rec.signing?.kind !== "message") return undefined;
    return Uint8Array.from(Buffer.from(rec.signing.message.hex.slice(2), "hex"));
  }

  /** What the terminal shows for an approval: the page's review, without the page token or the CSRF token. */
  reviewOf(r: ApprovalRecord): Record<string, unknown> {
    return {
      approvalId: r.approvalId,
      kind: r.kind,
      tool: r.tool,
      chainId: r.chainId,
      chain: chainLabel(r.chainId),
      mainnet: isMainnet(r.chainId),
      from: r.from,
      fingerprint: r.fingerprint,
      binding: r.batchHash,
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      failures: r.failures,
      steps: r.steps,
      prechecks: r.prechecks,
      ...(r.signing ? { signing: r.signing } : {}),
      ...(r.resumeNote?.length ? { resumeNote: r.resumeNote } : {}),
    };
  }

  /** The read-only view `dexe_tx_approval_status` returns. */
  view(approvalId: string): Record<string, unknown> | undefined {
    const r = this.store.get(approvalId);
    if (!r) return undefined;
    const tx = r.kind === "tx-batch";
    const next: Record<string, string> = {
      pending:
        "Waiting for the owner. Ask them to approve on the page or with `npx dexe-mcp approve` in their terminal " +
        "(never for the password in chat), then re-run the original call.",
      approved:
        "Approved and not used yet — re-run the ORIGINAL call with the same arguments now (the approval is held only " +
        "briefly); it signs without asking again.",
      executing: tx ? "Being signed and sent right now — check again shortly." : "Being signed right now — check again shortly.",
      consumed: tx ? "Done — every approved transaction was sent (see landed)." : "Done — the approved signature was produced.",
      declined: "The owner declined. Do not retry unless the user asks.",
      expired: "Expired before use. Re-run the original call for a fresh approval link.",
      revoked: tx
        ? "Revoked (a transaction differed from the approved batch, a step failed, or a newer approval replaced it). Re-run the original call if the user still wants it."
        : "Revoked (what was to be signed differed from what was approved, or a newer approval replaced it). Re-run the original call if the user still wants it.",
    };
    return {
      approvalId: r.approvalId,
      kind: r.kind,
      status: r.status,
      tool: r.tool,
      chainId: r.chainId,
      from: r.from,
      fingerprint: r.fingerprint,
      steps: summaryOf(r),
      ...(r.status === "pending" && this.server.started ? { url: this.server.urlFor(r) } : {}),
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      ...(tx ? { landed: r.landed } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      next: next[r.status] ?? "",
    };
  }

  /** Long-poll: resolve on the next change or after `ms`. */
  async waitView(approvalId: string, ms: number, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    await this.store.waitForChange(approvalId, ms, signal);
    return this.view(approvalId);
  }

  /** Approvals still open (pending or approved-unused), for dexe_write_context. */
  openApprovals(): Array<Record<string, unknown>> {
    return this.store.open().map((r) => ({
      approvalId: r.approvalId,
      kind: r.kind,
      status: r.status,
      tool: r.tool,
      chainId: r.chainId,
      fingerprint: r.fingerprint,
      ...(r.kind === "tx-batch" ? { txCount: r.steps.length } : {}),
      expiresAt: new Date(r.expiresAt).toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.control?.close();
  }
}

export function stepLabels(steps: readonly ReviewStep[]): string[] {
  return steps.map((s) => {
    const call = s.decoded ? `${s.decoded.contract ? `${s.decoded.contract}.` : ""}${s.decoded.signature.split("(")[0]}` : s.selector ?? "transfer";
    return `${s.index + 1}. ${call} → ${s.toLabel} (${s.to})`;
  });
}

/** Short model-facing labels of what an approval covers. Untrusted text is sanitized and capped. */
export function summaryOf(r: ApprovalRecord): string[] {
  if (r.signing?.kind === "message") {
    const m = r.signing.message;
    const preview = m.segments ? renderUntrusted(segmentsToText(m.segments), 80) : `${m.hex.slice(0, 42)}…`;
    return [`sign a message (${m.byteLength} bytes, ${m.encoding}) — ${m.purpose}: "${preview}"`];
  }
  if (r.signing?.kind === "safeTx") {
    const s = r.signing.safe;
    const inner = r.steps[0];
    const call = inner?.decoded ? inner.decoded.signature.split("(")[0] : (inner?.selector ?? "transfer");
    return [
      `sign Safe transaction nonce ${s.nonce} for Safe ${s.safe}: ${s.operation === 1 ? "DELEGATECALL" : "CALL"} ${call} → ${inner?.to ?? "?"}`,
    ];
  }
  return stepLabels(r.steps);
}
