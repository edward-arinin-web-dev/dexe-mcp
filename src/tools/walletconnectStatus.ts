import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { SignerManager } from "../lib/signer.js";

/**
 * C12 — WalletConnect status (Phase A: config-only).
 *
 * Reports the resolved WalletConnect config and whether `walletconnect` is the
 * active `signerMode`. Phase A opens **no relay connection** — it only echoes
 * what `loadConfig` parsed, so an operator can confirm their env before Phase B
 * adds `dexe_wc_connect`/`dexe_wc_disconnect` and the live phone-approval path.
 */
export function registerWalletConnectTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
): void {
  server.tool(
    "dexe_wc_status",
    "Diagnostic: returns the resolved WalletConnect config (project id present?, relay url, " +
      "approval timeout) and whether `walletconnect` is the active signerMode. Read-only — opens " +
      "no relay connection (Phase A). WalletConnect activates only when DEXE_WALLETCONNECT_PROJECT_ID " +
      "is set AND no DEXE_PRIVATE_KEY is present (hot key takes precedence).",
    {
      chainId: z.number().int().positive().optional().describe("Unused in Phase A; reserved for the live session."),
    },
    async () => {
      const projectIdConfigured = !!config.walletConnectProjectId;
      const safeServiceUrl = process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined;
      const signerMode: "readonly" | "eoa" | "safe" | "walletconnect" = signer.hasSigner()
        ? safeServiceUrl
          ? "safe"
          : "eoa"
        : projectIdConfigured
          ? "walletconnect"
          : "readonly";

      const result = {
        signerMode,
        active: signerMode === "walletconnect",
        projectIdConfigured,
        relayUrl: config.walletConnectRelayUrl ?? null,
        approvalTimeoutMs: config.walletConnectApprovalTimeoutMs ?? null,
        // Phase A has no live relay; these land in Phase B (dexe_wc_connect).
        connected: false,
        account: null,
        note: projectIdConfigured
          ? signerMode === "walletconnect"
            ? "WalletConnect is the active signer mode. Phase B adds dexe_wc_connect to start the phone session."
            : "WalletConnect project id is set but inactive — DEXE_PRIVATE_KEY (or Safe) takes precedence."
          : "No DEXE_WALLETCONNECT_PROJECT_ID set. Get a free id at https://cloud.reown.com to enable WalletConnect mode.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
