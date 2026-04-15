import { CID } from "multiformats/cid";
import * as json from "multiformats/codecs/json";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";

/**
 * Public IPFS gateways (dweb.link, ipfs.io, cf-ipfs.com, …) are unreliable —
 * frequent 502s, rate limits, and extended outages in 2025/2026. We do NOT
 * ship a default public-gateway chain. Callers must configure a dedicated
 * gateway via `DEXE_IPFS_GATEWAY` (e.g. the user's Pinata dedicated gateway,
 * Filebase, Quicknode, or a self-hosted one). Public gateways may be
 * opted-in as a best-effort fallback via `DEXE_IPFS_GATEWAYS_FALLBACK`.
 */
export const NO_DEFAULT_GATEWAYS: readonly string[] = [];

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

  for (const gw of cfg.gateways) {
    attempts++;
    const url = `${gw.replace(/\/$/, "")}/ipfs/${cidStr}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
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
      return { cid: cidStr, gateway: gw, contentType, bytes, json: parsedJson, attempts };
    } catch (err) {
      errors.push(`${gw} → ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error(
    `IPFS fetch failed for ${cidStr} across ${attempts} gateway(s): ${errors.join("; ")}`,
  );
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
    opts?: { fileName?: string; contentType?: string; name?: string },
  ): Promise<PinataPinResult> {
    const form = new FormData();
    const blob = new Blob([bytes], {
      type: opts?.contentType ?? "application/octet-stream",
    });
    form.append("file", blob, opts?.fileName ?? "file");
    if (opts?.name) {
      form.append("pinataMetadata", JSON.stringify({ name: opts.name }));
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
