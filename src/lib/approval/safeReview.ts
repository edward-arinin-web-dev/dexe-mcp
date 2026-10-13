import { getAddress, Interface, formatUnits, type JsonRpcProvider } from "ethers";
import type { DexeConfig } from "../../config.js";
import { RpcProvider } from "@dexe-network/dexe-mcp/core";
import { computeSafeTxHash, describeSafeTxRefund, SAFE_OPERATION, safeTxRefundFields, type SafeTx } from "../ethersProvider.js";
import { buildReview, chainLabel, type DecodedView, type Prechecks, type ReviewStep, type RiskFlag } from "./review.js";

/**
 * ── What the owner is shown before signing a Safe transaction ──────────────
 *
 * A SafeTx signature is the transaction, once enough owners sign. So before
 * one is put up for approval this module checks, from the chain:
 *
 *   - the address holds code and answers like a Safe (nonce, threshold,
 *     owners), version 1.3.0 or later (older Safes sign a domain without a
 *     chain id, which this server never produces);
 *   - the keystore address IS an owner (a non-owner's signature is useless,
 *     so it is not requested at all);
 *   - which singleton the proxy points at (slot 0): a canonical Safe 1.3.0 /
 *     1.4.1 deployment is labelled, anything else is DANGER;
 *   - the nonce against the Safe's current one;
 *
 * and decodes what the Safe will do — the inner call with the same decoder,
 * labels, handover checks and broadcast guards as a transaction, a MultiSend
 * unpacked into its sub-calls, Safe self-administration (owners, threshold,
 * modules, guard) by name, DELEGATECALL as DANGER, a gas refund as a warning.
 */

/** Canonical Safe singletons (deterministic deployments, same address on every chain). */
const KNOWN_SINGLETONS: Record<string, string> = {
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552": "Safe 1.3.0 (canonical)",
  "0x3e5c63644e683549055b9be8653de26e0b4cd36e": "Safe 1.3.0 L2 (canonical)",
  "0x69f4d1788e39c87893c980c06edf4b7f686e2938": "Safe 1.3.0 (canonical, EIP-155 deployment)",
  "0xfb1bffc9d739b8d520daf37df666da4c687191ea": "Safe 1.3.0 L2 (canonical, EIP-155 deployment)",
  "0x41675c099f32341bf84bfc5382af534df5c7461a": "Safe 1.4.1 (canonical)",
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762": "Safe 1.4.1 L2 (canonical)",
};

/**
 * Canonical MultiSend / MultiSendCallOnly deployments.
 *
 * NOTE for whoever adds MultiSend 1.5.0: from 1.5.0 a sub-call with
 * `to = address(0)` means "call the Safe itself" (MultiSend substitutes
 * `address(this)` under DELEGATECALL). unpackMultiSend() must then map
 * to = 0 to the Safe, so the self-call check below sees it.
 */
const KNOWN_MULTISEND: Record<string, string> = {
  "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761": "Safe MultiSend 1.3.0 (canonical)",
  "0x40a2accbd92bca938b02010e17a5b8929b49130d": "Safe MultiSendCallOnly 1.3.0 (canonical)",
  "0x998739bfdaadde7c933b942a68053933098f9eda": "Safe MultiSend 1.3.0 (canonical, EIP-155 deployment)",
  "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b": "Safe MultiSendCallOnly 1.3.0 (canonical, EIP-155 deployment)",
  "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526": "Safe MultiSend 1.4.1 (canonical)",
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2": "Safe MultiSendCallOnly 1.4.1 (canonical)",
};

const SAFE_READ = new Interface([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
]);

/**
 * Safe functions that matter wherever they are called — on THIS Safe, on
 * another Safe, or through a library under DELEGATECALL:
 *
 *   admin    rewrites who controls a Safe (owners, threshold, modules, guard,
 *            fallback handler)
 *   approve  approveHash / execTransaction: this Safe approves or executes a
 *            transaction of ANOTHER Safe it owns — a nested signature
 *   message  SignMessageLib.signMessage / a fallback handler's message
 *            signing: the Safe signs an EIP-1271 message, which can be a
 *            permit or an off-chain order
 */
const SAFE_ABI = new Interface([
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setModuleGuard(address moduleGuard)",
  "function setFallbackHandler(address handler)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "function signMessage(bytes _data)",
]);
const SAFE_ADMIN_FNS = new Set([
  "addOwnerWithThreshold",
  "removeOwner",
  "swapOwner",
  "changeThreshold",
  "enableModule",
  "disableModule",
  "setGuard",
  "setModuleGuard",
  "setFallbackHandler",
]);

/** A Safe-function call in `data`, named, with what it means where it goes; null when it is none of them. */
export function safeCallRisk(
  data: string,
  target: string,
  safe: string,
  operation: number,
): { call: string; risk: string; nestedRefund?: string[] } | null {
  let p;
  try {
    p = SAFE_ABI.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!p) return null;
  const args = p.args.map((a) => {
    const s = String(a);
    return s.length > 74 ? `${s.slice(0, 66)}…` : s;
  });
  const call = `${p.name}(${args.join(", ")})`;
  const self = getAddress(target) === getAddress(safe);
  const where = self ? "this Safe" : `${target}`;
  if (p.name === "signMessage") {
    return {
      call,
      risk:
        `${operation === 1 ? "DELEGATECALL" : "call"} ${call} via ${target}: the Safe SIGNS A MESSAGE (EIP-1271). A ` +
        "Safe-signed message can authorize a permit or an off-chain order — this page cannot show what it is for.",
    };
  }
  if (p.name === "approveHash" || p.name === "execTransaction") {
    // A nested execTransaction carries its own refund fields — the same drain
    // as a refund on the outer SafeTx (paid by the OTHER Safe to its executor).
    const nestedRefund =
      p.name === "execTransaction"
        ? safeTxRefundFields({ baseGas: p.args[5], gasPrice: p.args[6], gasToken: p.args[7], refundReceiver: p.args[8] })
        : [];
    return {
      ...(nestedRefund.length ? { nestedRefund } : {}),
      call,
      risk: self
        ? `${call} on this Safe itself — it approves or executes another transaction of this Safe.`
        : `${call} on ${target}: this Safe ${p.name === "approveHash" ? "approves a transaction hash of" : "executes a transaction on"} ` +
          "ANOTHER Safe (a nested owner signature) — what that transaction does is not shown here.",
    };
  }
  if (SAFE_ADMIN_FNS.has(p.name)) {
    return {
      call,
      risk: self
        ? `Calls the Safe itself: ${call} — this can change its owners, threshold, modules or guard.`
        : `${call} on ${where}: changes the owners / threshold / modules of that contract (another Safe?).`,
    };
  }
  return null;
}

const MULTISEND = new Interface(["function multiSend(bytes transactions)"]);
const MULTISEND_SEL = MULTISEND.getFunction("multiSend")!.selector;

export interface SafeReview {
  safe: string;
  version: string;
  singleton: string | null;
  singletonLabel: string | null;
  threshold: string;
  ownerCount: number;
  nonce: string;
  currentNonce: string;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  /** EIP-712 digest — set by the approval manager from the typed data it will sign. */
  safeTxHash?: string;
  /** The Safe's own getTransactionHash() for these fields (the manager requires it to equal the digest). */
  onChainSafeTxHash?: string;
  /** MultiSend sub-calls, when the inner call is one. */
  multiSend?: Array<{ operation: 0 | 1; to: string; value: string; dataBytes: number; decoded: DecodedView | null; selector: string | null }>;
  risks: RiskFlag[];
}

export type SafeReviewResult =
  | { ok: true; safe: SafeReview; steps: ReviewStep[]; prechecks: Prechecks }
  | { ok: false; reason: string; guard?: string };

type SafeProvider = Pick<JsonRpcProvider, "getCode" | "call" | "getStorage">;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Unpack MultiSend's packed `transactions`: operation(1) to(20) value(32) len(32) data(len), repeated. */
export function unpackMultiSend(
  packedHex: string,
): Array<{ operation: number; to: string; value: bigint; data: string }> | null {
  const hex = packedHex.startsWith("0x") ? packedHex.slice(2) : packedHex;
  const out: Array<{ operation: number; to: string; value: bigint; data: string }> = [];
  let i = 0;
  while (i < hex.length) {
    if (hex.length - i < 2 * (1 + 20 + 32 + 32)) return null;
    const operation = parseInt(hex.slice(i, i + 2), 16);
    const to = getAddress(`0x${hex.slice(i + 2, i + 42)}`);
    const value = BigInt(`0x${hex.slice(i + 42, i + 106)}`);
    const len = Number(BigInt(`0x${hex.slice(i + 106, i + 170)}`));
    const start = i + 170;
    if (len > (hex.length - start) / 2) return null;
    out.push({ operation, to, value, data: `0x${hex.slice(start, start + len * 2)}` });
    i = start + len * 2;
    if (out.length > 64) return null;
  }
  return out;
}

function nestedRefundReason(call: string, fields: readonly string[], where: string): string {
  return (
    `Refused: ${where}${call.split("(")[0]} on another Safe pays a gas refund of its own (${fields.join(", ")}) — ` +
    "that Safe would pay its executor on execution. In keystore mode no refund is ever signed, nested ones " +
    "included. Nothing was put up for approval."
  );
}

export interface SafeReviewContext {
  chainId: number;
  /** The keystore address that will sign. */
  from: string;
  safe: string;
  tx: SafeTx;
  config: DexeConfig;
  provider?: SafeProvider;
  /** buildReview's provider for the inner call (tests inject one; default from config). */
  innerProvider?: Pick<JsonRpcProvider, "getCode" | "call">;
}

/** Verify the Safe on-chain and build the review. Never signs; refuses with a reason instead of guessing. */
export async function buildSafeTxReview(ctx: SafeReviewContext): Promise<SafeReviewResult> {
  const safe = getAddress(ctx.safe);
  const from = getAddress(ctx.from);
  let provider: SafeProvider | undefined = ctx.provider;
  if (!provider) {
    try {
      provider = new RpcProvider(ctx.config).requireProvider(ctx.chainId) as unknown as SafeProvider;
    } catch {
      provider = undefined;
    }
  }
  if (!provider) {
    return { ok: false, reason: `No RPC for ${chainLabel(ctx.chainId)} — the Safe cannot be verified, so nothing is put up for signing.` };
  }
  const call = async (data: string): Promise<string | undefined> => {
    const r = await withTimeout(provider!.call({ to: safe, data }), 8000);
    return r && r !== "0x" ? r : undefined;
  };
  const code = await withTimeout(provider.getCode(safe), 8000);
  if (code === undefined) {
    return { ok: false, reason: `Could not read ${safe} on ${chainLabel(ctx.chainId)} (RPC) — nothing was put up for signing.` };
  }
  if (/^0x0*$/i.test(code)) {
    return { ok: false, reason: `${safe} has no contract code on ${chainLabel(ctx.chainId)} — it is not a Safe there. Nothing was signed.` };
  }
  const read = async <T>(fn: string): Promise<T | undefined> => {
    const r = await call(SAFE_READ.encodeFunctionData(fn));
    if (!r) return undefined;
    try {
      return SAFE_READ.decodeFunctionResult(fn, r)[0] as T;
    } catch {
      return undefined;
    }
  };
  const [nonce, threshold, owners, version] = await Promise.all([
    read<bigint>("nonce"),
    read<bigint>("getThreshold"),
    read<string[]>("getOwners"),
    read<string>("VERSION"),
  ]);
  if (nonce === undefined || threshold === undefined || owners === undefined) {
    return {
      ok: false,
      reason: `${safe} does not answer like a Safe (nonce / getThreshold / getOwners) on ${chainLabel(ctx.chainId)}. Nothing was signed.`,
    };
  }
  const ownerList = [...owners].map((o) => getAddress(o));
  if (!ownerList.includes(from)) {
    return {
      ok: false,
      reason:
        `The keystore address ${from} is not an owner of the Safe ${safe} (${ownerList.length} owner(s), threshold ` +
        `${threshold}). Its signature would be worthless, so none is requested.`,
    };
  }
  const v = String(version ?? "unknown");
  const m = /^(\d+)\.(\d+)\./.exec(v);
  if (m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 3))) {
    return {
      ok: false,
      reason: `Safe ${safe} is version ${v}. Safes before 1.3.0 sign a domain without a chain id; this server only signs for 1.3.0+.`,
    };
  }

  // The Safe must hash these fields to the same safeTxHash this server will
  // sign — proof that the page describes the transaction the Safe will run.
  const localHash = computeSafeTxHash(ctx.chainId, safe, ctx.tx);
  const onChainRaw = await call(
    SAFE_READ.encodeFunctionData("getTransactionHash", [
      ctx.tx.to,
      ctx.tx.value,
      ctx.tx.data,
      ctx.tx.operation,
      ctx.tx.safeTxGas,
      ctx.tx.baseGas,
      ctx.tx.gasPrice,
      ctx.tx.gasToken,
      ctx.tx.refundReceiver,
      ctx.tx.nonce,
    ]),
  );
  let onChainSafeTxHash: string | undefined;
  try {
    onChainSafeTxHash = onChainRaw ? String(SAFE_READ.decodeFunctionResult("getTransactionHash", onChainRaw)[0]) : undefined;
  } catch {
    onChainSafeTxHash = undefined;
  }
  if (!onChainSafeTxHash) {
    return {
      ok: false,
      reason: `Could not read the Safe's own getTransactionHash() for this SafeTx on ${chainLabel(ctx.chainId)} — nothing was put up for signing.`,
    };
  }
  if (onChainSafeTxHash.toLowerCase() !== localHash.toLowerCase()) {
    return {
      ok: false,
      reason:
        `The Safe hashes this transaction to ${onChainSafeTxHash}, but this server computes ${localHash}. The signature ` +
        "would not be for what the Safe executes — nothing was put up for signing.",
    };
  }

  const risks: RiskFlag[] = [];
  if (!m) risks.push({ level: "warn", text: `The Safe reports version "${v}" — not a version this server recognises.` });

  let singleton: string | null = null;
  const slot0 = await withTimeout(provider.getStorage(safe, 0), 8000);
  if (slot0 && /^0x[0-9a-fA-F]{64}$/.test(slot0)) singleton = getAddress(`0x${slot0.slice(-40)}`);
  const singletonLabel = singleton ? (KNOWN_SINGLETONS[singleton.toLowerCase()] ?? null) : null;
  if (!singletonLabel) {
    risks.push({
      level: "danger",
      text: singleton
        ? `This Safe's singleton (implementation) ${singleton} is not a canonical Safe 1.3.0 / 1.4.1 deployment known to ` +
          "this server. A contract can answer like a Safe without being one — verify it before you sign."
        : "The Safe's implementation (storage slot 0) could not be read, so it could not be checked against the canonical Safe deployments.",
    });
  }

  const txNonce = BigInt(ctx.tx.nonce);
  if (txNonce < nonce) {
    risks.push({
      level: "warn",
      text: `Nonce ${txNonce} is already used (the Safe is at ${nonce}): this signature can never execute.`,
    });
  } else if (txNonce > nonce) {
    risks.push({
      level: "warn",
      text: `Nonce ${txNonce} is ahead of the Safe's next nonce ${nonce}: ${txNonce - nonce} other transaction(s) must execute first.`,
    });
  }
  if (threshold <= 1n) {
    risks.push({
      level: "warn",
      text: "The threshold is 1: your signature alone is enough — once queued, anyone can execute this transaction.",
    });
  } else {
    risks.push({ level: "info", text: `Threshold ${threshold} of ${ownerList.length}: your signature is one of the ${threshold} needed.` });
  }

  const operation = (ctx.tx.operation === SAFE_OPERATION.DELEGATECALL ? 1 : 0) as 0 | 1;
  if (operation === 1) {
    risks.push({
      level: "danger",
      text:
        `DELEGATECALL: the Safe runs the code at ${ctx.tx.to} inside its OWN storage. A wrong or hostile target can ` +
        "rewrite the owners, the threshold and the implementation and take the Safe for good.",
    });
  }
  // Any gasPrice > 0 pays — with gasToken and refundReceiver zero, in the
  // native coin to whoever executes it. (Keystore signing refuses every
  // non-zero refund field anyway; the review still says what it would pay.)
  const refund = describeSafeTxRefund(ctx.tx);
  if (refund) risks.push({ level: "danger", text: `${refund} The value cap does not see it.` });

  // ---- the inner call: same guards, decode and labels as a transaction ------
  const inner = await buildReview([{ to: ctx.tx.to, data: ctx.tx.data, value: ctx.tx.value }], {
    chainId: ctx.chainId,
    from: safe,
    config: ctx.config,
    simulateFirst: false,
    ...(ctx.innerProvider ? { provider: ctx.innerProvider } : {}),
  });
  if (!inner.ok) return { ok: false, guard: inner.guard, reason: inner.reason };
  const step = inner.steps[0]!;
  const to = getAddress(ctx.tx.to);

  // Safe functions are decoded on ANY target: on this Safe (owners /
  // threshold), on another Safe (approveHash / execTransaction — a nested
  // signature) or through a message-signing library (EIP-1271 signMessage).
  const sc = safeCallRisk(ctx.tx.data, to, safe, operation);
  // This review exists for keystore signing only, where refunds are refused —
  // nested ones too.
  if (sc?.nestedRefund) {
    return { ok: false, reason: nestedRefundReason(sc.call, sc.nestedRefund, "") };
  }
  if (sc) {
    risks.push({ level: "danger", text: sc.risk });
    step.decoded = { signature: sc.call, contract: to === safe ? "Safe" : null, args: [], nested: [] };
    step.risks = step.risks.filter((r) => !/could not be decoded/.test(r.text));
  } else if (to === safe) {
    risks.push({ level: "danger", text: "Calls the Safe itself — this can change its owners, threshold, modules or guard." });
  }
  if (to === safe) step.toLabel = "this Safe";

  const msLabel = KNOWN_MULTISEND[to.toLowerCase()];
  if (msLabel) step.toLabel = msLabel;
  let multiSend: SafeReview["multiSend"];
  if (ctx.tx.data.slice(0, 10).toLowerCase() === MULTISEND_SEL) {
    let subs: ReturnType<typeof unpackMultiSend> = null;
    try {
      subs = unpackMultiSend(String(MULTISEND.decodeFunctionData("multiSend", ctx.tx.data)[0]));
    } catch {
      subs = null;
    }
    if (!subs) {
      risks.push({ level: "danger", text: "The MultiSend payload could not be unpacked — the sub-calls cannot be shown." });
    } else {
      if (operation === 0) {
        risks.push({ level: "warn", text: "multiSend called with a plain CALL: the sub-calls would run as the MultiSend contract, not as the Safe." });
      }
      if (!msLabel) {
        risks.push({ level: "danger", text: `${to} is not a canonical Safe MultiSend deployment known to this server.` });
      }
      // The same hard guards (B6 / B7 / B11 / B12) as a top-level call: a
      // signature is never produced for a sub-call this server would refuse.
      const subReview = await buildReview(
        subs.map((s) => ({ to: s.to, data: s.data, value: s.value.toString() })),
        { chainId: ctx.chainId, from: safe, config: ctx.config, simulateFirst: false, ...(ctx.innerProvider ? { provider: ctx.innerProvider } : {}) },
      ).catch(() => null);
      if (subReview && !subReview.ok) {
        return { ok: false, guard: subReview.guard, reason: `MultiSend call ${subReview.stepIndex + 1}: ${subReview.reason}` };
      }
      multiSend = subs.map((s, k) => {
        const sr = subReview && subReview.ok ? subReview.steps[k] : undefined;
        return {
          operation: (s.operation === 1 ? 1 : 0) as 0 | 1,
          to: s.to,
          value: s.value.toString(),
          dataBytes: Math.max(0, (s.data.length - 2) / 2),
          decoded: sr?.decoded ?? null,
          selector: s.data.length >= 10 ? s.data.slice(0, 10).toLowerCase() : null,
        };
      });
      for (const [k, s] of subs.entries()) {
        const where = `MultiSend call ${k + 1}: `;
        if (s.operation === 1) risks.push({ level: "danger", text: `${where}DELEGATECALL to ${s.to} — runs in the Safe's own storage.` });
        if (s.operation !== 0 && s.operation !== 1) risks.push({ level: "danger", text: `${where}unknown operation ${s.operation}.` });
        const subSafe = safeCallRisk(s.data, s.to, safe, s.operation);
        if (subSafe?.nestedRefund) return { ok: false, reason: nestedRefundReason(subSafe.call, subSafe.nestedRefund, where) };
        if (subSafe) risks.push({ level: "danger", text: `${where}${subSafe.risk}` });
        else if (getAddress(s.to) === safe) {
          risks.push({ level: "danger", text: `${where}calls the Safe itself (owners / threshold / modules).` });
        }
        if (subSafe && multiSend?.[k]) multiSend[k]!.decoded = { signature: subSafe.call, contract: null, args: [], nested: [] };
        if (s.value > 0n) risks.push({ level: "warn", text: `${where}sends ${formatUnits(s.value, 18)} native coin.` });
        if (subReview?.ok) {
          for (const r of subReview.steps[k]!.risks) risks.push({ level: r.level, text: `${where}${r.text}` });
        }
      }
    }
  }

  return {
    ok: true,
    safe: {
      safe,
      version: v,
      singleton,
      singletonLabel,
      threshold: threshold.toString(),
      ownerCount: ownerList.length,
      nonce: txNonce.toString(),
      currentNonce: nonce.toString(),
      operation,
      safeTxGas: ctx.tx.safeTxGas,
      baseGas: ctx.tx.baseGas,
      gasPrice: ctx.tx.gasPrice,
      gasToken: ctx.tx.gasToken,
      refundReceiver: ctx.tx.refundReceiver,
      onChainSafeTxHash,
      ...(multiSend ? { multiSend } : {}),
      risks,
    },
    steps: [step],
    prechecks: { guards: "pass", simulation: "skipped", simulationNote: "a signature is not simulated; the Safe executes it later" },
  };
}
