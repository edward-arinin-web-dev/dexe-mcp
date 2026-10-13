import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect } from "node:net";

/**
 * ── The terminal-channel protocol (v2): the server proves itself first ─────
 *
 * The per-process secret from the owner-only rendezvous file never crosses
 * the channel. One request per connection:
 *
 *   client → { v:2, op:"hello", nonce: Nc }                 (nothing secret)
 *   server → { ok, v:2, serverNonce: Ns,
 *              proof: HMAC(secret, "…/server-proof" ‖ Nc ‖ Ns ‖ pid) }
 *   client    verifies the proof — a server that does not hold this
 *             server's secret (a stale rendezvous whose pipe name another
 *             user re-created, a squatted socket path) is refused here, BEFORE
 *             anything secret leaves the client
 *   client → { v:2, payload: "<json>", mac: HMAC(secret, "…/request" ‖ Nc ‖ Ns ‖ payload),
 *              sealedPassword? }
 *             a password travels only sealed — AES-256-GCM under
 *             HKDF(secret, Nc ‖ Ns), with the exact payload as associated
 *             data, so it opens only for that one request
 *   server    verifies the MAC (constant time), opens the password, answers
 *
 * The labels separate the proof from the request MAC, so neither can be
 * replayed as the other; the fresh Ns per connection stops a request from
 * being replayed on another connection.
 *
 * The server's reply after the proof is NOT MAC'd: it travels on the same
 * local socket / pipe whose other end just proved it holds the secret, and
 * carries no secret. A connection that says hello but sends no authenticated
 * request is dropped after 10 s.
 */

export const PROTOCOL_VERSION = 2;
const L_SERVER = "dexe-mcp/approve/v2/server-proof";
const L_REQUEST = "dexe-mcp/approve/v2/request";
const L_PASSWORD = "dexe-mcp/approve/v2/password";
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function isNonce(v: unknown): v is string {
  return typeof v === "string" && NONCE_RE.test(v);
}

function hmac(secret: string, label: string, parts: readonly string[]): string {
  const h = createHmac("sha256", Buffer.from(secret, "utf8"));
  h.update(label);
  for (const p of parts) {
    h.update("\n");
    h.update(p);
  }
  return h.digest("hex");
}

export function serverProof(secret: string, clientNonce: string, serverNonce: string, pid: number): string {
  return hmac(secret, L_SERVER, [clientNonce, serverNonce, String(pid)]);
}

export function requestMac(secret: string, clientNonce: string, serverNonce: string, payload: string): string {
  return hmac(secret, L_REQUEST, [clientNonce, serverNonce, payload]);
}

/** Constant-time compare of two hex MACs (false on any shape mismatch). */
export function macEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface SealedPassword {
  iv: string;
  ct: string;
  tag: string;
}

function passwordKey(secret: string, clientNonce: string, serverNonce: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(`${clientNonce}\n${serverNonce}`, "utf8"), L_PASSWORD, 32),
  );
}

/**
 * Seal a password for one request. `boundTo` is the exact MAC'd payload of
 * that request (it names the approval): the GCM tag fails if the sealed
 * password is moved to any other request. The password is encrypted, never
 * hashed or MAC'd.
 */
export function sealPassword(
  secret: string,
  clientNonce: string,
  serverNonce: string,
  boundTo: string,
  password: string,
): SealedPassword {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", passwordKey(secret, clientNonce, serverNonce), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(boundTo, "utf8"));
  const ct = Buffer.concat([c.update(password, "utf8"), c.final()]);
  return { iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
}

/** The password, or null when it does not open (wrong key, another request, tampered). */
export function openPassword(
  secret: string,
  clientNonce: string,
  serverNonce: string,
  boundTo: string,
  sealed: unknown,
): string | null {
  const s = sealed as Partial<SealedPassword> | null;
  if (!s || typeof s.iv !== "string" || typeof s.ct !== "string" || typeof s.tag !== "string") return null;
  const iv = Buffer.from(s.iv, "base64url");
  const tag = Buffer.from(s.tag, "base64url");
  // Exactly a 96-bit IV and a full 128-bit tag: GCM otherwise accepts a
  // truncated tag (4 bytes opened in a probe), which makes forgery cheap.
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", passwordKey(secret, clientNonce, serverNonce), iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(boundTo, "utf8"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ControlConnectError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ControlConnectError";
  }
}

/** The server did not prove it holds this server's secret — nothing secret was sent. */
export class ControlAuthError extends ControlConnectError {
  constructor(message: string) {
    super(message, "EAUTH");
    this.name = "ControlAuthError";
  }
}

interface LineConn {
  send(obj: Record<string, unknown>): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

function lineConn(endpoint: string, timeoutMs: number): LineConn {
  const sock = netConnect(endpoint);
  sock.setEncoding("utf8");
  let buf = "";
  const lines: string[] = [];
  let failure: Error | null = null;
  let waiter: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null;
  const fail = (e: Error) => {
    if (failure) return;
    failure = e;
    if (waiter) {
      waiter.reject(e);
      waiter = null;
    }
  };
  const pump = () => {
    if (!waiter || lines.length === 0) return;
    const line = lines.shift()!;
    const w = waiter;
    waiter = null;
    try {
      w.resolve(JSON.parse(line) as Record<string, unknown>);
    } catch {
      w.reject(new ControlConnectError("malformed response", "EPROTO"));
    }
  };
  const timer = setTimeout(() => {
    fail(new ControlConnectError("the server did not answer in time", "ETIMEDOUT"));
    sock.destroy();
  }, timeoutMs);
  sock.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > 4 * 1024 * 1024) {
      fail(new ControlConnectError("response too large", "E2BIG"));
      sock.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    pump();
  });
  sock.on("end", () => fail(new ControlConnectError("the server closed the connection", "ECONNRESET")));
  sock.on("error", (e: NodeJS.ErrnoException) => fail(new ControlConnectError(e.message, e.code)));
  sock.on("close", () => clearTimeout(timer));
  const queued: string[] = [];
  let connected = false;
  sock.on("connect", () => {
    connected = true;
    for (const q of queued.splice(0)) sock.write(q);
  });
  return {
    send(obj) {
      const line = `${JSON.stringify(obj)}\n`;
      if (connected) sock.write(line);
      else queued.push(line);
    },
    next() {
      return new Promise((resolveNext, reject) => {
        if (lines.length === 0 && failure) return reject(failure);
        waiter = { resolve: resolveNext, reject };
        pump();
      });
    },
    close() {
      clearTimeout(timer);
      sock.destroy();
    },
  };
}

/**
 * One authenticated request to a terminal channel. The server must prove it
 * holds `server.secret` before anything secret is sent; a `password` in
 * `body` is sealed, never sent as text. Throws {@link ControlAuthError} when
 * the proof fails (nothing secret left this process), {@link ControlConnectError}
 * when the endpoint is gone or misbehaves.
 */
export async function controlCall(
  server: { endpoint: string; secret: string; pid: number },
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const conn = lineConn(server.endpoint, timeoutMs);
  try {
    const clientNonce = newNonce();
    conn.send({ v: PROTOCOL_VERSION, op: "hello", nonce: clientNonce });
    const hello = await conn.next();
    const serverNonce = hello.serverNonce;
    if (
      hello.ok !== true ||
      !isNonce(serverNonce) ||
      !macEqual(hello.proof, serverProof(server.secret, clientNonce, serverNonce, server.pid))
    ) {
      throw new ControlAuthError(
        `the process at ${server.endpoint} could not prove it is the dexe-mcp server that wrote this rendezvous ` +
          "(no proof of its secret) — nothing secret was sent to it",
      );
    }
    const { password, ...rest } = body;
    const payload = JSON.stringify(rest);
    const msg: Record<string, unknown> = {
      v: PROTOCOL_VERSION,
      payload,
      mac: requestMac(server.secret, clientNonce, serverNonce, payload),
    };
    // Outside the MAC'd payload, but bound to it (GCM associated data).
    if (typeof password === "string") {
      msg.sealedPassword = sealPassword(server.secret, clientNonce, serverNonce, payload, password);
    }
    conn.send(msg);
    return await conn.next();
  } finally {
    conn.close();
  }
}
