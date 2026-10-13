import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { wcPairingContent } from "../lib/qr.js";
import { safeErrorMessage } from "../lib/redact.js";

/**
 * C12 — WalletConnect tools.
 *
 * Phase A shipped `dexe_wc_status` as a config echo. Phase B adds the live relay
 * session: `dexe_wc_connect` (returns a pairing URI for the phone to scan) and
 * `dexe_wc_disconnect`, and `dexe_wc_status` now reports the live session state.
 *
 * WalletConnect is the signer in `walletconnect` mode — the default
 * DEXE_SIGNER_MODE, also when a hot key is present (since 1.0.0 only an
 * explicit `unattended` mode signs with one). When active, `dexe_tx_send` forwards every tx to the phone wallet
 * for approval — the wallet signs and broadcasts, so no key ever enters the MCP.
 */
export function registerWalletConnectTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
  wc: WalletConnectManager,
): void {
  // The signer mode is resolved ONCE, at startup (src/lib/signerMode.ts);
  // WalletConnect dispatches only in `walletconnect` mode (or, transitionally,
  // an unattended session with no primary key).
  const wcIsDispatch = (): boolean =>
    wc.isConfigured() && !signer.hasSigner() && signer.mode !== "keystore" && signer.mode !== "readonly";

  server.tool(
    "dexe_wc_status",
    "Read-only. WalletConnect config plus live session state (connected?, account, chain, topic, peer " +
      "wallet, last error). It dispatches transactions in DEXE_SIGNER_MODE=walletconnect (the default).",
    {
      chainId: z.number().int().positive().optional().describe("Unused; reserved."),
    },
    async () => {
      const signerMode = signer.mode;
      const active = wcIsDispatch();
      const session = wc.status();
      const result = {
        signerMode,
        active,
        projectIdConfigured: wc.isConfigured(),
        relayUrl: config.walletConnectRelayUrl ?? null,
        approvalTimeoutMs: config.walletConnectApprovalTimeoutMs ?? null,
        session,
        note: !wc.isConfigured()
          ? "No DEXE_WALLETCONNECT_PROJECT_ID set. Get a free id at https://cloud.reown.com to enable WalletConnect mode."
          : !active
            ? `WalletConnect project id is set but this server signs in ${signerMode} mode (DEXE_SIGNER_MODE); ` +
              "a WalletConnect session is used only for message signing there."
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
    "Writes to a remote service. Starts a WalletConnect session and renders a scannable QR (ASCII + PNG). " +
      "RECOMMENDED signer — the phone signs and broadcasts, so no private key touches this machine. " +
      "Poll dexe_wc_status until `connected`. In DEXE_SIGNER_MODE=unattended a hot key signs instead.",
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
      // A loaded hot key (unattended mode) or the keystore does not block
      // pairing — but be honest that it, not this session, sends transactions.
      const keyPrecedenceNote =
        signer.mode === "keystore"
          ? "This server signs transactions with the encrypted keystore (DEXE_SIGNER_MODE=keystore); this session is used for message signatures (dexe_auth_login). Set DEXE_SIGNER_MODE=walletconnect to send transactions through the phone."
          : signer.hasSigner()
            ? "⚠️ A hot key is set and still takes signing precedence — dexe_tx_send will use it, not this session. Set DEXE_SIGNER_MODE=walletconnect (and restart) to make WalletConnect the active signer."
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
                { status: "error", reason: safeErrorMessage(e) },
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
    "Writes to a remote service. Tears down the active WalletConnect session; safe when not connected.",
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
