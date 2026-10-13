import {
  AbiCoder,
  getAddress,
  hashMessage,
  hexlify,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  Wallet,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { SAFE_TX_TYPES } from "../ethersProvider.js";
import { safeErrorMessage } from "../redact.js";
import { ApprovalDeviationError, type ApprovalStore, type KeyHolder } from "./store.js";
import type { RiskFlag } from "./review.js";

/**
 * ── Signature approvals: an EIP-191 message or a Safe EIP-712 SafeTx ───────
 *
 * Phase A approved transactions only. A signature is as consequential: a
 * login message hands a session to whoever receives it, and a Safe owner's
 * SafeTx signature IS the transaction once the threshold is met. Both now go
 * through the same store, page, lockout and single-use rule as a tx batch.
 *
 * What an approval is bound to (its `batchHash` field — "binding hash"):
 *
 *   message  keccak(abi.encode(TAG_MESSAGE, chainId, from, keccak(message bytes)))
 *   safeTx   keccak(abi.encode(TAG_TYPED,   chainId, from, EIP-712 digest))
 *
 * The tags keep the three kinds in separate namespaces (a tx batch hash starts
 * with the chain id; these start with a 32-byte tag), so no approval of one
 * kind can ever be matched by a request of another.
 *
 * What the owner sees is derived HERE from the bytes that will be signed:
 * the exact message text (non-printables made visible, never dropped), its
 * hex, and flags for anything that looks like a hash, a transaction, typed
 * data, a permit, an address or an amount in disguise. The calling tool may
 * add only a server-written `purpose` line.
 *
 * Typed data is signed for exactly one primary type, `SafeTx`, with the exact
 * Safe type set, a domain whose chainId is the approval's chain and whose
 * verifyingContract is the reviewed Safe. Permit-shaped data (ERC-2612 Permit,
 * Permit2 PermitSingle / PermitBatch / PermitTransferFrom…) is refused on this
 * path outright: an off-chain permit moves tokens with no transaction for the
 * owner to see.
 */

/** Longest message put up for approval — the page always shows the WHOLE message. */
export const MESSAGE_MAX_BYTES = 4096;

const TAG_MESSAGE = keccak256(toUtf8Bytes("dexe-mcp/approval/message/v1"));
const TAG_TYPED = keccak256(toUtf8Bytes("dexe-mcp/approval/typed-data/v1"));

/** The approval binding for an EIP-191 message. */
export function messageBindingHash(chainId: number, from: string, message: Uint8Array): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32"],
      [TAG_MESSAGE, BigInt(chainId), getAddress(from), keccak256(message)],
    ),
  );
}

/** The approval binding for EIP-712 typed data (its digest). */
export function typedDataBindingHash(chainId: number, from: string, digest: string): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32"],
      [TAG_TYPED, BigInt(chainId), getAddress(from), digest],
    ),
  );
}

// ---------------------------------------------------------------------------
// Message review
// ---------------------------------------------------------------------------

/** One piece of a message as displayed: literal text, or a visible marker for a character that hides or reorders text. */
export type MessageSegment = { t: "text"; v: string } | { t: "mark"; v: string };

export interface MessageReview {
  /** Server-written: what the signature is for. Never model text. */
  purpose: string;
  byteLength: number;
  encoding: "utf8" | "binary";
  /** utf8 only: the exact text, split so invisible / control characters render as markers. */
  segments?: MessageSegment[];
  /** The whole message as hex (≤ MESSAGE_MAX_BYTES bytes). */
  hex: string;
  /** EIP-191 hash — what the key actually signs. */
  eip191Hash: string;
  risks: RiskFlag[];
}

/**
 * Characters that hide, fake or reorder text: C0/C1 controls (newline is the
 * one exception — it renders as a line break), DEL, no-break and other
 * look-alike spaces, soft hyphen, zero-width and joiner characters, bidi
 * marks / embeddings / overrides / isolates, line/paragraph separators,
 * variation selectors, the BOM, the Hangul fillers and the Unicode tag block.
 * The marker brackets themselves (⟨ ⟩) are included so a message cannot fake a
 * marker by spelling one.
 */
const HIDDEN_CLASS =
  "[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u00A0\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F" +
  "\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u206F\\u27E8\\u27E9\\u3000\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB" +
  "\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]";
const HIDDEN_RE = new RegExp(HIDDEN_CLASS, "gu");
/** Non-global twin for single-character tests (a /g regex's .test() is stateful). */
const HIDDEN_ONE = new RegExp(`^${HIDDEN_CLASS}$`, "u");

function markOf(ch: string): string {
  if (ch === "\r") return "CR";
  if (ch === "\t") return "TAB";
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Strict UTF-8 decode, BOM kept (it is made visible, not swallowed). Null when the bytes are not valid UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Split text into literal runs and visible markers. */
export function segmentsOf(text: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(HIDDEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: "text", v: text.slice(last, i) });
    out.push({ t: "mark", v: markOf(m[0]) });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** Segments as one plain string (`⟨U+202E⟩` markers), e.g. for a terminal. */
export function segmentsToText(segments: readonly MessageSegment[]): string {
  return segments.map((s) => (s.t === "text" ? s.v : `⟨${s.v}⟩`)).join("");
}

const APPROVAL_WORDS = /\b(permit2?|allowance|spender|approve|approval|setApprovalForAll|transferFrom|transfer|withdraw)\b/i;
const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const AMOUNT_RE =
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:t?BNB|ETH|USDT|USDC|BUSD|DEXE|wei|gwei|ether|tokens?)\b|(?<![0-9a-fA-Fx])\d{7,}(?![0-9a-fA-F])/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Everything the owner is told about a message, from its bytes alone.
 * `purpose` is the calling tool's server-written description of what the
 * signature is for (e.g. "Log in to the DeXe backend at https://api.dexe.io").
 */
export function reviewMessage(bytes: Uint8Array, ctx: { from: string; purpose: string }): MessageReview {
  const risks: RiskFlag[] = [];
  const text = decodeUtf8Strict(bytes);
  const hex = hexlify(bytes);
  const review: MessageReview = {
    purpose: ctx.purpose,
    byteLength: bytes.length,
    encoding: text === null ? "binary" : "utf8",
    hex,
    eip191Hash: hashMessage(bytes),
    risks,
  };

  if (text === null) {
    // (A readable 32-byte TEXT is just a short message; 32 raw bytes is a hash.)
    if (bytes.length === 32) {
      risks.push({
        level: "danger",
        text:
          "The message is exactly 32 bytes — the size of a transaction or typed-data hash. Signing a hash you cannot " +
          "read can authorize something you never see. Decline unless you know exactly what it is.",
      });
    }
    risks.push({
      level: "danger",
      text:
        `Not text: ${bytes.length} bytes of binary data (shown as hex). A signature over raw bytes can be a ` +
        "transaction, permit or typed-data hash in disguise.",
    });
    const first = bytes[0];
    if (first !== undefined && (first <= 0x04 || first >= 0xc0)) {
      risks.push({ level: "danger", text: "The bytes start like an encoded transaction or RLP list." });
    }
    return review;
  }

  review.segments = segmentsOf(text);
  const hidden = review.segments.filter((s) => s.t === "mark");
  const hiddenNonLayout = hidden.filter((s) => s.v !== "CR" && s.v !== "TAB");
  if (hiddenNonLayout.length > 0) {
    const kinds = [...new Set(hiddenNonLayout.map((s) => s.v))].slice(0, 8).join(", ");
    risks.push({
      level: "danger",
      text:
        `Contains ${hiddenNonLayout.length} invisible, control or direction-changing character(s) (${kinds}), shown ` +
        "as ⟨U+…⟩. They can hide or reorder what you read. Decline unless you expected them.",
    });
  } else if (hidden.length > 0) {
    risks.push({ level: "info", text: "Contains carriage returns / tabs, shown as ⟨CR⟩ / ⟨TAB⟩." });
  }

  const nonAscii = [...new Set([...text].filter((c) => (c.codePointAt(0) ?? 0) > 0x7e && !HIDDEN_ONE.test(c)))];
  if (nonAscii.length > 0) {
    const sample = nonAscii
      .slice(0, 8)
      .map((c) => `${c} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(", ");
    risks.push({
      level: "warn",
      text: `Contains non-ASCII characters (${sample}${nonAscii.length > 8 ? ", …" : ""}) — look-alike letters are possible.`,
    });
  }

  const trimmed = text.trim();
  if (/^0x[0-9a-fA-F]*$/.test(trimmed) && trimmed.length > 2) {
    risks.push({
      level: "danger",
      text: `The text is hex data (${(trimmed.length - 2) / 2} bytes), not readable words.${
        trimmed.length === 66 ? " 32 bytes is the size of a transaction / typed-data hash." : ""
      }`,
    });
  }
  if (/^[{[]/.test(trimmed)) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      if (j && typeof j === "object" && ("types" in j || "primaryType" in j || "domain" in j)) {
        risks.push({
          level: "danger",
          text:
            "This looks like EIP-712 typed data sent as a plain message. A wallet normally shows typed data as " +
            "structured fields; as a message it can carry a permit or an order you would not recognise.",
        });
      }
    } catch {
      /* not JSON */
    }
  }
  if (APPROVAL_WORDS.test(text)) {
    risks.push({
      level: "warn",
      text: "Mentions token approvals, permits or transfers. A login or a vote never needs them — read it carefully.",
    });
  }
  const addrs = [...new Set(text.match(ADDRESS_RE) ?? [])];
  for (const a of addrs.slice(0, 6)) {
    let mine = false;
    try {
      mine = getAddress(a) === getAddress(ctx.from);
    } catch {
      mine = false;
    }
    risks.push(
      mine
        ? { level: "info", text: `Mentions your own address ${a}.` }
        : { level: "warn", text: `Mentions the address ${a} — make sure you know who that is.` },
    );
  }
  if (addrs.length > 6) risks.push({ level: "warn", text: `Mentions ${addrs.length - 6} more address(es).` });
  const amounts = [...new Set(text.match(AMOUNT_RE) ?? [])];
  if (amounts.length > 0) {
    risks.push({ level: "warn", text: `Mentions amounts or large numbers: ${amounts.slice(0, 4).join(", ")}${amounts.length > 4 ? ", …" : ""}.` });
  }
  const urls = [...new Set(text.match(URL_RE) ?? [])];
  if (urls.length > 0) {
    risks.push({ level: "info", text: `Mentions ${urls.length === 1 ? "a link" : "links"}: ${urls.slice(0, 3).join(" ")}` });
  }
  return review;
}

// ---------------------------------------------------------------------------
// Typed data policy
// ---------------------------------------------------------------------------

/** A request this path will not sign (before any approval exists, or at sign time). */
export class SignatureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureRefusal";
  }
}

/** The only primary type the keystore signs as typed data. */
export const SIGNABLE_PRIMARY_TYPES: ReadonlySet<string> = new Set(["SafeTx"]);
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** A struct that has the shape of a token permit, whatever it is called. */
function permitShaped(fields: readonly TypedDataField[]): boolean {
  const names = new Set(fields.map((f) => f.name.toLowerCase()));
  const hasSpender = names.has("spender") || names.has("operator");
  const hasExpiry = names.has("deadline") || names.has("sigdeadline") || names.has("expiration") || names.has("expiry");
  const hasAmount = names.has("value") || names.has("amount") || names.has("allowed");
  return hasSpender && (hasExpiry || hasAmount);
}

/**
 * May this typed data be signed by the keystore? Throws {@link SignatureRefusal}.
 * Permit refusal first (its message is the one an owner must read), then the
 * SafeTx-only allowlist, the exact type set, and the domain.
 */
export function assertSignableTypedData(
  td: { domain: TypedDataDomain; types: Record<string, TypedDataField[]> },
  expect: { chainId: number; verifyingContract?: string },
): string {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== "EIP712Domain"));
  let primaryType: string;
  try {
    primaryType = TypedDataEncoder.getPrimaryType(types);
  } catch (e) {
    throw new SignatureRefusal(`Malformed typed data: ${safeErrorMessage(e)}`);
  }
  const typeNames = Object.keys(types);
  const vc = td.domain.verifyingContract ? String(td.domain.verifyingContract) : undefined;
  if (
    typeNames.some((n) => /permit/i.test(n)) ||
    (vc !== undefined && vc.toLowerCase() === PERMIT2.toLowerCase()) ||
    Object.values(types).some((fields) => permitShaped(fields))
  ) {
    throw new SignatureRefusal(
      "Refused: this is permit-style typed data (ERC-2612 Permit / Uniswap Permit2 or the same shape). A signed " +
        "permit lets someone move your tokens with no transaction for you to review, so the keystore never signs one. " +
        "Use an on-chain approve instead (it is shown decoded on the approval page).",
    );
  }
  if (!SIGNABLE_PRIMARY_TYPES.has(primaryType)) {
    throw new SignatureRefusal(
      `Refused: the keystore signs typed data of type SafeTx only (a Safe owner signature); got "${primaryType}".`,
    );
  }
  if (JSON.stringify(types) !== JSON.stringify(SAFE_TX_TYPES)) {
    throw new SignatureRefusal("Refused: the SafeTx type set differs from the canonical Safe EIP-712 SafeTx struct.");
  }
  const domainKeys = Object.keys(td.domain).filter((k) => (td.domain as Record<string, unknown>)[k] !== undefined);
  if (domainKeys.sort().join(",") !== "chainId,verifyingContract") {
    throw new SignatureRefusal(
      `Refused: a SafeTx domain is exactly { chainId, verifyingContract } (Safe 1.3.0+); got { ${domainKeys.join(", ")} }.`,
    );
  }
  let domainChain: number;
  try {
    domainChain = Number(BigInt(td.domain.chainId as bigint | number | string));
  } catch {
    throw new SignatureRefusal("Refused: the typed-data domain has no usable chainId.");
  }
  if (domainChain !== expect.chainId) {
    throw new SignatureRefusal(
      `Refused: the typed-data domain is for chain ${domainChain}, but this approval is for chain ${expect.chainId}. ` +
        "A signature for another chain is never produced under this approval.",
    );
  }
  if (expect.verifyingContract && (!vc || getAddress(vc) !== getAddress(expect.verifyingContract))) {
    throw new SignatureRefusal(
      `Refused: the typed-data domain names ${vc ?? "no contract"}, not the reviewed Safe ${expect.verifyingContract}.`,
    );
  }
  return primaryType;
}

// ---------------------------------------------------------------------------
// The single-use signer
// ---------------------------------------------------------------------------

export type SignatureKind = "message" | "safeTx";

/**
 * The only object that holds a decrypted keystore key for a SIGNATURE, and
 * the only way one is produced: exactly the approved message, or exactly the
 * approved typed data, once. Anything else — other bytes, another digest,
 * another domain chain or contract, a second use — revokes the approval and
 * drops the key before anything is signed.
 */
export class ApprovedSignature implements KeyHolder {
  /** ES private: not reachable by property access, Object.keys, JSON or spread. */
  #key: string | null;
  #used = false;

  constructor(
    readonly approvalId: string,
    readonly address: string,
    privateKey: string,
    readonly kind: SignatureKind,
    readonly chainId: number,
    private readonly binding: string,
    private readonly deps: { store: ApprovalStore; verifyingContract?: string },
  ) {
    this.#key = privateKey;
  }

  drop(): void {
    this.#key = null;
  }

  get active(): boolean {
    return this.#key !== null && !this.#used;
  }

  toJSON(): string {
    return "[ApprovedSignature redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ApprovedSignature { approvalId: ${this.approvalId}, kind: ${this.kind}, address: ${this.address}, key: [redacted] }`;
  }

  private refuse(reason: string): never {
    this.revoke(`deviation: ${reason}`);
    throw new ApprovalDeviationError(
      `Refused to sign: ${reason}. The approval was revoked and the key dropped; nothing was signed. Re-run the call ` +
        "to request a fresh approval for what you actually want to sign.",
    );
  }

  private take(kind: SignatureKind): string {
    if (this.#key === null || this.#used) {
      throw new ApprovalDeviationError(
        "This approval is no longer active (used, revoked, superseded or expired) — nothing was signed.",
      );
    }
    if (kind !== this.kind) this.refuse(`this approval is for a ${this.kind} signature, not a ${kind} one`);
    return this.#key;
  }

  /** EIP-191 personal_sign of exactly the approved bytes. */
  async signMessage(message: Uint8Array | string): Promise<string> {
    const key = this.take("message");
    const bytes = typeof message === "string" ? toUtf8Bytes(message) : message;
    if (messageBindingHash(this.chainId, this.address, bytes) !== this.binding) {
      this.refuse("the message differs from the one the owner approved");
    }
    this.#used = true;
    try {
      return await new Wallet(key).signMessage(bytes);
    } finally {
      this.finish();
    }
  }

  /** EIP-712 signature of exactly the approved SafeTx. */
  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const key = this.take("safeTx");
    try {
      assertSignableTypedData(
        { domain, types },
        { chainId: this.chainId, ...(this.deps.verifyingContract ? { verifyingContract: this.deps.verifyingContract } : {}) },
      );
    } catch (e) {
      this.refuse(safeErrorMessage(e));
    }
    let digest: string;
    try {
      digest = TypedDataEncoder.hash(domain, types, value);
    } catch (e) {
      this.refuse(`the typed data does not encode (${safeErrorMessage(e)})`);
    }
    if (typedDataBindingHash(this.chainId, this.address, digest) !== this.binding) {
      this.refuse("the typed data differs from what the owner approved");
    }
    this.#used = true;
    try {
      return await new Wallet(key).signTypedData(domain, types, value);
    } finally {
      this.finish();
    }
  }

  /** Signed (or abandoned) → consumed / revoked. Drops the key. */
  finish(): void {
    if (this.#used) this.deps.store.finish(this.approvalId);
    else this.deps.store.revoke(this.approvalId, "the approved signature was not produced");
    this.drop();
  }

  revoke(reason: string): void {
    this.drop();
    this.deps.store.revoke(this.approvalId, reason);
  }
}
