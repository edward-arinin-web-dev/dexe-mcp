import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import type { DexeConfig } from "../config.js";

export function registerTxTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
): void {
  server.tool(
    "dexe_tx_send",
    "Sign and broadcast a transaction using the configured DEXE_PRIVATE_KEY. " +
      "Pass the TxPayload fields returned by any dexe_*_build_* tool. " +
      "Waits for on-chain confirmation and returns the receipt.",
    {
      to: z.string().describe("Destination contract address"),
      data: z.string().describe("ABI-encoded calldata (0x-prefixed hex)"),
      value: z
        .string()
        .default("0")
        .describe("Wei value as decimal string"),
      gasLimit: z
        .string()
        .optional()
        .describe("Optional gas limit override (decimal string)"),
      waitConfirmations: z
        .number()
        .int()
        .min(0)
        .max(12)
        .default(1)
        .describe("Confirmations to wait (0 = fire-and-forget)"),
    },
    async ({ to, data, value, gasLimit, waitConfirmations }) => {
      const wallet = signer.requireSigner();

      const tx = await wallet.sendTransaction({
        to,
        data,
        value: BigInt(value),
        chainId: BigInt(config.chainId),
        ...(gasLimit ? { gasLimit: BigInt(gasLimit) } : {}),
      });

      if (waitConfirmations === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { txHash: tx.hash, from: wallet.address, status: "submitted" },
                null,
                2,
              ),
            },
          ],
        };
      }

      const receipt = await tx.wait(waitConfirmations);
      if (!receipt) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ txHash: tx.hash, status: "unknown" }, null, 2),
            },
          ],
        };
      }

      const result = {
        txHash: receipt.hash,
        from: wallet.address,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "dexe_tx_status",
    "Check the receipt/status of a previously submitted transaction hash.",
    {
      txHash: z.string().describe("Transaction hash to look up"),
    },
    async ({ txHash }) => {
      const wallet = signer.requireSigner();
      const provider = wallet.provider!;

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "pending" }) }],
        };
      }

      const result = {
        txHash: receipt.hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        logsCount: receipt.logs.length,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
