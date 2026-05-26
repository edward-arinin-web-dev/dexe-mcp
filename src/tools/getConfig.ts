import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { SignerManager } from "../lib/signer.js";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum mainnet",
  56: "BSC mainnet",
  97: "BSC testnet",
  137: "Polygon mainnet",
  8453: "Base mainnet",
  42161: "Arbitrum One",
};

/**
 * Read-only diagnostic. Returns the chains the MCP knows about, which one is
 * the default for tools that omit `chainId`, and whether a signer is
 * available. Call this at the start of a session to orient before any write.
 */
export function registerGetConfigTool(server: McpServer, config: DexeConfig, signer: SignerManager): void {
  server.tool(
    "dexe_get_config",
    "Diagnostic: returns the MCP's chain set, default chain, and signer status. " +
      "Call this once at session start when you're unsure which chain the server is configured for. " +
      "Read-only — never writes or broadcasts.",
    {
      _placeholder: z.boolean().optional().describe("Unused; tool takes no input."),
    },
    async () => {
      const chains = [...config.chains.values()]
        .sort((a, b) => a.chainId - b.chainId)
        .map(c => ({
          chainId: c.chainId,
          rpcUrl: c.rpcUrl,
          name: CHAIN_NAMES[c.chainId] ?? `chain ${c.chainId}`,
          isDefault: c.chainId === config.defaultChainId,
          registryOverride: c.registryOverride,
        }));

      const signerInfo = signer.hasSigner()
        ? { available: true, address: signer.getAddress() }
        : { available: false, address: null };

      // How writes are dispatched:
      //   - "readonly": no DEXE_PRIVATE_KEY → tools return unsigned TxPayloads only
      //   - "safe":     key + DEXE_SAFE_TX_SERVICE_URL → dexe_safe_* can queue txs
      //                 to the Safe multisig instead of broadcasting
      //   - "eoa":      key set, no Safe service → dexe_tx_send broadcasts directly
      //   - "walletconnect": no key, but DEXE_WALLETCONNECT_PROJECT_ID set →
      //                 txs are forwarded to the operator's phone for approval
      //                 (Phase B). WC wins only when no hot key is present.
      const safeServiceUrl = process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined;
      const signerMode: "readonly" | "eoa" | "safe" | "walletconnect" = signer.hasSigner()
        ? safeServiceUrl
          ? "safe"
          : "eoa"
        : config.walletConnectProjectId
          ? "walletconnect"
          : "readonly";

      const result = {
        defaultChainId: config.defaultChainId,
        defaultChainName: CHAIN_NAMES[config.defaultChainId] ?? `chain ${config.defaultChainId}`,
        chains,
        signerMode,
        signer: signerInfo,
        safe: {
          txServiceConfigured: !!safeServiceUrl,
          txServiceUrl: safeServiceUrl ?? null,
          apiKeyConfigured: !!(process.env.DEXE_SAFE_API_KEY?.trim()),
        },
        walletConnect: {
          projectIdConfigured: !!config.walletConnectProjectId,
          relayUrl: config.walletConnectRelayUrl ?? null,
          approvalTimeoutMs: config.walletConnectApprovalTimeoutMs ?? null,
        },
        ipfs: {
          pinataConfigured: !!config.pinataJwt,
        },
        subgraph: {
          poolsConfigured: !!config.subgraphPoolsUrl,
          validatorsConfigured: !!config.subgraphValidatorsUrl,
          interactionsConfigured: !!config.subgraphInteractionsUrl,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
