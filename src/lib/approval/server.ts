import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { checkOrigin } from "../../http/security.js";
import { safeEqual, type ApprovalRecord, type ApprovalStore } from "./store.js";
import { renderApprovalPage, renderClosedPage, renderNotFoundPage } from "./page.js";

/**
 * ── The loopback approval server ───────────────────────────────────────────
 *
 * Plain node:http on 127.0.0.1, random port, started on the first approval
 * and `unref()`ed so it never keeps the process alive. Admission, in order:
 *
 *   1. Host must be exactly `127.0.0.1:<port>` — a DNS-rebinding page
 *      (evil.example resolving to 127.0.0.1) arrives with its own Host.
 *   2. Only GET and POST; everything else is 405.
 *   3. The path carries a per-approval random token (`/a/<token>`); unknown
 *      tokens are 404 with no hint which part was wrong.
 *   4. POSTs need `Origin: http://127.0.0.1:<port>` (same-origin), a JSON
 *      body (a cross-site form cannot send one without a preflight), ≤ 4 KB,
 *      and the per-approval CSRF token from the page.
 *   5. Password attempts are serialized (one scrypt at a time), refused while
 *      the lockout runs, and refused outright from an automated browser
 *      (`navigator.webdriver`).
 *
 * Every response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
 * `X-Frame-Options: DENY`, nosniff; HTML adds a nonce-only CSP.
 */

export type ApproveAttempt =
  | { kind: "approved" }
  | { kind: "wrong-password"; remaining: number; declined: boolean; lockedMs: number }
  | { kind: "locked"; retryAfterMs: number }
  | { kind: "error"; message: string };

export interface ApprovalServerDeps {
  store: ApprovalStore;
  /** Decrypt with `password` and, on success, approve `record`. Never logs the password. */
  attemptApprove(record: ApprovalRecord, password: string): Promise<ApproveAttempt>;
  log?: (line: string) => void;
}

const MAX_BODY = 4 * 1024;

export class ApprovalServer {
  private server: Server | undefined;
  private starting: Promise<number> | undefined;
  private port = 0;
  /** One password check at a time — scrypt is the rate limit, never run in parallel. */
  private attemptChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ApprovalServerDeps) {}

  /** Start (once) and resolve the port. */
  start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolveStart, reject) => {
      const srv = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) this.json(res, 500, { status: "error", message: "internal error" });
          else res.end();
        });
      });
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        this.port = (srv.address() as AddressInfo).port;
        srv.unref();
        this.server = srv;
        resolveStart(this.port);
      });
    });
    return this.starting;
  }

  get started(): boolean {
    return this.port > 0;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  urlFor(r: ApprovalRecord): string {
    return `${this.origin}/a/${r.pathToken}`;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.port = 0;
    this.starting = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  // ---------------------------------------------------------------------------

  private baseHeaders(res: ServerResponse): void {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }

  private json(res: ServerResponse, code: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
    this.baseHeaders(res);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  private html(res: ServerResponse, code: number, render: (nonce: string) => string): void {
    this.baseHeaders(res);
    const nonce = randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
        "img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.statusCode = code;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(render(nonce));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Exact Host.
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      this.json(res, 421, { status: "refused", message: "wrong Host — open the exact link the tool printed" });
      return;
    }
    // 2. Methods.
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      this.json(res, 405, { status: "refused", message: "method not allowed" }, { Allow: "GET, POST" });
      return;
    }
    // 3. Route.
    const path = (req.url ?? "/").split("?")[0]!;
    const m = /^\/a\/([A-Za-z0-9_-]{16,64})(?:\/(approve|decline|status))?$/.exec(path);
    const record = m ? this.deps.store.getByToken(m[1]!) : undefined;
    if (!m || !record) {
      if (method === "GET" && !m?.[2]) this.html(res, 404, renderNotFoundPage);
      else this.json(res, 404, { status: "not-found", message: "no such approval" });
      return;
    }
    const action = m[2];
    const base = `/a/${record.pathToken}`;

    if (method === "GET") {
      if (action === "status") {
        this.json(res, 200, { status: record.status, landed: record.landed, reason: record.reason ?? null });
        return;
      }
      if (action) {
        this.json(res, 405, { status: "refused", message: "use POST" }, { Allow: "POST" });
        return;
      }
      if (record.status === "pending") {
        this.html(res, 200, (nonce) =>
          renderApprovalPage(record, {
            nonce,
            approvePath: `${base}/approve`,
            declinePath: `${base}/decline`,
            statusPath: `${base}/status`,
          }),
        );
      } else {
        this.html(res, 200, (nonce) => renderClosedPage(record, nonce));
      }
      return;
    }

    // 4. POST admission: approve / decline only, same-origin, JSON, CSRF.
    if (action !== "approve" && action !== "decline") {
      this.json(res, 405, { status: "refused", message: "method not allowed" }, { Allow: "GET" });
      return;
    }
    if (checkOrigin(req.headers.origin, [this.origin]) !== "allowed") {
      this.json(res, 403, { status: "refused", message: "cross-origin request refused" });
      return;
    }
    const ctype = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (ctype !== "application/json") {
      this.json(res, 415, { status: "refused", message: "JSON body required" });
      return;
    }
    let body: { csrf?: unknown; password?: unknown; webdriver?: unknown };
    try {
      body = JSON.parse(await readBody(req, MAX_BODY)) as typeof body;
    } catch (e) {
      const tooBig = e instanceof Error && e.message === "too-large";
      this.json(res, tooBig ? 413 : 400, { status: "refused", message: tooBig ? "body too large" : "malformed JSON" });
      return;
    }
    if (typeof body?.csrf !== "string" || !safeEqual(body.csrf, record.csrf)) {
      this.json(res, 403, { status: "refused", message: "missing or wrong CSRF token — reload the page" });
      return;
    }
    if (record.status !== "pending") {
      this.json(res, 409, { status: record.status, message: `this approval is already ${record.status}` });
      return;
    }

    if (action === "decline") {
      this.deps.store.decline(record.approvalId, "declined by the owner on the approval page");
      this.deps.log?.(`[dexe-mcp] approval ${record.approvalId} declined on the page`);
      this.json(res, 200, { status: "declined", message: "Declined. Nothing was signed." });
      return;
    }

    // 5. Password.
    if (body.webdriver === true) {
      this.json(res, 403, {
        status: "refused-webdriver",
        message:
          "This browser is being driven by automation (navigator.webdriver), so it will not take a password. " +
          "Open the link in your normal browser and approve there.",
      });
      return;
    }
    const locked429 = (ms: number) => {
      const s = Math.max(1, Math.ceil(ms / 1000));
      this.json(
        res,
        429,
        { status: "locked", message: `Too many wrong passwords — password entry is locked; try again in ${s} s.` },
        { "Retry-After": String(s) },
      );
    };
    // Checked here (cheap early refusal) AND again inside the queue right
    // before the password is verified: attempts queued behind a lockout must
    // not run once it starts.
    const locked = this.deps.store.lockedForMs();
    if (locked > 0) {
      locked429(locked);
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length > 1024) {
      this.json(res, 400, { status: "refused", message: "enter the keystore password" });
      return;
    }
    const attempt = this.attemptChain.then((): Promise<ApproveAttempt> => {
      const lockedNow = this.deps.store.lockedForMs();
      if (lockedNow > 0) return Promise.resolve({ kind: "locked", retryAfterMs: lockedNow });
      return record.status === "pending"
        ? this.deps.attemptApprove(record, password)
        : Promise.resolve({ kind: "error", message: `this approval is already ${record.status}` });
    });
    this.attemptChain = attempt.catch(() => undefined);
    let out: ApproveAttempt;
    try {
      out = await attempt;
    } catch {
      out = { kind: "error", message: "could not check the password" };
    }
    if (out.kind === "approved") {
      const mins = Math.max(1, Math.round(this.deps.store.approvedUseWindowMs / 60_000));
      this.json(res, 200, {
        status: "approved",
        message:
          "Approved. If the tool call is still waiting it signs now — keep this tab open to watch the transactions " +
          `land. If it already returned, re-run it within ${mins} min; after that the key is dropped and you approve again.`,
      });
      return;
    }
    if (out.kind === "locked") {
      locked429(out.retryAfterMs);
      return;
    }
    if (out.kind === "wrong-password") {
      const lock = out.lockedMs > 0 ? ` Password entry is now locked for ${Math.ceil(out.lockedMs / 1000)} s.` : "";
      this.json(res, 401, {
        status: out.declined ? "declined" : "wrong-password",
        message:
          (out.declined
            ? "Too many wrong passwords — this approval was declined."
            : `Wrong password. ${out.remaining} attempt(s) left for this approval.`) + lock,
      });
      return;
    }
    this.json(res, 400, { status: "error", message: out.message });
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // drain without buffering
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new Error("too-large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
