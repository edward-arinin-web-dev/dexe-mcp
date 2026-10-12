import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { keccak256, Wallet } from "ethers";
import { encryptPrivateKey } from "../../src/lib/keystore.js";
import { ApprovalManager } from "../../src/lib/approval/index.js";
import { ApprovalHaltError, approvalHaltResult } from "../../src/lib/approval/scope.js";
import type { ReviewStep } from "../../src/lib/approval/review.js";
import type { StoreOptions } from "../../src/lib/approval/store.js";
import { approveAsHuman, csrfFromPage, declineAsHuman, rawRequest } from "../helpers/approvalHttp.js";

/**
 * 2c Phase A — the approval loop end to end, in process: a real loopback
 * server, a real (cheap-scrypt) keystore, and the test playing the human over
 * HTTP. Covers the re-run path, the blocking path, decline + cooldown, wrong
 * passwords + lockout, webdriver refusal, and the HTTP admission rules.
 */
// The smallest KDF keystore mode accepts (production writes 2^18). Cheaper ones are refused.
const FAST = { N: 2 ** 17, r: 8, p: 1 };
const KEY = Wallet.createRandom();
const PW = "a fine keystore password";
let keystoreJson: string;

beforeAll(async () => {
  keystoreJson = await encryptPrivateKey(KEY.privateKey, PW, FAST);
});

const managers: ApprovalManager[] = [];
afterEach(async () => {
  while (managers.length) await managers.pop()!.close();
});

function stepView(i: number, to: string, note?: string): ReviewStep {
  return {
    index: i,
    to,
    toLabel: "unlabelled contract",
    value: "0",
    valueHuman: "0.0 tBNB",
    selector: "0x12345678",
    dataBytes: 4,
    dataHash: keccak256("0x12345678"),
    dataPreview: "0x12345678",
    decoded: null,
    ...(note ? { builderNote: note } : {}),
    risks: [{ level: "warn", text: "calldata could not be decoded" }],
  };
}

function makeManager(
  over: { waitMs?: number; maxFailures?: number; store?: Partial<StoreOptions>; keystore?: () => string } = {},
) {
  const sent: Array<{ to: string; data: string }> = [];
  const m = new ApprovalManager({
    keystoreFile: "(in memory)",
    address: KEY.address,
    waitMs: over.waitMs ?? 0,
    ttlMs: 900_000,
    openBrowser: false,
    readKeystore: over.keystore ?? (() => keystoreJson),
    connect: () => ({
      address: KEY.address,
      async sendTransaction(tx) {
        sent.push({ to: tx.to, data: tx.data });
        return { hash: keccak256(tx.data) } as never;
      },
    }),
    lock: (_c, task) => task(),
    log: () => undefined,
    storeOptions: { ...(over.maxFailures ? { maxFailures: over.maxFailures } : {}), ...(over.store ?? {}) },
  });
  managers.push(m);
  return { m, sent };
}

const TO = "0x1111111111111111111111111111111111111111";
function req(tool = "dexe_tx_send", data = "0x12345678", note?: string) {
  return {
    tool,
    chainId: 97,
    from: KEY.address,
    payloads: [{ to: TO, data, value: "0" }],
    steps: [stepView(0, TO, note)],
    prechecks: { guards: "pass" as const, simulation: "pass" as const },
  };
}

async function pending(m: ApprovalManager, r = req()) {
  const err = await m.request(r).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApprovalHaltError);
  const halt = (err as ApprovalHaltError).halt;
  expect(halt.status).toBe("pending");
  expect(halt.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{16,}$/);
  return halt;
}

describe("approval loop", () => {
  it("re-run path: pending → the owner approves → the same call gets an ApprovedSigner", async () => {
    const { m, sent } = makeManager();
    const halt = await pending(m);
    const res = await approveAsHuman(halt.url!, PW);
    expect(res.status).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(m.view(halt.approvalId)!.status).toBe("approved");

    const signer = await m.request(req());
    await signer.send({ to: TO, data: "0x12345678", value: "0", chainId: 97 });
    signer.landed(0, keccak256("0x12345678"));
    signer.finish();
    expect(sent).toHaveLength(1);
    expect(m.view(halt.approvalId)!.status).toBe("consumed");

    // Replay: the same batch needs a NEW approval now.
    const again = await pending(m);
    expect(again.approvalId).not.toBe(halt.approvalId);
  });

  it("an approval for one batch is useless for another (batchHash binding)", async () => {
    const { m } = makeManager();
    const halt = await pending(m);
    await approveAsHuman(halt.url!, PW);
    const other = await m.request(req("dexe_tx_send", "0xdeadbeef")).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ApprovalHaltError);
    expect((other as ApprovalHaltError).halt.approvalId).not.toBe(halt.approvalId);
  });

  it("blocking path: the call resolves as soon as the owner approves", async () => {
    const logs: string[] = [];
    const { m } = makeManager({ waitMs: 10_000 });
    const progress = vi.fn(async (msg: string) => {
      logs.push(msg);
    });
    const p = m.request(req(), { progress });
    // Find the URL the way a human would: from the progress message / stderr line.
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
    const url = /(http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]+)/.exec(logs[0]!)![1]!;
    await approveAsHuman(url, PW);
    const signer = await p;
    expect(signer.remaining).toBe(1);
    signer.finish();
  });

  it("decline: nothing signs, and the same batch is refused without a page during the cooldown", async () => {
    const { m } = makeManager();
    const halt = await pending(m);
    const res = await declineAsHuman(halt.url!);
    expect(res.json().status).toBe("declined");
    const again = await m.request(req()).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ApprovalHaltError);
    expect((again as ApprovalHaltError).halt.status).toBe("declined");
    expect((again as ApprovalHaltError).halt.approvalId).toBe(halt.approvalId); // no new page
    expect((again as ApprovalHaltError).halt.retryAfter).toBeTruthy();
  });

  it("wrong passwords count down, then auto-decline and lock password entry", async () => {
    const { m } = makeManager({ maxFailures: 2, store: { globalFailureThreshold: 2 } });
    const halt = await pending(m);
    const first = await approveAsHuman(halt.url!, "nope nope nope");
    expect(first.status).toBe(401);
    expect(first.json().status).toBe("wrong-password");
    const second = await approveAsHuman(halt.url!, "still wrong!!");
    expect(second.json().status).toBe("declined");
    expect(m.view(halt.approvalId)!.status).toBe("declined");
    // A fresh approval is locked out for a while, even with the right password.
    const next = await pending(m, req("dexe_proposal_create", "0x00000001"));
    const locked = await approveAsHuman(next.url!, PW);
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeTruthy();
  });

  it("review bypass 1a: guesses spread over fresh approvals hit the GLOBAL lockout; the right password is then refused", async () => {
    const { m } = makeManager();
    // Three fresh approvals (the pending cap), 1-wei-style variations of one call.
    const halts = [];
    for (const d of ["0x00000011", "0x00000012", "0x00000013"]) halts.push(await pending(m, req("dexe_tx_send", d)));
    const guesses = [halts[0], halts[0], halts[1], halts[1]];
    for (const h of guesses) expect((await approveAsHuman(h!.url!, "guess guess guess")).status).toBe(401);
    const fifth = await approveAsHuman(halts[2]!.url!, "guess guess guess");
    expect(fifth.json().message).toMatch(/locked/);
    const right = await approveAsHuman(halts[2]!.url!, PW);
    expect(right.status).toBe(429);
    for (const h of halts) expect(m.view(h.approvalId)!.status).toBe("pending");
  });

  it("review bypass 1b: password attempts queued before the lockout do not run after it", async () => {
    const { m } = makeManager();
    const a = await pending(m, req("dexe_tx_send", "0x00000021"));
    const b = await pending(m, req("dexe_tx_send", "0x00000022"));
    // Fire everything at once: 5 wrong guesses, then the right password, all queued.
    const posts = [
      approveAsHuman(a.url!, "wrong one 1"),
      approveAsHuman(a.url!, "wrong one 2"),
      approveAsHuman(b.url!, "wrong one 3"),
      approveAsHuman(b.url!, "wrong one 4"),
      approveAsHuman(a.url!, "wrong one 5"),
    ];
    // Let the five wrong ones reach the queue first.
    await new Promise((r) => setTimeout(r, 50));
    const right = approveAsHuman(b.url!, PW);
    const results = await Promise.all([...posts, right]);
    expect(results[5]!.status).toBe(429);
    expect(m.view(b.approvalId)!.status).toBe("pending");
    expect(results.filter((r) => r.status === 200)).toHaveLength(0);
  });

  it("review bypass 1c: at most 3 approvals wait at once; more are refused, not queued", async () => {
    const { m } = makeManager();
    for (const d of ["0x00000031", "0x00000032", "0x00000033"]) await pending(m, req("dexe_tx_send", d));
    const err = await m.request(req("dexe_tx_send", "0x00000034")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalHaltError);
    const halt = (err as ApprovalHaltError).halt;
    expect(halt.status).toBe("throttled");
    expect(halt.open).toHaveLength(3);
    const rendered = approvalHaltResult(halt);
    expect(rendered.isError).toBe(true);
    expect(JSON.parse(rendered.content[0]!.text).mode).toBe("approval_refused");
  });

  it("review bypass 1c: approval creation is rate-limited per minute", async () => {
    const { m } = makeManager({ store: { maxPending: 100 } });
    for (let i = 0; i < 6; i++) await pending(m, req("dexe_tx_send", `0x0000004${i}`));
    const err = await m.request(req("dexe_tx_send", "0x00000047")).catch((e: unknown) => e);
    expect((err as ApprovalHaltError).halt.status).toBe("throttled");
    expect((err as ApprovalHaltError).halt.message).toMatch(/last minute/);
  });

  it("an approved batch not used within the use window is dropped (re-run gets a fresh approval)", async () => {
    const { m } = makeManager({ store: { useWindowMs: 60 } });
    const halt = await pending(m, req("dexe_tx_send", "0x00000051"));
    expect((await approveAsHuman(halt.url!, PW)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 120));
    expect(m.view(halt.approvalId)!.status).toBe("expired");
    const again = await pending(m, req("dexe_tx_send", "0x00000051"));
    expect(again.approvalId).not.toBe(halt.approvalId);
  });

  it("refuses to decrypt a keystore whose KDF is too cheap (swapped after startup)", async () => {
    const weak = await encryptPrivateKey(KEY.privateKey, PW, { N: 2 ** 10, r: 8, p: 1 });
    // A cheap-KDF file must be refused even with the right password.
    const { m } = makeManager({ keystore: () => weak });
    const halt = await pending(m, req("dexe_tx_send", "0x00000061"));
    const res = await approveAsHuman(halt.url!, PW);
    expect(res.status).toBe(400);
    expect(res.json().message).toMatch(/minimum 2\^17/);
    expect(m.view(halt.approvalId)!.status).toBe("pending");
  });

  it("refuses the password from an automated browser (navigator.webdriver)", async () => {
    const { m } = makeManager();
    const halt = await pending(m);
    const res = await approveAsHuman(halt.url!, PW, { webdriver: true });
    expect(res.status).toBe(403);
    expect(res.json().status).toBe("refused-webdriver");
    expect(m.view(halt.approvalId)!.status).toBe("pending");
  });

  it("dexe_tx_approval_status view long-polls and never carries a secret", async () => {
    const { m } = makeManager();
    const halt = await pending(m);
    const waiting = m.waitView(halt.approvalId, 5_000);
    await approveAsHuman(halt.url!, PW);
    const v = (await waiting)!;
    expect(v.status).toBe("approved");
    const text = JSON.stringify(v);
    expect(text).not.toContain(PW);
    expect(text.toLowerCase()).not.toContain(KEY.privateKey.slice(2).toLowerCase());
    expect(text).not.toMatch(/csrf/i);
  });
});

describe("loopback server admission", () => {
  async function setup() {
    const { m } = makeManager();
    const halt = await pending(m);
    const page = await rawRequest(halt.url!);
    return { m, url: halt.url!, csrf: csrfFromPage(page.body), page };
  }

  it("serves the page with no-store, no-referrer, frame-deny and a nonce-only CSP", async () => {
    const { page } = await setup();
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toMatch(/no-store/);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(page.body).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<img/i);
  });

  it("escapes untrusted text on the page", async () => {
    const { m } = makeManager();
    const halt = await pending(m, req("dexe_proposal_create", "0x00000002", '<script>alert(1)</script>"><img src=x>'));
    const page = await rawRequest(halt.url!);
    expect(page.body).not.toContain("<script>alert(1)</script>");
    expect(page.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("rejects a wrong Host (DNS rebinding)", async () => {
    const { url } = await setup();
    const port = new URL(url).port;
    const res = await rawRequest(url, { headers: { Host: `evil.example:${port}` } });
    expect(res.status).toBe(421);
    const res2 = await rawRequest(url, { headers: { Host: `localhost:${port}` } });
    expect(res2.status).toBe(421);
  });

  it("allows only GET and POST", async () => {
    const { url } = await setup();
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect((await rawRequest(url, { method })).status).toBe(405);
    }
    expect((await rawRequest(`${url}/approve`)).status).toBe(405); // GET on an action
  });

  it("unknown tokens are 404", async () => {
    const { url } = await setup();
    const base = new URL(url).origin;
    expect((await rawRequest(`${base}/a/${"x".repeat(32)}`)).status).toBe(404);
    expect((await rawRequest(`${base}/`)).status).toBe(404);
  });

  it("POST needs same-origin, JSON and the CSRF token", async () => {
    const { url, csrf, m } = await setup();
    const body = JSON.stringify({ csrf, password: PW });
    const origin = new URL(url).origin;
    const post = (headers: Record<string, string>, b = body) =>
      rawRequest(`${url}/approve`, { method: "POST", headers, body: b });
    expect((await post({ "Content-Type": "application/json" })).status).toBe(403); // no Origin
    expect((await post({ Origin: "http://evil.example", "Content-Type": "application/json" })).status).toBe(403);
    expect((await post({ Origin: "null", "Content-Type": "application/json" })).status).toBe(403);
    expect((await post({ Origin: origin, "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect(
      (await post({ Origin: origin, "Content-Type": "application/json" }, JSON.stringify({ csrf: "x", password: PW }))).status,
    ).toBe(403);
    expect((await post({ Origin: origin, "Content-Type": "application/json" }, "x".repeat(5000))).status).toBe(413);
    // None of the refused requests approved anything.
    const id = (await m.request(req()).catch((e: ApprovalHaltError) => e.halt)) as { status: string };
    expect(id.status).toBe("pending");
  });
});
