import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { ENV_SPEC } from "../../src/env/schema.js";

/**
 * 2c Phase A — the keystore approval gate cannot be switched off.
 *
 * The design's promise is "no parameter or env var disables the gate": the
 * only way from `pending` to `approved` is the owner's password on the
 * loopback page or in `dexe-mcp approve` (a TTY), for transaction batches,
 * messages and Safe transactions alike. This ratchet greps src/ for every shape a future shortcut
 * would take — an env flag, a tool parameter, a second caller of the store's
 * approve(), a decrypt outside the known places, an approve/decline tool — and
 * fails the build on it. Adding one must be a deliberate edit HERE, in review.
 */
const SRC = resolve(__dirname, "..", "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(e.name) && !/\.generated\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));

function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of FILES) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) out.push(`${f.rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("the approval gate has no off switch", () => {
  it("no env var can auto-approve, skip or bypass approvals", () => {
    expect(hits(/DEXE_[A-Z0-9_]*(AUTO_?APPROV|SKIP_?APPROV|NO_?APPROV|BYPASS|APPROV[A-Z_]*_(OFF|DISABLE|SKIP|AUTO))/)).toEqual([]);
    const approvalVars = Object.keys(ENV_SPEC).filter((k) => /APPROV/.test(k));
    expect(approvalVars.sort()).toEqual([
      "DEXE_APPROVAL_OPEN_BROWSER",
      "DEXE_APPROVAL_TTL_S",
      "DEXE_APPROVAL_USE_S",
      "DEXE_APPROVAL_WAIT_MS",
      "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS", // the phone's own timeout, not this gate
    ]);
  });

  it("no tool parameter or code path named like an approval shortcut", () => {
    expect(
      hits(/\b(autoApprove|auto_approve|skipApproval|skip_approval|bypassApproval|approvalBypass|noApproval|forceApprove|approveWithoutPassword|preApproved)\b/i),
    ).toEqual([]);
  });

  it("ApprovalStore.approve() has exactly one caller: the password check behind the page and the terminal", () => {
    const callers = hits(/\bstore\.approve\(/);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatch(/^lib\/approval\/index\.ts:/);
    // ...and that function is reached only from the HTTP server's password POST
    // and the terminal channel's `approve` op (2c Phase B), both through the
    // manager's one queued, lockout-checked password check.
    const attempt = hits(/attemptApprove\(/).map((h) => h.split(":")[0]);
    expect(new Set(attempt)).toEqual(
      new Set(["lib/approval/index.ts", "lib/approval/server.ts", "lib/approval/control.ts"]),
    );
    const idx = FILES.find((f) => f.rel === "lib/approval/index.ts")!.text;
    // Both channels are wired to passwordAttempt (queue + lockout), never to the raw decrypt.
    expect(idx.match(/attemptApprove: \(r, pw\) => this\.passwordAttempt\(r, pw\)/g)).toHaveLength(2);
    // The terminal channel reaches it only with a non-empty password.
    const ctl = FILES.find((f) => f.rel === "lib/approval/control.ts")!.text;
    const pwCheck = ctl.indexOf("if (!password || password.length > 1024)");
    const call = ctl.indexOf("this.deps.attemptApprove(record, password)");
    expect(pwCheck).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(pwCheck);
  });

  it("key holders (transaction batches AND signatures) are created only inside the password check", () => {
    const signers = hits(/new ApprovedSigner\(/).map((h) => h.split(":")[0]);
    const signatures = hits(/new ApprovedSignature\(/).map((h) => h.split(":")[0]);
    expect(signers).toEqual(["lib/approval/index.ts"]);
    expect(signatures).toEqual(["lib/approval/index.ts"]);
  });

  it("every message / typed-data signature is a known path: an approval, unattended, or WalletConnect", () => {
    // A new raw `.signMessage(` / `.signTypedData(` anywhere is a new way to
    // sign without the owner — it must be added here, in review.
    const sites = hits(/\.(signMessage|signTypedData)\(/).map((h) => h.replace(/:\d+:/, ":").replace(/\s+/g, " "));
    expect(sites.sort()).toEqual(
      [
        // the ApprovedSignature: exactly the approved bytes / digest, once
        "lib/approval/signing.ts: return await new Wallet(key).signMessage(bytes);",
        "lib/approval/signing.ts: return await new Wallet(key).signTypedData(domain, types, value);",
        // unattended hot key (keystore mode throws before it, see signer-mode tests)
        "lib/signer.ts: return new Wallet(key).signMessage(message);",
        // dexe_auth_login: unattended / WalletConnect, and the keystore approval
        "tools/proposalBuildOffchain.ts: const signature = eoa ? await signer.signMessage(message, undefined, BACKEND_AUTH_CHAIN_ID) : await wc.signMessage(message);",
        "tools/proposalBuildOffchain.ts: const signature = await approved.signMessage(message);",
        // dexe_safe_propose_tx: the keystore approval, and the unattended wallet
        "tools/safe.ts: signature = await approved.signTypedData(typed.domain, typed.types, typed.message);",
        "tools/safe.ts: signature = await wallet.signTypedData(safeTxDomain(chainId, safe), SAFE_TX_TYPES, tx);",
      ].sort(),
    );
  });

  it("no lower-level signing primitive is used anywhere (raw digest / raw transaction signing)", () => {
    // A SigningKey or signTransaction() signs without any of the checks above:
    // a digest of anything, a transaction nobody reviewed. None may exist in src.
    expect(hits(/\bsigningKey\.sign\(|\.signDigest\(|\bsignTransaction\(|new SigningKey\(|\bSigningKey\b.*\.sign\(/)).toEqual([]);
  });

  it("typed data is signed for SafeTx only; permits never", async () => {
    const { SIGNABLE_PRIMARY_TYPES } = await import("../../src/lib/approval/signing.js");
    expect([...SIGNABLE_PRIMARY_TYPES]).toEqual(["SafeTx"]);
  });

  it("the terminal channel has no op that decides without the password, and the CLI reads it only from a TTY", () => {
    const ctl = FILES.find((f) => f.rel === "lib/approval/control.ts")!.text;
    const ops = [...ctl.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).sort();
    expect(ops).toEqual(["approve", "decline", "hello", "list"]);
    // The secret never crosses the wire (a request carrying one is refused), and
    // a password is accepted only sealed — never as a plain request field.
    expect(ctl).toMatch(/"secret" in msg/);
    expect(ctl).not.toMatch(/req\.password\b/);
    expect(ctl).toMatch(/openPassword\(this\.secret/);
    const cli = FILES.find((f) => f.rel === "cli/approve.ts")!.text;
    // No password from an argument, the environment, a file or a pipe.
    expect(cli).not.toMatch(/process\.env/);
    expect(cli).not.toMatch(/--password|PASSWORD|readFileSync|stdin\.on\(/);
    expect(cli).toMatch(/password = await io\.promptHidden\(/);
    // Deciding refuses without an interactive terminal, before anything else runs.
    const refusal = cli.indexOf("if (!listOnly && !io.isInteractive())");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(cli.indexOf("discoverServers(runDir"));
    // The hidden prompt itself reads raw keystrokes from the TTY only.
    const key = FILES.find((f) => f.rel === "cli/key.ts")!.text;
    expect(key).toMatch(/stdin\.setRawMode\(true\)/);
  });

  it("the keystore is decrypted only on the approval page, by the key CLI, and for unattended password files", () => {
    const files = new Set(hits(/\bdecryptKeystore\(/).map((h) => h.split(":")[0]));
    files.delete("lib/keystore.ts"); // the definition
    expect([...files].sort()).toEqual(["cli/key.ts", "config.ts", "lib/approval/index.ts"]);
    // config.ts decrypts only in unattended mode with a password file.
    const cfg = FILES.find((f) => f.rel === "config.ts")!.text;
    expect(cfg).toMatch(/if \(signerMode === "unattended" && !privateKey && passwordFile\)/);
  });

  it("no tool can approve or decline — the one approval tool is read-only", () => {
    // (dexe_vote_build_erc20_approve builds an ERC20 approve() payload — unrelated.)
    const named = [...READ_TOOLS, ...WRITE_TOOLS].filter((t) => /approval|declin/.test(t));
    expect(named).toEqual(["dexe_tx_approval_status"]);
    const ann = FILES.find((f) => f.rel === "tools/annotationsWrite.ts")!.text;
    expect(ann).toMatch(/dexe_tx_approval_status: LOCAL_READ/);
  });

  it("nothing in the approval code reads process.env (configuration arrives through the config)", () => {
    // openBrowser.ts is the one exception: it checks DISPLAY / WAYLAND_DISPLAY to
    // know whether there is a desktop to open a tab on — never a gate setting.
    const envReads = hits(/process\.env/).filter(
      (h) =>
        (h.startsWith("lib/approval/") || h.startsWith("cli/approve.ts")) &&
        !/^lib\/approval\/openBrowser\.ts:\d+: .*deps\.env \?\? process\.env/.test(h),
    );
    expect(envReads).toEqual([]);
  });
});
