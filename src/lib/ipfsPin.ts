import { pinataCidForJson } from "@dexe-network/dexe-mcp/core";

/**
 * The write half of IPFS: the Pinata client and the one fork between a real
 * pin and a dryRun preview. Fetching, CID parsing and the offline CID
 * functions live in ./ipfs.ts, which never pins; the DEXE_PINATA_JWT guard
 * and hint live in ./pinata.ts.
 */

/** One JSON artifact that was either pinned for real or previewed locally. */
export interface PinOrPreview {
  /** `ipfs://<cid>` — ready to drop into calldata. */
  uri: string;
  cid: string;
  /** False under dryRun: the CID is right, the bytes are on nobody's node. */
  pinned: boolean;
  /** Only meaningful when `pinned` is false — see `LocalPinCid.exact`. */
  exact: boolean;
}

/**
 * Pin `value`, or — under dryRun — compute the identical CID locally and pin
 * nothing. The ONE place the preview/broadcast fork lives, so a new pin site
 * cannot forget it (0.33.0 had five hand-written copies and three were wrong).
 */
export async function pinJsonOrPreview(
  value: unknown,
  opts: { dryRun: boolean; pinata?: PinataClient; name?: string },
): Promise<PinOrPreview> {
  if (opts.dryRun) {
    const local = await pinataCidForJson(value);
    return { uri: `ipfs://${local.cid}`, cid: local.cid, pinned: false, exact: local.exact };
  }
  if (!opts.pinata) {
    throw new Error(
      "Internal: a real (non-dryRun) pin was attempted without a Pinata client. " +
        "Set DEXE_PINATA_JWT in .env and restart, then run dexe_write_doctor to verify.",
    );
  }
  const res = await opts.pinata.pinJson(value, opts.name ? { name: opts.name } : undefined);
  return { uri: `ipfs://${res.cid}`, cid: res.cid, pinned: true, exact: true };
}

// ---------- Pinata upload ----------

const PINATA_PIN_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_USER_URL = "https://api.pinata.cloud/data/testAuthentication";

/**
 * Deadlines for the Pinata calls. This is the highest-stakes timeout in the
 * server: pinning happens MID-FLOW in DAO and proposal creation, after earlier
 * steps may already have cost real gas. A stalled Pinata with no deadline
 * freezes the whole tool call with no way to tell whether the pin landed.
 *
 * Sized by payload, not uniformly — 8s (the `backendGetJson` default) is right
 * for an auth probe but would abandon a legitimate multi-hundred-KB avatar
 * upload that is still making progress.
 */
const PINATA_PING_TIMEOUT_MS = 8_000;
const PINATA_PIN_JSON_TIMEOUT_MS = 15_000;
const PINATA_PIN_FILE_TIMEOUT_MS = 30_000;

export interface PinataTimeouts {
  pingMs?: number;
  pinJsonMs?: number;
  pinFileMs?: number;
}

export interface PinataPinResult {
  cid: string;
  size: number;
  pinnedAt: string;
}

/**
 * Wrap a Pinata call in a deadline. On abort we say plainly that NOTHING was
 * pinned and that re-running the same composite is safe — the flow tools skip
 * landed steps via their ledger. A bare "The operation was aborted" leaves an
 * agent guessing whether it just double-spent.
 */
async function pinataFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `Pinata ${what} timed out after ${timeoutMs}ms — IPFS upload timed out, no metadata was pinned. ` +
          `Re-run the same call: ERC20.approve / GovPool.deposit / createProposalAndVote / GovPool.vote that ` +
          `already landed are re-derived from chain state and skipped, so nothing is paid for twice. ` +
          `If it keeps timing out, check status.pinata.cloud or set a different pinning service.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class PinataClient {
  readonly #timeouts: Required<PinataTimeouts>;

  constructor(private readonly jwt: string, timeouts?: PinataTimeouts) {
    if (!jwt) throw new Error("Pinata JWT is required");
    this.#timeouts = {
      pingMs: timeouts?.pingMs ?? PINATA_PING_TIMEOUT_MS,
      pinJsonMs: timeouts?.pinJsonMs ?? PINATA_PIN_JSON_TIMEOUT_MS,
      pinFileMs: timeouts?.pinFileMs ?? PINATA_PIN_FILE_TIMEOUT_MS,
    };
  }

  /** Verify the JWT — cheap sanity check before an upload. */
  async ping(): Promise<void> {
    const res = await pinataFetch(
      PINATA_USER_URL,
      { headers: { Authorization: `Bearer ${this.jwt}` } },
      this.#timeouts.pingMs,
      "auth check",
    );
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
    const res = await pinataFetch(
      PINATA_PIN_JSON_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      this.#timeouts.pinJsonMs,
      "pinJSON",
    );
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
    const res = await pinataFetch(
      PINATA_PIN_FILE_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.jwt}` },
        body: form,
      },
      this.#timeouts.pinFileMs,
      "pinFile",
    );
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
