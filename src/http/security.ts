import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * Request-admission checks for the HTTP mode: Host and Origin validation,
 * client-IP resolution behind a reverse proxy, and a per-IP token bucket.
 * Everything here is pure or self-contained so it can be unit-tested without
 * a socket.
 */

/**
 * Host header → bare lowercase hostname (no port), or null when unparseable.
 * IPv6 literals keep their brackets, matching how operators write them.
 */
export function hostnameFromHostHeader(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const u = new URL(`http://${header.trim()}`);
    // A Host header is authority only; anything that parses into a path,
    // query or credentials is not a Host header.
    if (u.pathname !== "/" || u.search || u.username || u.password) return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** `null` allowlist = check disabled. */
export function hostAllowed(header: string | undefined, allowed: readonly string[] | null): boolean {
  if (allowed === null) return true;
  const h = hostnameFromHostHeader(header);
  return h !== null && allowed.includes(h);
}

export type OriginVerdict = "absent" | "allowed" | "rejected";

/**
 * Spec (2025-11-25 and 2026-07-28 Streamable HTTP): "If the Origin header is
 * present and invalid, servers MUST respond with HTTP 403". An absent Origin is
 * the normal case for server-to-server clients — the Claude.ai and ChatGPT
 * connector backends, SDK clients, curl — and is allowed.
 *
 * The literal `Origin: null` (sandboxed iframes, file://) is present and not a
 * real origin, so it is rejected unless the operator opened the check with `*`.
 */
export function checkOrigin(header: string | undefined, allowed: readonly string[] | null): OriginVerdict {
  if (header === undefined || header.trim() === "") return "absent";
  if (allowed === null) return "allowed";
  let origin: string;
  try {
    origin = new URL(header.trim()).origin.toLowerCase();
  } catch {
    return "rejected";
  }
  if (origin === "null") return "rejected";
  return allowed.includes(origin) ? "allowed" : "rejected";
}

/**
 * One address in canonical form: no port (`1.2.3.4:5678`, `[2001:db8::1]:443`),
 * no brackets, no zone id (`fe80::1%eth0`), IPv4-mapped IPv6 folded to IPv4,
 * lowercase. Proxies write X-Forwarded-For entries in all of these shapes; left
 * as-is, one client would get a fresh rate-limit bucket per source port.
 */
export function canonicalIp(ip: string): string {
  let t = ip.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
  if (bracketed) t = bracketed[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(t)) t = t.slice(0, t.lastIndexOf(":"));
  const zone = t.indexOf("%");
  if (zone !== -1) t = t.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  return mapped ? mapped[1]! : t.toLowerCase();
}

/** Eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  // Trailing dotted IPv4 (e.g. 64:ff9b::1.2.3.4) becomes two groups. Parsed
  // by splitting, not a regex: this runs on header-derived input.
  const lastColon = s.lastIndexOf(":");
  const tailPart = s.slice(lastColon + 1);
  if (isIP(tailPart) === 4) {
    const b = tailPart.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The rate-limit bucket for an address. IPv4: the address. IPv6: its /64 —
 * one subscriber is routinely handed a whole /64, so per-address buckets
 * would give a single client 2^64 of them.
 */
export function rateLimitKey(ip: string): string {
  const c = canonicalIp(ip);
  if (isIP(c) !== 6) return c;
  const g = ipv6Groups(c);
  if (!g) return c;
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/**
 * The client address used for rate limiting and the hashed access-log field.
 *
 * With `trustProxyHops = 0` (default) X-Forwarded-For is ignored entirely: a
 * client can put anything in it, so honouring it on a directly exposed server
 * hands every caller an unlimited supply of fresh rate-limit buckets.
 *
 * With N trusted hops the address chain is read right to left — the socket peer
 * first, then X-Forwarded-For entries from the nearest proxy outward — and the
 * address N steps in is the client. This is the same rule as Express's numeric
 * `trust proxy`. Entries that are not IP addresses end the walk (a proxy that
 * writes garbage is not trusted past that point).
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxyHops: number,
): string {
  const peer = canonicalIp(socketAddress ?? "unknown");
  if (trustProxyHops <= 0 || forwardedFor === undefined) return peer;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const hops = raw
    .split(",")
    .map((s) => canonicalIp(s))
    .filter(Boolean)
    .reverse();
  const chain = [peer];
  for (const h of hops) {
    if (isIP(h) === 0) break;
    chain.push(h);
  }
  return chain[Math.min(trustProxyHops, chain.length - 1)]!;
}

/**
 * Per-process salted hash of a client IP for the access log. The salt is random
 * per process and never logged, so a log line cannot be turned back into an
 * address by hashing the IPv4 space, while one process's lines still correlate.
 */
export function makeIpHasher(salt: Buffer = randomBytes(16)): (ip: string) => string {
  return (ip: string) => createHash("sha256").update(salt).update(ip).digest("hex").slice(0, 12);
}

interface Bucket {
  tokens: number;
  updated: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until one token is available again (only meaningful when refused). */
  retryAfterSeconds: number;
}

/**
 * In-memory token bucket per key (client IP). `perMinute` tokens refill evenly
 * over a minute up to `burst`. Memory is bounded: idle full buckets are swept,
 * and past `maxKeys` the oldest bucket is evicted (an evicted client simply
 * starts again with a full bucket — failing open on memory pressure, never
 * locking anyone out).
 *
 * Process-local by design. Several replicas each enforce their own limit; put
 * a shared limiter at the reverse proxy if that matters.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;
  private lastSweep: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {
    this.ratePerMs = perMinute / 60_000;
    this.lastSweep = now();
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): RateDecision {
    if (!this.enabled) return { allowed: true, retryAfterSeconds: 0 };
    const t = this.now();
    this.maybeSweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.burst, updated: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (t - b.updated) * this.ratePerMs);
      b.updated = t;
      // Re-insert so Map order tracks recency for eviction.
      this.buckets.delete(key);
      this.buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const waitMs = (1 - b.tokens) / this.ratePerMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  /** Drop buckets that have refilled completely — they carry no information. */
  private maybeSweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.updated) * this.ratePerMs >= this.burst) this.buckets.delete(k);
    }
  }
}
