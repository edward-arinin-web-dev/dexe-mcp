import { scrypt as nodeScrypt } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decryptKeystoreJson, encryptKeystoreJson, getAddress, isAddress, scrypt as ethersScrypt, Wallet } from "ethers";
import { renameWithRetry, safeErrorMessage, tempStatePath } from "@dexe-network/dexe-mcp/core";

/**
 * ── Encrypted key at rest (keystore v3) ─────────────────────────────────────
 *
 * The `keystore` signer mode keeps its one key in a Web3 Secret Storage v3
 * file — the format MetaMask, geth and ethers read and write — encrypted with
 * scrypt (N=2^18, r=8, p=1, dkLen 32) + aes-128-ctr. The password never
 * touches disk, env or a tool argument: it is typed on the local approval page
 * (src/lib/approval/) for each batch, or at the `dexe-mcp key` prompt.
 *
 * scrypt runs on Node's native implementation (registered into ethers below):
 * ~1 s per unlock at these parameters instead of ~10 s in pure JS, which is
 * what makes "password per batch" bearable.
 *
 * Files live in `~/.dexe-mcp/keystore/` (or `DEXE_KEYSTORE_PATH`), named
 * `UTC--<iso>--<address>.json`, written atomically (private temp + rename) with
 * 0700/0600 permissions on POSIX. On Windows the file inherits the profile
 * directory's ACL (only the user and administrators) — documented, not set.
 */

/** Production scrypt cost. Tests pass smaller params explicitly; nothing reads them from env. */
export const KEYSTORE_SCRYPT = { N: 2 ** 18, r: 8, p: 1 } as const;
/** Below this N doctor warns: a cheap KDF turns a stolen file into an offline brute force. */
export const KEYSTORE_MIN_SAFE_N = 2 ** 17;
/** Shortest password the CLI accepts. */
export const KEYSTORE_MIN_PASSWORD = 8;

/** scrypt memory is 128·N·r bytes (256 MiB at N=2^18, r=8); Node's default cap is 32 MiB. */
const SCRYPT_MAXMEM = 1024 * 1024 * 1024;

let nativeScryptRegistered = false;

/**
 * Route ethers' async scrypt through Node's native `crypto.scrypt`. Idempotent;
 * every encrypt/decrypt below calls it first, so no caller can forget.
 */
export function ensureNativeScrypt(): void {
  if (nativeScryptRegistered) return;
  ethersScrypt.register(
    (passwd: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number) =>
      new Promise<Uint8Array>((resolveKey, reject) => {
        nodeScrypt(passwd, salt, dkLen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
          if (err) reject(err);
          else resolveKey(new Uint8Array(key));
        });
      }),
  );
  nativeScryptRegistered = true;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Encrypt a private key into keystore v3 JSON. `params` exists for tests; production uses KEYSTORE_SCRYPT. */
export async function encryptPrivateKey(
  privateKey: string,
  password: string,
  params: ScryptParams = KEYSTORE_SCRYPT,
): Promise<string> {
  ensureNativeScrypt();
  const wallet = new Wallet(privateKey);
  return encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password, {
    scrypt: { N: params.N, r: params.r, p: params.p },
  });
}

export class KeystoreAddressMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeystoreAddressMismatchError";
  }
}

/** True for the ethers error a wrong password produces (MAC check). */
export function isWrongPasswordError(err: unknown): boolean {
  const m = safeErrorMessage(err);
  return /incorrect password/i.test(m);
}

/**
 * Decrypt keystore JSON. Throws on a wrong password (`isWrongPasswordError`).
 *
 * The `address` field of a keystore file is NOT covered by its MAC, so it is
 * checked against the address the decrypted key derives (ethers does this
 * when the field is present; a file without one is refused here) AND against
 * `expectedAddress` — the account the batch being approved was built for.
 */
export async function decryptKeystore(
  json: string,
  password: string,
  expectedAddress?: string,
): Promise<{ address: string; privateKey: string }> {
  ensureNativeScrypt();
  const meta = parseKeystoreMeta(json);
  const account = await decryptKeystoreJson(json, password);
  const derived = getAddress(account.address);
  if (derived !== meta.address) {
    throw new KeystoreAddressMismatchError(
      `keystore address field ${meta.address} does not match the key it holds (${derived}) — refusing this file.`,
    );
  }
  if (expectedAddress && derived !== getAddress(expectedAddress)) {
    throw new KeystoreAddressMismatchError(
      `keystore holds ${derived}, but this approval was built for ${getAddress(expectedAddress)} — refusing to sign.`,
    );
  }
  return { address: derived, privateKey: account.privateKey };
}

export interface KeystoreMeta {
  /** Checksummed address from the file's `address` field. */
  address: string;
  kdf: string;
  /** scrypt N, or null for pbkdf2 / unknown. */
  n: number | null;
  r: number | null;
  p: number | null;
}

/** Parse the non-secret header of a keystore v3 JSON. Throws on anything that is not one. */
export function parseKeystoreMeta(json: string): KeystoreMeta {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("not JSON");
  }
  if (Number(data.version) !== 3) throw new Error("not a keystore v3 file (version != 3)");
  const raw = typeof data.address === "string" ? data.address : "";
  const addr = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isAddress(addr)) throw new Error("keystore has no valid `address` field");
  const crypto = (data.crypto ?? data.Crypto) as Record<string, unknown> | undefined;
  if (!crypto || typeof crypto !== "object") throw new Error("keystore has no `crypto` section");
  const kdf = String(crypto.kdf ?? "").toLowerCase();
  const kp = (crypto.kdfparams ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    address: getAddress(addr),
    kdf,
    n: kdf === "scrypt" ? num(kp.n) : null,
    r: kdf === "scrypt" ? num(kp.r) : null,
    p: kdf === "scrypt" ? num(kp.p) : null,
  };
}

/**
 * Why this keystore's KDF is too cheap to sign with in keystore mode, or null.
 * scrypt below N=2^17 (or pbkdf2 at any count) makes each password guess
 * against a stolen file or the approval page cheap. `dexe-mcp key
 * change-password` (or `key import --json`) re-encrypts at N=2^18.
 */
export function weakKdfReason(meta: KeystoreMeta): string | null {
  if (meta.kdf !== "scrypt") {
    return (
      `The keystore for ${meta.address} uses ${meta.kdf || "an unknown KDF"}, not scrypt — refused. ` +
      "Re-encrypt it: `npx dexe-mcp key change-password` (or `key import --json <file>`) writes scrypt N=2^18."
    );
  }
  if (meta.n === null || meta.n < KEYSTORE_MIN_SAFE_N) {
    return (
      `The keystore for ${meta.address} uses scrypt N=${meta.n ?? "?"} (minimum 2^17) — refused. ` +
      "Re-encrypt it: `npx dexe-mcp key change-password` writes scrypt N=2^18."
    );
  }
  return null;
}

/** `~/.dexe-mcp/keystore`. */
export function defaultKeystoreDir(): string {
  return join(homedir(), ".dexe-mcp", "keystore");
}

/**
 * `DEXE_KEYSTORE_PATH` names a directory or one file. Unset → the default dir.
 * A path ending in `.json` (or an existing file) is a file.
 */
export function resolveKeystoreLocation(pathEnv?: string): { dir: string; file?: string } {
  const raw = pathEnv?.trim();
  if (!raw) return { dir: defaultKeystoreDir() };
  const abs = resolve(raw);
  let isFile = /\.json$/i.test(abs);
  try {
    isFile = statSync(abs).isFile();
  } catch {
    /* not there yet — decide by the name */
  }
  return isFile ? { dir: dirname(abs), file: abs } : { dir: abs };
}

export interface KeystoreEntry {
  file: string;
  meta?: KeystoreMeta;
  error?: string;
}

/** Every `*.json` in `dir`, parsed as a keystore (unparseable files carry `error`). Missing dir → []. */
export function listKeystores(dir: string): KeystoreEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /\.json$/i.test(n))
    .sort()
    .map((n) => {
      const file = join(dir, n);
      try {
        return { file, meta: parseKeystoreMeta(readFileSync(file, "utf8")) };
      } catch (err) {
        return { file, error: safeErrorMessage(err) };
      }
    });
}

export type KeystoreSelection = { file: string; address: string } | { error: string; candidates: string[] };

/**
 * Pick THE keystore this server signs with: the file `DEXE_KEYSTORE_PATH`
 * names; else the one in the directory matching `DEXE_KEYSTORE_ADDRESS`; else
 * the only one there. Several and no address → error naming them.
 */
export function selectKeystore(opts: { path?: string; address?: string }): KeystoreSelection {
  const loc = resolveKeystoreLocation(opts.path);
  const want = opts.address?.trim();
  if (want && !isAddress(want)) return { error: `DEXE_KEYSTORE_ADDRESS is not an address: ${want}`, candidates: [] };
  if (loc.file) {
    if (!existsSync(loc.file)) {
      return { error: `no keystore file at ${loc.file} — create one with \`dexe-mcp key create\``, candidates: [] };
    }
    try {
      const meta = parseKeystoreMeta(readFileSync(loc.file, "utf8"));
      if (want && meta.address !== getAddress(want)) {
        return {
          error: `${loc.file} holds ${meta.address}, not DEXE_KEYSTORE_ADDRESS ${getAddress(want)}`,
          candidates: [meta.address],
        };
      }
      return { file: loc.file, address: meta.address };
    } catch (err) {
      return { error: `${loc.file} is not a usable keystore: ${safeErrorMessage(err)}`, candidates: [] };
    }
  }
  const entries = listKeystores(loc.dir).filter((e): e is KeystoreEntry & { meta: KeystoreMeta } => !!e.meta);
  const addrs = entries.map((e) => e.meta.address);
  if (want) {
    const hit = entries.find((e) => e.meta.address === getAddress(want));
    return hit
      ? { file: hit.file, address: hit.meta.address }
      : { error: `no keystore for ${getAddress(want)} in ${loc.dir}`, candidates: addrs };
  }
  if (entries.length === 1) return { file: entries[0]!.file, address: entries[0]!.meta.address };
  if (entries.length === 0) {
    return { error: `no keystore in ${loc.dir} — create one with \`dexe-mcp key create\` (or \`key import\`)`, candidates: [] };
  }
  return {
    error: `${entries.length} keystores in ${loc.dir} — set DEXE_KEYSTORE_ADDRESS to pick one (${addrs.join(", ")})`,
    candidates: addrs,
  };
}

/** geth-style name, with ':' replaced so it is a valid Windows filename. */
export function keystoreFileName(address: string, when: Date = new Date()): string {
  return `UTC--${when.toISOString().replace(/:/g, "-")}--${getAddress(address).slice(2).toLowerCase()}.json`;
}

/**
 * Write keystore JSON atomically into `dir`, creating `dir` 0700. The temp file
 * is opened `wx` + 0600 (a symlink planted at its name is never followed), then
 * renamed over the target. Returns the final path.
 */
export function writeKeystoreFile(dir: string, json: string, targetName?: string): string {
  const meta = parseKeystoreMeta(json);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not our directory to tighten — doctor reports the mode */
    }
  }
  const target = join(dir, targetName ?? keystoreFileName(meta.address));
  const tmp = tempStatePath(target);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(target, 0o600);
    } catch {
      /* best effort */
    }
  }
  return target;
}

/**
 * POSIX permission problems for a keystore file and its directory (group /
 * other access). Empty on Windows, where the profile ACL is the control.
 */
export function keystorePermissionIssues(file: string): string[] {
  if (process.platform === "win32") return [];
  const out: string[] = [];
  try {
    const f = statSync(file).mode & 0o777;
    if (f & 0o077) out.push(`${basename(file)} is mode ${f.toString(8)} — run chmod 600 on it`);
  } catch {
    /* missing file is reported elsewhere */
  }
  try {
    const d = statSync(dirname(file)).mode & 0o777;
    if (d & 0o077) out.push(`${dirname(file)} is mode ${d.toString(8)} — run chmod 700 on it`);
  } catch {
    /* ditto */
  }
  return out;
}
