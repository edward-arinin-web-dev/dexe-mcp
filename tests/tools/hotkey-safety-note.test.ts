/**
 * D16-4 — the hot-key "NOT SAFE" note reached `dexe_tx_send` and nothing else.
 *
 * `sendOrCollect` only ever broadcasts with a LOCAL key (the no-signer leg
 * returns `mode: "payloads"` before a wallet is resolved), so every
 * `mode: "executed"` it returns is by construction a plaintext-key signature —
 * and the composites, which the server instructions name as the PRIMARY write
 * path, said nothing about it.
 */
import { describe, it, expect, vi } from "vitest";
import { HOT_KEY_SAFETY, hotKeySafetyFields } from "../../src/lib/signer.js";
import { sendOrCollect } from "../../src/tools/flow.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { TxPayload } from "../../src/lib/calldata.js";
import { readFileSync } from "node:fs";

const PAYLOAD: TxPayload = {
  to: "0x1111111111111111111111111111111111111111",
  data: "0x12345678",
  value: "0",
  chainId: 97,
  description: "test tx",
};

/** RPC-less so B11's getCode probe takes its fail-open branch offline. */
const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  treasuryGuard: "off",
} as unknown as ReturnType<SignerManager["getConfig"]>;

const USER = "0x2222222222222222222222222222222222222222";

function fakeSigner(opts?: { failSend?: boolean }): SignerManager {
  const wallet = {
    address: USER,
    async sendTransaction(_tx: { data: string }) {
      if (opts?.failSend) throw new Error("broadcast refused");
      return {
        hash: "0x" + "a".repeat(64),
        chainId: 97n,
        async wait() {
          return { status: 1, hash: "0x" + "a".repeat(64) };
        },
      };
    },
  };
  return {
    hasSigner: () => true,
    getAddress: () => USER,
    getConfig: () => GUARD_CFG,
    trySigner: () => ({ ok: wallet }),
    describeSigner: () => ({ signerKey: "primary", address: USER }),
    withBroadcastLock: (_c: number, task: () => Promise<unknown>) => task(),
  } as unknown as SignerManager;
}

describe("hotKeySafetyFields", () => {
  it("is emitted only when something was actually broadcast", () => {
    expect(hotKeySafetyFields(true).safety).toBe(HOT_KEY_SAFETY);
    expect(hotKeySafetyFields(false)).toEqual({});
    expect(HOT_KEY_SAFETY).toContain("NOT SAFE");
    expect(HOT_KEY_SAFETY).toContain("dexe_wc_connect");
  });
});

describe("sendOrCollect attaches the note to every hot-key broadcast", () => {
  it("mode:executed carries signer.safety", async () => {
    const res = await sendOrCollect(fakeSigner(), [PAYLOAD], { chainId: 97 });
    expect(res.mode).toBe("executed");
    expect(res.signer?.safety).toBe(HOT_KEY_SAFETY);
  });

  // 0.34.0 changed this deliberately: a dryRun now NAMES the wallet that would
  // pay, because a preview that cannot answer "with whose money?" is missing
  // the first question a human asks. `safety` — not presence — is what marks a
  // real hot-key signature, and that is what this asserts.
  it("dryRun names the payer but never claims a signature", async () => {
    const res = await sendOrCollect(fakeSigner(), [PAYLOAD], { dryRun: true, chainId: 97 });
    expect(res.mode).toBe("dryRun");
    expect(res.signer?.address).toBeTruthy();
    expect(res.signer?.safety).toBeUndefined();
  });

  it("a failure BEFORE anything landed does not claim a hot-key signature", async () => {
    const res = await sendOrCollect(
      fakeSigner({ failSend: true }),
      [PAYLOAD],
      { chainId: 97 },
    );
    expect(res.mode).toBe("failed");
    expect(res.signer?.safety).toBeUndefined();
  });
});

describe("the string cannot fork again", () => {
  it("dexe_tx_send imports it instead of declaring its own copy", () => {
    const src = readFileSync(new URL("../../src/tools/txSend.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/const HOT_KEY_SAFETY\s*=/);
    expect(src).toMatch(/HOT_KEY_SAFETY.*from "\.\.\/lib\/signer\.js"/);
  });

  it("every composite response assembly that forwards a signer also forwards the note", () => {
    for (const file of ["flow.ts", "otc.ts"]) {
      const src = readFileSync(new URL(`../../src/tools/${file}`, import.meta.url), "utf8");
      const signerSpreads = (src.match(/\{ signer: (result|execResult)\.signer \}/g) ?? []).length;
      const safetySpreads = (src.match(/hotKeySafetyFields\(Boolean\((result|execResult)\.signer\?\.safety\)\)/g) ?? [])
        .length;
      expect(safetySpreads, `${file}: ${signerSpreads} signer spreads but ${safetySpreads} safety spreads`).toBe(
        signerSpreads,
      );
    }
  });
});

vi.mock("../../src/lib/broadcastGuards.js", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return { ...mod, runBroadcastGuards: async () => {} };
});
