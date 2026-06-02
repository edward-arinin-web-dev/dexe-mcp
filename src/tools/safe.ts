import { z } from "zod";
import { isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { SignerManager } from "../lib/signer.js";
import { RpcProvider } from "../rpc.js";
import { resolveChain } from "../config.js";
import {
  buildSafeTx,
  computeSafeTxHash,
  readSafeState,
  resolveSafeServiceEndpoint,
  safeTxDomain,
  SAFE_OPERATION,
  SAFE_TX_TYPES,
} from "../lib/ethersProvider.js";
import { assertAllowlistAndValueCap, BroadcastGuardError } from "../lib/broadcastGuards.js";

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/** Read the Safe service overrides from env (config.ts is intentionally untouched). */
function safeEnv(): { serviceUrl?: string; apiKey?: string } {
  return {
    serviceUrl: process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined,
    apiKey: process.env.DEXE_SAFE_API_KEY?.trim() || undefined,
  };
}

// ---------- register ----------

export function registerSafeTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_safe_info
  // =============================================
  server.tool(
    "dexe_safe_info",
    "Safe multisig diagnostic — reads the live on-chain Safe state (nonce, threshold, " +
      "owners, singleton version) and resolves which Safe Transaction Service endpoint " +
      "`dexe_safe_propose_tx` would POST to for this chain. Also reports whether the " +
      "configured signer (DEXE_PRIVATE_KEY) is one of the Safe owners. Read-only — never " +
      "signs, broadcasts, or POSTs.",
    {
      safe: z.string().describe("Safe Smart Account (multisig) address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
    },
    async ({ safe, chainId }) => {
      if (!isAddress(safe)) return err(`Invalid safe address: ${safe}`);
      try {
        const chain = resolveChain(ctx.config, chainId);
        const pr = rpc.tryProvider(chain.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const state = await readSafeState(provider, safe);

        const { serviceUrl, apiKey } = safeEnv();
        let endpoint: { base: string; hosted: boolean; postUrl: string } | { error: string };
        try {
          const ep = resolveSafeServiceEndpoint(chain.chainId, serviceUrl);
          endpoint = { base: ep.base, hosted: ep.hosted, postUrl: ep.multisigTransactions(state.safe) };
        } catch (e) {
          endpoint = { error: e instanceof Error ? e.message : String(e) };
        }

        const signerAddr = signer.hasSigner() ? getAddress(signer.getAddress()) : null;
        const signerIsOwner =
          signerAddr !== null &&
          state.owners.some((o) => o.toLowerCase() === signerAddr.toLowerCase());

        return ok({
          chainId: chain.chainId,
          safe: state.safe,
          version: state.version,
          nonce: state.nonce,
          threshold: state.threshold,
          ownerCount: state.owners.length,
          owners: state.owners,
          signer: signerAddr,
          signerIsOwner,
          service: {
            ...endpoint,
            apiKeyConfigured: !!apiKey,
            overrideConfigured: !!serviceUrl,
          },
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // =============================================
  // dexe_safe_propose_tx
  // =============================================
  server.tool(
    "dexe_safe_propose_tx",
    "Safe multisig propose — instead of broadcasting, queues a transaction in the Safe " +
      "Transaction Service for the Safe owners to co-sign and execute. Takes a TxPayload " +
      "(to/value/data) as produced by any dexe_*_build_* tool, reads the Safe's next nonce " +
      "on-chain (unless `nonce` is given), computes the EIP-712 `safeTxHash`, signs it with " +
      "DEXE_PRIVATE_KEY (which must be a Safe owner), and assembles the Safe-TX-Service " +
      "create-multisig-transaction body. " +
      "**dryRun defaults to true** — the tool returns the full signed payload and the POST " +
      "target without sending. Set dryRun=false to actually POST (requires a resolvable " +
      "service endpoint; api.safe.global needs DEXE_SAFE_API_KEY).",
    {
      safe: z.string().describe("Safe Smart Account (multisig) address"),
      to: z.string().describe("Destination contract address (TxPayload.to)"),
      data: z.string().default("0x").describe("ABI-encoded calldata, 0x-prefixed (TxPayload.data)"),
      value: z.string().default("0").describe("Wei value as decimal string (TxPayload.value)"),
      operation: z
        .number()
        .int()
        .min(0)
        .max(1)
        .default(SAFE_OPERATION.CALL)
        .describe("0 = CALL (default), 1 = DELEGATECALL"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
      nonce: z
        .string()
        .optional()
        .describe("Safe nonce. Omit to read the Safe's current nonce() on-chain."),
      safeTxGas: z.string().default("0"),
      baseGas: z.string().default("0"),
      gasPrice: z.string().default("0"),
      gasToken: z.string().optional().describe("Defaults to the zero address (pay gas in native)."),
      refundReceiver: z.string().optional().describe("Defaults to the zero address."),
      origin: z
        .string()
        .optional()
        .describe("Free-form origin tag stored alongside the queued tx (e.g. a JSON note)."),
      sender: z
        .string()
        .optional()
        .describe("Proposer address. Defaults to the signer address. Required (with a signature) for a live POST."),
      dryRun: z
        .boolean()
        .default(true)
        .describe("Default true: build + sign + return payload without POSTing. Set false to POST to the service."),
    },
    async (input) => {
      if (!isAddress(input.safe)) return err(`Invalid safe address: ${input.safe}`);
      if (!isAddress(input.to)) return err(`Invalid 'to' address: ${input.to}`);

      try {
        const chain = resolveChain(ctx.config, input.chainId);
        const chainId = chain.chainId;
        const safe = getAddress(input.safe);

        // Resolve nonce: explicit input wins, else read on-chain.
        let nonce = input.nonce;
        let nonceSource: "input" | "onchain" = "input";
        if (nonce === undefined) {
          const pr = rpc.tryProvider(chainId);
          if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
          const provider = pr.ok;
          const state = await readSafeState(provider, safe);
          nonce = state.nonce.toString();
          nonceSource = "onchain";
        }

        const tx = buildSafeTx({
          to: input.to,
          value: input.value,
          data: input.data,
          operation: input.operation,
          safeTxGas: input.safeTxGas,
          baseGas: input.baseGas,
          gasPrice: input.gasPrice,
          gasToken: input.gasToken,
          refundReceiver: input.refundReceiver,
          nonce,
        });

        // L-1: apply the destination-allowlist (B6) and value-cap (B7) guards on
        // the Safe-queue path too. Previously a Safe propose signed and queued a
        // transaction without ANY broadcast guard, giving the operator a false
        // sense of protection from DEXE_SIGNER_ALLOWLIST / DEXE_SIGNER_MAX_VALUE_WEI.
        try {
          assertAllowlistAndValueCap({ to: tx.to, value: String(tx.value) }, signer.getConfig());
        } catch (e) {
          if (e instanceof BroadcastGuardError) return err(`[${e.guard}] ${e.message}`);
          throw e;
        }

        const safeTxHash = computeSafeTxHash(chainId, safe, tx);

        // Sign with the configured owner key when present.
        let signature: string | undefined;
        let sender = input.sender ? getAddress(input.sender) : undefined;
        if (signer.hasSigner()) {
          const sg = signer.trySigner(chainId);
          if ("error" in sg) return err(`${sg.error}\n${sg.remediation}`);
          const wallet = sg.ok;
          signature = await wallet.signTypedData(safeTxDomain(chainId, safe), SAFE_TX_TYPES, tx);
          sender = sender ?? getAddress(wallet.address);
        }

        // Assemble the Safe-TX-Service create-multisig-transaction body. Field
        // names match the documented REST contract (v1/v2 share this shape);
        // `contractTransactionHash` carries the safeTxHash.
        const body: Record<string, unknown> = {
          to: tx.to,
          value: tx.value,
          data: tx.data,
          operation: tx.operation,
          safeTxGas: tx.safeTxGas,
          baseGas: tx.baseGas,
          gasPrice: tx.gasPrice,
          gasToken: tx.gasToken,
          refundReceiver: tx.refundReceiver,
          nonce: tx.nonce,
          contractTransactionHash: safeTxHash,
          sender: sender ?? null,
          signature: signature ?? null,
          origin: input.origin ?? null,
        };

        const { serviceUrl, apiKey } = safeEnv();

        // dryRun (default): emit everything, POST nothing.
        if (input.dryRun) {
          let endpoint: { base: string; hosted: boolean; postUrl: string } | { error: string };
          try {
            const ep = resolveSafeServiceEndpoint(chainId, serviceUrl);
            endpoint = { base: ep.base, hosted: ep.hosted, postUrl: ep.multisigTransactions(safe) };
          } catch (e) {
            endpoint = { error: e instanceof Error ? e.message : String(e) };
          }
          return ok({
            mode: "dryRun",
            chainId,
            safe,
            nonce,
            nonceSource,
            safeTxHash,
            signedBy: signature ? sender : null,
            signaturePresent: !!signature,
            endpoint,
            body,
          });
        }

        // Live POST path.
        if (!signature || !sender) {
          return err(
            "Live POST requires a signature. Set DEXE_PRIVATE_KEY (a Safe owner) so the tool can sign the safeTxHash, or run with dryRun=true.",
          );
        }
        const ep = resolveSafeServiceEndpoint(chainId, serviceUrl);
        const url = ep.multisigTransactions(safe);
        const headers: Record<string, string> = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        else if (ep.hosted) {
          return err(
            "api.safe.global requires an API key. Set DEXE_SAFE_API_KEY, or point DEXE_SAFE_TX_SERVICE_URL at a service that doesn't require one.",
          );
        }

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          return err(`Safe service POST failed (${res.status} ${res.statusText}): ${text}`);
        }

        return ok({
          mode: "posted",
          chainId,
          safe,
          nonce,
          safeTxHash,
          sender,
          postUrl: url,
          status: res.status,
          response: text ? safeJsonParse(text) : null,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
