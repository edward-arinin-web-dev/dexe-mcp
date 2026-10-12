import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import {
  KEYSTORE_MIN_SAFE_N,
  KEYSTORE_SCRYPT,
  KeystoreAddressMismatchError,
  decryptKeystore,
  encryptPrivateKey,
  isWrongPasswordError,
  keystoreFileName,
  keystorePermissionIssues,
  listKeystores,
  parseKeystoreMeta,
  resolveKeystoreLocation,
  selectKeystore,
  writeKeystoreFile,
} from "../../src/lib/keystore.js";

/**
 * 2c Phase A — the encrypted key at rest. Small scrypt params here only: the
 * production cost (N=2^18) is pinned separately and nothing reads it from env.
 */
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR = new Wallet(PK).address;
const PW = "correct horse battery staple";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dexe-ks-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("keystore v3 round trip", () => {
  it("production parameters are scrypt N=2^18 r=8 p=1", () => {
    expect(KEYSTORE_SCRYPT).toEqual({ N: 2 ** 18, r: 8, p: 1 });
    expect(KEYSTORE_MIN_SAFE_N).toBe(2 ** 17);
  });

  it("encrypts to a v3 file that decrypts back to the same key and address", async () => {
    const json = await encryptPrivateKey(PK, PW, FAST);
    const meta = parseKeystoreMeta(json);
    expect(meta.address).toBe(ADDR);
    expect(meta.kdf).toBe("scrypt");
    expect(meta.n).toBe(FAST.N);
    expect(json).not.toContain(PK.slice(2));
    const out = await decryptKeystore(json, PW, ADDR);
    expect(out.address).toBe(ADDR);
    expect(out.privateKey.toLowerCase()).toBe(PK.toLowerCase());
  });

  it("a wrong password is recognisable as such", async () => {
    const json = await encryptPrivateKey(PK, PW, FAST);
    const err = await decryptKeystore(json, "wrong password!").catch((e: unknown) => e);
    expect(isWrongPasswordError(err)).toBe(true);
  });

  it("refuses when the key does not belong to the account the approval was built for", async () => {
    const json = await encryptPrivateKey(PK, PW, FAST);
    const other = Wallet.createRandom().address;
    await expect(decryptKeystore(json, PW, other)).rejects.toBeInstanceOf(KeystoreAddressMismatchError);
  });

  it("refuses a file whose (MAC-less) address field was swapped", async () => {
    const json = JSON.parse(await encryptPrivateKey(PK, PW, FAST)) as Record<string, unknown>;
    json.address = Wallet.createRandom().address.slice(2).toLowerCase();
    const err = await decryptKeystore(JSON.stringify(json), PW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isWrongPasswordError(err)).toBe(false);
  });

  it("parseKeystoreMeta rejects what is not a keystore v3", () => {
    expect(() => parseKeystoreMeta("not json")).toThrow();
    expect(() => parseKeystoreMeta(JSON.stringify({ version: 1, address: ADDR }))).toThrow(/v3/);
    expect(() => parseKeystoreMeta(JSON.stringify({ version: 3, crypto: {} }))).toThrow(/address/);
  });
});

describe("files on disk", () => {
  it("writes atomically under a geth-style, Windows-safe name and lists it", async () => {
    const sub = join(dir, "one");
    const json = await encryptPrivateKey(PK, PW, FAST);
    const file = writeKeystoreFile(sub, json);
    expect(file.endsWith(`--${ADDR.slice(2).toLowerCase()}.json`)).toBe(true);
    expect(file).not.toMatch(/:\d\d/); // no ':' from the ISO time in the name
    expect(readFileSync(file, "utf8")).toBe(json);
    const entries = listKeystores(sub);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta?.address).toBe(ADDR);
    expect(keystoreFileName(ADDR, new Date("2026-10-12T01:02:03.004Z"))).toBe(
      `UTC--2026-10-12T01-02-03.004Z--${ADDR.slice(2).toLowerCase()}.json`,
    );
  });

  it.skipIf(process.platform === "win32")("creates the directory 0700 and the file 0600", async () => {
    const sub = join(dir, "perms");
    const file = writeKeystoreFile(sub, await encryptPrivateKey(PK, PW, FAST));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(keystorePermissionIssues(file)).toEqual([]);
  });

  it("selects the only keystore, refuses to guess between several, honours an address", async () => {
    const sub = join(dir, "select");
    expect("error" in selectKeystore({ path: sub })).toBe(true); // empty / missing dir
    writeKeystoreFile(sub, await encryptPrivateKey(PK, PW, FAST));
    const one = selectKeystore({ path: sub });
    expect(one).toMatchObject({ address: ADDR });

    const other = Wallet.createRandom();
    writeKeystoreFile(sub, await encryptPrivateKey(other.privateKey, PW, FAST));
    const two = selectKeystore({ path: sub });
    expect("error" in two && two.error).toMatch(/DEXE_KEYSTORE_ADDRESS/);
    expect(selectKeystore({ path: sub, address: other.address })).toMatchObject({ address: other.address });
    expect("error" in selectKeystore({ path: sub, address: Wallet.createRandom().address })).toBe(true);
  });

  it("DEXE_KEYSTORE_PATH may name one file", async () => {
    const file = writeKeystoreFile(join(dir, "file"), await encryptPrivateKey(PK, PW, FAST), "mine.json");
    expect(resolveKeystoreLocation(file)).toEqual({ dir: join(dir, "file"), file });
    expect(selectKeystore({ path: file })).toEqual({ file, address: ADDR });
  });

  it("an unparseable .json in the directory is listed with its error, not selected", () => {
    const sub = join(dir, "junk");
    writeKeystoreFile(sub, readFileSync(listKeystores(join(dir, "one"))[0]!.file, "utf8"));
    writeFileSync(join(sub, "zz-broken.json"), "{");
    const entries = listKeystores(sub);
    expect(entries.find((e) => e.file.endsWith("zz-broken.json"))?.error).toBeTruthy();
    expect(selectKeystore({ path: sub })).toMatchObject({ address: ADDR });
  });
});
