import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { getAddress, keccak256 } from "ethers";
import type { Prechecks, ReviewStep } from "./review.js";
import type { MessageReview } from "./signing.js";
import type { SafeReview } from "./safeReview.js";

/**
 * ── The approval state machine (in memory only) ────────────────────────────
 *
 *   pending ──approve(password)──▶ approved ──take()──▶ executing ──finish()──▶ consumed
 *      │                              │                     │
 *      ├──decline / 5 bad passwords──▶ declined             └──deviation / failure──▶ revoked
 *      └──TTL──▶ expired              └──TTL / superseded──▶ expired | revoked
 *
 * Nothing here is persisted: a restart forgets every approval, and the
 * decrypted key lives only inside an {@link ApprovedSigner} — created when the
 * human types the password, dropped when the batch is consumed, revoked,
 * superseded or expires. JavaScript cannot wipe a string from memory; what it
 * CAN do is make sure no reference outlives the approval, which is what every
 * transition out of `approved`/`executing` does.
 *
 * An approval is bound to what will be signed — `batchHash`, the binding hash:
 *
 *   tx-batch  chain, sender and the ordered (to, value, keccak(data)) list. The
 *             ApprovedSigner signs exactly those transactions, in that order,
 *             once each; anything else revokes it.
 *   message   chain, sender and keccak(message bytes) (signing.ts).
 *   safeTx    chain, sender and the EIP-712 SafeTx digest (signing.ts).
 *
 * The two signature kinds are held by an ApprovedSignature, which produces
 * exactly that one signature, once.
 */

export type ApprovalStatus = "pending" | "approved" | "executing" | "consumed" | "declined" | "expired" | "revoked";
const TERMINAL: ReadonlySet<ApprovalStatus> = new Set(["consumed", "declined", "expired", "revoked"]);

export type ApprovalKind = "tx-batch" | "message" | "safeTx";

/** What a signature approval shows, beside (safeTx) or instead of (message) the steps. */
export type SigningReview = { kind: "message"; message: MessageReview } | { kind: "safeTx"; safe: SafeReview };

export interface ExpectedTx {
  to: string;
  value: bigint;
  dataHash: string;
}

export interface ApprovalRecord {
  approvalId: string;
  /** Random path segment of the page URL. Dead once the approval is decided. */
  pathToken: string;
  /** Per-approval CSRF token, delivered only inside the page. */
  csrf: string;
  kind: ApprovalKind;
  tool: string;
  chainId: number;
  from: string;
  /** tx-batch: the batch. safeTx: the one inner call the Safe will make. message: empty. */
  steps: ReviewStep[];
  /** tx-batch only. */
  expected: ExpectedTx[];
  prechecks: Prechecks;
  /** message / safeTx: what is signed, as the owner sees it. */
  signing?: SigningReview;
  /** The binding hash (for every kind; see the header). */
  batchHash: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  /** Wrong passwords typed for THIS approval. */
  failures: number;
  /** Why it was declined / revoked / expired. */
  reason?: string;
  decidedAt?: number;
  /** Steps that landed under this approval, for the page and dexe_tx_approval_status. */
  landed: Array<{ index: number; txHash: string }>;
  /** Earlier steps of the same flow that landed before a failure (resume ledger), shown on the page. */
  resumeNote?: Array<{ label: string; txHash: string }>;
}

/** What the signing side of an approval looks like to the store: something holding a key that can be dropped. */
export interface KeyHolder {
  drop(): void;
}

export class ApprovalDeviationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDeviationError";
  }
}

export interface StoreOptions {
  ttlMs: number;
  /**
   * How long an APPROVED batch may wait for its tool call to start sending
   * before the decrypted key is dropped (default 120 s, never above the TTL).
   * The blocking call takes it within milliseconds; the re-run path has this
   * long.
   */
  useWindowMs?: number;
  /** Open (pending) approvals allowed at once (default 3). */
  maxPending?: number;
  /** Approvals that may be created per rolling minute (default 6). */
  maxCreatesPerMinute?: number;
  /** Wrong passwords, across ALL approvals, that trigger a lockout (default 5). */
  globalFailureThreshold?: number;
  /** Same batchHash is refused without a page for this long after a decline. */
  declineCooldownMs?: number;
  /** Wrong passwords per approval before it is auto-declined. */
  maxFailures?: number;
  /** First lockout after an auto-decline; doubles each time, capped at an hour. */
  baseLockoutMs?: number;
  now?: () => number;
}

export const DEFAULT_DECLINE_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_BASE_LOCKOUT_MS = 60_000;
export const DEFAULT_USE_WINDOW_MS = 120_000;
export const DEFAULT_MAX_PENDING = 3;
export const DEFAULT_MAX_CREATES_PER_MINUTE = 6;
export const DEFAULT_GLOBAL_FAILURE_THRESHOLD = 5;
/** Wrong passwords older than this no longer count toward the next lockout. */
export const FAILURE_WINDOW_MS = 60 * 60_000;
const MAX_LOCKOUT_MS = 60 * 60_000;

function token(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string compare (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface NewApproval {
  /** Default "tx-batch". */
  kind?: ApprovalKind;
  tool: string;
  chainId: number;
  from: string;
  steps: ReviewStep[];
  expected: ExpectedTx[];
  prechecks: Prechecks;
  signing?: SigningReview;
  batchHash: string;
  fingerprint: string;
  resumeNote?: Array<{ label: string; txHash: string }>;
}

export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly byToken = new Map<string, string>();
  private readonly holders = new Map<string, KeyHolder>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly events = new EventEmitter();
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly maxFailures: number;
  private readonly baseLockoutMs: number;
  private readonly useWindowMs: number;
  private readonly maxPending: number;
  private readonly maxCreatesPerMinute: number;
  private readonly globalThreshold: number;
  /** Lockouts so far — for the process lifetime; each one doubles the next. */
  private lockouts = 0;
  private lockedUntilMs = 0;
  /** Wrong passwords since the last lockout, across every approval (timestamps). */
  private failureTimes: number[] = [];
  /** Approval creations in the last minute (timestamps). */
  private createTimes: number[] = [];
  private readonly useTimers = new Map<string, NodeJS.Timeout>();
  /** tool|from|chain → steps that landed before a revoke, for the next approval's page. */
  private readonly resumeNotes = new Map<string, { at: number; landed: Array<{ label: string; txHash: string }> }>();

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.declineCooldownMs ?? DEFAULT_DECLINE_COOLDOWN_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.baseLockoutMs = opts.baseLockoutMs ?? DEFAULT_BASE_LOCKOUT_MS;
    this.useWindowMs = Math.min(opts.useWindowMs ?? DEFAULT_USE_WINDOW_MS, opts.ttlMs);
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxCreatesPerMinute = opts.maxCreatesPerMinute ?? DEFAULT_MAX_CREATES_PER_MINUTE;
    this.globalThreshold = opts.globalFailureThreshold ?? DEFAULT_GLOBAL_FAILURE_THRESHOLD;
    this.events.setMaxListeners(0);
  }

  /**
   * May a NEW approval be created now? Bounds two things an agent could
   * otherwise use against the owner: guessing passwords across a stream of
   * fresh approvals (each with its own per-approval counter), and nagging the
   * owner with a page per 1-wei variation of a declined batch.
   */
  admitCreate(): { ok: true } | { ok: false; reason: string; retryAfterMs: number } {
    const t = this.now();
    this.createTimes = this.createTimes.filter((x) => x > t - 60_000);
    const pending = this.open().filter((r) => r.status === "pending");
    if (pending.length >= this.maxPending) {
      return {
        ok: false,
        reason:
          `${pending.length} approvals are already waiting for the owner (limit ${this.maxPending}) — approve or decline ` +
          "those first; nothing new is put up for approval until then.",
        retryAfterMs: Math.max(1000, Math.min(...pending.map((r) => r.expiresAt - t))),
      };
    }
    if (this.createTimes.length >= this.maxCreatesPerMinute) {
      const retry = this.createTimes[0]! + 60_000 - t;
      return {
        ok: false,
        reason: `${this.createTimes.length} approvals were requested in the last minute (limit ${this.maxCreatesPerMinute}).`,
        retryAfterMs: Math.max(1000, retry),
      };
    }
    return { ok: true };
  }

  create(input: NewApproval): ApprovalRecord {
    const t = this.now();
    this.prune(t);
    this.createTimes.push(t);
    const rec: ApprovalRecord = {
      approvalId: `apr_${token(9)}`,
      pathToken: token(24),
      csrf: token(24),
      kind: input.kind ?? "tx-batch",
      tool: input.tool,
      chainId: input.chainId,
      from: getAddress(input.from),
      steps: input.steps,
      expected: input.expected,
      prechecks: input.prechecks,
      ...(input.signing ? { signing: input.signing } : {}),
      batchHash: input.batchHash,
      fingerprint: input.fingerprint,
      createdAt: t,
      expiresAt: t + this.opts.ttlMs,
      status: "pending",
      failures: 0,
      landed: [],
      ...(input.resumeNote?.length ? { resumeNote: input.resumeNote } : {}),
    };
    this.records.set(rec.approvalId, rec);
    this.byToken.set(rec.pathToken, rec.approvalId);
    const timer = setTimeout(() => this.expire(rec.approvalId), Math.max(0, rec.expiresAt - t));
    timer.unref?.();
    this.timers.set(rec.approvalId, timer);
    return rec;
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const r = this.records.get(approvalId);
    if (r) this.expireIfDue(r);
    return r;
  }

  getByToken(pathToken: string): ApprovalRecord | undefined {
    const id = this.byToken.get(pathToken);
    return id ? this.get(id) : undefined;
  }

  /** Every approval that is still open (pending or approved-unused). */
  open(): ApprovalRecord[] {
    return [...this.records.values()].filter((r) => {
      this.expireIfDue(r);
      return r.status === "pending" || r.status === "approved";
    });
  }

  findByBatch(batchHash: string, status: ApprovalStatus): ApprovalRecord | undefined {
    for (const r of this.records.values()) {
      this.expireIfDue(r);
      if (r.batchHash === batchHash && r.status === status) return r;
    }
    return undefined;
  }

  /** A decline of this exact batch inside the cooldown window, if any. */
  recentDecline(batchHash: string): ApprovalRecord | undefined {
    const t = this.now();
    for (const r of this.records.values()) {
      if (r.batchHash === batchHash && r.status === "declined" && (r.decidedAt ?? 0) + this.cooldownMs > t) return r;
    }
    return undefined;
  }

  /**
   * A decline of ANY approval of this flow (kind + tool + signer + chain)
   * inside the cooldown window — for kinds whose bytes change on every call
   * (a login nonce), where a per-binding cooldown would never match.
   */
  recentFlowDecline(kind: ApprovalKind, tool: string, from: string, chainId: number): ApprovalRecord | undefined {
    const t = this.now();
    let newest: ApprovalRecord | undefined;
    for (const r of this.records.values()) {
      if (
        r.kind === kind &&
        r.tool === tool &&
        r.from === getAddress(from) &&
        r.chainId === chainId &&
        r.status === "declined" &&
        (r.decidedAt ?? 0) + this.cooldownMs > t &&
        (!newest || (r.decidedAt ?? 0) > (newest.decidedAt ?? 0))
      ) {
        newest = r;
      }
    }
    return newest;
  }

  cooldownEndsAt(r: ApprovalRecord): number {
    return (r.decidedAt ?? r.createdAt) + this.cooldownMs;
  }

  // ---- password attempts -------------------------------------------------------

  /** Milliseconds until password attempts are accepted again (0 = not locked). */
  lockedForMs(): number {
    return Math.max(0, this.lockedUntilMs - this.now());
  }

  /**
   * Count a wrong password.
   *
   * The lockout is GLOBAL: wrong passwords are counted across every approval
   * (a fresh approval does not get a fresh counter), and every
   * `globalFailureThreshold` of them within an hour locks ALL password entry
   * for 1 min, 2, 4, … ≤ 1 h — doubling for the process lifetime; a correct
   * password does not reset it. Separately, the fifth wrong password on one
   * approval declines that approval.
   */
  recordFailure(approvalId: string): { declined: boolean; remaining: number; lockedMs: number } {
    const t = this.now();
    this.failureTimes = this.failureTimes.filter((x) => x > t - FAILURE_WINDOW_MS);
    this.failureTimes.push(t);
    let lockedMs = 0;
    if (this.failureTimes.length >= this.globalThreshold) {
      this.lockouts += 1;
      lockedMs = Math.min(MAX_LOCKOUT_MS, this.baseLockoutMs * 2 ** (this.lockouts - 1));
      this.lockedUntilMs = t + lockedMs;
      this.failureTimes = [];
    }
    const r = this.records.get(approvalId);
    if (!r || r.status !== "pending") return { declined: false, remaining: 0, lockedMs };
    r.failures += 1;
    if (r.failures >= this.maxFailures) {
      this.decline(approvalId, `${r.failures} wrong passwords — auto-declined`);
      return { declined: true, remaining: 0, lockedMs };
    }
    return { declined: false, remaining: this.maxFailures - r.failures, lockedMs };
  }

  // ---- transitions -------------------------------------------------------------

  /** pending → approved, holding the key. Supersedes any other approved-unused batch for the same tool/sender/chain. */
  approve(approvalId: string, holder: KeyHolder): boolean {
    const r = this.get(approvalId);
    if (!r || r.status !== "pending") {
      holder.drop();
      return false;
    }
    for (const other of this.records.values()) {
      if (
        other !== r &&
        other.status === "approved" &&
        other.tool === r.tool &&
        other.from === r.from &&
        other.chainId === r.chainId
      ) {
        this.close(other, "revoked", "superseded by a newer approval for the same flow");
      }
    }
    r.status = "approved";
    r.decidedAt = this.now();
    this.holders.set(approvalId, holder);
    // The decrypted key may sit unused only briefly: if no call starts sending
    // within the use window, drop it (the owner approves again if needed).
    const useTimer = setTimeout(() => {
      const cur = this.records.get(approvalId);
      if (cur && cur.status === "approved") {
        this.close(cur, "expired", `approved but not used within ${Math.round(this.useWindowMs / 1000)} s — the key was dropped`);
      }
    }, this.useWindowMs);
    useTimer.unref?.();
    this.useTimers.set(approvalId, useTimer);
    this.emit(r);
    return true;
  }

  /** How long an approved batch may wait to be used (ms). */
  get approvedUseWindowMs(): number {
    return this.useWindowMs;
  }

  decline(approvalId: string, reason = "declined by the owner"): boolean {
    const r = this.records.get(approvalId);
    if (!r || (r.status !== "pending" && r.status !== "approved")) return false;
    this.close(r, "declined", reason);
    return true;
  }

  /** approved → executing; hands the key holder to the caller. */
  take(approvalId: string): KeyHolder | undefined {
    const r = this.get(approvalId);
    if (!r || r.status !== "approved") return undefined;
    const h = this.holders.get(approvalId);
    if (!h) return undefined;
    r.status = "executing";
    const useTimer = this.useTimers.get(approvalId);
    if (useTimer) {
      clearTimeout(useTimer);
      this.useTimers.delete(approvalId);
    }
    this.emit(r);
    return h;
  }

  markLanded(approvalId: string, index: number, txHash: string): void {
    const r = this.records.get(approvalId);
    if (!r) return;
    r.landed.push({ index, txHash });
    this.emit(r);
  }

  /** executing → consumed (all steps sent). Drops the key. */
  finish(approvalId: string): void {
    const r = this.records.get(approvalId);
    if (r && r.status === "executing") this.close(r, "consumed");
  }

  /** Any open state → revoked. Drops the key. Remembers what landed for the next approval of the same flow. */
  revoke(approvalId: string, reason: string, landedLabels: Array<{ label: string; txHash: string }> = []): void {
    const r = this.records.get(approvalId);
    if (!r || TERMINAL.has(r.status)) return;
    if (landedLabels.length > 0) {
      this.resumeNotes.set(this.flowKey(r.tool, r.from, r.chainId), { at: this.now(), landed: landedLabels });
    }
    this.close(r, "revoked", reason);
  }

  /** Landed steps from a revoked approval of the same flow within the TTL (shown on the next page). */
  resumeNoteFor(tool: string, from: string, chainId: number): Array<{ label: string; txHash: string }> | undefined {
    const k = this.flowKey(tool, from, chainId);
    const n = this.resumeNotes.get(k);
    if (!n) return undefined;
    if (n.at + this.opts.ttlMs < this.now()) {
      this.resumeNotes.delete(k);
      return undefined;
    }
    return n.landed;
  }

  clearResumeNote(tool: string, from: string, chainId: number): void {
    this.resumeNotes.delete(this.flowKey(tool, from, chainId));
  }

  /** Resolve when the record leaves `pending` (or the wait ends). Returns the record either way. */
  waitForDecision(approvalId: string, ms: number, signal?: AbortSignal): Promise<ApprovalRecord | undefined> {
    const r = this.get(approvalId);
    if (!r || r.status !== "pending" || ms <= 0 || signal?.aborted) return Promise.resolve(r);
    return new Promise((resolveWait) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(approvalId, onChange);
        signal?.removeEventListener("abort", done);
        resolveWait(this.get(approvalId));
      };
      const onChange = (rec: ApprovalRecord) => {
        if (rec.status !== "pending") done();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.events.on(approvalId, onChange);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Resolve on ANY change of the record (or the wait ends) — the status long-poll. */
  waitForChange(approvalId: string, ms: number, signal?: AbortSignal): Promise<ApprovalRecord | undefined> {
    const r = this.get(approvalId);
    if (!r || TERMINAL.has(r.status) || ms <= 0 || signal?.aborted) return Promise.resolve(r);
    return new Promise((resolveWait) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(approvalId, done);
        signal?.removeEventListener("abort", done);
        resolveWait(this.get(approvalId));
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.events.on(approvalId, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  // ---- internals ---------------------------------------------------------------

  /**
   * Forget closed approvals once nothing can still refer to them: past the
   * decline cooldown and the TTL (so dexe_tx_approval_status keeps answering
   * for a while). Keeps a long session's memory flat.
   */
  private prune(t: number): void {
    const keepMs = Math.max(this.cooldownMs, this.opts.ttlMs) * 2;
    for (const [id, r] of this.records) {
      if (TERMINAL.has(r.status) && (r.decidedAt ?? r.createdAt) + keepMs < t) {
        this.records.delete(id);
        this.byToken.delete(r.pathToken);
      }
    }
  }

  private flowKey(tool: string, from: string, chainId: number): string {
    return `${tool}|${from.toLowerCase()}|${chainId}`;
  }

  private expire(approvalId: string): void {
    const r = this.records.get(approvalId);
    if (!r) return;
    if (r.status === "pending" || r.status === "approved") this.close(r, "expired", "the approval window ended");
  }

  private expireIfDue(r: ApprovalRecord): void {
    const t = this.now();
    if ((r.status === "pending" || r.status === "approved") && t >= r.expiresAt) {
      this.close(r, "expired", "the approval window ended");
    } else if (r.status === "approved" && r.decidedAt !== undefined && t >= r.decidedAt + this.useWindowMs) {
      this.close(r, "expired", `approved but not used within ${Math.round(this.useWindowMs / 1000)} s — the key was dropped`);
    }
  }

  private close(r: ApprovalRecord, status: ApprovalStatus, reason?: string): void {
    r.status = status;
    r.decidedAt ??= this.now();
    if (status !== "consumed") r.decidedAt = this.now();
    if (reason) r.reason = reason;
    const h = this.holders.get(r.approvalId);
    if (h) {
      h.drop();
      this.holders.delete(r.approvalId);
    }
    const timer = this.timers.get(r.approvalId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(r.approvalId);
    }
    const useTimer = this.useTimers.get(r.approvalId);
    if (useTimer) {
      clearTimeout(useTimer);
      this.useTimers.delete(r.approvalId);
    }
    this.emit(r);
  }

  private emit(r: ApprovalRecord): void {
    this.events.emit(r.approvalId, r);
  }
}

/** keccak of calldata, normalized. */
export function dataHashOf(data: string): string {
  return keccak256(data && data !== "" ? data : "0x");
}

/**
 * Does `tx` match the next expected step exactly? Addresses compare
 * case-insensitively, value as an integer, data by hash.
 */
export function matchesExpected(exp: ExpectedTx, tx: { to: string; value: string | bigint; data: string }): boolean {
  let value: bigint;
  try {
    value = BigInt(tx.value || 0);
  } catch {
    return false;
  }
  return exp.to.toLowerCase() === tx.to.toLowerCase() && exp.value === value && exp.dataHash === dataHashOf(tx.data);
}
