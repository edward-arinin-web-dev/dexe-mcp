import { resolveChain, type DexeConfig } from "../config.js";

/**
 * C12 Phase B — WalletConnect (Reown) signer session.
 *
 * In `walletconnect` signerMode the MCP holds **no private key**. Every write is
 * forwarded to the operator's phone wallet over the WalletConnect v2 relay; the
 * wallet signs *and broadcasts*, returning only the tx hash. The key therefore
 * never enters this process — the whole point of the mode.
 *
 * The `@walletconnect/universal-provider` dependency is **lazily imported** the
 * first time a session is opened, so read-only / EOA / Safe deployments that
 * never touch WalletConnect pay no startup cost and the dep stays optional at
 * runtime (a missing install surfaces a clear error only on `dexe_wc_connect`).
 */

/** Minimal shape of the bits of UniversalProvider we use — avoids a hard type dep. */
interface UniversalProviderLike {
  session?: {
    topic: string;
    namespaces: Record<string, { accounts: string[] }>;
    expiry?: number;
    peer?: { metadata?: { name?: string; url?: string } };
  };
  on(event: string, cb: (arg: unknown) => void): void;
  once(event: string, cb: (arg: unknown) => void): void;
  removeListener?(event: string, cb: (arg: unknown) => void): void;
  connect(args: unknown): Promise<unknown>;
  request<T = unknown>(payload: { method: string; params?: unknown[] }, chain?: string): Promise<T>;
  disconnect(): Promise<void>;
}

export interface WcSendTx {
  to: string;
  data: string;
  /** Wei value as a decimal string. */
  value: string;
  chainId: number;
  /** Optional gas limit override (decimal string). */
  gasLimit?: string;
}

export interface WcStatus {
  connected: boolean;
  connecting: boolean;
  account: string | null;
  chainId: number | null;
  topic: string | null;
  peerName: string | null;
  expiry: number | null;
  lastError: string | null;
}

export class WalletConnectManager {
  private readonly config: DexeConfig;
  private provider?: UniversalProviderLike;
  private connecting = false;
  private connectedChainId?: number;
  private lastError?: string;

  constructor(config: DexeConfig) {
    this.config = config;
  }

  /** WalletConnect is usable only when a project id was configured. */
  isConfigured(): boolean {
    return !!this.config.walletConnectProjectId;
  }

  /** True once the phone wallet has approved the session proposal. */
  isConnected(): boolean {
    return !!this.provider?.session;
  }

  /**
   * Active account address for the connected session, or null.
   * Accounts are CAIP-10 (`eip155:<chainId>:<addr>`) — we return the bare addr.
   */
  account(): string | null {
    const accounts = this.provider?.session?.namespaces?.eip155?.accounts;
    if (!accounts || accounts.length === 0) return null;
    const parts = accounts[0]!.split(":");
    return parts[parts.length - 1] ?? null;
  }

  status(): WcStatus {
    const session = this.provider?.session;
    return {
      connected: !!session,
      connecting: this.connecting,
      account: this.account(),
      chainId: this.connectedChainId ?? null,
      topic: session?.topic ?? null,
      peerName: session?.peer?.metadata?.name ?? null,
      expiry: session?.expiry ?? null,
      lastError: this.lastError ?? null,
    };
  }

  /**
   * Lazily init the UniversalProvider. Throws a readable error if the optional
   * dependency is not installed.
   */
  private async getProvider(): Promise<UniversalProviderLike> {
    if (this.provider) return this.provider;
    if (!this.config.walletConnectProjectId) {
      throw new Error(
        "DEXE_WALLETCONNECT_PROJECT_ID not set. Get a free project id at https://cloud.reown.com to enable WalletConnect mode.",
      );
    }
    type UpCtor = { init(opts: unknown): Promise<UniversalProviderLike> };
    let mod: Record<string, unknown>;
    try {
      mod = (await import("@walletconnect/universal-provider")) as never;
    } catch {
      throw new Error(
        "@walletconnect/universal-provider is not installed. Run `npm install @walletconnect/universal-provider` in the MCP server directory to enable WalletConnect mode.",
      );
    }
    // ESM/CJS interop: the published package is CJS, so a dynamic import nests the
    // class under varying keys depending on the loader. Probe the known shapes:
    //   mod.UniversalProvider | mod.default.UniversalProvider | mod.default.default | mod.default
    const def = mod.default as Record<string, unknown> | undefined;
    const candidate =
      (mod.UniversalProvider as UpCtor | undefined) ??
      (def?.UniversalProvider as UpCtor | undefined) ??
      (def?.default as UpCtor | undefined) ??
      (def as UpCtor | undefined);
    if (!candidate || typeof candidate.init !== "function") {
      throw new Error(
        "@walletconnect/universal-provider loaded but UniversalProvider.init was not found (unexpected module shape).",
      );
    }
    const UniversalProvider = candidate;
    const provider = await UniversalProvider.init({
      projectId: this.config.walletConnectProjectId,
      relayUrl: this.config.walletConnectRelayUrl,
      metadata: {
        name: "dexe-mcp",
        description: "DeXe Protocol MCP server — DAO governance via WalletConnect",
        url: "https://github.com/edward-arinin-web-dev/dexe-mcp",
        icons: ["https://avatars.githubusercontent.com/u/37784886"],
      },
    });
    // Clear local session state when the phone ends the session out-of-band.
    provider.on("session_delete", () => {
      this.connectedChainId = undefined;
    });
    this.provider = provider;
    return provider;
  }

  /**
   * Start a session for `chainId`. Returns the pairing URI as soon as the relay
   * emits it (the user scans this as a QR or pastes it into their wallet). The
   * session-approval handshake completes in the background — poll `status()` /
   * `dexe_wc_status` until `connected` flips true.
   */
  async connect(chainId?: number): Promise<{ uri: string; chainId: number }> {
    if (this.isConnected()) {
      throw new Error(
        `Already connected to ${this.account()} (chain ${this.connectedChainId}). Call dexe_wc_disconnect first to pair a different wallet.`,
      );
    }
    const chain = resolveChain(this.config, chainId);
    const provider = await this.getProvider();
    this.lastError = undefined;
    this.connecting = true;

    return new Promise<{ uri: string; chainId: number }>((resolveUri, rejectUri) => {
      let uriEmitted = false;
      const onUri = (arg: unknown) => {
        const uri = (arg as { uri?: string })?.uri ?? (arg as unknown as string);
        if (typeof uri === "string" && !uriEmitted) {
          uriEmitted = true;
          resolveUri({ uri, chainId: chain.chainId });
        }
      };
      provider.once("display_uri", onUri);

      provider
        .connect({
          optionalNamespaces: {
            eip155: {
              methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4"],
              chains: [`eip155:${chain.chainId}`],
              events: ["chainChanged", "accountsChanged"],
            },
          },
        })
        .then(() => {
          // Session approved by the phone wallet.
          this.connecting = false;
          this.connectedChainId = chain.chainId;
        })
        .catch((e: unknown) => {
          this.connecting = false;
          this.lastError = e instanceof Error ? e.message : String(e);
          provider.removeListener?.("display_uri", onUri);
          // If the URI never made it out, the caller is still awaiting — reject.
          if (!uriEmitted) rejectUri(e);
        });
    });
  }

  /** Tear down the active session. No-op (returns false) when not connected. */
  async disconnect(): Promise<boolean> {
    if (!this.provider?.session) return false;
    await this.provider.disconnect();
    this.connectedChainId = undefined;
    this.connecting = false;
    return true;
  }

  /**
   * Forward a transaction to the phone wallet for approval. Resolves with the
   * broadcast tx hash once the user approves, or rejects on timeout / rejection.
   * The wallet signs AND broadcasts — we never see a private key.
   */
  async sendTransaction(tx: WcSendTx): Promise<string> {
    const provider = await this.getProvider();
    if (!provider.session) {
      throw new Error("WalletConnect session not established. Call dexe_wc_connect and approve on your phone first.");
    }
    const account = this.account();
    if (!account) throw new Error("WalletConnect session has no eip155 account.");

    const params = [
      {
        from: account,
        to: tx.to,
        data: tx.data,
        value: "0x" + BigInt(tx.value).toString(16),
        ...(tx.gasLimit ? { gas: "0x" + BigInt(tx.gasLimit).toString(16) } : {}),
      },
    ];

    const timeoutMs = this.config.walletConnectApprovalTimeoutMs ?? 120000;
    const request = provider.request<string>(
      { method: "eth_sendTransaction", params },
      `eip155:${tx.chainId}`,
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `WalletConnect approval timed out after ${timeoutMs}ms (DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS). The phone wallet did not approve in time.`,
            ),
          ),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
