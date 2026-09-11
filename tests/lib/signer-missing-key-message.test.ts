import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { SignerManager, NoSignerKeyError } from "../../src/lib/signer.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * D12-4 — the missing-key error pointed the user at the one place the server's
 * own architecture calls a trap.
 *
 * `process.loadEnvFile()` does NOT override a key that is already set, so the
 * MCP host's `env` block (in Claude Code, `.claude.json`) silently SHADOWS
 * `.env`. The whole env layer — the startup banner, dexe_doctor's precedence
 * check, the project rule — exists to keep users out of that. The signer's own
 * message said "Configure it in MCP server env", and `trySigner` then appended
 * `hintFor`'s "Set DEXE_PRIVATE_KEY in .env": one message, two contradictory
 * instructions, and the wrong one first.
 *
 * It also enumerated every DEXE_* variable name in `process.env` — ~20 on a
 * real machine including each keyring slot — which is not the user's next step
 * and which no other error in the codebase does.
 */

function cfg(partial: Partial<DexeConfig> = {}): DexeConfig {
  return { agentKeys: {}, chains: new Map(), ...partial } as unknown as DexeConfig;
}

const CANARY = "DEXE_CANARY_FOR_THIS_TEST";

beforeEach(() => {
  process.env[CANARY] = "1";
});
afterEach(() => {
  delete process.env[CANARY];
});

describe("the no-key message", () => {
  const sm = () => new SignerManager(cfg());

  it("names .env as the place to put the key", () => {
    expect(() => sm().getAddress()).toThrow(/\.env/);
  });

  it("never points the user at the MCP host env block", () => {
    // The assertion that would have caught the shipped string.
    let msg = "";
    try {
      sm().getAddress();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/MCP server env|\.claude\.json|host env/i);
  });

  it("does not enumerate process.env", () => {
    let msg = "";
    try {
      sm().getAddress();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(CANARY);
    expect(msg).not.toMatch(/Available DEXE_\* env vars/);
  });

  it("says reads still work, and offers WalletConnect before the hot key", () => {
    let msg = "";
    try {
      sm().getAddress();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Reads work without one/);
    expect(msg).toContain("dexe_wc_connect");
    expect(msg).toContain("dexe_doctor");
    // "cannot sign", not "cannot broadcast": the same failure reaches an
    // EIP-191 auth signature and a Safe typed-data signature, neither of which
    // broadcasts anything.
    expect(msg).toMatch(/cannot sign/);
  });

  it("every no-key throw site shares the one message", () => {
    const sites: Array<[string, () => unknown]> = [
      ["getAddress", () => sm().getAddress()],
      ["requireSigner", () => sm().requireSigner()],
      ["describeSigner", () => sm().describeSigner()],
    ];
    for (const [label, call] of sites) {
      let msg = "";
      try {
        call();
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, `${label} does not name .env`).toMatch(/\.env/);
      expect(msg, `${label} points at the host env block`).not.toMatch(/MCP server env/i);
    }
  });

  it("signMessage REJECTS with the same message (it is async, not a throw)", async () => {
    await expect(sm().signMessage("hi")).rejects.toThrow(/\.env/);
  });

  it("tags the cause so callers can branch on it, not on a substring", () => {
    expect(() => sm().getAddress()).toThrow(NoSignerKeyError);
  });
});

describe("trySigner does not print the same remedy twice", () => {
  it("the no-key path carries hintFor once, not twice", () => {
    const r = new SignerManager(cfg()).trySigner();
    expect("error" in r).toBe(true);
    const joined = `${(r as { error: string }).error}\n${(r as { remediation: string }).remediation}`;
    // sendOrCollect joins both halves into one thrown message.
    expect(joined.split("Set DEXE_PRIVATE_KEY in .env").length - 1).toBe(1);
  });

  it("a NON-key failure still gets the full hint", () => {
    const pk = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const manager = new SignerManager(
      cfg({ privateKey: pk, chains: new Map([[97, { chainId: 97, rpcUrl: "https://rpc.invalid", rpcUrls: [] }]]) } as never),
    );
    expect(new Wallet(pk).address).toBeTruthy();
    const r = manager.trySigner(97, "agent9");
    expect("error" in r).toBe(true);
    expect((r as { remediation: string }).remediation).toContain("Set DEXE_PRIVATE_KEY in .env");
  });
});
