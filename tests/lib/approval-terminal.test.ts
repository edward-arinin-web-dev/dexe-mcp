import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toUtf8Bytes, verifyMessage, Wallet } from "ethers";
import { encryptPrivateKey } from "../../src/lib/keystore.js";
import { ApprovalManager } from "../../src/lib/approval/index.js";
import { ApprovalHaltError } from "../../src/lib/approval/scope.js";
import { createServer, connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import { ControlAuthError, controlCall, requestMac, sealPassword, serverProof } from "../../src/lib/approval/controlProtocol.js";
import {
  discoverServers,
  rendezvousFile,
  trustProblem,
  type PosixIdentity,
  type RendezvousInfo,
} from "../../src/lib/approval/rendezvous.js";
import { renderTerminalReview, tsafe, type TerminalReview } from "../../src/lib/approval/terminalReview.js";
import { run as approveCli, type ApproveIo } from "../../src/cli/approve.js";
import type { ReviewStep } from "../../src/lib/approval/review.js";
import { approveAsHuman, rawRequest } from "../helpers/approvalHttp.js";

/**
 * 2c Phase B — the terminal approval channel (`dexe-mcp approve`): the
 * owner-only rendezvous, the per-process secret, the same password check and
 * global lockout as the page, stale-server cleanup, and the CLI's refusal to
 * decide anything without an interactive terminal.
 */
const FAST = { N: 2 ** 17, r: 8, p: 1 };
const KEY = Wallet.createRandom();
const PW = "terminal channel password";
let json: string;
beforeAll(async () => {
  json = await encryptPrivateKey(KEY.privateKey, PW, FAST);
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const POSIX = process.platform !== "win32";

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "dexe-approve-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function manager(runDir: string) {
  const sent: string[] = [];
  const m = new ApprovalManager({
    keystoreFile: "(memory)",
    address: KEY.address,
    waitMs: 0,
    ttlMs: 900_000,
    openBrowser: false,
    readKeystore: () => json,
    connect: () => ({
      address: KEY.address,
      async sendTransaction(tx) {
        sent.push(tx.data);
        return { hash: keccak256(tx.data) } as never;
      },
    }),
    lock: (_c, task) => task(),
    log: () => undefined,
    terminal: { runDir, version: "test" },
  });
  cleanups.push(() => m.close());
  return { m, sent };
}

const TO = "0x1111111111111111111111111111111111111111";
const step = (data: string): ReviewStep => ({
  index: 0,
  to: TO,
  toLabel: "unlabelled contract",
  value: "0",
  valueHuman: "0.0 tBNB",
  selector: data.slice(0, 10),
  dataBytes: (data.length - 2) / 2,
  dataHash: keccak256(data),
  dataPreview: data,
  decoded: null,
  risks: [{ level: "danger", text: "danger \u001b[2Jflag" }],
});
const txReq = (data = "0x12345678") => ({
  tool: "dexe_tx_send",
  chainId: 97,
  from: KEY.address,
  payloads: [{ to: TO, data, value: "0" }],
  steps: [step(data)],
  prechecks: { guards: "pass" as const, simulation: "pass" as const },
});
const msgReq = (text = "Sign in: nonce 1") => ({
  kind: "message" as const,
  tool: "dexe_auth_login",
  chainId: 56,
  from: KEY.address,
  message: toUtf8Bytes(text),
  purpose: "Log in to the DeXe backend at https://api.example",
});

async function pending(p: Promise<unknown>) {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApprovalHaltError);
  return (e as ApprovalHaltError).halt;
}

function serverInfo(runDir: string): RendezvousInfo {
  const d = discoverServers(runDir);
  expect(d.servers).toHaveLength(1);
  return d.servers[0]!.info;
}

const call = (info: RendezvousInfo, body: Record<string, unknown>) => controlCall(info, body, 30_000);

/** Speak the channel protocol by hand (what a hostile or buggy client would send). */
function rawSession(endpoint: string) {
  const sock = netConnect(endpoint);
  sock.setEncoding("utf8");
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  sock.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(l);
      else lines.push(l);
    }
  });
  sock.on("error", () => undefined);
  return {
    send: (o: Record<string, unknown>) => void sock.write(`${JSON.stringify(o)}\n`),
    next: () =>
      new Promise<Record<string, unknown>>((r) => {
        const l = lines.shift();
        if (l !== undefined) r(JSON.parse(l) as Record<string, unknown>);
        else waiters.push((x) => r(JSON.parse(x) as Record<string, unknown>));
      }),
    close: () => sock.destroy(),
  };
}

// ---------------------------------------------------------------------------

describe("terminal channel (server side)", () => {
  it("starts with the first approval, writes an owner-only rendezvous, and answers only with the secret", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    expect(existsSync(runDir)).toBe(false); // lazy: nothing before an approval
    const halt = await pending(m.request(txReq()));
    expect(halt.message).toMatch(/or the terminal/);
    const info = serverInfo(runDir);
    expect(info.pid).toBe(process.pid);
    expect(info.address).toBe(KEY.address);
    if (POSIX) {
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(statSync(rendezvousFile(runDir, process.pid)).mode & 0o777).toBe(0o600);
      expect(statSync(info.endpoint).mode & 0o777).toBe(0o600);
    } else {
      expect(info.endpoint).toMatch(/^\\\\\.\\pipe\\dexe-mcp-approve-\d+-[0-9a-f]{32}$/);
    }
    expect((await call(info, { op: "hello" })).ok).toBe(true);
    // A client with the wrong secret cannot verify the server's proof: it stops before sending anything.
    await expect(controlCall({ ...info, secret: "x".repeat(43) }, { op: "list" })).rejects.toBeInstanceOf(ControlAuthError);
  });

  it("protocol: the secret is never accepted on the wire; a request needs a MAC over this session's nonces; a password only sealed", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const halt = await pending(m.request(txReq()));
    const info = serverInfo(runDir);
    // v1 (raw secret) — refused outright.
    const v1 = rawSession(info.endpoint);
    v1.send({ v: 1, secret: info.secret, op: "list" });
    expect(await v1.next()).toMatchObject({ ok: false, status: "refused" });
    v1.close();
    // v2 hello is answered with a proof (no secret in it) …
    const s = rawSession(info.endpoint);
    const nonce = "n".repeat(43);
    s.send({ v: 2, op: "hello", nonce });
    const hello = await s.next();
    expect(hello.proof).toBe(serverProof(info.secret, nonce, String(hello.serverNonce), info.pid));
    expect(JSON.stringify(hello)).not.toContain(info.secret);
    // … and a request with a bad MAC is unauthorized.
    s.send({ v: 2, payload: JSON.stringify({ op: "list" }), mac: "00".repeat(32) });
    expect(await s.next()).toMatchObject({ status: "unauthorized" });
    s.close();
    // A correctly MAC'd approve with a PLAIN password is refused (only sealed passwords open).
    const p = rawSession(info.endpoint);
    p.send({ v: 2, op: "hello", nonce });
    const h2 = await p.next();
    const rec = m.store.get(halt.approvalId)!;
    const payload = JSON.stringify({ op: "approve", approvalId: rec.approvalId, binding: rec.batchHash, password: PW });
    p.send({ v: 2, payload, mac: requestMac(info.secret, nonce, String(h2.serverNonce), payload) });
    expect(await p.next()).toMatchObject({ status: "refused", message: "enter the keystore password" });
    p.close();
    // A sealed password lifted onto ANOTHER (correctly MAC'd) request does not open.
    const q = rawSession(info.endpoint);
    q.send({ v: 2, op: "hello", nonce });
    const h3 = await q.next();
    const sn = String(h3.serverNonce);
    const sealedFor = JSON.stringify({ op: "approve", approvalId: "apr_other", binding: rec.batchHash });
    const actual = JSON.stringify({ op: "approve", approvalId: rec.approvalId, binding: rec.batchHash });
    q.send({
      v: 2,
      payload: actual,
      mac: requestMac(info.secret, nonce, sn, actual),
      sealedPassword: sealPassword(info.secret, nonce, sn, sealedFor, PW),
    });
    expect(await q.next()).toMatchObject({ status: "refused", message: "enter the keystore password" });
    q.close();
    expect(m.view(halt.approvalId)!.status).toBe("pending");
  });

  it("a fake server that does not hold the secret gets NOTHING secret: no secret, no MAC'd request, no password", async () => {
    const runDir = tempDir();
    if (POSIX) chmodSync(runDir, 0o700);
    const endpoint = POSIX
      ? join(runDir, `approve-${process.pid}.sock`)
      : `\\\\.\\pipe\\dexe-mcp-approve-${process.pid}-${randomBytes(16).toString("hex")}`;
    const received: string[] = [];
    const fake = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => {
        received.push(d);
        // Answer like a server — but it cannot compute the proof.
        sock.write(`${JSON.stringify({ ok: true, v: 2, serverNonce: "s".repeat(43), proof: "ab".repeat(32) })}\n`);
      });
      sock.on("error", () => undefined);
    });
    await new Promise<void>((r) => fake.listen(endpoint, () => r()));
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
    if (POSIX) chmodSync(endpoint, 0o600);
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(
      rendezvousFile(runDir, process.pid),
      JSON.stringify({ v: 1, pid: process.pid, address: KEY.address, endpoint, secret, createdAt: "", version: "" }),
      { mode: 0o600 },
    );
    // Directly:
    await expect(
      controlCall({ endpoint, secret, pid: process.pid }, { op: "approve", approvalId: "apr_x", binding: "0x", password: PW }),
    ).rejects.toBeInstanceOf(ControlAuthError);
    // Through the CLI, interactive, with a password ready to be typed:
    const out: string[] = [];
    const prompts: string[] = [];
    const io: ApproveIo = {
      isInteractive: () => true,
      promptHidden: async (q) => {
        prompts.push(q);
        return PW;
      },
      ask: async () => "a",
      out: (l = "") => void out.push(l),
      err: (l) => void out.push(l),
    };
    expect(await approveCli([], { runDir, io })).toBe(0);
    expect(out.join("\n")).toMatch(/NOT TRUSTED: whatever answers for server \d+ could not prove/);
    expect(prompts).toEqual([]); // never even asked for the password
    const all = received.join("");
    expect(all).not.toContain(secret);
    expect(all).not.toContain(PW);
    expect(all).not.toMatch(/"mac"|"payload"|sealedPassword/);
    for (const line of all.split("\n").filter(Boolean)) expect(JSON.parse(line)).toMatchObject({ v: 2, op: "hello" });
  });

  it("a rendezvous whose pid now belongs to another user is not trusted", () => {
    const runDir = tempDir();
    if (POSIX) chmodSync(runDir, 0o700);
    const file = rendezvousFile(runDir, 4242);
    writeFileSync(file, JSON.stringify({ v: 1, pid: 4242, address: KEY.address, endpoint: "/x.sock", secret: "s".repeat(43) }), {
      mode: 0o600,
    });
    const d = discoverServers(runDir, { pidState: () => "other" });
    expect(d.servers).toEqual([]);
    expect(d.ignored[0]!.reason).toMatch(/belongs to another user/);
    expect(existsSync(file)).toBe(true); // not ours to delete either
  });

  it("list → the same review as the page (no page token, no CSRF) → approve with the password → the call signs", async () => {
    const runDir = join(tempDir(), "run");
    const { m, sent } = manager(runDir);
    const halt = await pending(m.request(txReq()));
    const info = serverInfo(runDir);
    const listed = await call(info, { op: "list" });
    const approvals = listed.approvals as TerminalReview[];
    expect(approvals).toHaveLength(1);
    const r = approvals[0]!;
    expect(r).toMatchObject({ approvalId: halt.approvalId, fingerprint: halt.fingerprint, kind: "tx-batch" });
    const rec = m.store.get(halt.approvalId)!;
    expect(JSON.stringify(listed)).not.toContain(rec.pathToken);
    expect(JSON.stringify(listed)).not.toContain(rec.csrf);
    // a decision about a review the terminal did not see is refused
    expect(await call(info, { op: "approve", approvalId: r.approvalId, binding: keccak256("0x00"), password: PW })).toMatchObject({
      ok: false,
      status: "refused",
    });
    expect(await call(info, { op: "approve", approvalId: r.approvalId, binding: r.binding, password: "" })).toMatchObject({
      status: "refused",
    });
    const ok = await call(info, { op: "approve", approvalId: r.approvalId, binding: r.binding, password: PW });
    expect(ok).toMatchObject({ ok: true, status: "approved" });
    const signer = await m.request(txReq());
    await signer.send({ to: TO, data: "0x12345678", value: "0", chainId: 97 });
    signer.finish();
    expect(sent).toEqual(["0x12345678"]);
    // already decided → nothing more to do in the terminal
    expect((await call(info, { op: "list" })).approvals).toEqual([]);
  });

  it("message approvals work the same way, and decline in the terminal starts the same cooldown", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const a = await pending(m.requestSignature(msgReq("login one")));
    const info = serverInfo(runDir);
    const [r] = (await call(info, { op: "list" })).approvals as TerminalReview[];
    expect(r!.kind).toBe("message");
    expect(await call(info, { op: "approve", approvalId: r!.approvalId, binding: r!.binding, password: PW })).toMatchObject({ ok: true });
    const s = await m.requestSignature(msgReq("login one"));
    expect(verifyMessage("login one", await s.signMessage(toUtf8Bytes("login one")))).toBe(KEY.address);
    expect(a.approvalId).toBe(r!.approvalId);

    const b = await pending(m.requestSignature(msgReq("login two")));
    const [r2] = (await call(info, { op: "list" })).approvals as TerminalReview[];
    expect(await call(info, { op: "decline", approvalId: r2!.approvalId, binding: r2!.binding })).toMatchObject({ status: "declined" });
    const again = await pending(m.requestSignature(msgReq("login two")));
    expect(again).toMatchObject({ status: "declined", approvalId: b.approvalId });
  });

  it("ONE lockout for both channels: wrong passwords on the page and in the terminal add up", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const p1 = await pending(m.request(txReq("0x00000001")));
    await pending(m.request(txReq("0x00000002")));
    const info = serverInfo(runDir);
    for (let i = 0; i < 3; i++) expect((await approveAsHuman(p1.url!, `wrong ${i}`)).status).toBe(401);
    const [, r2] = ((await call(info, { op: "list" })).approvals as TerminalReview[]).sort((x, y) => (x.approvalId === p1.approvalId ? -1 : 1));
    expect(await call(info, { op: "approve", approvalId: r2!.approvalId, binding: r2!.binding, password: "wrong 4" })).toMatchObject({
      status: "wrong-password",
    });
    const fifth = await call(info, { op: "approve", approvalId: r2!.approvalId, binding: r2!.binding, password: "wrong 5" });
    expect(String(fifth.message)).toMatch(/locked/);
    // Now the RIGHT password is refused in both places.
    expect(await call(info, { op: "approve", approvalId: r2!.approvalId, binding: r2!.binding, password: PW })).toMatchObject({
      status: "locked",
    });
    expect((await approveAsHuman(p1.url!, PW)).status).toBe(429);
    expect(m.view(r2!.approvalId)!.status).toBe("pending");
  });

  it("close() removes the rendezvous (and the socket)", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    await pending(m.request(txReq()));
    const info = serverInfo(runDir);
    await m.close();
    expect(existsSync(rendezvousFile(runDir, process.pid))).toBe(false);
    if (POSIX) expect(existsSync(info.endpoint)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("rendezvous trust and stale-server cleanup", () => {
  const ID: PosixIdentity = { platform: "linux", uid: 1000 };
  const st = (o: { file?: boolean; dir?: boolean; link?: boolean; sock?: boolean; uid?: number; mode?: number }) => ({
    isFile: () => !!o.file,
    isDirectory: () => !!o.dir,
    isSymbolicLink: () => !!o.link,
    isSocket: () => !!o.sock,
    uid: o.uid ?? 1000,
    mode: o.mode ?? 0o100600,
  });

  it("trusts only owner-only, non-symlink files, directories and sockets owned by the current user", () => {
    expect(trustProblem(st({ file: true }), "file", ID)).toBeNull();
    expect(trustProblem(st({ dir: true, mode: 0o40700 }), "dir", ID)).toBeNull();
    expect(trustProblem(st({ sock: true, mode: 0o140600 }), "socket", ID)).toBeNull();
    expect(trustProblem(st({ file: true, uid: 1001 }), "file", ID)).toMatch(/owned by uid 1001/);
    expect(trustProblem(st({ file: true, mode: 0o100644 }), "file", ID)).toMatch(/group\/other.*0644/);
    expect(trustProblem(st({ dir: true, mode: 0o40755 }), "dir", ID)).toMatch(/0755/);
    expect(trustProblem(st({ link: true, file: true }), "file", ID)).toMatch(/symbolic link/);
    expect(trustProblem(st({ file: true }), "socket", ID)).toMatch(/not a unix socket/);
    // Windows: Node cannot read ACLs; the profile directory's ACL is the check (documented).
    expect(trustProblem(st({ file: true, uid: 0, mode: 0o100666 }), "file", { platform: "win32", uid: -1 })).toBeNull();
  });

  it("removes the file of a server whose process is gone", () => {
    const runDir = tempDir();
    const child = spawnSync(process.execPath, ["-e", "0"]);
    const deadPid = child.pid!;
    const file = rendezvousFile(runDir, deadPid);
    writeFileSync(file, JSON.stringify({ v: 1, pid: deadPid, address: KEY.address, endpoint: "/x.sock", secret: "s".repeat(43) }), {
      mode: 0o600,
    });
    if (POSIX) chmodSync(runDir, 0o700);
    const d = discoverServers(runDir);
    expect(d.removed).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it("removes a live pid's file whose endpoint is gone (pid reuse / crash) — the CLI does it on connect", async () => {
    const runDir = tempDir();
    if (POSIX) chmodSync(runDir, 0o700);
    const endpoint = POSIX
      ? join(runDir, `approve-${process.pid}.sock`)
      : `\\\\.\\pipe\\dexe-mcp-approve-${process.pid}-${"0".repeat(32)}`;
    const file = rendezvousFile(runDir, process.pid);
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid, address: KEY.address, endpoint, secret: "s".repeat(43) }), {
      mode: 0o600,
    });
    const out: string[] = [];
    const io: ApproveIo = {
      isInteractive: () => false,
      promptHidden: async () => "",
      ask: async () => "",
      out: (l = "") => void out.push(l),
      err: (l) => void out.push(l),
    };
    expect(await approveCli(["--list"], { runDir, io })).toBe(0);
    expect(out.join("\n")).toMatch(/No running dexe-mcp server/);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!POSIX)("ignores (never connects to) a rendezvous file others could have written", async () => {
    const runDir = tempDir();
    chmodSync(runDir, 0o700);
    const file = rendezvousFile(runDir, process.pid);
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid, address: KEY.address, endpoint: "/tmp/evil.sock", secret: "s".repeat(43) }));
    chmodSync(file, 0o644);
    const d = discoverServers(runDir);
    expect(d.servers).toEqual([]);
    expect(d.ignored[0]!.reason).toMatch(/group\/other/);
    // a group-writable directory is not trusted at all
    const loose = tempDir();
    chmodSync(loose, 0o777);
    expect(discoverServers(loose).ignored[0]!.reason).toMatch(/the directory/);
    // a symlinked rendezvous is not followed
    const linkDir = tempDir();
    chmodSync(linkDir, 0o700);
    symlinkSync(file, rendezvousFile(linkDir, process.pid));
    expect(discoverServers(linkDir).ignored[0]!.reason).toMatch(/symbolic link/);
  });

  it.skipIf(!POSIX)("the server tightens a loose run directory it owns before writing the secret", async () => {
    const runDir = join(tempDir(), "run");
    mkdirSync(runDir, { mode: 0o755 });
    chmodSync(runDir, 0o755);
    const { m } = manager(runDir);
    await pending(m.request(txReq()));
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------

describe("dexe-mcp approve (CLI, in process)", () => {
  function fakeIo(answers: string[], passwords: string[], interactive = true) {
    const out: string[] = [];
    const prompts: string[] = [];
    const io: ApproveIo = {
      isInteractive: () => interactive,
      promptHidden: async (q) => {
        prompts.push(q);
        return passwords.shift() ?? "";
      },
      ask: async () => answers.shift() ?? "s",
      out: (l = "") => void out.push(l),
      err: (l) => void out.push(l),
    };
    return { io, out, prompts };
  }

  it("refuses to decide without an interactive terminal — before it even looks for a server", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    await pending(m.request(txReq()));
    const before = readdirSync(runDir).sort();
    const { io, out, prompts } = fakeIo(["a"], [PW], false);
    expect(await approveCli([], { runDir, io })).toBe(2);
    expect(out.join("\n")).toMatch(/needs an interactive terminal/);
    expect(prompts).toEqual([]);
    expect(readdirSync(runDir).sort()).toEqual(before);
    expect(m.store.open()[0]!.status).toBe("pending");
  });

  it("--list prints the review (no TTY needed) and decides nothing", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const halt = await pending(m.requestSignature(msgReq(`Sign in please${String.fromCodePoint(0x202e)}`)));
    const { io, out } = fakeIo([], [], false);
    expect(await approveCli(["--list"], { runDir, io })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(halt.fingerprint);
    expect(text).toContain("Sign a message");
    expect(text).toContain("Sign in please⟨U+202E⟩");
    expect(text).toMatch(/!! DANGER/);
    expect(m.view(halt.approvalId)!.status).toBe("pending");
  });

  it("interactive: review → approve → a wrong password is re-asked → the right one approves", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const halt = await pending(m.request(txReq()));
    const { io, out, prompts } = fakeIo(["a"], ["not it", PW]);
    expect(await approveCli([halt.approvalId], { runDir, io })).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(out.join("\n")).toMatch(/Wrong password\. 4 attempt\(s\) left/);
    expect(out.join("\n")).toMatch(/✔ Approved/);
    expect(m.view(halt.approvalId)!.status).toBe("approved");
    // the terminal never echoed the password
    expect(out.join("\n")).not.toContain(PW);
  });

  it("interactive: decline", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const halt = await pending(m.request(txReq()));
    const { io } = fakeIo(["d"], []);
    expect(await approveCli([], { runDir, io })).toBe(0);
    expect(m.view(halt.approvalId)!.status).toBe("declined");
  });

  it("the page and the terminal decide the same approval: once decided in one, the other sees it", async () => {
    const runDir = join(tempDir(), "run");
    const { m } = manager(runDir);
    const halt = await pending(m.request(txReq()));
    expect((await approveAsHuman(halt.url!, PW)).status).toBe(200);
    const { io, out } = fakeIo(["a"], [PW]);
    expect(await approveCli([halt.approvalId], { runDir, io })).toBe(1);
    expect(out.join("\n")).toMatch(/not waiting/);
    expect((await rawRequest(halt.url!)).body).toMatch(/This approval is approved/);
  });

  it("the terminal review cannot rewrite the screen (escape sequences are made visible)", () => {
    expect(tsafe(`a${String.fromCodePoint(0x1b)}[2Jb${String.fromCodePoint(0x202e)}c`)).toBe("a⟨U+001B⟩[2Jb⟨U+202E⟩c");
    // the same set the page marks — incl. the Arabic letter mark and blank-looking letters
    expect(tsafe(`x${String.fromCodePoint(0x61c)}y${String.fromCodePoint(0x2800)}z`)).toBe("x⟨U+061C⟩y⟨U+2800⟩z");
    const lines = renderTerminalReview({
      approvalId: "apr_x",
      kind: "tx-batch",
      tool: "dexe_tx_send",
      chainId: 97,
      chain: "BSC Testnet (97)",
      mainnet: false,
      from: KEY.address,
      fingerprint: "ABC-DEF",
      binding: "0x",
      createdAt: "",
      expiresAt: "",
      failures: 0,
      steps: [step("0x12345678")],
      prechecks: { guards: "pass", simulation: "pass" },
    });
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toMatch(/!! DANGER danger ⟨U\+001B⟩\[2Jflag/);
  });
});
