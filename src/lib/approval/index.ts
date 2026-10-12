import { readFileSync } from "node:fs";
import { registerLedgerSecrets } from "../agentLedger.js";
import { decryptKeystore, isWrongPasswordError, KeystoreAddressMismatchError } from "../keystore.js";
import { ApprovalServer, type ApproveAttempt } from "./server.js";
import { ApprovalStore, dataHashOf, type ApprovalRecord, type StoreOptions } from "./store.js";
import { ApprovedSigner, type SendCapable } from "./approvedSigner.js";
import { computeBatchHash, fingerprintOf, chainLabel, type Prechecks, type ReviewPayload, type ReviewStep } from "./review.js";
import { openBrowser as defaultOpenBrowser } from "./openBrowser.js";
import { ApprovalHaltError, type ApprovalHalt } from "./scope.js";

export { ApprovalStore } from "./store.js";
export { ApprovedSigner } from "./approvedSigner.js";
export { ApprovalHaltError, approvalHaltResult, applyApprovalScope, currentToolScope } from "./scope.js";
export { buildReview, computeBatchHash, fingerprintOf } from "./review.js";

/**
 * ── ApprovalManager: one per keystore-mode server ──────────────────────────
 *
 * `request()` is the whole contract the signing paths see:
 *
 *   1. an approved, unused approval for this exact batch → take it (the
 *      "re-run the same call" path);
 *   2. a decline of this exact batch in the last 10 minutes → declined, no
 *      new page (the owner is not worn down by retries);
 *   3. otherwise reuse the pending approval for this batch, or create one,
 *      print + open its page, and wait up to `waitMs` for the owner.
 *
 * It returns an {@link ApprovedSigner} or throws {@link ApprovalHaltError}
 * (pending / declined / expired). There is no method that approves without
 * the password, and nothing reads a password from env, a file or an argument.
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
}

export interface ApprovalRequest {
  tool: string;
  chainId: number;
  from: string;
  payloads: readonly ReviewPayload[];
  steps: ReviewStep[];
  prechecks: Prechecks;
}

export interface RequestOptions {
  waitMs?: number;
  signal?: AbortSignal;
  progress?: (message: string) => Promise<void>;
}

/** Progress heartbeat while blocking on the owner. */
const HEARTBEAT_MS = 15_000;

export class ApprovalManager {
  readonly store: ApprovalStore;
  readonly server: ApprovalServer;
  private readonly signers = new Map<string, ApprovedSigner>();

  constructor(private readonly opts: ApprovalManagerOptions) {
    this.store = new ApprovalStore({ ttlMs: opts.ttlMs, ...(opts.storeOptions ?? {}) });
    this.server = new ApprovalServer({
      store: this.store,
      attemptApprove: (r, pw) => this.attemptApprove(r, pw),
      log: opts.log,
    });
  }

  get address(): string {
    return this.opts.address;
  }

  /** Approve with the password typed on the page. The only path from `pending` to `approved`. */
  private async attemptApprove(record: ApprovalRecord, password: string): Promise<ApproveAttempt> {
    let json: string;
    try {
      json = this.opts.readKeystore ? this.opts.readKeystore() : readFileSync(this.opts.keystoreFile, "utf8");
    } catch {
      return { kind: "error", message: "The keystore file could not be read — nothing was signed." };
    }
    let account: { address: string; privateKey: string };
    try {
      account = await decryptKeystore(json, password, record.from);
    } catch (e) {
      if (isWrongPasswordError(e)) {
        const f = this.store.recordFailure(record.approvalId);
        this.opts.log?.(`[dexe-mcp] approval ${record.approvalId}: wrong password${f.declined ? " — auto-declined" : ""}`);
        return { kind: "wrong-password", remaining: f.remaining, declined: f.declined };
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
    const signer = new ApprovedSigner(record.approvalId, account.address, account.privateKey, record.chainId, record.expected, {
      store: this.store,
      connect: (pk) => this.opts.connect(pk, record.chainId),
      lock: (task) => this.opts.lock(record.chainId, task),
    });
    if (!this.store.approve(record.approvalId, signer)) {
      return { kind: "error", message: `this approval is already ${record.status}` };
    }
    this.signers.set(record.approvalId, signer);
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
      steps: stepLabels(r.steps),
      message,
    };
  }

  private takeApproved(r: ApprovalRecord): ApprovedSigner | undefined {
    const holder = this.store.take(r.approvalId);
    const signer = this.signers.get(r.approvalId);
    this.signers.delete(r.approvalId);
    if (!holder || !signer || holder !== signer) return undefined;
    return signer;
  }

  /** Get an ApprovedSigner for this batch, or throw ApprovalHaltError. */
  async request(req: ApprovalRequest, ro: RequestOptions = {}): Promise<ApprovedSigner> {
    const batchHash = computeBatchHash(req.chainId, req.from, req.payloads);

    const approved = this.store.findByBatch(batchHash, "approved");
    if (approved) {
      const s = this.takeApproved(approved);
      if (s) return s;
    }

    const declined = this.store.recentDecline(batchHash);
    if (declined) {
      throw new ApprovalHaltError({
        ...this.haltOf(declined, "declined", "The owner declined this exact batch recently; nothing was signed."),
        retryAfter: new Date(this.store.cooldownEndsAt(declined)).toISOString(),
      });
    }

    const executing = this.store.findByBatch(batchHash, "executing");
    if (executing) {
      throw new ApprovalHaltError(
        this.haltOf(executing, "executing", "This exact batch is being signed by another call right now — wait for it, then re-check."),
      );
    }

    let record = this.store.findByBatch(batchHash, "pending");
    if (!record) {
      const resumeNote = this.store.resumeNoteFor(req.tool, req.from, req.chainId);
      record = this.store.create({
        tool: req.tool,
        chainId: req.chainId,
        from: req.from,
        steps: req.steps,
        expected: req.payloads.map((p) => ({ to: p.to, value: BigInt(p.value || "0"), dataHash: dataHashOf(p.data) })),
        prechecks: req.prechecks,
        batchHash,
        fingerprint: fingerprintOf(batchHash),
        ...(resumeNote ? { resumeNote } : {}),
      });
      await this.server.start();
      const url = this.server.urlFor(record);
      this.opts.log?.(
        `[dexe-mcp] APPROVAL NEEDED — ${req.tool}: ${record.steps.length} tx on ${chainLabel(req.chainId)} from ${req.from}. ` +
          `Open ${url} and check fingerprint ${record.fingerprint}.`,
      );
      if (this.opts.openBrowser) (this.opts.opener ?? defaultOpenBrowser)(url);
    } else {
      await this.server.start();
    }
    const url = this.server.urlFor(record);

    const waitMs = Math.max(0, Math.min(ro.waitMs ?? this.opts.waitMs, record.expiresAt - Date.now()));
    const deadline = Date.now() + waitMs;
    await ro.progress?.(
      `Waiting for the owner to approve ${record.steps.length} transaction(s) at ${url} (fingerprint ${record.fingerprint}).`,
    );
    let current: ApprovalRecord | undefined = record;
    while (current?.status === "pending" && Date.now() < deadline && !ro.signal?.aborted) {
      current = await this.store.waitForDecision(record.approvalId, Math.min(HEARTBEAT_MS, deadline - Date.now()), ro.signal);
      if (current?.status === "pending" && Date.now() < deadline) {
        await ro.progress?.(`Still waiting for approval at ${url} (fingerprint ${record.fingerprint}).`);
      }
    }

    const r = current ?? record;
    if (r.status === "approved") {
      const s = this.takeApproved(r);
      if (s) return s;
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
        `Waiting for the owner to approve ${r.steps.length} transaction(s) on ${chainLabel(r.chainId)} in the browser ` +
          `(fingerprint ${r.fingerprint}). Nothing was signed yet.`,
        url,
      ),
    );
  }

  /** The read-only view `dexe_tx_approval_status` returns. */
  view(approvalId: string): Record<string, unknown> | undefined {
    const r = this.store.get(approvalId);
    if (!r) return undefined;
    const next: Record<string, string> = {
      pending:
        "Waiting for the owner. Ask them to approve on the page (never for the password in chat), then re-run the original call.",
      approved: "Approved and not used yet — re-run the ORIGINAL call with the same arguments now; it signs without asking again.",
      executing: "Being signed and sent right now — check again shortly.",
      consumed: "Done — every approved transaction was sent (see landed).",
      declined: "The owner declined. Do not retry unless the user asks.",
      expired: "Expired before use. Re-run the original call for a fresh approval link.",
      revoked: "Revoked (a transaction differed from the approved batch, a step failed, or a newer approval replaced it). Re-run the original call if the user still wants it.",
    };
    return {
      approvalId: r.approvalId,
      status: r.status,
      tool: r.tool,
      chainId: r.chainId,
      from: r.from,
      fingerprint: r.fingerprint,
      steps: stepLabels(r.steps),
      ...(r.status === "pending" && this.server.started ? { url: this.server.urlFor(r) } : {}),
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      landed: r.landed,
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
      status: r.status,
      tool: r.tool,
      chainId: r.chainId,
      fingerprint: r.fingerprint,
      txCount: r.steps.length,
      expiresAt: new Date(r.expiresAt).toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

export function stepLabels(steps: readonly ReviewStep[]): string[] {
  return steps.map((s) => {
    const call = s.decoded ? `${s.decoded.contract ? `${s.decoded.contract}.` : ""}${s.decoded.signature.split("(")[0]}` : s.selector ?? "transfer";
    return `${s.index + 1}. ${call} → ${s.toLabel} (${s.to})`;
  });
}
