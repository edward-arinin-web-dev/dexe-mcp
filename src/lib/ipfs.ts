import { CID } from "multiformats/cid";
import * as json from "multiformats/codecs/json";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";

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
  /** Per-hop timeout in ms. Default 4000. */
  perRequestTimeoutMs?: number;
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

export async function fetchIpfs(
  cid: string,
  cfg: IpfsFetchConfig,
): Promise<IpfsFetchResult> {
  const parsed = CID.parse(stripIpfsPrefix(cid));
  const cidStr = parsed.toString();
  const timeout = cfg.perRequestTimeoutMs ?? 4000;
  const errors: string[] = [];
  let attempts = 0;

  const pinataGatewayToken = process.env.DEXE_PINATA_GATEWAY_TOKEN?.trim();
  for (const gw of cfg.gateways) {
    attempts++;
    const base = gw.replace(/\/+$/, "").replace(/\/ipfs$/, "");
    const url = `${base}/ipfs/${cidStr}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
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
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) {
        errors.push(`${gw} → HTTP ${res.status}`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const bytes = new Uint8Array(await res.arrayBuffer());
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
        errors.push(`${gw} → content-hash mismatch for ${cidStr}`);
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
      errors.push(`${gw} → ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(t);
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

// ---------- Pinata upload ----------

const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_USER_URL = "https://api.pinata.cloud/data/testAuthentication";

export interface PinataPinResult {
  cid: string;
  size: number;
  pinnedAt: string;
}

export class PinataClient {
  constructor(private readonly jwt: string) {
    if (!jwt) throw new Error("Pinata JWT is required");
  }

  /** Verify the JWT — cheap sanity check before an upload. */
  async ping(): Promise<void> {
    const res = await fetch(PINATA_USER_URL, {
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (!res.ok) throw new Error(`Pinata auth failed: HTTP ${res.status} ${await res.text()}`);
  }

  async pinJson(
    payload: unknown,
    opts?: { name?: string; keyvalues?: Record<string, string> },
  ): Promise<PinataPinResult> {
    const body = {
      pinataContent: payload,
      pinataMetadata: opts?.name || opts?.keyvalues
        ? { name: opts?.name, keyvalues: opts?.keyvalues }
        : undefined,
    };
    const res = await fetch(PINATA_PIN_JSON_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Pinata pinJSON failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      IpfsHash: string;
      PinSize: number;
      Timestamp: string;
    };
    return { cid: data.IpfsHash, size: data.PinSize, pinnedAt: data.Timestamp };
  }

  async pinFile(
    bytes: Uint8Array,
    opts?: { fileName?: string; contentType?: string; name?: string; wrapWithDirectory?: boolean },
  ): Promise<PinataPinResult> {
    const form = new FormData();
    const blob = new Blob([bytes], {
      type: opts?.contentType ?? "application/octet-stream",
    });
    // Default: wrap-with-directory so the returned CID is a directory whose
    // single child is `fileName`. That's what lets subdomain gateways serve
    // `<cid>.ipfs.<host>/<fileName>` — without the wrapper, the CID is a raw
    // file and any path suffix returns 404, breaking every consumer that
    // builds URLs from `cid + fileName` (DeXe frontend + ipfs-cache.dexe.io).
    const wrap = opts?.wrapWithDirectory ?? true;
    form.append("file", blob, opts?.fileName ?? "file");
    if (opts?.name) {
      form.append("pinataMetadata", JSON.stringify({ name: opts.name }));
    }
    if (wrap) {
      form.append("pinataOptions", JSON.stringify({ wrapWithDirectory: true }));
    }
    const res = await fetch(PINATA_PIN_FILE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Pinata pinFile failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      IpfsHash: string;
      PinSize: number;
      Timestamp: string;
    };
    return { cid: data.IpfsHash, size: data.PinSize, pinnedAt: data.Timestamp };
  }
}
