import { z } from "zod";
import { JsonRpcProvider } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { runBroadcastGuards, BroadcastGuardError } from "../lib/broadcastGuards.js";
import { ENABLE_WRITES_HINT } from "./flow.js";

/**
 * Classify a transaction whose receipt is absent: a tx that exists on-chain but
 * isn't mined yet is "pending"; a hash the node has never seen is "not_found"
 * (typo / wrong chain) — not perpetually "pending" (H-12 cross-ref).
 */
export function txStatusFromLookup(hasReceipt: boolean, hasTx: boolean): "mined" | "pending" | "not_found" {
  if (hasReceipt) return "mined";
  return hasTx ? "pending" : "not_found";
}

export function registerTxTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
  wc: WalletConnectManager,
): void {
  // WalletConnect is the dispatch path only when there is no hot key to sign with.
  const wcActive = (): boolean => !signer.hasSigner() && wc.isConfigured();
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

      // ---- WalletConnect dispatch path (no hot key) ----------------------
      // The phone wallet signs AND broadcasts; we only see the hash. Guards
      // (B6/B7/B9/B10) still run, keyed on the connected account as `from`.
      if (wcActive()) {
        if (!wc.isConnected()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "rejected",
                    reason:
                      "WalletConnect mode is active but no session is connected. Call dexe_wc_connect and approve on your phone first.",
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
        const from = wc.account()!;
        try {
          await runBroadcastGuards({ to, data, value, chainId: chain.chainId, from }, config);
        } catch (e) {
          if (e instanceof BroadcastGuardError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { status: "rejected", guard: e.guard, reason: e.message, chainId: chain.chainId },
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

        let txHash: string;
        try {
          txHash = await wc.sendTransaction({ to, data, value, chainId: chain.chainId, gasLimit });
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { status: "rejected", reason: e instanceof Error ? e.message : String(e), chainId: chain.chainId },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        if (waitConfirmations === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { txHash, from, chainId: chain.chainId, signer: "walletconnect", status: "submitted" },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        // Wait via a read provider — WC returned the hash, the wallet broadcast it.
        const provider = new JsonRpcProvider(chain.rpcUrl);
        const receipt = await provider.waitForTransaction(txHash, waitConfirmations);
        const result = receipt
          ? {
              txHash: receipt.hash,
              from,
              chainId: chain.chainId,
              signer: "walletconnect",
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString(),
              status: receipt.status,
            }
          : { txHash, from, chainId: chain.chainId, signer: "walletconnect", status: "unknown" };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      // ---- hot-key (EOA) dispatch path -----------------------------------
      const sg = signer.trySigner(chain.chainId);
      if ("error" in sg) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rejected",
                  reason: sg.error,
                  remediation: sg.remediation,
                  enableWrites: ENABLE_WRITES_HINT,
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
      const wallet = sg.ok;

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

      const tx = await signer.withBroadcastLock(chain.chainId, () =>
        wallet.sendTransaction({
          to,
          data,
          value: BigInt(value),
          chainId: BigInt(chain.chainId),
          ...(gasLimit ? { gasLimit: BigInt(gasLimit) } : {}),
        }),
      );

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
      // Read-only lookup — no signer needed, so this works in WalletConnect/
      // readonly modes too.
      const provider = new JsonRpcProvider(chain.rpcUrl);

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        // A null receipt is ambiguous: the tx may be genuinely pending, or the
        // hash is a typo / on the wrong chain. Probe getTransaction to tell them
        // apart instead of reporting a nonexistent hash as perpetually pending.
        const tx = await provider.getTransaction(txHash);
        const status = txStatusFromLookup(false, tx !== null);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                status === "pending"
                  ? { chainId: chain.chainId, txHash, status: "pending", note: "Seen in the mempool, not yet mined." }
                  : {
                      chainId: chain.chainId,
                      txHash,
                      status: "not_found",
                      note: "No transaction with this hash on this chain — check the hash and chainId.",
                    },
              ),
            },
          ],
          isError: status === "not_found",
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
