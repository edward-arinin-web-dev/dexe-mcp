import type { DecodedView, Prechecks, ReviewStep, RiskFlag } from "./review.js";
import type { SigningReview } from "./store.js";
import { HIDDEN_CHAR_SOURCE, markOf, segmentsToText } from "./signing.js";
import { describeSafeTxRefund, safeTxRefundFields } from "../ethersProvider.js";

/**
 * ── The review, as `dexe-mcp approve` prints it ────────────────────────────
 *
 * The same facts as the approval page (src/lib/approval/page.ts), from the
 * same server-built review: chain, signer, fingerprint, each call decoded with
 * its labels and risk flags, the exact message, the verified Safe. Text that
 * came from the chain or a backend was already sanitized when the review was
 * built; every line is passed through `tsafe` again here anyway, because a
 * terminal executes escape sequences and a review must never be able to
 * rewrite the screen it is shown on.
 */

/** The shape `ApprovalManager.reviewOf()` sends over the channel. */
export interface TerminalReview {
  approvalId: string;
  kind: "tx-batch" | "message" | "safeTx";
  tool: string;
  chainId: number;
  chain: string;
  mainnet: boolean;
  from: string;
  fingerprint: string;
  binding: string;
  createdAt: string;
  expiresAt: string;
  failures: number;
  steps: ReviewStep[];
  prechecks: Prechecks;
  signing?: SigningReview;
  resumeNote?: Array<{ label: string; txHash: string }>;
}

// The SAME set the page marks (signing.ts HIDDEN_CHAR_SOURCE): controls but
// the newline, every Unicode format character (bidi incl. U+061C, zero-width,
// BOM, tags…), separators, non-ASCII spaces and blank-looking letters.
const TERMINAL_UNSAFE = new RegExp(HIDDEN_CHAR_SOURCE, "gu");

/** Make a string safe to print: no escape sequences, no bidi reordering, nothing invisible; newlines kept. */
export function tsafe(s: unknown): string {
  return String(s).replace(TERMINAL_UNSAFE, (c) => `⟨${markOf(c)}⟩`);
}

function oneLine(s: unknown): string {
  return tsafe(String(s).replace(/\n/g, "⏎"));
}

const LEVEL = { danger: "!! DANGER", warn: " ! warn  ", info: " · note  " } as const;

function risks(list: readonly RiskFlag[], indent: string): string[] {
  const order = { danger: 0, warn: 1, info: 2 } as const;
  return [...list].sort((a, b) => order[a.level] - order[b.level]).map((r) => `${indent}${LEVEL[r.level]} ${oneLine(r.text)}`);
}

function decoded(d: DecodedView, indent: string): string[] {
  const out = [`${indent}${oneLine(`${d.contract ? `${d.contract}.` : ""}${d.signature}`)}`];
  for (const a of d.args) out.push(`${indent}    ${oneLine(a.name)} = ${oneLine(a.value)}`);
  if (d.nested.length) {
    out.push(`${indent}    contains ${d.nested.length} inner call(s):`);
    for (const n of d.nested) out.push(...decoded(n, `${indent}      `));
  }
  return out;
}

function step(s: ReviewStep, title: string): string[] {
  const out = [`  ${title}`];
  out.push(`    to        ${oneLine(s.to)}  (${oneLine(s.toLabel)})`);
  out.push(`    value     ${oneLine(s.valueHuman)}`);
  if (s.decoded) {
    const [first, ...rest] = decoded(s.decoded, "");
    out.push(`    call      ${first}`);
    for (const l of rest) out.push(`              ${l}`);
  } else {
    out.push(`    call      NOT DECODABLE — ${oneLine(s.dataPreview)}`);
  }
  out.push(`    calldata  ${s.dataBytes} bytes · keccak ${oneLine(s.dataHash)}`);
  if (s.builderNote) out.push(`    tool's note (written by the calling tool, not verified): ${oneLine(s.builderNote)}`);
  out.push(...risks(s.risks, "    "));
  return out;
}

const HEADINGS = { "tx-batch": "Approve transaction(s)", message: "Sign a message", safeTx: "Sign a Safe transaction" } as const;

/** The whole review as lines of text. */
export function renderTerminalReview(r: TerminalReview): string[] {
  const rule = "─".repeat(72);
  const out: string[] = [rule];
  out.push(`${HEADINGS[r.kind] ?? "Approval"} — ${oneLine(r.approvalId)}   [${r.kind === "message" ? "message" : r.mainnet ? "MAINNET — real funds" : "testnet"}]`);
  out.push(`  requested by  ${oneLine(r.tool)}`);
  out.push(
    r.kind === "message"
      ? `  network       none in the signature (for an account on ${oneLine(r.chain)})`
      : `  network       ${oneLine(r.chain)}`,
  );
  out.push(`  ${r.kind === "tx-batch" ? "from    " : "signer  "}      ${oneLine(r.from)}`);
  out.push(`  fingerprint   ${oneLine(r.fingerprint)}   ← must match the code in your chat; if not, decline`);
  out.push(`  expires       ${oneLine(r.expiresAt)}`);
  if (r.failures > 0) out.push(`  wrong passwords so far on this approval: ${r.failures}`);
  if (r.resumeNote?.length) {
    out.push("  Earlier in this flow (already on-chain, NOT part of this approval):");
    for (const l of r.resumeNote) out.push(`    ${oneLine(l.label)} — ${oneLine(l.txHash)}`);
  }
  out.push("");

  if (r.signing?.kind === "message") {
    const m = r.signing.message;
    out.push(`  For: ${oneLine(m.purpose)}  (stated by the server)`);
    out.push(
      `  Message — ${m.byteLength} bytes, ${m.encoding === "utf8" ? "UTF-8 text, shown in full between the lines" : "binary, shown as hex"}:`,
    );
    out.push("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
    // Segments already split out every hidden character as a marker; the text
    // runs hold none (tsafe on top would mark the marker brackets themselves).
    const body = m.encoding === "utf8" && m.segments ? segmentsToText(m.segments) : tsafe(m.hex);
    for (const line of body.split("\n")) out.push(`  ${line}`);
    out.push("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
    out.push("  (⟨U+…⟩ / ⟨CR⟩ / ⟨TAB⟩ mark characters that could hide or reorder text.)");
    out.push(`  EIP-191 hash  ${oneLine(m.eip191Hash)}`);
    out.push(...risks(m.risks, "  "));
    out.push("   · note   A message signature sends nothing on-chain, but whoever receives it can present it as you.");
  } else if (r.signing?.kind === "safeTx") {
    const s = r.signing.safe;
    out.push(`  Safe          ${oneLine(s.safe)}  (${s.singletonLabel ? oneLine(s.singletonLabel) : "IMPLEMENTATION NOT RECOGNISED"}, version ${oneLine(s.version)})`);
    out.push(`  owners        threshold ${oneLine(s.threshold)} of ${s.ownerCount} · you are an owner (checked on-chain)`);
    out.push(`  operation     ${s.operation === 1 ? "DELEGATECALL (1)" : "CALL (0)"}`);
    out.push(`  nonce         ${oneLine(s.nonce)} (the Safe's next nonce is ${oneLine(s.currentNonce)})`);
    // Every signed gas field, always — a refund hides in baseGas × gasPrice.
    out.push(`  gas fields    safeTxGas ${oneLine(s.safeTxGas)} · baseGas ${oneLine(s.baseGas)} · gasPrice ${oneLine(s.gasPrice)}`);
    out.push(`                gasToken ${oneLine(s.gasToken)} · refundReceiver ${oneLine(s.refundReceiver)}`);
    out.push(
      safeTxRefundFields(s).length
        ? `!! DANGER     ${oneLine(describeSafeTxRefund(s) ?? `non-zero refund fields: ${safeTxRefundFields(s).join(", ")}`)}`
        : "                no gas refund: the Safe pays nothing to whoever executes it",
    );
    out.push(`  safeTxHash    ${oneLine(s.safeTxHash ?? "")}  (EIP-712, chain ${r.chainId}, verifyingContract = the Safe)`);
    if (s.multiSend?.length) {
      out.push(`  MultiSend sub-calls (${s.multiSend.length}, in order):`);
      s.multiSend.forEach((c, k) => {
        const call = c.decoded ? oneLine(`${c.decoded.contract ? `${c.decoded.contract}.` : ""}${c.decoded.signature}`) : c.selector ?? "(no calldata)";
        out.push(`    ${k + 1}. ${c.operation === 1 ? "DELEGATECALL" : "CALL"} ${oneLine(c.to)} value ${oneLine(c.value)} wei — ${call}`);
      });
    }
    out.push(...risks(s.risks, "  "));
    out.push("");
    for (const st of r.steps) out.push(...step(st, "What the Safe will do"));
    out.push("   · note   This signs only; nothing is sent on-chain now. Once the threshold is met, anyone can execute it.");
  } else {
    const sim =
      r.prechecks.simulation === "pass"
        ? "transaction 1 simulated OK"
        : r.prechecks.simulation === "unavailable"
          ? "simulation unavailable (RPC) — retried at send time"
          : "not simulated";
    out.push(`  checks        allowlist / value cap / wrong-chain / denylist passed · ${sim}`);
    if (r.prechecks.simulationNote) out.push(`                ${oneLine(r.prechecks.simulationNote)}`);
    out.push("");
    r.steps.forEach((s, k) => {
      out.push(...step(s, `Transaction ${k + 1} of ${r.steps.length}`));
      out.push("");
    });
  }
  out.push(rule);
  return out;
}
