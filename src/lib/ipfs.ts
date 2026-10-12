import { CID } from "multiformats/cid";
import * as json from "multiformats/codecs/json";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";
import { safeErrorMessage } from "./redact.js";
import { BodyTooLargeError, discardBody, formatBytes, readBodyCapped } from "./boundedBody.js";
import { currentRequestSignal, deadlineSignal, RequestCancelledError } from "./requestScope.js";

/**
 * Public IPFS read gateways seeded as a zero-config default when the operator
 * configures no dedicated gateway. Public gateways (ipfs.io, dweb.link,
 * cloudflare) are best-effort — they rate-limit and occasionally 5xx — so
 * `fetchIpfs` tries them in order and `dexe_doctor` nudges heavy users toward a
 * dedicated gateway (a free Pinata dedicated gateway, Filebase, Quicknode, or a
 * self-hosted one) via `DEXE_IPFS_GATEWAY`. Opt out of the public default with
 * `DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1`. This covers READS only — uploads still
 * require a Pinata JWT.
 */
export const DEFAULT_PUBLIC_READ_GATEWAYS: readonly string[] = [
  "https://ipfs.io",
  "https://dweb.link",
  "https://cloudflare-ipfs.com",
];

export interface IpfsFetchConfig {
  gateways: readonly string[];
  /** Per-hop timeout in ms. Default 10000 (a dedicated Pinata gateway answers a small JSON in 5–6 s; 4 s timed out on every read, 2026-09-24). */
  perRequestTimeoutMs?: number;
  /**
   * Byte ceiling for the body. Default: `resolveIpfsMaxBytes()` (2 MB, or
   * `DEXE_IPFS_MAX_BYTES`). Over it the fetch stops and throws
   * `IpfsTooLargeError` — no other gateway is tried, since the CID names the
   * same bytes everywhere.
   */
  maxBytes?: number;
  /**
   * Caller cancellation. Default: the ambient request signal of the running
   * read tool (src/lib/requestScope.ts). Once it aborts no further gateway is
   * tried.
   */
  signal?: AbortSignal;
}

export interface IpfsFetchResult {
  cid: string;
  gateway: string;
  contentType: string;
  bytes: Uint8Array;
  /** JSON-parsed body if content-type is JSON; null otherwise. */
  json: unknown | null;
  /** Total attempts made (including failures before success). */
  attempts: number;
  /**
   * True if the bytes were hash-verified against the requested CID (raw/json
   * codecs). False when the codec (dag-pb / unixfs) can't be cheaply verified
   * without full DAG reconstruction — content-addressing was NOT confirmed.
   */
  verified: boolean;
}

/**
 * Default per-gateway timeout. 4 s until 0.34.1: the public Pinata gateway
 * (`gateway.pinata.cloud`, what most installs point DEXE_IPFS_GATEWAY at)
 * returns a 300-byte DAO profile in 5–6 s under normal load, so every read —
 * and every `modify_dao_profile`, which refuses to broadcast without the
 * current profile — failed with "timed out after 4000ms". Still one hop at a
 * time, still no public-gateway default; only the budget per hop moved.
 */
export const DEFAULT_IPFS_HOP_TIMEOUT_MS = 10_000;

/**
 * Default byte ceiling for one IPFS read. DeXe metadata — a DAO profile, a
 * proposal description, a token-sale tier description — is a few KB. A CID is
 * whatever anyone pinned, though, and a dag-pb (`Qm…`) body cannot be
 * hash-checked here, so without a ceiling one call could pull a 600 MB file
 * into memory.
 */
export const DEFAULT_IPFS_MAX_BYTES = 2 * 1024 * 1024;

/** Bounds on `DEXE_IPFS_MAX_BYTES`: 1 KB … 256 MB. */
export const IPFS_MAX_BYTES_FLOOR = 1024;
export const IPFS_MAX_BYTES_CEILING = 256 * 1024 * 1024;

/**
 * The IPFS byte ceiling: `DEXE_IPFS_MAX_BYTES` (digits only, clamped to
 * 1 KB … 256 MB) or 2 MB. A malformed value falls back to the default; the
 * env spec reports it at startup.
 */
export function resolveIpfsMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEXE_IPFS_MAX_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_IPFS_MAX_BYTES;
  return Math.min(IPFS_MAX_BYTES_CEILING, Math.max(IPFS_MAX_BYTES_FLOOR, Number(raw)));
}

/** The CID's content is larger than the byte ceiling. Not retried on another gateway. */
export class IpfsTooLargeError extends Error {
  constructor(cid: string, limit: number, declared?: number) {
    super(
      `IPFS content too large: ${cid} is ` +
        (declared !== undefined ? `${formatBytes(declared)} (${declared} bytes)` : `more than ${formatBytes(limit)}`) +
        `, over the ${formatBytes(limit)} read limit, so the fetch was stopped. DAO profiles and proposal ` +
        `descriptions are a few KB, so this CID is not DeXe metadata. Open it with an IPFS client or a gateway ` +
        `directly; the server operator can raise the limit with DEXE_IPFS_MAX_BYTES.`,
    );
    this.name = "IpfsTooLargeError";
  }
}

/**
 * How a gateway is named in messages and results: its host only. A configured
 * gateway URL can carry a key in its path or query, and which dedicated
 * gateway an operator pays for is the operator's business, not the caller's.
 */
export function gatewayLabel(gw: string): string {
  try {
    return new URL(/^https?:\/\//i.test(gw) ? gw : `https://${gw}`).host || "gateway";
  } catch {
    return "gateway";
  }
}

export async function fetchIpfs(
  cid: string,
  cfg: IpfsFetchConfig,
): Promise<IpfsFetchResult> {
  const parsed = CID.parse(stripIpfsPrefix(cid));
  const cidStr = parsed.toString();
  const timeout = cfg.perRequestTimeoutMs ?? DEFAULT_IPFS_HOP_TIMEOUT_MS;
  const maxBytes = cfg.maxBytes ?? resolveIpfsMaxBytes();
  const caller = cfg.signal ?? currentRequestSignal();
  const errors: string[] = [];
  let attempts = 0;

  const pinataGatewayToken = process.env.DEXE_PINATA_GATEWAY_TOKEN?.trim();
  for (const gw of cfg.gateways) {
    if (caller?.aborted) throw new RequestCancelledError("IPFS fetch");
    attempts++;
    const base = gw.replace(/\/+$/, "").replace(/\/ipfs$/, "");
    const url = `${base}/ipfs/${cidStr}`;
    const label = gatewayLabel(gw);
    const deadline = deadlineSignal(timeout, caller);
    // Pinata "dedicated gateways" (`*.mypinata.cloud`) in Restricted mode
    // reject anonymous GETs with HTTP 403. They authenticate via a separate
    // Gateway Key (NOT the API JWT used for pinning); pass it as either
    // `?pinataGatewayToken=…` or the `x-pinata-gateway-token` header. We use
    // the header form. Public gateways receive no auth header.
    const headers: Record<string, string> = {};
    if (pinataGatewayToken && /\.mypinata\.cloud(\/|$)/i.test(base)) {
      headers["x-pinata-gateway-token"] = pinataGatewayToken;
    }
    try {
      const res = await fetch(url, { signal: deadline.signal, headers });
      if (!res.ok) {
        await discardBody(res);
        errors.push(`${label} → HTTP ${res.status}`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const bytes = await readBodyCapped(res, maxBytes);
      let parsedJson: unknown | null = null;
      if (contentType.includes("json") || contentType.includes("text")) {
        try {
          parsedJson = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // not JSON — that's fine
        }
      }
      const verdict = await verifyCidBytes(parsed, bytes);
      if (verdict === "mismatch") {
        // W20: a hostile / MitM gateway returned bytes that don't hash to the
        // requested CID. Don't trust it — try the next gateway.
        errors.push(`${label} → content-hash mismatch for ${cidStr}`);
        continue;
      }
      return {
        cid: cidStr,
        gateway: gw,
        contentType,
        bytes,
        json: parsedJson,
        attempts,
        verified: verdict === "verified",
      };
    } catch (err) {
      // Same bytes on every gateway (that is what a CID is), so a body over the
      // ceiling ends the read here instead of downloading it N more times.
      if (err instanceof BodyTooLargeError) throw new IpfsTooLargeError(cidStr, maxBytes, err.declared);
      if (deadline.cancelled()) throw new RequestCancelledError("IPFS fetch");
      // Name the deadline explicitly. "The operation was aborted" in the
      // aggregated list reads as a bug in us rather than as a slow gateway,
      // and hides the one number the user can act on.
      errors.push(
        deadline.timedOut()
          ? `${label} → timed out after ${timeout}ms`
          : `${label} → ${safeErrorMessage(err)}`,
      );
    } finally {
      deadline.clear();
    }
  }

  // When every gateway tried was a shared public reader, the failure is almost
  // always public-gateway flakiness, not a bad CID — nudge toward a dedicated one.
  // Match by parsed hostname, not a URL substring (js/incomplete-url-substring-sanitization).
  const PUBLIC_READ_HOSTS = new Set(["ipfs.io", "dweb.link", "cloudflare-ipfs.com", "cf-ipfs.com"]);
  const hostOf = (u: string): string | null => {
    try {
      return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const allPublic =
    cfg.gateways.length > 0 &&
    cfg.gateways.every((g) => {
      const h = hostOf(g);
      return h != null && PUBLIC_READ_HOSTS.has(h);
    });
  const hint = allPublic
    ? " — the shared public IPFS gateways are failing. Set DEXE_IPFS_GATEWAY to a dedicated " +
      "gateway (a free Pinata dedicated gateway takes ~2 min; Filebase / Quicknode also work), " +
      "then restart. Run /dexe-setup for a guided walkthrough."
    : "";
  throw new Error(
    `IPFS fetch failed for ${cidStr} across ${attempts} gateway(s): ${errors.join("; ")}${hint}`,
  );
}

/**
 * W20 content-address check. Returns "verified" when sha256(bytes) reproduces
 * the requested CID, "mismatch" when it doesn't (tampered / MitM gateway), and
 * "unverifiable" for codecs whose CID is over a DAG rather than the raw bytes
 * (dag-pb / unixfs) — those need full DAG reconstruction we don't perform here.
 */
export async function verifyCidBytes(
  parsedCid: CID,
  bytes: Uint8Array,
): Promise<"verified" | "mismatch" | "unverifiable"> {
  if (parsedCid.multihash.code !== sha256.code) return "unverifiable";
  if (parsedCid.code !== raw.code && parsedCid.code !== json.code) return "unverifiable";
  const digest = await sha256.digest(bytes);
  const expected = CID.create(parsedCid.version, parsedCid.code, digest);
  return expected.equals(parsedCid) ? "verified" : "mismatch";
}

// ---------- CID helpers ----------

export interface CidInfo {
  cid: string;
  version: 0 | 1;
  codec: string;
  multihash: string;
  /** Same CID in the other version if conversion is legal (v1 ↔ v0 only for dag-pb/sha-256). */
  alternate: string | null;
}

export function parseCid(input: string): CidInfo {
  const s = stripIpfsPrefix(input);
  const cid = CID.parse(s);
  const version = cid.version as 0 | 1;
  const codec = codecName(cid.code);
  const multihash = base58btc.encode(cid.multihash.bytes).slice(1);

  let alternate: string | null = null;
  try {
    if (version === 0) {
      alternate = cid.toV1().toString(base32);
    } else if (version === 1 && cid.code === 0x70) {
      // only dag-pb v1 is legal to downgrade to v0
      alternate = cid.toV0().toString();
    }
  } catch {
    alternate = null;
  }

  return { cid: cid.toString(), version, codec, multihash, alternate };
}

export function stripIpfsPrefix(s: string): string {
  return s.replace(/^ipfs:\/\//, "").replace(/^\/?ipfs\//, "");
}

/**
 * Convert a CID string to its v1 base32 form (idempotent for v1 inputs).
 * Frontend uses subdomain gateway (`<cid>.ipfs.4everland.io`), which only
 * resolves CID v1 base32. Passing a v0 (Qm...) here produces a dead link.
 */
export function toCidV1(input: string): string {
  const s = stripIpfsPrefix(input);
  const cid = CID.parse(s);
  if (cid.version === 1) return cid.toString(base32);
  return cid.toV1().toString(base32);
}

/** Compute the CIDv1 for arbitrary JSON locally — no network. */
export async function cidForJson(value: unknown): Promise<string> {
  const bytes = json.encode(value);
  const hash = await sha256.digest(bytes);
  return CID.create(1, json.code, hash).toString(base32);
}

/** Compute the CIDv1 (raw codec) for arbitrary bytes locally. */
export async function cidForBytes(bytes: Uint8Array): Promise<string> {
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash).toString(base32);
}

// ---------- Pinata-identical local CID (dag-pb / UnixFS) ----------
//
// `cidForJson` above is a multiformats *json codec* CID (`bagaaiera…`). Pinata's
// `pinJSONToIPFS` stores the JSON as a UnixFS FILE and returns a dag-pb CIDv0
// (`Qm…`), so the two never match — which is why a dryRun preview built on
// `cidForJson` emitted calldata the real run would never emit.
//
// The dag-pb CID is fully computable offline: serialize with `JSON.stringify`
// (Pinata re-emits exactly those bytes — no whitespace, insertion key order),
// wrap in a single-chunk UnixFS `File` node, wrap that in a link-less PBNode,
// sha-256, base58. Verified byte-for-byte against two CIDs Pinata actually
// returned for `dao-settings` JSONs:
//   QmdFNFNZ2Uku589i8fm8kFsyRjXYSBzoG9tDQAffZ8ixN4 (558 B)
//   QmZXSnHWDRtSRKvLKJLx6QEx4TNUDz9sVv3pDsiARPdLLE (559 B)
// (locked in tests/lib/pinata-cid-parity.test.ts).

/** Bytes IPFS packs into ONE UnixFS chunk; past this a file becomes a DAG. */
const UNIXFS_CHUNK_BYTES = 262144;

/** dag-pb multicodec code. */
const DAG_PB_CODE = 0x70;

function protoVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** `PBNode{ Data: UnixFS{ Type: File, Data: bytes, filesize: len } }`, no links. */
function unixfsFileBlock(bytes: Uint8Array): Uint8Array {
  const len = protoVarint(bytes.length);
  // UnixFS Data message: field 1 (Type) = 2 (File), field 2 (Data), field 3 (filesize)
  const unixfs = [0x08, 0x02, 0x12, ...len, ...bytes, 0x18, ...len];
  // PBNode: field 1 (Data) only — a link-less node serializes to just this.
  return Uint8Array.from([0x0a, ...protoVarint(unixfs.length), ...unixfs]);
}

/** A locally computed CID plus whether it is provably what a real pin returns. */
export interface LocalPinCid {
  /** dag-pb CIDv0 — the exact string `pinJSONToIPFS` returns for this value. */
  cid: string;
  /**
   * True when the reproduction is provable: single UnixFS chunk and pure-ASCII
   * bytes (the two conditions under which Pinata's re-serialization cannot
   * differ from ours). False → still the right shape, but treat as an estimate.
   */
  exact: boolean;
}

/**
 * Compute, with no network, the CID Pinata's `pinJSONToIPFS` would return for
 * `value`. This is what makes a dryRun preview's calldata byte-identical to the
 * real run's — the preview no longer has to fabricate a CID in a codec no
 * gateway will ever serve.
 */
export async function pinataCidForJson(value: unknown): Promise<LocalPinCid> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await sha256.digest(unixfsFileBlock(bytes));
  return {
    cid: CID.create(0, DAG_PB_CODE, hash).toString(),
    exact: bytes.length <= UNIXFS_CHUNK_BYTES && bytes.every((b) => b < 0x80),
  };
}

function codecName(code: number): string {
  switch (code) {
    case 0x55:
      return "raw";
    case 0x70:
      return "dag-pb";
    case 0x71:
      return "dag-cbor";
    case 0x0200:
      return "json";
    case 0x0129:
      return "dag-json";
    default:
      return `0x${code.toString(16)}`;
  }
}
