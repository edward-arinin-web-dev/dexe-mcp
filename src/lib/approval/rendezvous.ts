import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAddress, isAddress } from "ethers";
import { renameWithRetry, tempStatePath } from "@dexe-network/dexe-mcp/core";

/**
 * ── How `dexe-mcp approve` finds the running server (the rendezvous) ───────
 *
 * The MCP server that holds the approvals is a child of the AI client, with
 * no terminal. A human in another terminal finds it like this:
 *
 *   ~/.dexe-mcp/run/                 0700, owned by you
 *     approve-<pid>.json             0600, owned by you, written atomically:
 *       { v, pid, address, endpoint, secret, createdAt, version }
 *
 *   endpoint  POSIX:   ~/.dexe-mcp/run/approve-<pid>.sock (a unix socket, 0600,
 *                      in the 0700 directory — the kernel refuses every other
 *                      user before a byte is exchanged)
 *             Windows: \\.\pipe\dexe-mcp-approve-<pid>-<128 random bits> (a
 *                      named pipe: libuv creates it as the FIRST instance, so a
 *                      pre-created squatting pipe makes the server's bind fail
 *                      instead of sharing it; the default pipe DACL lets only
 *                      you, SYSTEM and Administrators write to it)
 *   secret    256 random bits, per process. It never crosses the channel:
 *             the server first proves it holds it (HMAC over the client's
 *             nonce), then each request carries an HMAC instead and the
 *             password travels sealed (controlProtocol.ts).
 *
 * Owner-only, twice: the file system (only you can read the secret or the
 * socket) and the secret (only a reader of your file can speak to the
 * channel, and the server must prove it holds it before the CLI sends
 * anything secret). The CLI trusts a rendezvous file only if the directory,
 * the file and (POSIX) the socket are owned by the current user, grant nothing
 * to group or others, and are not symlinks — a file another local user
 * planted would point at THEIR socket and harvest your password — and only
 * while its pid is ours (EPERM = another user's process now: untrusted). Node
 * cannot read Windows ACLs or a pipe server's process id
 * (GetNamedPipeServerProcessId is not reachable), so on Windows the profile
 * directory's default ACL plus the server's proof of the secret carry it
 * (documented in docs/SIGNING.md).
 *
 * What it does NOT stop: a process running as YOU (an AI agent with a shell)
 * can read the secret, talk to the channel, or replace the file with its own
 * look-alike server. The channel exposes nothing such a process could not do
 * through the approval page; the password stays the gate.
 *
 * Stale entries: the server removes its file on exit; a killed server leaves
 * one behind, which the next server or `dexe-mcp approve` deletes when the pid
 * is gone or the endpoint no longer answers.
 */

export const RENDEZVOUS_VERSION = 1;
const FILE_RE = /^approve-(\d{1,10})\.json$/;
const PIPE_PREFIX = "\\\\.\\pipe\\dexe-mcp-approve-";

export interface RendezvousInfo {
  v: 1;
  pid: number;
  address: string;
  endpoint: string;
  secret: string;
  createdAt: string;
  version: string;
}

export interface PosixIdentity {
  platform: NodeJS.Platform;
  /** Current uid on POSIX; ignored on win32. */
  uid: number;
}

export function currentIdentity(): PosixIdentity {
  return { platform: process.platform, uid: typeof process.getuid === "function" ? process.getuid() : -1 };
}

/** ~/.dexe-mcp/run */
export function defaultRunDir(home: string = homedir()): string {
  return join(home, ".dexe-mcp", "run");
}

export function rendezvousFile(runDir: string, pid: number): string {
  return join(runDir, `approve-${pid}.json`);
}

/**
 * Why `st` must not be trusted, or null. Pure (tests pass fake stats).
 * On win32 Node reports no owner and synthetic modes, so nothing is checked.
 */
export function trustProblem(
  st: Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink" | "isSocket" | "uid" | "mode">,
  expect: "dir" | "file" | "socket",
  id: PosixIdentity,
): string | null {
  if (id.platform === "win32") return null;
  if (st.isSymbolicLink()) return "is a symbolic link";
  if (expect === "dir" && !st.isDirectory()) return "is not a directory";
  if (expect === "file" && !st.isFile()) return "is not a regular file";
  if (expect === "socket" && !st.isSocket()) return "is not a unix socket";
  if (st.uid !== id.uid) return `is owned by uid ${st.uid}, not by you (uid ${id.uid})`;
  const loose = st.mode & 0o077;
  if (loose !== 0) return `grants group/other permissions (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")})`;
  return null;
}

/** Create (or tighten) the run directory; throws if it cannot be made owner-only. */
export function prepareRunDir(dir: string, id: PosixIdentity = currentIdentity()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (id.platform === "win32") return;
  let st = lstatSync(dir);
  if (st.isDirectory() && !st.isSymbolicLink() && st.uid === id.uid && (st.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    st = lstatSync(dir);
  }
  const p = trustProblem(st, "dir", id);
  if (p) throw new Error(`${dir} ${p} — refusing to put the terminal-approval secret there.`);
}

/** Write the rendezvous file atomically, 0600. */
export function writeRendezvous(dir: string, info: RendezvousInfo): string {
  const path = rendezvousFile(dir, info.pid);
  const tmp = tempStatePath(path);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  return path;
}

/** True alive, false gone, "other" alive but not signalable by us (another user's pid). */
export function pidState(pid: number): "alive" | "gone" | "other" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM" ? "other" : "gone";
  }
}

function parseInfo(raw: string, pidFromName: number): RendezvousInfo | string {
  let j: Partial<RendezvousInfo>;
  try {
    j = JSON.parse(raw) as Partial<RendezvousInfo>;
  } catch {
    return "is not JSON";
  }
  if (j.v !== RENDEZVOUS_VERSION) return `has version ${String(j.v)}, expected ${RENDEZVOUS_VERSION}`;
  if (j.pid !== pidFromName) return "names another pid than its file name";
  if (typeof j.secret !== "string" || j.secret.length < 32) return "has no usable secret";
  if (typeof j.address !== "string" || !isAddress(j.address)) return "has no keystore address";
  if (typeof j.endpoint !== "string") return "has no endpoint";
  return {
    v: 1,
    pid: j.pid,
    address: getAddress(j.address),
    endpoint: j.endpoint,
    secret: j.secret,
    createdAt: String(j.createdAt ?? ""),
    version: String(j.version ?? ""),
  };
}

/** Is `endpoint` an IPC endpoint of the shape this server creates (never a host:port)? */
export function endpointProblem(endpoint: string, id: PosixIdentity): string | null {
  if (id.platform === "win32") {
    return endpoint.startsWith(PIPE_PREFIX) && /^[A-Za-z0-9\\.:_-]+$/.test(endpoint) ? null : "is not a dexe-mcp named pipe";
  }
  if (!isAbsolute(endpoint) || !endpoint.endsWith(".sock")) return "is not an absolute unix-socket path";
  let st: Stats;
  try {
    st = lstatSync(endpoint);
  } catch {
    return "does not exist (the server is gone)";
  }
  return trustProblem(st, "socket", id);
}

export interface Discovery {
  servers: Array<{ file: string; info: RendezvousInfo }>;
  /** Files that were not trusted, and why. */
  ignored: Array<{ file: string; reason: string }>;
  /** Stale files removed (their process is gone). */
  removed: string[];
}

/** Read every trustworthy rendezvous file in `dir`; delete the ones whose process is gone. */
export function discoverServers(
  dir: string,
  opts: { id?: PosixIdentity; pidState?: (pid: number) => "alive" | "gone" | "other" } = {},
): Discovery {
  const id = opts.id ?? currentIdentity();
  const state = opts.pidState ?? pidState;
  const out: Discovery = { servers: [], ignored: [], removed: [] };
  if (!existsSync(dir)) return out;
  const dirProblem = trustProblem(lstatSync(dir), "dir", id);
  if (dirProblem) {
    out.ignored.push({ file: dir, reason: `the directory ${dirProblem}` });
    return out;
  }
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    const read = readTrusted(file, id);
    if (read === null) continue;
    if ("problem" in read) {
      out.ignored.push({ file, reason: read.problem });
      continue;
    }
    const pid = Number(m[1]);
    const ps = state(pid);
    if (ps === "gone") {
      removeRendezvous(file, id);
      out.removed.push(file);
      continue;
    }
    if (ps === "other") {
      // Alive but not ours to signal: that pid now belongs to another user —
      // whatever answers at the endpoint is not the server that wrote this.
      out.ignored.push({ file, reason: `pid ${pid} belongs to another user now (the server that wrote it is gone)` });
      continue;
    }
    const info = parseInfo(read.raw, pid);
    if (typeof info === "string") {
      out.ignored.push({ file, reason: info });
      continue;
    }
    const ep = endpointProblem(info.endpoint, id);
    if (ep) {
      if (/does not exist/.test(ep)) {
        removeRendezvous(file, id);
        out.removed.push(file);
      } else {
        out.ignored.push({ file, reason: `its endpoint ${ep}` });
      }
      continue;
    }
    out.servers.push({ file, info });
  }
  return out;
}

/**
 * Read a rendezvous file without a check-then-use window: open it once
 * (refusing a symlink with O_NOFOLLOW where the OS has it), check ownership
 * and mode on THAT descriptor (fstat), and read from the same descriptor —
 * a file swapped between the check and the read is never the one read.
 * null = vanished meanwhile.
 */
function readTrusted(file: string, id: PosixIdentity): { raw: string } | { problem: string } | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return { problem: "is a symbolic link" };
    return null;
  }
  try {
    const problem = trustProblem(fstatSync(fd), "file", id);
    if (problem) return { problem };
    return { raw: readFileSync(fd, "utf8") };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Delete a rendezvous file and (POSIX) the socket it names, when both are ours. */
export function removeRendezvous(file: string, id: PosixIdentity = currentIdentity()): void {
  let endpoint: string | undefined;
  try {
    endpoint = (JSON.parse(readFileSync(file, "utf8")) as { endpoint?: string }).endpoint;
  } catch {
    endpoint = undefined;
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
  if (endpoint && id.platform !== "win32" && isAbsolute(endpoint) && endpoint.endsWith(".sock")) {
    try {
      const st = lstatSync(endpoint);
      if (st.isSocket() && st.uid === id.uid) unlinkSync(endpoint);
    } catch {
      /* gone */
    }
  }
}
