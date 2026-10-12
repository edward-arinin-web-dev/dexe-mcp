import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { getAddress, keccak256 } from "ethers";
import type { Prechecks, ReviewStep } from "./review.js";

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
 * An approval is bound to its batch: chain, sender and the ordered list of
 * (to, value, keccak(data)) — `batchHash`. The ApprovedSigner signs exactly
 * those transactions, in that order, once each; anything else revokes it.
 */

export type ApprovalStatus = "pending" | "approved" | "executing" | "consumed" | "declined" | "expired" | "revoked";
const TERMINAL: ReadonlySet<ApprovalStatus> = new Set(["consumed", "declined", "expired", "revoked"]);

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
  kind: "tx-batch";
  tool: string;
  chainId: number;
  from: string;
  steps: ReviewStep[];
  expected: ExpectedTx[];
  prechecks: Prechecks;
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
  tool: string;
  chainId: number;
  from: string;
  steps: ReviewStep[];
  expected: ExpectedTx[];
  prechecks: Prechecks;
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
  private lockouts = 0;
  private lockedUntilMs = 0;
  /** tool|from|chain → steps that landed before a revoke, for the next approval's page. */
  private readonly resumeNotes = new Map<string, { at: number; landed: Array<{ label: string; txHash: string }> }>();

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.declineCooldownMs ?? DEFAULT_DECLINE_COOLDOWN_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.baseLockoutMs = opts.baseLockoutMs ?? DEFAULT_BASE_LOCKOUT_MS;
    this.events.setMaxListeners(0);
  }

  create(input: NewApproval): ApprovalRecord {
    const t = this.now();
    const rec: ApprovalRecord = {
      approvalId: `apr_${token(9)}`,
      pathToken: token(24),
      csrf: token(24),
      kind: "tx-batch",
      tool: input.tool,
      chainId: input.chainId,
      from: getAddress(input.from),
      steps: input.steps,
      expected: input.expected,
      prechecks: input.prechecks,
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

  cooldownEndsAt(r: ApprovalRecord): number {
    return (r.decidedAt ?? r.createdAt) + this.cooldownMs;
  }

  // ---- password attempts -------------------------------------------------------

  /** Milliseconds until password attempts are accepted again (0 = not locked). */
  lockedForMs(): number {
    return Math.max(0, this.lockedUntilMs - this.now());
  }

  /**
   * Count a wrong password. The fifth on one approval declines it and locks
   * every password attempt out for a growing period (1 min, 2, 4, … ≤ 1 h).
   */
  recordFailure(approvalId: string): { declined: boolean; remaining: number } {
    const r = this.records.get(approvalId);
    if (!r || r.status !== "pending") return { declined: false, remaining: 0 };
    r.failures += 1;
    if (r.failures >= this.maxFailures) {
      this.lockouts += 1;
      const ms = Math.min(MAX_LOCKOUT_MS, this.baseLockoutMs * 2 ** (this.lockouts - 1));
      this.lockedUntilMs = this.now() + ms;
      this.decline(approvalId, `${r.failures} wrong passwords — auto-declined; password entry locked for ${Math.round(ms / 1000)} s`);
      return { declined: true, remaining: 0 };
    }
    return { declined: false, remaining: this.maxFailures - r.failures };
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
    this.emit(r);
    return true;
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

  private flowKey(tool: string, from: string, chainId: number): string {
    return `${tool}|${from.toLowerCase()}|${chainId}`;
  }

  private expire(approvalId: string): void {
    const r = this.records.get(approvalId);
    if (!r) return;
    if (r.status === "pending" || r.status === "approved") this.close(r, "expired", "the approval window ended");
  }

  private expireIfDue(r: ApprovalRecord): void {
    if ((r.status === "pending" || r.status === "approved") && this.now() >= r.expiresAt) {
      this.close(r, "expired", "the approval window ended");
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
