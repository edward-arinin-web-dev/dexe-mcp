import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { runBroadcastGuards, BroadcastGuardError } from "../lib/broadcastGuards.js";

export function registerTxTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
): void {
  server.tool(
    "dexe_tx_send",
    "Sign and broadcast a transaction using the configured DEXE_PRIVATE_KEY. " +
      "Pass the TxPayload fields returned by any dexe_*_build_* tool. " +
      "Waits for on-chain confirmation and returns the receipt. " +
      "When the MCP has multiple chains configured, pass `chainId` explicitly to pick which one to broadcast on; otherwise the default chain is used.",
    {
      to: z.string().describe("Destination contract address"),
      data: z.string().describe("ABI-encoded calldata (0x-prefixed hex)"),
      value: z
        .string()
        .default("0")
        .describe("Wei value as decimal string"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target chain id. Defaults to the MCP's default chain. Tool rejects if no RPC is configured for the requested chain.",
        ),
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
    async ({ to, data, value, chainId, gasLimit, waitConfirmations }) => {
      const chain = resolveChain(config, chainId);
      const wallet = signer.requireSigner(chain.chainId);

      // Signer broadcast guards (B6/B7/B9/B10) — no-ops unless their env vars
      // are set. Run before spending any gas.
      try {
        await runBroadcastGuards(
          { to, data, value, chainId: chain.chainId, from: wallet.address },
          config,
        );
      } catch (e) {
        if (e instanceof BroadcastGuardError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "rejected",
                    guard: e.guard,
                    reason: e.message,
                    chainId: chain.chainId,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }

      const tx = await wallet.sendTransaction({
        to,
        data,
        value: BigInt(value),
        chainId: BigInt(chain.chainId),
        ...(gasLimit ? { gasLimit: BigInt(gasLimit) } : {}),
      });

      if (waitConfirmations === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  txHash: tx.hash,
                  from: wallet.address,
                  chainId: chain.chainId,
                  status: "submitted",
                },
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
              text: JSON.stringify(
                { txHash: tx.hash, chainId: chain.chainId, status: "unknown" },
                null,
                2,
              ),
            },
          ],
        };
      }

      const result = {
        txHash: receipt.hash,
        from: wallet.address,
        chainId: chain.chainId,
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
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Chain id to look up the receipt on. Defaults to the MCP's default chain.",
        ),
    },
    async ({ txHash, chainId }) => {
      const chain = resolveChain(config, chainId);
      const wallet = signer.requireSigner(chain.chainId);
      const provider = wallet.provider!;

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ chainId: chain.chainId, status: "pending" }),
            },
          ],
        };
      }

      const result = {
        txHash: receipt.hash,
        chainId: chain.chainId,
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
