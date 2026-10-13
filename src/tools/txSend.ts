import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HOT_KEY_SAFETY, KEYSTORE_SAFETY, type SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { resolveChain, type DexeConfig } from "../config.js";
import {
  createChainProvider,
  findForbiddenSelector,
  forbiddenBroadcastError,
  forbiddenSelectors,
  scanForbiddenCalldata,
  selectorOf,
  type ForbiddenSelector,
} from "@dexe-network/dexe-mcp/core";
import { runBroadcastGuards, BroadcastGuardError } from "../lib/broadcastGuards.js";
import { waitWithTimeout, waitForHashWithTimeout, txWaitTimeoutMs } from "../lib/txWait.js";
import { toActionableError } from "../lib/writeErrors.js";
import {
  enableWritesHint,
  KEYSTORE_MISSING_HINT,
  KEYSTORE_SIGNERKEY_REFUSAL,
  READONLY_MODE_HINT,
  describeBroadcaster,
} from "./flow.js";
import { buildReview } from "../lib/approval/review.js";
import { currentToolScope } from "../lib/approval/scope.js";
import { wcPairingContent } from "../lib/qr.js";
import { withActionContext } from "../lib/agentLedger.js";

/**
 * R3 — receipt.status===0 (mined but REVERTED) must surface as a failure, not
 * a normal result the model reads as success.
 */
const REVERTED_NOTE =
  "⚠️ REVERTED — the transaction was mined but FAILED on-chain (status 0). State was NOT changed. " +
  "Inspect the tx on the explorer for the revert reason before retrying.";

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
  // WalletConnect is the dispatch path only when there is no hot key to sign
  // with — and never in keystore mode (the keystore signs, after the owner's
  // password) or readonly mode (nothing signs).
  const wcActive = (): boolean =>
    !signer.hasSigner() && wc.isConfigured() && signer.mode !== "keystore" && signer.mode !== "readonly";
  const rejected = (body: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ status: "rejected", ...body }, null, 2) }],
    isError: true,
  });
  server.tool(
    "dexe_tx_send",
    "Broadcasts when a signer is configured. Sends the TxPayload fields from any dexe_*_build_* tool and waits for confirmation. " +
      "Pass `chainId` when several chains are configured, plus the payload's own chainId as `payloadChainId` — a mismatch REFUSES the send. " +
      "Calldata with a privileged GovUserKeeper accounting selector is refused (hard block, no override).",
    {
      to: z.string().optional().describe("Destination contract address (or pass the builder's `payload` object)"),
      data: z.string().optional().describe("ABI-encoded calldata (0x-prefixed hex)"),
      value: z
        .string()
        .default("0")
        .describe("Wei value as decimal string"),
      payload: z
        .object({
          to: z.string().describe("Destination contract address (the payload's `to`)"),
          data: z.string().describe("ABI-encoded calldata, 0x-hex (the payload's `data`)"),
          value: z.string().optional().describe("Wei value as decimal string (the payload's `value`, default 0)"),
          chainId: z.number().int().positive().optional().describe("The payload's own chainId; used as payloadChainId"),
        })
        .passthrough()
        .optional()
        .describe(
          "A dexe_*_build_* `payload` object verbatim ({to,data,value,chainId}). Fills to/data/value and payloadChainId when the flat fields are omitted.",
        ),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Chain to broadcast on; needs an RPC for it. Default: the MCP's default chain."),
      payloadChainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("The TxPayload's own `chainId`, copied verbatim — a mismatch REFUSES the send."),
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
        .describe("Signer: omit = primary DEXE_PRIVATE_KEY (never an agent); 'agent<n>'/address = keyring."),
    },
    async ({ to: toFlat, data: dataFlat, value: valueFlat, payload, chainId, payloadChainId: payloadChainIdFlat, gasLimit, waitConfirmations, signerKey }) => {
      // Every dexe_*_build_* tool answers `{ payload: { to, data, value, chainId } }`,
      // and the natural next call is to hand that object straight back. Accept
      // it: the flat fields win when both are given, and the payload's own
      // chainId feeds the same mismatch refusal as an explicit `payloadChainId`.
      const to = toFlat ?? payload?.to;
      const data = dataFlat ?? payload?.data;
      const value = valueFlat !== "0" || payload?.value === undefined ? valueFlat : payload.value;
      const payloadChainId = payloadChainIdFlat ?? payload?.chainId;
      if (!to || !data) {
        return {
          content: [
            {
              type: "text" as const,
              text: "dexe_tx_send needs `to` + `data` — pass them flat, or pass a builder's `payload` object as `payload`.",
            },
          ],
          isError: true,
        };
      }
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

      // ---- keystore dispatch path ----------------------------------------
      // One-step batch: review (B6/B7/B11/B12 + B9) → the owner approves on the
      // local page with the keystore password → the ApprovedSigner signs exactly
      // this transaction. Not approved yet / declined → ApprovalHaltError, which
      // the approval scope renders as awaiting_approval / declined.
      if (signer.mode === "keystore") {
        if (signerKey && !signer.hasSigner(signerKey)) {
          return rejected({ reason: KEYSTORE_SIGNERKEY_REFUSAL, chainId: chain.chainId });
        }
        const approvals = signer.approvals;
        if (!signer.hasSigner() || !approvals) {
          return rejected({ reason: KEYSTORE_MISSING_HINT, chainId: chain.chainId });
        }
        if (payloadChainId !== undefined && payloadChainId !== chain.chainId) {
          return rejected({
            guard: "B11",
            reason:
              `Payload was built for chain ${payloadChainId} but you are broadcasting on chain ${chain.chainId}. ` +
              `Refusing: an address holds a different contract (or none) on each chain.`,
            chainId: chain.chainId,
          });
        }
        const from = signer.getAddress();
        const review = await buildReview([{ to, data, value }], {
          chainId: chain.chainId,
          from,
          config,
          simulateFirst: true,
        });
        if (!review.ok) return rejected({ guard: review.guard, reason: review.reason, chainId: chain.chainId });
        const scope = currentToolScope();
        const approved = await approvals.request(
          { tool: "dexe_tx_send", chainId: chain.chainId, from, payloads: [{ to, data, value }], steps: review.steps, prechecks: review.prechecks },
          { ...(scope?.signal ? { signal: scope.signal } : {}), ...(scope ? { progress: (m: string) => scope.progress(m) } : {}) },
        );
        // Full guards again at send time — the owner may have taken minutes.
        try {
          await runBroadcastGuards({ to, data, value, chainId: chain.chainId, from, payloadChainId }, config);
        } catch (e) {
          approved.revoke(`send-time guard refused: ${e instanceof Error ? e.message.slice(0, 160) : "guard"}`);
          if (e instanceof BroadcastGuardError) {
            return rejected({ guard: e.guard, reason: e.message, chainId: chain.chainId });
          }
          throw e;
        }
        let ktx;
        try {
          ktx = await withActionContext({ tool: "dexe_tx_send", action: `${selectorOf(data) ?? "0x"} → ${to}` }, () =>
            // gasLimit is NOT forwarded: the owner did not approve it. The
            // ApprovedSigner estimates it server-side under a cap.
            approved.send({ to, data, value, chainId: chain.chainId }),
          );
        } catch (e) {
          approved.revoke("broadcast failed");
          const actionable = toActionableError(e, "dexe_tx_send broadcast");
          return rejected({
            reason: actionable.message,
            ...(actionable.slug ? { failure: actionable.slug } : {}),
            from,
            chainId: chain.chainId,
          });
        }
        approved.landed(0, ktx.hash);
        approved.finish();
        const base = {
          txHash: ktx.hash,
          from,
          signerKey: "keystore",
          chainId: chain.chainId,
          signer: "keystore",
          ...(gasLimit ? { gasLimitNote: "gasLimit was ignored: in keystore mode gas is estimated server-side (capped)." } : {}),
        };
        if (waitConfirmations === 0) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ...base, status: "submitted", safety: KEYSTORE_SAFETY }, null, 2) },
            ],
          };
        }
        let kreceipt;
        try {
          kreceipt = await waitWithTimeout(ktx, { confirmations: waitConfirmations, timeoutMs: txWaitTimeoutMs() });
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: toActionableError(e, "dexe_tx_send wait").message }],
            isError: true,
          };
        }
        const kreverted = kreceipt?.status === 0;
        const kresult = kreceipt
          ? {
              ...base,
              txHash: kreceipt.hash,
              blockNumber: kreceipt.blockNumber,
              gasUsed: kreceipt.gasUsed.toString(),
              status: kreceipt.status,
              ...(kreverted ? { reverted: true, note: REVERTED_NOTE } : {}),
              safety: KEYSTORE_SAFETY,
            }
          : { ...base, status: "unknown", safety: KEYSTORE_SAFETY };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(kresult, null, 2) }],
          ...(kreverted ? { isError: true } : {}),
        };
      }

      if (signer.mode === "readonly") {
        return rejected({ reason: READONLY_MODE_HINT, chainId: chain.chainId });
      }

      if (signerKey && wcActive()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "signerKey selects a DEXE_AGENT_PK_* hot key — it is not available in WalletConnect mode (the phone wallet owns the only key). Unset signerKey, or set DEXE_SIGNER_MODE=unattended with DEXE_PRIVATE_KEY + DEXE_AGENT_PK_* for keyring mode.",
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
                  enableWrites: enableWritesHint(signer),
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
    "Read-only. Receipt/status for a submitted tx hash (pending vs not_found). A broadcast timeout is not a failure — the tx may still confirm; re-check here.",
    {
      txHash: z.string().describe("Transaction hash to look up"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Chain to look the receipt up on. Default: the MCP's default chain."),
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

  // Read-only on purpose: there is no approve or decline tool, and no
  // parameter here changes an approval. Only the owner, on the page, can.
  server.tool(
    "dexe_tx_approval_status",
    "Read-only. Status + landed tx hashes of a keystore approval (`awaiting_approval`). Cannot approve; only the owner can, on the page.",
    {
      approvalId: z.string().max(64).describe("`approval.approvalId` of the awaiting_approval result"),
      waitMs: z.number().int().min(0).max(120_000).default(0).describe("Long-poll up to this many ms for a change"),
    },
    async ({ approvalId, waitMs }, extra) => {
      const approvals = signer.approvals;
      if (!approvals) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "unavailable",
                  signerMode: signer.mode,
                  reason:
                    signer.mode === "keystore"
                      ? KEYSTORE_MISSING_HINT
                      : `This server is in ${signer.mode} mode; approvals exist only in DEXE_SIGNER_MODE=keystore.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const view = waitMs > 0 ? await approvals.waitView(approvalId, waitMs, extra?.signal) : approvals.view(approvalId);
      if (!view) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "not_found",
                  approvalId,
                  reason:
                    "No such approval in this server. Approvals live in memory only — a restart forgets them. " +
                    "Re-run the original call to get a new approval link.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }] };
    },
  );
}
