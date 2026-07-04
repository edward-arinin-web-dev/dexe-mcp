import { describe, expect, it } from "vitest";
import { WalletConnectManager } from "../src/lib/walletconnect.js";
import type { DexeConfig } from "../src/config.js";

/** Minimal DexeConfig for unit tests — only the fields the WC manager reads. */
function makeConfig(overrides: Partial<DexeConfig> = {}): DexeConfig {
  const chains = new Map([[56, { chainId: 56, rpcUrl: "https://bsc.example/rpc" }]]);
  return {
    protocolPath: "/tmp/protocol",
    chains,
    defaultChainId: 56,
    chainId: 56,
    rpcUrl: "https://bsc.example/rpc",
    walletConnectRelayUrl: "wss://relay.walletconnect.com",
    walletConnectApprovalTimeoutMs: 120000,
    ...overrides,
  } as DexeConfig;
}

describe("WalletConnectManager — config gating", () => {
  it("isConfigured reflects the project id", () => {
    expect(new WalletConnectManager(makeConfig()).isConfigured()).toBe(false);
    expect(
      new WalletConnectManager(makeConfig({ walletConnectProjectId: "abc" })).isConfigured(),
    ).toBe(true);
  });

  it("reports disconnected before any session", () => {
    const wc = new WalletConnectManager(makeConfig({ walletConnectProjectId: "abc" }));
    expect(wc.isConnected()).toBe(false);
    expect(wc.account()).toBeNull();
    const s = wc.status();
    expect(s).toMatchObject({ connected: false, connecting: false, account: null, topic: null });
  });

  it("connect rejects when no project id is configured", async () => {
    const wc = new WalletConnectManager(makeConfig());
    await expect(wc.connect()).rejects.toThrow(/DEXE_WALLETCONNECT_PROJECT_ID not set/);
  });

  it("disconnect is a safe no-op when not connected", async () => {
    const wc = new WalletConnectManager(makeConfig({ walletConnectProjectId: "abc" }));
    await expect(wc.disconnect()).resolves.toBe(false);
  });

  it("sendTransaction rejects with no session", async () => {
    const wc = new WalletConnectManager(makeConfig({ walletConnectProjectId: "abc" }));
    // Inject a provider with no session to bypass the lazy relay init.
    (wc as unknown as { provider: unknown }).provider = { session: undefined };
    await expect(
      wc.sendTransaction({ to: "0x00", data: "0x", value: "0", chainId: 56 }),
    ).rejects.toThrow(/session not established/);
  });
});

describe("@walletconnect/universal-provider — export shape", () => {
  // Regression guard for the CJS/ESM interop bug fixed 2026-05-26: the published
  // package is CJS, so a dynamic import nests the class under one of several keys.
  // getProvider() probes them in order; this asserts at least one still resolves
  // to a constructor exposing `.init`, so a future package bump can't silently
  // reintroduce `UniversalProvider.init is not a function` at connect time.
  it("resolves UniversalProvider with an init() via one of the known shapes", async () => {
    const mod = (await import("@walletconnect/universal-provider")) as Record<string, unknown>;
    const def = mod.default as Record<string, unknown> | undefined;
    const candidate =
      (mod.UniversalProvider as { init?: unknown } | undefined) ??
      (def?.UniversalProvider as { init?: unknown } | undefined) ??
      (def?.default as { init?: unknown } | undefined) ??
      (def as { init?: unknown } | undefined);
    expect(candidate).toBeTruthy();
    expect(typeof candidate?.init).toBe("function");
    // 30s timeout: this dynamically imports the heavy @walletconnect/universal-
    // provider CJS bundle, which can exceed the 5s default on a cold cache (CI,
    // first run) even though it resolves in ~150ms warm.
  }, 30000);
});

describe("WalletConnectManager — CAIP-10 account parsing", () => {
  function withSession(): WalletConnectManager {
    const wc = new WalletConnectManager(makeConfig({ walletConnectProjectId: "abc" }));
    (wc as unknown as { provider: unknown; connectedChainId: number }).provider = {
      session: {
        topic: "deadbeef",
        expiry: 1234,
        peer: { metadata: { name: "MetaMask" } },
        namespaces: {
          eip155: { accounts: ["eip155:56:0xAbC0000000000000000000000000000000000001"] },
        },
      },
    };
    (wc as unknown as { connectedChainId: number }).connectedChainId = 56;
    return wc;
  }

  it("extracts the bare address from a CAIP-10 account", () => {
    const wc = withSession();
    expect(wc.isConnected()).toBe(true);
    expect(wc.account()).toBe("0xAbC0000000000000000000000000000000000001");
  });

  it("status surfaces topic, peer, chain and account", () => {
    const s = withSession().status();
    expect(s).toMatchObject({
      connected: true,
      account: "0xAbC0000000000000000000000000000000000001",
      chainId: 56,
      topic: "deadbeef",
      peerName: "MetaMask",
      expiry: 1234,
    });
  });
});
