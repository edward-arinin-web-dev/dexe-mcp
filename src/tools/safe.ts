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
import {
  assertAllowlistAndValueCap,
  assertNoForbiddenCalldata,
  BroadcastGuardError,
} from "../lib/broadcastGuards.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/errors.js";

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Drop `user:pass@` from a URL, keeping scheme/host/path/query.
 *
 * WHY not `maskUrl` from lib/redact: this is used on the endpoint we
 * DELIBERATELY show the operator (they asked "where would this POST go?"), and
 * `maskUrl` collapses the path to `/***`, which would hide the Safe address and
 * the API version — the whole point of showing it. Userinfo is the one part of
 * a `DEXE_SAFE_TX_SERVICE_URL` that is a credential, so that is all we strip.
 * Never throws: an unparseable override falls back to a regex strip.
 */
function stripUrlUserinfo(raw: string): string {
  try {
    const u = new URL(raw);
    // Return the original string when there is nothing to strip: URL.toString()
    // normalizes (adds a trailing slash to a bare origin), and the endpoint we
    // print should stay byte-identical to what the operator configured.
    if (!u.username && !u.password) return raw;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s@]+@/g, "$1");
  }
}

/**
 * The one sink both Safe tools' catch-alls go through.
 *
 * WHY: `DEXE_SAFE_TX_SERVICE_URL` is operator-supplied and may carry
 * credentials in the URL itself even though the API key normally rides in a
 * Bearer header. `fetch()` refuses such a URL outright with "Request cannot be
 * constructed from a URL that includes credentials: <the whole URL>", so
 * echoing the raw message publishes it into the model context and the
 * transcript. Same class as W36 (ethers appends the RPC URL to err.message).
 *
 * WHY the `Safe service POST` carve-out: that message (see postSafeTransaction)
 * already answers the only question a timed-out queue POST raises — "did it
 * land, and is re-POSTing safe?" — and the shared remedy table has no Safe
 * entry, so it would fall through to `rpc-timeout` and tell the operator to set
 * DEXE_RPC_URL_* and check dexe_tx_status. Wrong knob, wrong tool.
 */
function safeToolError(e: unknown, step: string): string {
  const raw = safeErrorMessage(e);
  if (/Safe service POST/i.test(raw)) return `${step} failed: ${raw}`;
  return toActionableError(e, step).message;
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/**
 * B13 — refuse a Safe DELEGATECALL (operation=1) unless explicitly allowed.
 *
 * Safe-queue path only, which is why it lives here and not in the shared
 * `runBroadcastGuards` sink: `BroadcastTx` has no `operation` field, and the
 * sink is used by every ordinary broadcast, for which the concept is meaningless.
 *
 * A delegatecall runs `to`'s code in the SAFE's own storage, where slot 0 is
 * the singleton pointer and the owners linked list + threshold live. B12's
 * selector scan cannot help: the target's CODE, not the leading selector,
 * decides what gets written, and B6's destination allowlist bounds where the
 * call goes, not what it does to the caller. Two keys: an operator env may
 * forbid it outright, otherwise the caller opts in per call.
 *
 * NOTE this is NOT the only way to rewrite the owner set — a plain CALL to the
 * Safe itself with `swapOwner`/`changeThreshold` calldata does it too (that is
 * the normal owner-management path). DELEGATECALL is the broader privilege
 * (arbitrary target, arbitrary slots), not a unique one.
 */
export function assertSafeOperationAllowed(
  operation: number,
  to: string,
  allowDelegateCall: boolean | undefined,
): void {
  if (operation !== SAFE_OPERATION.DELEGATECALL) return;
  const policy = (process.env.DEXE_SAFE_DELEGATECALL ?? "").trim().toLowerCase();
  if (policy === "block") {
    throw new BroadcastGuardError(
      "B13",
      "DELEGATECALL (operation=1) is disabled by DEXE_SAFE_DELEGATECALL=block. " +
        "Unset that variable (and restart Claude Code — env is read once at startup) if this Safe " +
        "genuinely needs MultiSend or module calls.",
    );
  }
  if (allowDelegateCall !== true) {
    throw new BroadcastGuardError(
      "B13",
      `Refusing to build a DELEGATECALL (operation=1). It executes the code at ${to} inside THIS ` +
        "Safe's own storage — a wrong or hostile target can rewrite the owner list, the threshold " +
        "and the singleton pointer, taking the Safe permanently. Almost every DAO/ERC-20 payload " +
        "from a dexe_*_build_* tool is a plain CALL: drop `operation` (or set it to 0). If you are " +
        "deliberately queuing a vetted MultiSend or Safe module call, verify the target yourself and " +
        "re-run with allowDelegateCall: true — note that the destination allowlist (B6) and the " +
        "GovUserKeeper denylist (B12) cannot inspect a delegatecall's effects.",
    );
  }
}

/**
 * Advisory (never a refusal — gas refunds are legitimate) for the other pair of
 * SafeTx fields no guard inspects: with `gasPrice > 0`, a non-zero `gasToken`
 * plus an arbitrary `refundReceiver` makes the Safe pay out an ERC-20 amount on
 * execution, and B7's value cap only ever sees native `value`.
 */
function gasRefundWarnings(tx: {
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
}): { warnings?: string[] } {
  const zero = "0x0000000000000000000000000000000000000000";
  const paysRefund =
    tx.gasPrice !== "0" &&
    (tx.gasToken.toLowerCase() !== zero || tx.refundReceiver.toLowerCase() !== zero);
  if (!paysRefund) return {};
  return {
    warnings: [
      `This SafeTx pays a gas refund in ${tx.gasToken} to ${tx.refundReceiver} on execution. ` +
        "The value cap (DEXE_SIGNER_MAX_VALUE_WEI) only inspects native value and does not bound this.",
    ],
  };
}

/** Read the Safe service overrides from env (config.ts is intentionally untouched). */
function safeEnv(): { serviceUrl?: string; apiKey?: string } {
  return {
    serviceUrl: process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined,
    apiKey: process.env.DEXE_SAFE_API_KEY?.trim() || undefined,
  };
}

/** Deadline for the Safe Transaction Service POST — 8s, as elsewhere. */
export const SAFE_SERVICE_TIMEOUT_MS = 8_000;

/**
 * POST the queue request under a deadline.
 *
 * Deliberately NOT retried: this is a write to the Safe service, and a timeout
 * leaves the outcome genuinely unknown — an automatic second POST would be
 * issued blind. We hand the decision back to the caller instead, with the one
 * fact that makes it decidable: `safeTxHash` is deterministic over
 * (chainId, safe, tx, nonce), so a re-POST addresses the SAME queue entry
 * rather than creating a second one.
 */
export async function postSafeTransaction(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = SAFE_SERVICE_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, text };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(
        `Safe service POST timed out after ${timeoutMs}ms — it is unknown whether the transaction was ` +
          `queued. Check the Safe UI (or the service's multisig-transactions list) before retrying. ` +
          `Re-POSTing is not a second transaction: safeTxHash is deterministic for this ` +
          `(chain, safe, nonce, payload), so the service addresses the same queue entry.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
    "Read-only. Live Safe state (nonce, threshold, owners, singleton version), the Safe Transaction " +
      "Service endpoint a propose would POST to, and whether the DEXE_PRIVATE_KEY signer is a Safe owner.",
    {
      safe: z.string().describe("Safe Smart Account (multisig) address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Chain to read the Safe on. Default: the MCP's default chain."),
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
          endpoint = {
            base: stripUrlUserinfo(ep.base),
            hosted: ep.hosted,
            postUrl: stripUrlUserinfo(ep.multisigTransactions(state.safe)),
          };
        } catch (e) {
          endpoint = { error: safeErrorMessage(e) };
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
        return err(safeToolError(e, "dexe_safe_info"));
      }
    },
  );

  // =============================================
  // dexe_safe_propose_tx
  // =============================================
  server.tool(
    "dexe_safe_propose_tx",
    "Broadcasts when a signer is configured. Queues a tx in the Safe Transaction Service for the owners " +
      "to co-sign and execute. Takes a TxPayload, reads the Safe's next nonce on-chain (unless `nonce` " +
      "is given), computes the EIP-712 `safeTxHash`. " +
      "**dryRun defaults to true and is UNSIGNED** — payload, safeTxHash and POST target only, no " +
      "signature. dryRun=false signs with DEXE_PRIVATE_KEY (which must be a Safe owner) and POSTs " +
      "(api.safe.global needs DEXE_SAFE_API_KEY); sign=true returns the signed body without POSTing. " +
      "operation=1 (DELEGATECALL) is refused unless allowDelegateCall=true.",
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
        .describe(
          "0 = CALL (default), 1 = DELEGATECALL. 1 requires allowDelegateCall:true — it runs the target's code in the Safe's own storage.",
        ),
      allowDelegateCall: z
        .boolean()
        .default(false)
        .describe(
          "Required to build operation=1 (DELEGATECALL). Off by default: DELEGATECALL runs the target's code in the Safe's own storage and can rewrite owners/threshold. Set DEXE_SAFE_DELEGATECALL=block to forbid it even with this flag.",
        ),
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
      safeTxGas: z.string().default("0").describe("SafeTx `safeTxGas`: gas units as a decimal string."),
      baseGas: z.string().default("0").describe("SafeTx `baseGas`: gas units as a decimal string."),
      gasPrice: z
        .string()
        .default("0")
        .describe(
          "SafeTx `gasPrice` in wei, decimal string. Non-zero with a gasToken/refundReceiver makes the Safe pay a refund on execution.",
        ),
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
        .describe(
          "Default true: build the payload and return it UNSIGNED with the POST target. Set false to sign + POST; set sign:true to get a signed body without POSTing.",
        ),
      sign: z
        .boolean()
        .default(false)
        .describe(
          "dryRun only: also produce the owner EIP-712 signature. Default false — a signature is queue-ready and irreversible until the Safe nonce is consumed, so a dry run does not create one. Use sign:true when you will POST the body yourself (e.g. no DEXE_SAFE_API_KEY).",
        ),
    },
    async (input) => {
      if (!isAddress(input.safe)) return err(`Invalid safe address: ${input.safe}`);
      if (!isAddress(input.to)) return err(`Invalid 'to' address: ${input.to}`);
      // Before any nonce read, any hash, any signature: a refusal must cost no
      // RPC and must produce no artifact the caller could reuse.
      try {
        assertSafeOperationAllowed(input.operation, input.to, input.allowDelegateCall);
      } catch (e) {
        if (e instanceof BroadcastGuardError) return err(`[${e.guard}] ${e.message}`);
        throw e;
      }

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
          // B12 on this path too, and UNCONDITIONALLY — never behind the
          // signing flag. This path CAN produce a signed, queue-ready body
          // (dryRun:false, or dryRun + sign:true), and even the unsigned
          // preview must not advertise calldata this server calls a hard
          // block. For the GovUserKeeper denylist that is the harm: the
          // multisig threshold still gates execution, but this server must not
          // manufacture an owner's signature on calldata it calls a hard block.
          assertNoForbiddenCalldata({
            to: tx.to,
            data: String(tx.data ?? "0x"),
            value: String(tx.value),
            chainId,
            from: "",
          });
        } catch (e) {
          if (e instanceof BroadcastGuardError) return err(`[${e.guard}] ${e.message}`);
          throw e;
        }

        const safeTxHash = computeSafeTxHash(chainId, safe, tx);

        // A signature — not the POST — is the privileged, irreversible act
        // here: it stays valid for this (chainId, safe, payload, nonce) until
        // that nonce is consumed, and anyone holding the body can POST it. So a
        // dry run does not produce one unless asked, matching the invariant the
        // rest of the codebase already holds (daoCreate.ts and flow.ts:
        // "dryRun stays side-effect-free").
        const produceSignature = !input.dryRun || input.sign === true;
        let signature: string | undefined;
        let sender = input.sender ? getAddress(input.sender) : undefined;
        let signHint: string | undefined;
        if (signer.hasSigner()) {
          if (produceSignature) {
            const sg = signer.trySigner(chainId);
            if ("error" in sg) return err(`${sg.error}\n${sg.remediation}`);
            const wallet = sg.ok;
            signature = await wallet.signTypedData(safeTxDomain(chainId, safe), SAFE_TX_TYPES, tx);
            sender = sender ?? getAddress(wallet.address);
          } else {
            // Chain-agnostic: an unsigned preview must not fail on a chain with
            // no configured RPC, and naming the proposer keeps it useful.
            sender = sender ?? getAddress(signer.getAddress());
          }
        } else if (input.sign === true) {
          signHint =
            "sign:true was requested but no signer is configured — set DEXE_PRIVATE_KEY (a Safe owner) and re-run. The payload below is unsigned.";
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
            endpoint = {
              base: stripUrlUserinfo(ep.base),
              hosted: ep.hosted,
              postUrl: stripUrlUserinfo(ep.multisigTransactions(safe)),
            };
          } catch (e) {
            endpoint = { error: safeErrorMessage(e) };
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
            note:
              signHint ??
              (signature
                ? "SIGNED: `body.signature` is a queue-ready owner signature for this (chain, safe, nonce, payload). Treat it as sensitive — anyone holding it can POST this transaction into the Safe queue."
                : "UNSIGNED preview. Check `safeTxHash` against what your wallet shows, then re-run with dryRun:false to sign + POST, or sign:true to get the signed body without POSTing."),
            ...gasRefundWarnings(tx),
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

        const res = await postSafeTransaction(url, headers, body);
        if (!res.ok) {
          return err(`Safe service POST failed (${res.status} ${res.statusText}): ${res.text}`);
        }

        return ok({
          mode: "posted",
          chainId,
          safe,
          nonce,
          safeTxHash,
          sender,
          postUrl: stripUrlUserinfo(url),
          status: res.status,
          ...gasRefundWarnings(tx),
          response: res.text ? safeJsonParse(res.text) : null,
        });
      } catch (e) {
        return err(safeToolError(e, "dexe_safe_propose_tx"));
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
