import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { getAddress, hexlify, keccak256, toUtf8Bytes, TypedDataEncoder, verifyMessage, verifyTypedData, Wallet } from "ethers";
import { encryptPrivateKey } from "../../src/lib/keystore.js";
import { ApprovalManager, ApprovedSignature, SignatureRefusal } from "../../src/lib/approval/index.js";
import { ApprovalHaltError } from "../../src/lib/approval/scope.js";
import { computeBatchHash, type ReviewStep } from "../../src/lib/approval/review.js";
import {
  assertSignableTypedData,
  MESSAGE_MAX_BYTES,
  messageBindingHash,
  reviewMessage,
  segmentsOf,
  typedDataBindingHash,
} from "../../src/lib/approval/signing.js";
import type { SafeReview } from "../../src/lib/approval/safeReview.js";
import { buildSafeTx, safeTxDomain, SAFE_TX_TYPES } from "../../src/lib/ethersProvider.js";
import type { StoreOptions } from "../../src/lib/approval/store.js";
import { approveAsHuman, declineAsHuman, rawRequest } from "../helpers/approvalHttp.js";

/**
 * 2c Phase B — the two signature kinds, `message` (EIP-191) and `safeTx`
 * (EIP-712 SafeTx), through the same store / page / lockout / single-use rule
 * as a transaction batch: what an approval is bound to, what the page shows
 * (from the bytes), what is refused before any page, and that an approved
 * signature can be spent exactly once on exactly the approved bytes.
 */
const FAST = { N: 2 ** 17, r: 8, p: 1 }; // the smallest KDF keystore mode accepts
const KEY = Wallet.createRandom();
const PW = "signature approval password";
let json: string;
beforeAll(async () => {
  json = await encryptPrivateKey(KEY.privateKey, PW, FAST);
});

const managers: ApprovalManager[] = [];
afterEach(async () => {
  while (managers.length) await managers.pop()!.close();
});

function manager(store: Partial<StoreOptions> = {}, waitMs = 0, ttlMs = 900_000) {
  const m = new ApprovalManager({
    keystoreFile: "(memory)",
    address: KEY.address,
    waitMs,
    ttlMs,
    openBrowser: false,
    readKeystore: () => json,
    connect: () => {
      throw new Error("a signature approval never sends a transaction");
    },
    lock: (_c, task) => task(),
    log: () => undefined,
    storeOptions: store,
  });
  managers.push(m);
  return m;
}

const LOGIN = "Sign in to DeXe.\nNonce: 7f3a91c2";
/** Invisible characters are built at runtime: the test source itself holds none. */
const cp = (n: number) => String.fromCodePoint(n);
const PURPOSE = "Log in to the DeXe backend at https://api.example as test";
const msgReq = (message: string | Uint8Array = LOGIN, chainId = 56) => ({
  kind: "message" as const,
  tool: "dexe_auth_login",
  chainId,
  from: KEY.address,
  message: typeof message === "string" ? toUtf8Bytes(message) : message,
  purpose: PURPOSE,
});

async function halted(p: Promise<unknown>): Promise<ApprovalHaltError["halt"]> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApprovalHaltError);
  return (e as ApprovalHaltError).halt;
}

// ---------------------------------------------------------------------------

describe("binding hashes", () => {
  const bytes = toUtf8Bytes(LOGIN);
  it("a message binding changes with the chain, the signer and every byte", () => {
    const base = messageBindingHash(56, KEY.address, bytes);
    expect(messageBindingHash(97, KEY.address, bytes)).not.toBe(base);
    expect(messageBindingHash(56, Wallet.createRandom().address, bytes)).not.toBe(base);
    expect(messageBindingHash(56, KEY.address, toUtf8Bytes(`${LOGIN} `))).not.toBe(base);
    expect(messageBindingHash(56, KEY.address.toLowerCase(), bytes)).toBe(base); // address case is not a difference
  });

  it("the three kinds live in separate namespaces", () => {
    const digest = keccak256(bytes);
    const asMessage = messageBindingHash(56, KEY.address, Uint8Array.from(Buffer.from(digest.slice(2), "hex")));
    const asTyped = typedDataBindingHash(56, KEY.address, digest);
    const asBatch = computeBatchHash(56, KEY.address, [{ to: KEY.address, value: "0", data: digest }]);
    expect(new Set([asMessage, asTyped, asBatch]).size).toBe(3);
  });
});

describe("what the owner is told about a message (from its bytes)", () => {
  const review = (m: string | Uint8Array) =>
    reviewMessage(typeof m === "string" ? toUtf8Bytes(m) : m, { from: KEY.address, purpose: PURPOSE });
  const dangers = (r: ReturnType<typeof review>) => r.risks.filter((x) => x.level === "danger").map((x) => x.text);

  it("a plain login nonce has no danger flag, and shows in full", () => {
    const r = review(LOGIN);
    expect(r.encoding).toBe("utf8");
    expect(dangers(r)).toEqual([]);
    expect(r.segments).toEqual([{ t: "text", v: LOGIN }]);
    expect(r.hex).toBe(hexlify(toUtf8Bytes(LOGIN)));
    // A readable 32-byte text is not a "hash in disguise".
    expect(toUtf8Bytes(LOGIN).length).toBe(32);
  });

  it("32 raw bytes (a hash in disguise) and binary data are DANGER", () => {
    const r = review(Uint8Array.from(Buffer.from(keccak256("0x01").slice(2), "hex")));
    expect(r.encoding).toBe("binary");
    expect(dangers(r).join(" ")).toMatch(/exactly 32 bytes/);
    expect(dangers(r).join(" ")).toMatch(/Not text/);
  });

  it("hex text, typed data in JSON, and a transaction-looking blob are DANGER", () => {
    expect(dangers(review(keccak256("0x02"))).join(" ")).toMatch(/hex data \(32 bytes\)/);
    const typed = JSON.stringify({ types: { Permit: [] }, primaryType: "Permit", domain: {}, message: {} });
    expect(dangers(review(typed)).join(" ")).toMatch(/EIP-712 typed data/);
    expect(dangers(review(Uint8Array.from([0x02, 0xf8, 0x6c, 0x01, 0xff, 0xfe]))).join(" ")).toMatch(/encoded transaction/);
  });

  it("invisible and direction-changing characters are made VISIBLE (never dropped) and flagged", () => {
    const sneaky = `Pay ${cp(0x202e)}evil${cp(0x202c)} to${cp(0x200b)}me${cp(0xfeff)}`;
    const r = review(sneaky);
    expect(dangers(r).join(" ")).toMatch(/invisible, control or direction-changing/);
    expect(r.segments).toContainEqual({ t: "mark", v: "U+202E" });
    expect(r.segments).toContainEqual({ t: "mark", v: "U+200B" });
    expect(r.segments).toContainEqual({ t: "mark", v: "U+FEFF" });
    // Nothing lost: the text pieces plus the marked characters are the whole message.
    expect(r.byteLength).toBe(toUtf8Bytes(sneaky).length);
  });

  it("a message cannot fake a marker by spelling one", () => {
    expect(segmentsOf("⟨U+202E⟩")).toEqual([
      { t: "mark", v: "U+27E8" },
      { t: "text", v: "U+202E" },
      { t: "mark", v: "U+27E9" },
    ]);
  });

  it("addresses, amounts, permits and look-alike letters are called out", () => {
    const other = Wallet.createRandom().address;
    const r = review(`approve ${other} to spend 1,000,000 USDT for ${KEY.address} — раypal`);
    const text = r.risks.map((x) => `${x.level}:${x.text}`).join("\n");
    expect(text).toMatch(new RegExp(`warn:Mentions the address ${other}`));
    expect(text).toMatch(new RegExp(`info:Mentions your own address ${KEY.address}`));
    expect(text).toMatch(/warn:Mentions amounts .*1,000,000/);
    expect(text).toMatch(/warn:Mentions token approvals/);
    expect(text).toMatch(/warn:Contains non-ASCII characters \(.*р U\+0440/);
  });

  it("every Unicode format character and blank-looking letter is a marker (U+061C, U+2800, U+3164, U+115F, U+FFA0, tags)", () => {
    for (const c of [0x061c, 0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x00ad, 0x2066, 0xe0041, 0x180e, 0x1680]) {
      const r = review(`a${cp(c)}b`);
      expect(r.segments).toContainEqual({ t: "mark", v: `U+${c.toString(16).toUpperCase().padStart(4, "0")}` });
      expect(dangers(r).join(" ")).toMatch(/invisible, control or direction-changing/);
    }
  });

  it("long blank stretches that push text out of view are DANGER", () => {
    expect(dangers(review(`Sign in.${"\n".repeat(6)}Also: transfer everything`)).join(" ")).toMatch(/5 blank lines in a row/);
    expect(dangers(review(`Sign in.${" ".repeat(60)}hidden on the right`)).join(" ")).toMatch(/run of 60 spaces/);
    expect(dangers(review("Line one\n\nLine two"))).toEqual([]);
  });

  it("a BOM is kept and shown, not swallowed by the decoder", () => {
    const r = review(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(r.segments?.[0]).toEqual({ t: "mark", v: "U+FEFF" });
  });
});

// ---------------------------------------------------------------------------

const SAFE = getAddress("0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe");
const TO_X = "0x4444444444444444444444444444444444444444";
const tx = (over: Partial<Parameters<typeof buildSafeTx>[0]> = {}) =>
  buildSafeTx({ to: "0x2222222222222222222222222222222222222222", value: "0", data: "0x", nonce: "4", ...over });
const typed = (chainId = 97, safeTx = tx()) => ({
  domain: safeTxDomain(chainId, SAFE),
  types: SAFE_TX_TYPES,
  message: safeTx as unknown as Record<string, unknown>,
});

describe("typed-data policy", () => {
  it("a canonical SafeTx for the approval's chain and Safe passes", () => {
    expect(assertSignableTypedData(typed(), { chainId: 97, verifyingContract: SAFE })).toBe("SafeTx");
  });

  it("ERC-2612 Permit, Permit2 and anything permit-shaped are refused outright", () => {
    const permit = {
      domain: { name: "Token", version: "1", chainId: 97, verifyingContract: SAFE },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    };
    expect(() => assertSignableTypedData(permit, { chainId: 97 })).toThrow(/permit-style/);
    const permit2 = {
      domain: { name: "Permit2", chainId: 97, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      types: {
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
    };
    expect(() => assertSignableTypedData(permit2, { chainId: 97 })).toThrow(/permit-style/);
    const disguised = {
      domain: { chainId: 97, verifyingContract: SAFE },
      types: { Order: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }] },
    };
    expect(() => assertSignableTypedData(disguised, { chainId: 97 })).toThrow(/permit-style/);
    // Permit2's address alone is enough.
    expect(() =>
      assertSignableTypedData(
        { domain: { chainId: 97, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, types: SAFE_TX_TYPES },
        { chainId: 97 },
      ),
    ).toThrow(/permit-style/);
  });

  it("any other primary type, an altered SafeTx struct or an extra domain field is refused", () => {
    expect(() =>
      assertSignableTypedData({ domain: { chainId: 97, verifyingContract: SAFE }, types: { Mail: [{ name: "to", type: "address" }] } }, { chainId: 97 }),
    ).toThrow(/SafeTx only/);
    const altered = { SafeTx: SAFE_TX_TYPES.SafeTx!.filter((f) => f.name !== "refundReceiver") };
    expect(() => assertSignableTypedData({ domain: { chainId: 97, verifyingContract: SAFE }, types: altered }, { chainId: 97 })).toThrow(
      /differs from the canonical/,
    );
    expect(() =>
      assertSignableTypedData({ domain: { name: "x", chainId: 97, verifyingContract: SAFE }, types: SAFE_TX_TYPES }, { chainId: 97 }),
    ).toThrow(/exactly \{ chainId, verifyingContract \}/);
  });

  it("a domain for another chain or another contract than the approval's is refused", () => {
    expect(() => assertSignableTypedData(typed(56), { chainId: 97, verifyingContract: SAFE })).toThrow(/chain 56.*chain 97/);
    expect(() =>
      assertSignableTypedData(typed(97), { chainId: 97, verifyingContract: "0x1111111111111111111111111111111111111111" }),
    ).toThrow(/not the reviewed Safe/);
  });
});

// ---------------------------------------------------------------------------

describe("message approvals end to end (page)", () => {
  it("pending → page shows the exact message → owner approves → re-run signs it once → replay needs a new page", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq()));
    expect(halt.status).toBe("pending");
    expect(halt.steps[0]).toMatch(/sign a message \(\d+ bytes, utf8\)/);
    const page = await rawRequest(halt.url!);
    expect(page.body).toContain("Sign a message");
    expect(page.body).toContain("Sign in to DeXe.\nNonce: 7f3a91c2");
    expect(page.body).toContain(halt.fingerprint);
    expect((await approveAsHuman(halt.url!, PW)).status).toBe(200);

    const s = await m.requestSignature(msgReq());
    expect(s).toBeInstanceOf(ApprovedSignature);
    const sig = await s.signMessage(toUtf8Bytes(LOGIN));
    expect(verifyMessage(LOGIN, sig)).toBe(KEY.address);
    expect(m.view(halt.approvalId)!.status).toBe("consumed");
    // Single use: the same signer cannot sign again…
    await expect(s.signMessage(toUtf8Bytes(LOGIN))).rejects.toThrow(/no longer active/);
    // …and the same message needs a NEW approval.
    const again = await halted(m.requestSignature(msgReq()));
    expect(again.approvalId).not.toBe(halt.approvalId);
  });

  it("the page escapes the message and shows hidden characters as markers", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq(`<script>alert(1)</script>${cp(0x202e)}x`)));
    const page = await rawRequest(halt.url!);
    expect(page.body).not.toContain("<script>alert(1)</script>");
    expect(page.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.body).toMatch(/<span class="mk">⟨U\+202E⟩<\/span>/);
    expect(page.body).toMatch(/risk r-danger[^<]*invisible, control or direction-changing/);
  });

  it("an approval for one message cannot sign another (deviation revokes it)", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq()));
    await approveAsHuman(halt.url!, PW);
    const s = await m.requestSignature(msgReq());
    await expect(s.signMessage(toUtf8Bytes(`${LOGIN}!`))).rejects.toThrow(/differs from the one the owner approved/);
    expect(m.view(halt.approvalId)!.status).toBe("revoked");
    // and a typed-data signature on a message approval is refused too
    const halt2 = await halted(m.requestSignature(msgReq("another login")));
    await approveAsHuman(halt2.url!, PW);
    const s2 = await m.requestSignature(msgReq("another login"));
    await expect(s2.signTypedData(typed().domain, typed().types, typed().message)).rejects.toThrow(/message signature, not a safeTx/);
  });

  it("decline → the same message is refused without a new page for the cooldown", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq()));
    expect((await declineAsHuman(halt.url!)).json().status).toBe("declined");
    const again = await halted(m.requestSignature(msgReq()));
    expect(again.status).toBe("declined");
    expect(again.approvalId).toBe(halt.approvalId);
    expect(again.retryAfter).toBeTruthy();
  });

  it("a decline holds for the whole flow: a NEW message of the same tool/signer/chain is refused without a page", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq("Sign in: nonce one")));
    await declineAsHuman(halt.url!);
    // dexe_auth_login's next call brings a fresh nonce — a different message.
    const again = await halted(m.requestSignature(msgReq("Sign in: nonce two")));
    expect(again.status).toBe("declined");
    expect(again.approvalId).toBe(halt.approvalId);
    expect(() => m.assertNoRecentDecline({ kind: "message", tool: "dexe_auth_login", from: KEY.address, chainId: 56 })).toThrow(
      ApprovalHaltError,
    );
    expect(m.store.open()).toEqual([]);
    // another flow (another tool) is unaffected
    const other = await halted(m.requestSignature({ ...msgReq("Sign in: nonce three"), tool: "some_other_tool" }));
    expect(other.status).toBe("pending");
  });

  it("server-written flags come first (e.g. a login to a non-default backend is DANGER)", async () => {
    const m = manager();
    const halt = await halted(
      m.requestSignature({ ...msgReq(), serverRisks: [{ level: "danger", text: "This login goes to https://evil.example, NOT the DeXe backend" }] }),
    );
    const page = (await rawRequest(halt.url!)).body;
    expect(page).toMatch(/risk r-danger[^<]*This login goes to https:\/\/evil\.example, NOT the DeXe backend/);
  });

  it("expiry: an approval nobody decided ends, and a fresh request makes a new one", async () => {
    const m = manager({}, 0, 80);
    const halt = await halted(m.requestSignature(msgReq()));
    await new Promise((r) => setTimeout(r, 160));
    expect(m.view(halt.approvalId)!.status).toBe("expired");
    expect((await approveAsHuman(halt.url!, PW).catch(() => null))?.status ?? 0).not.toBe(200);
    const again = await halted(m.requestSignature(msgReq()));
    expect(again.approvalId).not.toBe(halt.approvalId);
  });

  it("an internal hand-over failure revokes the approval (never left 'executing' with a key)", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(msgReq("internal path")));
    await approveAsHuman(halt.url!, PW);
    // Simulate the manager losing track of the key holder.
    (m as unknown as { holders: Map<string, unknown> }).holders.delete(halt.approvalId);
    const again = await halted(m.requestSignature(msgReq("internal path")));
    expect(m.view(halt.approvalId)!.status).toBe("revoked");
    expect(again.approvalId).not.toBe(halt.approvalId);
  });

  it("empty and over-long messages are refused before any page", async () => {
    const m = manager();
    await expect(m.requestSignature(msgReq(new Uint8Array()))).rejects.toBeInstanceOf(SignatureRefusal);
    await expect(m.requestSignature(msgReq(new Uint8Array(MESSAGE_MAX_BYTES + 1).fill(0x61)))).rejects.toThrow(/over 4096 bytes/);
    expect(m.store.open()).toEqual([]);
  });

  it("wrong passwords on signature approvals count toward the same global lockout as transactions", async () => {
    const m = manager();
    const a = await halted(m.requestSignature(msgReq("login a")));
    const b = await halted(m.requestSignature(msgReq("login b")));
    for (const h of [a, a, b, b]) expect((await approveAsHuman(h.url!, "wrong wrong")).status).toBe(401);
    expect((await approveAsHuman(a.url!, "wrong wrong")).json().message).toMatch(/locked/);
    expect((await approveAsHuman(b.url!, PW)).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------

function safeReview(over: Partial<SafeReview> = {}): SafeReview {
  return {
    safe: SAFE,
    version: "1.4.1",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    singletonLabel: "Safe 1.4.1 L2 (canonical)",
    threshold: "2",
    ownerCount: 3,
    nonce: "4",
    currentNonce: "4",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    risks: [{ level: "info", text: "Threshold 2 of 3: your signature is one of the 2 needed." }],
    ...over,
  };
}

const innerStep: ReviewStep = {
  index: 0,
  to: "0x2222222222222222222222222222222222222222",
  toLabel: "unlabelled contract",
  value: "0",
  valueHuman: "0.0 tBNB",
  selector: null,
  dataBytes: 0,
  dataHash: keccak256("0x"),
  dataPreview: "0x",
  decoded: null,
  risks: [],
};

const safeReq = (t = typed(), review = safeReview(), steps: ReviewStep[] = [innerStep]) => {
  let onChain = review.onChainSafeTxHash;
  if (!onChain) {
    try {
      onChain = TypedDataEncoder.hash(t.domain, t.types, t.message); // what a real Safe's getTransactionHash returns
    } catch {
      onChain = undefined;
    }
  }
  return {
    kind: "safeTx" as const,
    tool: "dexe_safe_propose_tx",
    chainId: 97,
    from: KEY.address,
    typedData: t,
    safe: { ...review, ...(onChain ? { onChainSafeTxHash: onChain } : {}) },
    steps,
    prechecks: { guards: "pass" as const, simulation: "skipped" as const },
  };
};

describe("Safe transaction approvals end to end (page)", () => {
  it("pending → page shows the verified Safe and the inner call → approve → signs exactly that SafeTx", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(safeReq()));
    const page = (await rawRequest(halt.url!)).body;
    const digest = TypedDataEncoder.hash(typed().domain, typed().types, typed().message);
    expect(page).toContain("Sign a Safe transaction");
    expect(page).toContain(digest); // safeTxHash, computed by the manager
    expect(page).toContain("Safe 1.4.1 L2 (canonical)");
    expect(page).toContain("What the Safe will do");
    expect(page).toMatch(/threshold 2 of 3/);
    await approveAsHuman(halt.url!, PW);
    const s = await m.requestSignature(safeReq());
    const sig = await s.signTypedData(typed().domain, typed().types, typed().message);
    expect(verifyTypedData(typed().domain, typed().types, typed().message, sig)).toBe(KEY.address);
    expect(m.view(halt.approvalId)!.status).toBe("consumed");
  });

  it("DELEGATECALL renders as DANGER on the page", async () => {
    const m = manager();
    const t = typed(97, tx({ operation: 1 }));
    const review = safeReview({
      operation: 1,
      risks: [{ level: "danger", text: "DELEGATECALL: the Safe runs the code at 0x2222… inside its OWN storage." }],
    });
    const halt = await halted(m.requestSignature(safeReq(t, review)));
    const page = (await rawRequest(halt.url!)).body;
    expect(page).toMatch(/risk r-danger[^<]*DELEGATECALL/);
    expect(page).toMatch(/<span class="mk">DELEGATECALL \(1\)<\/span>/);
  });

  it("a domain for another chain is refused before any page, and at sign time it revokes", async () => {
    const m = manager();
    await expect(m.requestSignature(safeReq(typed(56)))).rejects.toThrow(/chain 56.*chain 97/);
    expect(m.store.open()).toEqual([]);
    const halt = await halted(m.requestSignature(safeReq()));
    await approveAsHuman(halt.url!, PW);
    const s = await m.requestSignature(safeReq());
    const t56 = typed(56);
    await expect(s.signTypedData(t56.domain, t56.types, t56.message)).rejects.toThrow(/chain 56/);
    expect(m.view(halt.approvalId)!.status).toBe("revoked");
  });

  it("a different SafeTx (another nonce) is not covered by the approval", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(safeReq()));
    await approveAsHuman(halt.url!, PW);
    const s = await m.requestSignature(safeReq());
    const other = typed(97, tx({ nonce: "5" }));
    await expect(s.signTypedData(other.domain, other.types, other.message)).rejects.toThrow(/differs from what the owner approved/);
  });

  it("review probe: a SafeTx paying a gas refund is refused at the primitive — before any page AND at sign time", async () => {
    // gasPrice 1 gwei + baseGas 1e12, token and receiver zero: ≥ 1000 native coin to the executor.
    const probe = typed(97, tx({ gasPrice: "1000000000", baseGas: "1000000000000" }));
    expect(() => assertSignableTypedData(probe, { chainId: 97, verifyingContract: SAFE })).toThrow(
      /pays a gas refund on execution \(gasPrice 1000000000, baseGas 1000000000000\)/,
    );
    for (const over of [{ gasPrice: "1" }, { baseGas: "1" }, { gasToken: TO_X }, { refundReceiver: TO_X }]) {
      expect(() => assertSignableTypedData(typed(97, tx(over)), { chainId: 97, verifyingContract: SAFE })).toThrow(/gas refund/);
    }
    const m = manager();
    await expect(m.requestSignature(safeReq(probe))).rejects.toThrow(/gas refund/);
    expect(m.store.open()).toEqual([]);
    // and an approved signer for a clean SafeTx will not sign the refund variant
    const halt = await halted(m.requestSignature(safeReq()));
    await approveAsHuman(halt.url!, PW);
    const s = await m.requestSignature(safeReq());
    await expect(s.signTypedData(probe.domain, probe.types, probe.message)).rejects.toThrow(/gas refund/);
    expect(m.view(halt.approvalId)!.status).toBe("revoked");
  });

  it("the page shows every gas field, and the Safe fields come from the typed data, not the caller's review", async () => {
    const m = manager();
    // A review that lies about the nonce / gas: the page shows the signed values.
    const lying = safeReview({ nonce: "999", safeTxGas: "1", gasPrice: "0" });
    const t = typed(97, tx({ safeTxGas: "21000" }));
    const halt = await halted(m.requestSignature(safeReq(t, lying)));
    const page = (await rawRequest(halt.url!)).body;
    expect(page).toMatch(/safeTxGas 21000 · baseGas 0 · gasPrice 0/);
    expect(page).toMatch(/no gas refund/);
    expect(page).toMatch(/Nonce<\/div><div>4 /);
    expect(page).not.toContain(">999 ");
  });

  it("refuses when the reviewed call is not the SafeTx's call, or the Safe's own hash differs", async () => {
    const m = manager();
    const otherStep = { ...innerStep, to: "0x3333333333333333333333333333333333333333" };
    await expect(m.requestSignature(safeReq(typed(), safeReview(), [otherStep]))).rejects.toThrow(/reviewed call is not the one/);
    await expect(m.requestSignature(safeReq(typed(), safeReview({ onChainSafeTxHash: `0x${"cd".repeat(32)}` })))).rejects.toThrow(
      /getTransactionHash .* differs/,
    );
    expect(m.store.open()).toEqual([]);
  });

  it("permit typed data never reaches the store", async () => {
    const m = manager();
    const permit = {
      domain: { chainId: 97, verifyingContract: SAFE },
      types: { Permit: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { spender: SAFE, value: 1n, deadline: 1n },
    };
    await expect(m.requestSignature(safeReq(permit))).rejects.toThrow(/permit-style/);
    expect(m.store.open()).toEqual([]);
  });

  it("dexe_tx_approval_status / dexe_write_context name the kind and never carry a secret", async () => {
    const m = manager();
    const halt = await halted(m.requestSignature(safeReq()));
    const v = m.view(halt.approvalId)!;
    expect(v.kind).toBe("safeTx");
    expect(v.landed).toBeUndefined();
    expect(String((v.steps as string[])[0])).toMatch(/sign Safe transaction nonce 4 for Safe/);
    expect(m.openApprovals()[0]).toMatchObject({ kind: "safeTx", status: "pending" });
    expect(JSON.stringify(v)).not.toMatch(/csrf|pathToken/i);
    // What the terminal channel sends carries neither the page token nor the CSRF token.
    const rec = m.store.get(halt.approvalId)!;
    const terminal = JSON.stringify([m.openApprovals(), m.reviewOf(rec)]);
    expect(terminal).not.toMatch(/csrf|pathToken/i);
    expect(terminal).not.toContain(rec.pathToken);
    expect(terminal).not.toContain(rec.csrf);
  });
});
