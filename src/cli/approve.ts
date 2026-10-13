import { createInterface } from "node:readline/promises";
import { isInteractive, promptHidden } from "./key.js";
import {
  ControlConnectError,
  controlRequest,
  currentIdentity,
  defaultRunDir,
  discoverServers,
  removeRendezvous,
  type PosixIdentity,
  type RendezvousInfo,
} from "../lib/approval/rendezvous.js";
import { renderTerminalReview, tsafe, type TerminalReview } from "../lib/approval/terminalReview.js";
import { safeErrorMessage } from "../lib/redact.js";

/**
 * `dexe-mcp approve` — decide keystore approvals in a terminal instead of the
 * browser page: for SSH sessions, and for owners who do not want to type the
 * password into a browser an AI agent may be driving.
 *
 *   dexe-mcp approve                 every approval waiting in the running server(s)
 *   dexe-mcp approve <approvalId>    just that one
 *   dexe-mcp approve --list          print the reviews only (works without a terminal)
 *   dexe-mcp approve --pid <n>       only the server with that process id
 *
 * It finds the server through the owner-only rendezvous in ~/.dexe-mcp/run
 * (src/lib/approval/rendezvous.ts), prints the same review as the page, and
 * asks for the keystore password with echo off. Deciding REFUSES without an
 * interactive terminal: an AI agent's shell is a pipe, and an agent piping a
 * password in is exactly what this must not allow. The password goes to the
 * server's one password check — the same lockout as the page — and is never
 * read from an argument, the environment or a file.
 */

export interface ApproveIo {
  isInteractive(): boolean;
  promptHidden(question: string): Promise<string>;
  ask(question: string): Promise<string>;
  out(line?: string): void;
  err(line: string): void;
}

export interface ApproveOptions {
  runDir?: string;
  io?: ApproveIo;
  id?: PosixIdentity;
}

export function approveUsage(): string {
  return [
    "dexe-mcp approve [<approvalId>] [--list] [--pid <n>]",
    "",
    "  Review and approve / decline the keystore approvals waiting in the running dexe-mcp server(s),",
    "  here in the terminal. The password is typed with echo off and checked by the server, under the",
    "  same wrong-password lockout as the approval page.",
    "",
    "  <approvalId>     only this approval (apr_…)",
    "  --list           print the reviews and exit (no terminal needed, decides nothing)",
    "  --pid <n>        only the server with this process id",
    "",
    "Deciding needs an interactive terminal — run it yourself, not through an AI agent.",
    "",
  ].join("\n");
}

function defaultIo(): ApproveIo {
  return {
    isInteractive,
    promptHidden,
    async ask(question: string) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    out: (line = "") => void process.stdout.write(`${line}\n`),
    err: (line: string) => void process.stderr.write(`${line}\n`),
  };
}

interface LiveServer {
  file: string;
  info: RendezvousInfo;
}

const GONE = new Set(["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"]);

export async function run(argv: readonly string[], opts: ApproveOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIo();
  const id = opts.id ?? currentIdentity();
  const runDir = opts.runDir ?? defaultRunDir();
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    io.out(approveUsage());
    return 0;
  }
  const listOnly = argv.includes("--list");
  let pid: number | undefined;
  let approvalId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--list") continue;
    if (a === "--pid") {
      pid = Number(argv[++i]);
      if (!Number.isInteger(pid) || pid <= 0) {
        io.err("[dexe-mcp approve] --pid needs a process id.");
        return 2;
      }
      continue;
    }
    if (/^apr_[A-Za-z0-9_-]{4,40}$/.test(a) && !approvalId) {
      approvalId = a;
      continue;
    }
    io.err(`[dexe-mcp approve] unexpected argument '${tsafe(a)}'.\n\n${approveUsage()}`);
    return 2;
  }
  if (!listOnly && !io.isInteractive()) {
    io.err(
      "[dexe-mcp approve] deciding an approval needs an interactive terminal (stdin/stdout is not a TTY here). " +
        "An AI agent's shell or a pipe cannot type the keystore password, by design. Run `npx dexe-mcp approve` " +
        "yourself in a terminal, or approve on the page the tool printed. (`--list` only prints the reviews.)",
    );
    return 2;
  }

  // ---- find the running server(s) -------------------------------------------
  const disc = discoverServers(runDir, { id });
  for (const g of disc.ignored) io.err(`[dexe-mcp approve] not trusted, ignored: ${tsafe(g.file)} — ${tsafe(g.reason)}`);
  const live: LiveServer[] = [];
  for (const s of disc.servers) {
    if (pid !== undefined && s.info.pid !== pid) continue;
    try {
      const hello = await controlRequest(s.info.endpoint, { v: 1, secret: s.info.secret, op: "hello" }, 10_000);
      if (hello.ok === true && hello.address === s.info.address) live.push(s);
      else io.err(`[dexe-mcp approve] server ${s.info.pid} did not authenticate (${tsafe(String(hello.status ?? "?"))}) — ignored.`);
    } catch (e) {
      if (e instanceof ControlConnectError && GONE.has(e.code ?? "")) {
        removeRendezvous(s.file, id); // a server that died without cleaning up
      } else {
        io.err(`[dexe-mcp approve] server ${s.info.pid}: ${tsafe(safeErrorMessage(e))}`);
      }
    }
  }
  if (live.length === 0) {
    io.out(
      `No running dexe-mcp server has terminal approvals open (looked in ${runDir}). The channel starts with the first ` +
        "approval a keystore-mode server asks for; approvals of a server that restarted are gone.",
    );
    return approvalId ? 1 : 0;
  }

  // ---- collect what is waiting -------------------------------------------------
  const waiting: Array<{ server: LiveServer; review: TerminalReview }> = [];
  for (const s of live) {
    try {
      const res = await controlRequest(s.info.endpoint, { v: 1, secret: s.info.secret, op: "list" }, 30_000);
      for (const r of (res.approvals as TerminalReview[] | undefined) ?? []) {
        if (!approvalId || r.approvalId === approvalId) waiting.push({ server: s, review: r });
      }
      const locked = Number(res.lockedForMs ?? 0);
      if (locked > 0) io.out(`(server ${s.info.pid}: password entry is locked for another ${Math.ceil(locked / 1000)} s after wrong passwords)`);
    } catch (e) {
      io.err(`[dexe-mcp approve] server ${s.info.pid}: ${tsafe(safeErrorMessage(e))}`);
    }
  }
  if (waiting.length === 0) {
    io.out(approvalId ? `Approval ${approvalId} is not waiting (decided, expired, or unknown).` : "No approvals are waiting.");
    return approvalId ? 1 : 0;
  }
  if (live.length > 1) {
    io.out(`${live.length} dexe-mcp servers are running; each approval below names its server (pid) and keystore address.`);
  }

  // ---- review and decide ---------------------------------------------------------
  let failed = false;
  for (const { server, review } of waiting) {
    io.out("");
    for (const line of renderTerminalReview(review)) io.out(line);
    io.out(`  server pid ${server.info.pid} · keystore ${server.info.address}`);
    if (listOnly) continue;
    let decided = false;
    while (!decided) {
      const choice = (await io.ask("Approve (a), decline (d) or skip (s)? ")).toLowerCase();
      if (choice === "s" || choice === "skip" || choice === "") {
        io.out("  skipped — nothing changed.");
        break;
      }
      if (choice === "d" || choice === "decline") {
        const res = await send(server, { op: "decline", approvalId: review.approvalId, binding: review.binding }, io);
        if (!res) failed = true;
        decided = true;
        continue;
      }
      if (choice !== "a" && choice !== "approve") continue;
      io.out(`  Check: the fingerprint above (${review.fingerprint}) is the one in your chat.`);
      for (let attempt = 0; attempt < 3; attempt++) {
        let password: string;
        try {
          password = await io.promptHidden("  Keystore password (hidden): ");
        } catch {
          io.out("  aborted — nothing changed.");
          return 1;
        }
        if (!password) {
          io.out("  empty — nothing sent.");
          break;
        }
        const res = await send(
          server,
          { op: "approve", approvalId: review.approvalId, binding: review.binding, password },
          io,
        );
        password = "";
        if (res?.status === "wrong-password") continue;
        if (!res || res.ok !== true) failed = true;
        break;
      }
      decided = true;
    }
  }
  return failed ? 1 : 0;
}

async function send(server: LiveServer, body: Record<string, unknown>, io: ApproveIo): Promise<Record<string, unknown> | null> {
  try {
    const res = await controlRequest(server.info.endpoint, { v: 1, secret: server.info.secret, ...body }, 150_000);
    io.out(`  ${res.ok === true ? "✔" : "✗"} ${tsafe(String(res.message ?? res.status ?? ""))}`);
    return res;
  } catch (e) {
    io.err(`  ✗ could not reach the server: ${tsafe(safeErrorMessage(e))}`);
    return null;
  }
}
