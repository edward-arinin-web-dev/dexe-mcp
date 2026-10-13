import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeErrorMessage } from "../redact.js";
import type { ApprovalRecord, ApprovalStore } from "./store.js";
import { isNonce, macEqual, newNonce, openPassword, PROTOCOL_VERSION, requestMac, serverProof } from "./controlProtocol.js";
import type { ApproveAttempt } from "./server.js";
import {
  currentIdentity,
  discoverServers,
  prepareRunDir,
  removeRendezvous,
  RENDEZVOUS_VERSION,
  writeRendezvous,
  type PosixIdentity,
} from "./rendezvous.js";

/**
 * ── The terminal approval channel (`dexe-mcp approve`) ─────────────────────
 *
 * A second way to the SAME approvals, for owners on SSH or who would rather
 * not type a password into a browser an AI could be driving. It reaches the
 * same store, the same password check (one scrypt at a time, shared with the
 * page) and the same global lockout — there is one counter, whichever channel
 * the guesses come through.
 *
 * Transport and discovery: see rendezvous.ts (owner-only IPC endpoint + a
 * per-process secret in an owner-only file). Protocol v2 (controlProtocol.ts):
 * the client's hello carries only a nonce, this server answers with a proof
 * of the secret, then ONE request arrives as a MAC'd payload:
 *
 *   { op: "hello" }                                                    → server identity
 *   { op: "list" }                                                     → pending approvals, reviewed
 *   { op: "approve", approvalId, binding, sealedPassword }             → the password check
 *   { op: "decline", approvalId, binding }                             → decline
 *
 * The secret itself is never accepted on the wire (a v1 `{ secret }` request
 * is refused). `binding` must equal the approval's binding hash, so a decision
 * is always about the review the terminal displayed. There is no op that
 * approves without a password.
 */

export interface ControlDeps {
  store: ApprovalStore;
  address: string;
  runDir: string;
  version: string;
  /** The manager's queued, lockout-checked password check — the page uses the same one. */
  attemptApprove(record: ApprovalRecord, password: string): Promise<ApproveAttempt>;
  /** The review a terminal prints (no page token, no CSRF token). */
  reviewOf(record: ApprovalRecord): Record<string, unknown>;
  log?: (line: string) => void;
  identity?: PosixIdentity;
  pid?: number;
}

const MAX_REQUEST = 16 * 1024;

export class ControlChannel {
  private server: Server | undefined;
  private starting: Promise<boolean> | undefined;
  private secret = "";
  private endpoint = "";
  private file = "";
  private readonly id: PosixIdentity;
  private readonly pid: number;
  private exitHook: (() => void) | undefined;

  constructor(private readonly deps: ControlDeps) {
    this.id = deps.identity ?? currentIdentity();
    this.pid = deps.pid ?? process.pid;
  }

  get started(): boolean {
    return !!this.server;
  }

  /** Where the rendezvous file is (tests). */
  get rendezvousPath(): string {
    return this.file;
  }

  /** Start once. Never throws: on failure the channel stays off and the page still works. */
  start(): Promise<boolean> {
    this.starting ??= this.doStart().catch((e: unknown) => {
      this.deps.log?.(
        `[dexe-mcp] terminal approvals (dexe-mcp approve) are unavailable: ${safeErrorMessage(e)}. ` +
          "Approve on the page instead.",
      );
      this.starting = undefined;
      return false;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    prepareRunDir(this.deps.runDir, this.id);
    // Leftovers of servers that died without cleaning up.
    discoverServers(this.deps.runDir, { id: this.id });
    this.secret = randomBytes(32).toString("base64url");
    this.endpoint =
      this.id.platform === "win32"
        ? `\\\\.\\pipe\\dexe-mcp-approve-${this.pid}-${randomBytes(16).toString("hex")}`
        : join(this.deps.runDir, `approve-${this.pid}.sock`);
    if (this.id.platform !== "win32") {
      if (Buffer.byteLength(this.endpoint) > 100) {
        throw new Error(`the socket path ${this.endpoint} is too long for a unix socket (set a shorter HOME)`);
      }
      // A socket file with our pid in our 0700 directory is a leftover of an
      // earlier process that had this pid.
      if (existsSync(this.endpoint)) {
        const st = lstatSync(this.endpoint);
        if (st.isSocket() && st.uid === this.id.uid) unlinkSync(this.endpoint);
      }
    }
    const srv = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolveListen, reject) => {
      srv.once("error", reject);
      srv.listen(this.endpoint, () => {
        srv.off("error", reject);
        resolveListen();
      });
    });
    srv.unref();
    srv.on("error", () => undefined);
    if (this.id.platform !== "win32") chmodSync(this.endpoint, 0o600);
    this.server = srv;
    this.file = writeRendezvous(this.deps.runDir, {
      v: RENDEZVOUS_VERSION,
      pid: this.pid,
      address: this.deps.address,
      endpoint: this.endpoint,
      secret: this.secret,
      createdAt: new Date().toISOString(),
      version: this.deps.version,
    });
    this.exitHook = () => this.cleanupSync();
    process.once("exit", this.exitHook);
    return true;
  }

  private cleanupSync(): void {
    if (this.file) removeRendezvous(this.file, this.id);
    else if (this.endpoint && this.id.platform !== "win32") {
      try {
        unlinkSync(this.endpoint);
      } catch {
        /* gone */
      }
    }
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (this.exitHook) process.off("exit", this.exitHook);
    this.exitHook = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    this.cleanupSync();
    this.file = "";
    this.endpoint = "";
  }

  // ---------------------------------------------------------------------------

  private onConnection(sock: Socket): void {
    sock.setEncoding("utf8");
    sock.setTimeout(150_000, () => sock.destroy());
    let buf = "";
    let stage: "hello" | "request" | "done" = "hello";
    let clientNonce = "";
    let serverNonce = "";
    const send = (body: Record<string, unknown>) => {
      if (sock.writable) sock.write(`${JSON.stringify(body)}\n`);
    };
    const finish = (body: Record<string, unknown>) => {
      stage = "done";
      if (sock.writable) sock.end(`${JSON.stringify(body)}\n`);
    };
    const onLine = (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return finish({ ok: false, status: "refused", message: "malformed request" });
      }
      if (stage === "hello") {
        // Step 1: prove THIS server holds the secret, before the client sends anything secret.
        if (msg.v !== PROTOCOL_VERSION || msg.op !== "hello" || !isNonce(msg.nonce) || "secret" in msg) {
          return finish({ ok: false, status: "refused", message: `protocol v${PROTOCOL_VERSION} hello expected` });
        }
        clientNonce = msg.nonce;
        serverNonce = newNonce();
        stage = "request";
        return send({ ok: true, v: PROTOCOL_VERSION, serverNonce, proof: serverProof(this.secret, clientNonce, serverNonce, this.pid) });
      }
      // Step 2: exactly one request, authenticated by its MAC over these nonces.
      stage = "done";
      const payload = msg.payload;
      if (typeof payload !== "string" || !macEqual(msg.mac, requestMac(this.secret, clientNonce, serverNonce, payload))) {
        return finish({ ok: false, status: "unauthorized", message: "request not authenticated" });
      }
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return finish({ ok: false, status: "refused", message: "malformed request" });
      }
      this.handle(req, { clientNonce, serverNonce }).then(finish, () =>
        finish({ ok: false, status: "error", message: "internal error" }),
      );
    };
    sock.on("error", () => undefined);
    sock.on("data", (chunk: string) => {
      if (stage === "done") return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) {
        finish({ ok: false, status: "refused", message: "request too large" });
        return;
      }
      let nl: number;
      // (onLine moves `stage` forward; re-read it each turn.)
      while ((stage as string) !== "done" && (nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    });
  }

  private async handle(
    req: Record<string, unknown>,
    session: { clientNonce: string; serverNonce: string },
  ): Promise<Record<string, unknown>> {
    const store = this.deps.store;
    switch (req.op) {
      case "hello":
        return { ok: true, pid: this.pid, address: this.deps.address, version: this.deps.version, lockedForMs: store.lockedForMs() };
      case "list":
        return {
          ok: true,
          pid: this.pid,
          address: this.deps.address,
          lockedForMs: store.lockedForMs(),
          approvals: store
            .open()
            .filter((r) => r.status === "pending")
            .map((r) => this.deps.reviewOf(r)),
        };
      case "approve":
      case "decline": {
        const record = typeof req.approvalId === "string" ? store.get(req.approvalId) : undefined;
        if (!record) return { ok: false, status: "not-found", message: "no such approval (expired, or the server restarted)" };
        if (typeof req.binding !== "string" || req.binding !== record.batchHash) {
          return { ok: false, status: "refused", message: "the approval does not match the review you saw — list again" };
        }
        if (record.status !== "pending") {
          return { ok: false, status: record.status, message: `this approval is already ${record.status}` };
        }
        if (req.op === "decline") {
          store.decline(record.approvalId, "declined by the owner in the terminal (dexe-mcp approve)");
          this.deps.log?.(`[dexe-mcp] approval ${record.approvalId} declined in the terminal`);
          return { ok: true, status: "declined", message: "Declined. Nothing was signed." };
        }
        // Only a sealed password is accepted (never plain text on the wire).
        const password =
          openPassword(this.secret, session.clientNonce, session.serverNonce, record.approvalId, req.sealedPassword) ?? "";
        if (!password || password.length > 1024) return { ok: false, status: "refused", message: "enter the keystore password" };
        const out = await this.deps.attemptApprove(record, password);
        if (out.kind === "approved") {
          this.deps.log?.(`[dexe-mcp] approval ${record.approvalId} approved in the terminal`);
          const mins = Math.max(1, Math.round(store.approvedUseWindowMs / 60_000));
          return {
            ok: true,
            status: "approved",
            message:
              "Approved. If the tool call is still waiting it signs now; if it already returned, ask the AI to re-run it " +
              `within ${mins} min (after that the key is dropped and you approve again).`,
          };
        }
        if (out.kind === "locked") {
          return {
            ok: false,
            status: "locked",
            retryAfterMs: out.retryAfterMs,
            message: `Too many wrong passwords — password entry is locked; try again in ${Math.ceil(out.retryAfterMs / 1000)} s.`,
          };
        }
        if (out.kind === "wrong-password") {
          return {
            ok: false,
            status: out.declined ? "declined" : "wrong-password",
            remaining: out.remaining,
            lockedMs: out.lockedMs,
            message:
              (out.declined
                ? "Too many wrong passwords — this approval was declined."
                : `Wrong password. ${out.remaining} attempt(s) left for this approval.`) +
              (out.lockedMs > 0 ? ` Password entry is now locked for ${Math.ceil(out.lockedMs / 1000)} s.` : ""),
          };
        }
        return { ok: false, status: "error", message: out.message };
      }
      default:
        return { ok: false, status: "refused", message: "unknown op" };
    }
  }
}
