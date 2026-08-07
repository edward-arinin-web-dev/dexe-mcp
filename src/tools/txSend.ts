import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { createChainProvider } from "../rpc.js";
import { runBroadcastGuards, BroadcastGuardError } from "../lib/broadcastGuards.js";
import { waitWithTimeout, waitForHashWithTimeout, txWaitTimeoutMs } from "../lib/txWait.js";
import { toActionableError } from "../lib/errors.js";
import { ENABLE_WRITES_HINT, describeBroadcaster } from "./flow.js";
import { wcPairingContent } from "../lib/qr.js";
import { withActionContext } from "../lib/agentLedger.js";
import {
  findForbiddenSelector,
  forbiddenSelectors,
  selectorOf,
  scanForbiddenCalldata,
  forbiddenBroadcastError,
  type ForbiddenSelector,
} from "../lib/dangerousSelectors.js";

/**
 * R3 — receipt.status===0 (mined but REVERTED) must surface as a failure, not
 * a normal result the model reads as success.
 */
const REVERTED_NOTE =
  "⚠️ REVERTED — the transaction was mined but FAILED on-chain (status 0). State was NOT changed. " +
  "Inspect the tx on the explorer for the revert reason before retrying.";

/** Flagged on every hot-key broadcast — a plaintext key on disk is not safe. */
const HOT_KEY_SAFETY =
  "⚠️ NOT SAFE — signed with a hot key (DEXE_PRIVATE_KEY) in plaintext on disk. " +
  "Prefer WalletConnect: run dexe_wc_connect and the phone signs, so the key never touches this machine.";

/**
 * Classify a transaction whose receipt is absent: a tx that exists on-chain but
 * isn't mined yet is "pending"; a hash the node has never seen is "not_found"
 * (typo / wrong chain) — not perpetually "pending" (H-12 cross-ref).
 */
export function txStatusFromLookup(hasReceipt: boolean, hasTx: boolean): "mined" | "pending" | "not_found" {
  if (hasReceipt) return "mined";
  return hasTx ? "pending" : "not_found";
}

/* ───────────────── GovUserKeeper denylist — enforced at broadcast ──────────── */

// Re-exported for callers that already import these from here. The
// implementation lives in src/lib/dangerousSelectors.ts alongside the denylist
// itself: while it sat in this TOOL module, `runBroadcastGuards` could not see
// it, so every composite broadcast path silently skipped the "hard block".
export { scanForbiddenCalldata, forbiddenBroadcastError };

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
      "When the MCP has multiple chains configured, pass `chainId` explicitly to pick which one to broadcast on; otherwise the default chain is used. " +
      "Also pass the payload's own chainId as `payloadChainId` — the send is refused when the two disagree. " +
      "Calldata carrying a privileged GovUserKeeper accounting selector is refused outright (hard block, no override).",
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
      payloadChainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "The `chainId` field of the TxPayload being broadcast — copy it verbatim from the builder output. " +
            "If it disagrees with `chainId` the send is REFUSED (the payload was built for a different chain).",
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
      signerKey: z
        .string()
        .optional()
        .describe(
          "Which persona signs. Omit = the primary DEXE_PRIVATE_KEY (never implicit fallback to an agent). " +
            "'agent<n>' / 'funder' / an address = that DEXE_AGENT_PK_* keyring key; dexe_context lists the " +
            "configured slots. Hot-key mode only.",
        ),
    },
    async ({ to, data, value, chainId, payloadChainId, gasLimit, waitConfirmations, signerKey }) => {
      // Denylist FIRST — before chain resolution, signer lookup, WalletConnect
      // pairing, or any RPC. A refusal that only fires once the rest of the call
      // is well-formed is not a hard block; these bytes must never reach a node
      // whatever else is wrong with the request.
      const forbidden = scanForbiddenCalldata(data);
      if (forbidden) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rejected",
                  guard: "denylist",
                  selector: forbidden.match.selector,
                  signature: forbidden.match.signature,
                  reason: forbiddenBroadcastError(forbidden, to),
                  chainId: chainId ?? config.defaultChainId,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const chain = resolveChain(config, chainId);

      if (signerKey && wcActive()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "signerKey selects a DEXE_AGENT_PK_* hot key — it is not available in WalletConnect mode (the phone wallet owns the only key). Unset signerKey, or configure DEXE_PRIVATE_KEY + DEXE_AGENT_PK_* for keyring mode.",
            },
          ],
          isError: true,
        };
      }

      // ---- WalletConnect dispatch path (no hot key) ----------------------
      // The phone wallet signs AND broadcasts; we only see the hash. Guards
      // (B6/B7/B9/B10/B11) still run, keyed on the connected account as `from`.
      if (wcActive()) {
        if (!wc.isConnected()) {
          // Auto-pair: instead of erroring, start the session and print the QR
          // right here so the user just scans, approves, and re-runs.
          try {
            const pr = await wc.ensurePairing(chain.chainId);
            if (!pr.connected && pr.uri) {
              return {
                content: await wcPairingContent(pr.uri, pr.chainId, {
                  next: "Scan the QR, approve the session on your phone, then re-run dexe_tx_send to broadcast.",
                }),
              };
            }
          } catch (e) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "rejected",
                      reason: toActionableError(e, "WalletConnect pairing").message,
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
        }
        const from = wc.account()!;
        try {
          await runBroadcastGuards(
            { to, data, value, chainId: chain.chainId, from, payloadChainId },
            config,
          );
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
                  {
                    status: "rejected",
                    reason: toActionableError(e, "WalletConnect broadcast").message,
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
        const provider = createChainProvider(chain, config);
        let receipt;
        try {
          receipt = await waitForHashWithTimeout(provider, txHash, chain.chainId, {
            confirmations: waitConfirmations,
            timeoutMs: txWaitTimeoutMs(),
          });
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: toActionableError(e, "dexe_tx_send wait").message }],
            isError: true,
          };
        }
        const reverted = receipt?.status === 0;
        const result = receipt
          ? {
              txHash: receipt.hash,
              from,
              chainId: chain.chainId,
              signer: "walletconnect",
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString(),
              status: receipt.status,
              ...(reverted ? { reverted: true, note: REVERTED_NOTE } : {}),
            }
          : { txHash, from, chainId: chain.chainId, signer: "walletconnect", status: "unknown" };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(reverted ? { isError: true } : {}),
        };
      }

      // ---- hot-key (EOA) dispatch path -----------------------------------
      const sg = signer.trySigner(chain.chainId, signerKey);
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
      // Who is acting. Reported on every response so a fleet's transactions are
      // attributable in the transcript, not just in the ledger file.
      const who = describeBroadcaster(signer, wallet, signerKey);

      // Signer broadcast guards (B6/B7/B9/B10/B11) — B6/B7/B10 are no-ops
      // unless their env vars are set. Run before spending any gas.
      try {
        await runBroadcastGuards(
          { to, data, value, chainId: chain.chainId, from: wallet.address, payloadChainId },
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

      // The broadcast itself is the single most common failure in the server
      // (no gas, nonce clash, gas estimation reverting, RPC 429/timeout). An
      // uncaught throw here escapes as a raw ethers dump — which on a keyed
      // endpoint carries the RPC URL, API key and all (W36). Classify it.
      let tx;
      try {
        tx = await withActionContext(
          { tool: "dexe_tx_send", action: `${selectorOf(data) ?? "0x"} → ${to}` },
          () =>
            signer.withBroadcastLock(
              chain.chainId,
              () =>
                wallet.sendTransaction({
                  to,
                  data,
                  value: BigInt(value),
                  chainId: BigInt(chain.chainId),
                  ...(gasLimit ? { gasLimit: BigInt(gasLimit) } : {}),
                }),
              wallet.address,
            ),
        );
      } catch (e) {
        const actionable = toActionableError(e, "dexe_tx_send broadcast");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rejected",
                  reason: actionable.message,
                  ...(actionable.slug ? { failure: actionable.slug } : {}),
                  from: wallet.address,
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

      if (waitConfirmations === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  txHash: tx.hash,
                  from: wallet.address,
                  signerKey: who.signerKey,
                  chainId: chain.chainId,
                  signer: "eoa",
                  status: "submitted",
                  safety: HOT_KEY_SAFETY,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      let receipt;
      try {
        receipt = await waitWithTimeout(tx, {
          confirmations: waitConfirmations,
          timeoutMs: txWaitTimeoutMs(),
        });
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: toActionableError(e, "dexe_tx_send wait").message }],
          isError: true,
        };
      }
      if (!receipt) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  txHash: tx.hash,
                  from: wallet.address,
                  signerKey: who.signerKey,
                  chainId: chain.chainId,
                  signer: "eoa",
                  status: "unknown",
                  safety: HOT_KEY_SAFETY,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const reverted = receipt.status === 0;
      const result = {
        txHash: receipt.hash,
        from: wallet.address,
        signerKey: who.signerKey,
        chainId: chain.chainId,
        signer: "eoa",
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status,
        ...(reverted ? { reverted: true, note: REVERTED_NOTE } : {}),
        safety: HOT_KEY_SAFETY,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        ...(reverted ? { isError: true } : {}),
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
      const provider = createChainProvider(chain, config);

      // dexe_tx_status is the tool users reach for when a broadcast already went
      // sideways — an unclassified RPC failure here strands them twice.
      let receipt;
      let pendingTx = null;
      try {
        receipt = await provider.getTransactionReceipt(txHash);
        // A null receipt is ambiguous: the tx may be genuinely pending, or the
        // hash is a typo / on the wrong chain. Probe getTransaction to tell them
        // apart instead of reporting a nonexistent hash as perpetually pending.
        if (!receipt) pendingTx = await provider.getTransaction(txHash);
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: toActionableError(e, "dexe_tx_status lookup").message }],
          isError: true,
        };
      }
      if (!receipt) {
        const status = txStatusFromLookup(false, pendingTx !== null);
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
