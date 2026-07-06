import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { wcPairingContent } from "../lib/qr.js";

/**
 * C12 — WalletConnect tools.
 *
 * Phase A shipped `dexe_wc_status` as a config echo. Phase B adds the live relay
 * session: `dexe_wc_connect` (returns a pairing URI for the phone to scan) and
 * `dexe_wc_disconnect`, and `dexe_wc_status` now reports the live session state.
 *
 * WalletConnect activates as the signer only when DEXE_WALLETCONNECT_PROJECT_ID
 * is set AND no DEXE_PRIVATE_KEY is present (a hot key, or Safe, takes
 * precedence). When active, `dexe_tx_send` forwards every tx to the phone wallet
 * for approval — the wallet signs and broadcasts, so no key ever enters the MCP.
 */
export function registerWalletConnectTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
  wc: WalletConnectManager,
): void {
  const resolveSignerMode = (): "readonly" | "eoa" | "safe" | "walletconnect" => {
    const safeServiceUrl = process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined;
    return signer.hasSigner()
      ? safeServiceUrl
        ? "safe"
        : "eoa"
      : wc.isConfigured()
        ? "walletconnect"
        : "readonly";
  };

  server.tool(
    "dexe_wc_status",
    "Diagnostic: returns the resolved WalletConnect config plus the live session state " +
      "(connected?, account, chain, topic, peer wallet, last error). Read-only. WalletConnect " +
      "activates only when DEXE_WALLETCONNECT_PROJECT_ID is set AND no DEXE_PRIVATE_KEY is present.",
    {
      chainId: z.number().int().positive().optional().describe("Unused; reserved."),
    },
    async () => {
      const signerMode = resolveSignerMode();
      const session = wc.status();
      const result = {
        signerMode,
        active: signerMode === "walletconnect",
        projectIdConfigured: wc.isConfigured(),
        relayUrl: config.walletConnectRelayUrl ?? null,
        approvalTimeoutMs: config.walletConnectApprovalTimeoutMs ?? null,
        session,
        note: !wc.isConfigured()
          ? "No DEXE_WALLETCONNECT_PROJECT_ID set. Get a free id at https://cloud.reown.com to enable WalletConnect mode."
          : signerMode !== "walletconnect"
            ? "WalletConnect project id is set but inactive — DEXE_PRIVATE_KEY (or Safe) takes precedence."
            : session.connected
              ? "Connected. dexe_tx_send will forward transactions to the phone wallet for approval."
              : session.connecting
                ? "Pairing in progress — approve the session on your phone, then re-check status."
                : "WalletConnect is the active signer mode. Call dexe_wc_connect to start a phone session.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "dexe_wc_connect",
    "Start a WalletConnect session and render a scannable QR (ASCII + PNG) for the phone wallet " +
      "(MetaMask / Trust / Rainbow). This is the RECOMMENDED signer — the phone signs and " +
      "broadcasts, so no private key ever touches this machine. The session is approved on the " +
      "phone; this tool returns as soon as the QR is ready — poll dexe_wc_status until `connected` " +
      "is true. Works even if DEXE_PRIVATE_KEY is set (a hot key just keeps signing precedence " +
      "until you unset it).",
    {
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Chain to request in the session namespace. Defaults to the MCP's default chain."),
    },
    async ({ chainId }) => {
      if (!wc.isConfigured()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "error",
                  reason:
                    "WalletConnect not configured. Set DEXE_WALLETCONNECT_PROJECT_ID (https://cloud.reown.com).",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      // A hot key no longer blocks pairing — but be honest that it still signs
      // until removed (we keep key-wins precedence to avoid a breaking change).
      const keyPrecedenceNote = signer.hasSigner()
        ? "⚠️ DEXE_PRIVATE_KEY is set and still takes signing precedence — dexe_tx_send will use the hot key, not this session, until you unset the key. Unset it to make WalletConnect the active signer."
        : undefined;
      try {
        const { uri, chainId: resolved } = await wc.connect(chainId);
        return {
          content: await wcPairingContent(
            uri,
            resolved,
            keyPrecedenceNote ? { keyPrecedenceNote } : undefined,
          ),
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "error", reason: e instanceof Error ? e.message : String(e) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "dexe_wc_disconnect",
    "Tear down the active WalletConnect session. Safe to call when not connected (returns disconnected:false).",
    {
      _placeholder: z.boolean().optional().describe("Unused; tool takes no input."),
    },
    async () => {
      const disconnected = await wc.disconnect();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "ok", disconnected }, null, 2),
          },
        ],
      };
    },
  );
}
