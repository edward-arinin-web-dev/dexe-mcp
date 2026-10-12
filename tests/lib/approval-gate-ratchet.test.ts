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
 * loopback page. This ratchet greps src/ for every shape a future shortcut
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
      "DEXE_APPROVAL_WAIT_MS",
      "DEXE_WALLETCONNECT_APPROVAL_TIMEOUT_MS", // the phone's own timeout, not this gate
    ]);
  });

  it("no tool parameter or code path named like an approval shortcut", () => {
    expect(
      hits(/\b(autoApprove|auto_approve|skipApproval|skip_approval|bypassApproval|approvalBypass|noApproval|forceApprove|approveWithoutPassword|preApproved)\b/i),
    ).toEqual([]);
  });

  it("ApprovalStore.approve() has exactly one caller: the password check behind the loopback page", () => {
    const callers = hits(/\bstore\.approve\(/);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatch(/^lib\/approval\/index\.ts:/);
    // ...and that function is reached only from the HTTP server's password POST.
    const attempt = hits(/attemptApprove\(/).map((h) => h.split(":")[0]);
    expect(new Set(attempt)).toEqual(new Set(["lib/approval/index.ts", "lib/approval/server.ts"]));
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
      (h) => h.startsWith("lib/approval/") && !/^lib\/approval\/openBrowser\.ts:\d+: .*deps\.env \?\? process\.env/.test(h),
    );
    expect(envReads).toEqual([]);
  });
});
