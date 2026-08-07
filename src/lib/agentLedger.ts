import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { debugLog } from "../runtime.js";
import { redactUrlCredentials, safeErrorMessage } from "./redact.js";
import {
  lockBackoffMs,
  renameWithRetry,
  resolveStatePath,
  tempStatePath,
  withWriteLock,
} from "./stateStore.js";

/**
 * Agent action ledger (0.32.0) — the attribution substrate for multi-agent
 * orchestration.
 *
 * An orchestrator driving 8 keyring personas could previously not answer the
 * first question anyone asks after a run: *which agent did what, and what did
 * it cost?* Nothing recorded the signer behind a broadcast, so per-persona
 * attribution and any spend guard (SWARM_DAILY_BNB_BUDGET was documented as
 * enforced and read by no code) had nothing to stand on. This file is that
 * record:
 *
 *  - `AgentLedger`      — durable, capped, append-only log of every broadcast,
 *                         keyed by signerKey and carrying the resolved address,
 *                         chain, tx hash, initiating tool, description, time
 *                         and outcome.
 *  - `spendSince()`     — per-signerKey and total spend over a rolling window,
 *                         native value + gas, so a budget guard can consult a
 *                         number instead of a promise.
 *  - `attachBroadcastRecorder()` — the signer-side hook: once a wallet is
 *                         attributed, every `sendTransaction` on it is logged
 *                         whether or not the call site remembered to.
 *
 * **Persistence is stateStore's, not a second scheme.** The concurrency
 * hazards are identical (every Claude Code window and every swarm process
 * shares one file), and 0.30.4 already paid for the answer there: private temp
 * per writer + atomic rename with jittered backoff, a cross-process lock around
 * read-modify-write, and a content compare-and-swap at publish so even an
 * unlocked writer cannot clobber records it never read. This module composes
 * those exported primitives (`withWriteLock`, `tempStatePath`,
 * `renameWithRetry`, `lockBackoffMs`) rather than reimplementing them.
 *
 * **Nothing here may hold key material.** Two independent defenses:
 *   1. structure — only `signerKey` labels and 20-byte addresses are ever
 *      stored; the ledger is never handed a key;
 *   2. a scrubber — free text and hex-shaped fields are masked, and any token
 *      whose SHA-256 matches a registered secret digest is replaced. The
 *      digests (not the secrets) are registered by `SignerManager`, so even a
 *      caller that passes a private key as a "description" or a "tx hash"
 *      cannot get it onto disk.
 *
 * Every write is best-effort: a read-only home directory, a full disk or a
 * wedged peer degrades to a debug line. Bookkeeping must never turn a landed
 * on-chain transaction into a failed tool call.
 */

export const LEDGER_VERSION = 1;

/** Default retention. An autonomous fleet writes forever; the file may not grow forever. */
export const DEFAULT_MAX_ENTRIES = 500;
/** Ceiling on the `DEXE_AGENT_LEDGER_MAX` override — a 5k-entry file is ~2MB of JSON. */
export const MAX_MAX_ENTRIES = 5_000;
const MIN_MAX_ENTRIES = 10;

/** Rolling window a daily budget guard asks about. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** How many times a mutation recomputes after losing the compare-and-swap (mirrors stateStore). */
const CAS_ATTEMPTS = 5;

/** Free-text caps — a ledger entry is a label, never a log dump. */
const MAX_ACTION_CHARS = 200;
const MAX_NOTE_CHARS = 300;

/**
 * Outcome of one attributed broadcast:
 *   broadcast — accepted by the node, receipt not seen yet (value + estimated gas at risk)
 *   confirmed — mined with status 1
 *   reverted  — mined with status 0 (gas spent, value returned)
 *   failed    — never left this process (guard refusal, RPC rejection) — spends nothing
 */
export type LedgerOutcome = "broadcast" | "confirmed" | "reverted" | "failed";

export interface AgentAction {
  /** Stable per-entry id (settlement target; unique within this file). */
  id: string;
  /** Keyring slot that signed: "agent1".."agent16", "funder", or "primary". */
  signerKey: string;
  /** Resolved EOA (checksummed). Addresses yes, keys never. */
  address: string;
  chainId: number;
  /** MCP tool that initiated the broadcast, e.g. "dexe_agents_fund". */
  tool: string;
  /** Short human description of what was attempted. */
  action: string;
  txHash?: string;
  outcome: LedgerOutcome;
  /** ISO-8601 timestamp of the broadcast. */
  at: string;
  /** Native value moved, wei, decimal string. */
  valueWei: string;
  /** Gas cost: upper-bound estimate while pending, actual fee once settled. */
  gasWei: string;
  /** Redacted failure note, when the outcome is `reverted`/`failed`. */
  note?: string;
}

export interface AgentActionInput {
  signerKey: string;
  address: string;
  chainId: number;
  tool?: string;
  action?: string;
  txHash?: string;
  outcome?: LedgerOutcome;
  valueWei?: bigint | string | number;
  gasWei?: bigint | string | number;
  note?: string;
  /** ISO-8601 override (tests / backfill). Defaults to now. */
  at?: string;
}

export interface LedgerFile {
  version: number;
  /** Newest first. */
  entries: AgentAction[];
}

/* ─────────────────────────── secret-digest registry ──────────────────────── */

/**
 * SHA-256 of every configured private key, so the scrubber can recognize one
 * without ever holding one. Registration is one-way by construction: a digest
 * cannot be turned back into the key, and the set is process-local.
 */
const secretDigests = new Set<string>();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Normalize a hex token for digesting: lowercase, no 0x prefix. */
function normalizeHex(token: string): string {
  const t = token.trim().toLowerCase();
  return t.startsWith("0x") ? t.slice(2) : t;
}

/**
 * Register secrets the ledger must never write. Stores digests only — the
 * caller's values are not retained. Called by `SignerManager` for the primary
 * key and every keyring slot.
 */
export function registerLedgerSecrets(values: Iterable<string | undefined>): void {
  for (const v of values) {
    if (!v) continue;
    const norm = normalizeHex(v);
    if (norm.length < 32) continue; // too short to be a key; not worth a digest
    secretDigests.add(digest(norm));
  }
}

/** True when `token` is a registered secret. Never logs or returns the token. */
export function isRegisteredSecret(token: string): boolean {
  if (secretDigests.size === 0) return false;
  return secretDigests.has(digest(normalizeHex(token)));
}

/** Test hook: forget every registered digest. */
export function __resetLedgerSecrets(): void {
  secretDigests.clear();
}

/* ──────────────────────────────── scrubbing ──────────────────────────────── */

/** Any 32-byte hex token — the shape of both a private key and a tx hash. */
const HEX32_RE = /(?:0x)?[0-9a-fA-F]{64}/g;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const REDACTED = "0x<redacted-32-bytes>";

/**
 * Mask secrets in free text.
 *
 * A 32-byte hex token is a private key and a tx hash at the same time — the
 * shapes are identical — so text is masked structurally: every such token is
 * replaced unless it is exactly the entry's own tx hash (which we set
 * ourselves, from the broadcast) or is provably not a registered secret AND the
 * caller asked to keep hashes. Registered secrets are always removed, whatever
 * the context. URL credentials go through the shared redactor (W36).
 */
export function scrubLedgerText(text: string, keepHash?: string): string {
  const keep = keepHash ? keepHash.trim().toLowerCase() : undefined;
  return redactUrlCredentials(text).replace(HEX32_RE, (m) => {
    if (isRegisteredSecret(m)) return REDACTED;
    const norm = m.trim().toLowerCase();
    const withPrefix = norm.startsWith("0x") ? norm : `0x${norm}`;
    return keep && withPrefix === keep ? m : REDACTED;
  });
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Wei normalizer: bigint / decimal string / number → non-negative decimal string. */
export function toWeiString(v: bigint | string | number | undefined): string {
  if (v === undefined || v === null) return "0";
  try {
    const n = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : v.trim());
    return n > 0n ? n.toString() : "0";
  } catch {
    return "0";
  }
}

let entrySeq = 0;

function nextId(): string {
  entrySeq = (entrySeq + 1) >>> 0;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${entrySeq.toString(36)}`;
}

/**
 * Turn caller input into a storable entry: validated structure, scrubbed text,
 * clamped lengths. A field that fails validation is dropped or replaced, never
 * stored raw — this is the last gate before bytes hit the disk.
 */
export function normalizeAction(input: AgentActionInput): AgentAction {
  const signerKeyRaw = String(input.signerKey ?? "").trim().toLowerCase();
  const signerKey =
    SIGNER_KEY_RE.test(signerKeyRaw) && !isRegisteredSecret(signerKeyRaw) ? signerKeyRaw : "unknown";
  const address = ADDRESS_RE.test(String(input.address ?? "").trim()) ? String(input.address).trim() : "";
  const txHashRaw = input.txHash ? String(input.txHash).trim() : "";
  // A tx hash and a private key are the same shape, so a registered secret in
  // this slot is dropped rather than stored — the one place structure alone
  // cannot tell them apart.
  const txHash = TX_HASH_RE.test(txHashRaw) && !isRegisteredSecret(txHashRaw) ? txHashRaw : undefined;
  const chainId = Number.isFinite(Number(input.chainId)) ? Number(input.chainId) : 0;
  const tool = clamp(scrubLedgerText(String(input.tool ?? "unknown").trim() || "unknown"), 64);
  const action = clamp(scrubLedgerText(String(input.action ?? "").trim(), txHash), MAX_ACTION_CHARS);
  const note = input.note ? clamp(scrubLedgerText(String(input.note), txHash), MAX_NOTE_CHARS) : undefined;
  return {
    id: nextId(),
    signerKey,
    address,
    chainId,
    tool,
    action,
    ...(txHash ? { txHash } : {}),
    outcome: input.outcome ?? "broadcast",
    at: typeof input.at === "string" && input.at ? input.at : new Date().toISOString(),
    valueWei: toWeiString(input.valueWei),
    gasWei: toWeiString(input.gasWei),
    ...(note ? { note } : {}),
  };
}

/* ─────────────────────────────── spend view ──────────────────────────────── */

export interface SpendRow {
  signerKey: string;
  address?: string;
  actions: number;
  /** Native value counted as spent, wei. */
  valueWei: string;
  /** Gas counted as spent, wei. */
  gasWei: string;
  /** valueWei + gasWei. */
  totalWei: string;
}

export interface SpendReport {
  /** Inclusive lower bound of the window (ISO-8601). */
  since: string;
  windowMs: number;
  chainId?: number;
  /** Everything in the window, summed. */
  total: SpendRow;
  /** Per-signerKey, biggest spender first. */
  byAgent: SpendRow[];
}

/**
 * What one entry counts as spent. Deliberately conservative — a budget guard
 * that under-counts is a budget guard that lets the fleet through:
 *   broadcast (in flight) → value + the upper-bound gas estimate;
 *   confirmed             → value + actual fee;
 *   reverted              → gas only (the value came back);
 *   failed (never sent)   → nothing.
 */
export function effectiveSpend(e: AgentAction): { value: bigint; gas: bigint } {
  const value = BigInt(e.valueWei || "0");
  const gas = BigInt(e.gasWei || "0");
  switch (e.outcome) {
    case "failed":
      return { value: 0n, gas: 0n };
    case "reverted":
      return { value: 0n, gas };
    default:
      return { value, gas };
  }
}

function row(signerKey: string, address: string | undefined, value: bigint, gas: bigint, actions: number): SpendRow {
  return {
    signerKey,
    ...(address ? { address } : {}),
    actions,
    valueWei: value.toString(),
    gasWei: gas.toString(),
    totalWei: (value + gas).toString(),
  };
}

/** Aggregate a set of entries into the total + per-agent spend view. Pure. */
export function summarizeSpend(
  entries: AgentAction[],
  opts: { since: string; windowMs: number; chainId?: number },
): SpendReport {
  let tv = 0n;
  let tg = 0n;
  const per = new Map<string, { address?: string; value: bigint; gas: bigint; actions: number }>();
  for (const e of entries) {
    const { value, gas } = effectiveSpend(e);
    tv += value;
    tg += gas;
    const cur = per.get(e.signerKey) ?? { value: 0n, gas: 0n, actions: 0 };
    cur.value += value;
    cur.gas += gas;
    cur.actions += 1;
    if (!cur.address && e.address) cur.address = e.address;
    per.set(e.signerKey, cur);
  }
  const byAgent = [...per.entries()]
    .map(([k, v]) => row(k, v.address, v.value, v.gas, v.actions))
    .sort((a, b) => (BigInt(b.totalWei) > BigInt(a.totalWei) ? 1 : BigInt(b.totalWei) < BigInt(a.totalWei) ? -1 : a.signerKey.localeCompare(b.signerKey)));
  return {
    since: opts.since,
    windowMs: opts.windowMs,
    ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}),
    total: row("*", undefined, tv, tg, entries.length),
    byAgent,
  };
}

export interface BudgetStatus {
  budgetWei: string;
  usedWei: string;
  remainingWei: string;
  exceeded: boolean;
  /** Fraction of the budget consumed, rounded to 4 dp (1 = exactly at cap). */
  utilization: number;
}

/**
 * Compare a spend window against a budget. Pure, so the budget guard and any
 * reporting tool agree on the arithmetic instead of each rolling its own.
 * `pendingWei` is the cost of the transaction about to be sent, if any.
 */
export function evaluateBudget(report: SpendReport, budgetWei: bigint, pendingWei: bigint = 0n): BudgetStatus {
  const used = BigInt(report.total.totalWei) + (pendingWei > 0n ? pendingWei : 0n);
  const remaining = budgetWei > used ? budgetWei - used : 0n;
  const utilization =
    budgetWei > 0n ? Math.round(Number((used * 10_000n) / budgetWei)) / 10_000 : used > 0n ? Infinity : 0;
  return {
    budgetWei: budgetWei.toString(),
    usedWei: used.toString(),
    remainingWei: remaining.toString(),
    exceeded: budgetWei > 0n ? used > budgetWei : used > 0n,
    utilization,
  };
}

/* ───────────────────────────── path + retention ──────────────────────────── */

/**
 * Ledger file path: `DEXE_AGENT_LEDGER_PATH`, else a sibling of the state file
 * (so `DEXE_STATE_PATH` relocates both and a test can redirect either).
 * Never throws — `resolveStatePath` already handles a host with no home.
 */
export function resolveLedgerPath(override?: string): string {
  const raw = (override ?? process.env.DEXE_AGENT_LEDGER_PATH)?.trim();
  if (raw) return raw;
  return join(dirname(resolveStatePath()), "agent-ledger.json");
}

/** Retention cap, clamped. Garbage or out-of-range falls back to the default. */
export function maxLedgerEntries(): number {
  const raw = process.env.DEXE_AGENT_LEDGER_MAX?.trim();
  if (!raw) return DEFAULT_MAX_ENTRIES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_MAX_ENTRIES) return DEFAULT_MAX_ENTRIES;
  return Math.min(n, MAX_MAX_ENTRIES);
}

/** `DEXE_AGENT_LEDGER=off|0|false` disables recording (the file is never created). */
export function ledgerEnabled(): boolean {
  const raw = process.env.DEXE_AGENT_LEDGER?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/**
 * Shared 4-byte Atomics.wait target. The store is synchronous (a tool must have
 * persisted before it returns), so there is no `await` to hand off to.
 * Duplicated from stateStore, which keeps its sleeper private.
 */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/* ──────────────────────────────── the ledger ─────────────────────────────── */

export interface LedgerFilter {
  signerKey?: string;
  chainId?: number;
  tool?: string;
  /** Only entries at or after this ISO-8601 instant. */
  since?: string;
  /** Newest N. */
  limit?: number;
}

export class AgentLedger {
  constructor(readonly path: string) {}

  /** Every entry, newest first. Always re-read: peer processes append too. */
  all(): AgentAction[] {
    return this.snapshot().entries;
  }

  /** Filtered view, newest first. */
  list(filter: LedgerFilter = {}): AgentAction[] {
    const key = filter.signerKey?.trim().toLowerCase();
    const sinceMs = filter.since ? Date.parse(filter.since) : undefined;
    let out = this.all().filter((e) => {
      if (key && e.signerKey !== key) return false;
      if (filter.chainId !== undefined && e.chainId !== filter.chainId) return false;
      if (filter.tool && e.tool !== filter.tool) return false;
      if (sinceMs !== undefined && Number.isFinite(sinceMs) && Date.parse(e.at) < sinceMs) return false;
      return true;
    });
    if (filter.limit !== undefined && filter.limit >= 0) out = out.slice(0, filter.limit);
    return out;
  }

  /**
   * Per-signerKey and total spend over a rolling window — the number a budget
   * guard consults. Native value AND gas both count; see `effectiveSpend` for
   * how each outcome is charged.
   */
  spendSince(opts: { windowMs?: number; chainId?: number; now?: number } = {}): SpendReport {
    const windowMs = opts.windowMs ?? DAY_MS;
    const now = opts.now ?? Date.now();
    const sinceMs = now - windowMs;
    const since = new Date(sinceMs).toISOString();
    const entries = this.all().filter((e) => {
      if (opts.chainId !== undefined && e.chainId !== opts.chainId) return false;
      const t = Date.parse(e.at);
      return Number.isFinite(t) ? t >= sinceMs : false;
    });
    return summarizeSpend(entries, {
      since,
      windowMs,
      ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}),
    });
  }

  /**
   * Append one action. Returns the stored entry (its `id` is the settlement
   * handle) or null when recording is disabled. Never throws.
   */
  record(input: AgentActionInput): AgentAction | null {
    if (!ledgerEnabled()) return null;
    let entry: AgentAction;
    try {
      entry = normalizeAction(input);
    } catch (err) {
      debugLog("ledger", `could not normalize entry (${safeErrorMessage(err)})`);
      return null;
    }
    const cap = maxLedgerEntries();
    this.mutate((entries) => [entry, ...entries].slice(0, cap));
    return entry;
  }

  /**
   * Fill in a recorded action once its receipt is known. Matches by entry id or
   * tx hash; a miss is a no-op (the entry may have aged out under the cap, or a
   * peer process owns it). This is the only mutation of an existing row — the
   * file is otherwise strictly append-and-prune.
   */
  settle(
    idOrHash: string,
    patch: { outcome?: LedgerOutcome; gasWei?: bigint | string; txHash?: string; note?: string },
  ): void {
    if (!ledgerEnabled()) return;
    const key = idOrHash.trim().toLowerCase();
    if (!key) return;
    this.mutate((entries) => {
      const i = entries.findIndex((e) => e.id.toLowerCase() === key || e.txHash?.toLowerCase() === key);
      if (i < 0) return null;
      const prev = entries[i]!;
      const txHash =
        patch.txHash && TX_HASH_RE.test(patch.txHash.trim()) && !isRegisteredSecret(patch.txHash.trim())
          ? patch.txHash.trim()
          : prev.txHash;
      const next: AgentAction = {
        ...prev,
        ...(patch.outcome ? { outcome: patch.outcome } : {}),
        ...(patch.gasWei !== undefined ? { gasWei: toWeiString(patch.gasWei) } : {}),
        ...(txHash ? { txHash } : {}),
        ...(patch.note ? { note: clamp(scrubLedgerText(patch.note, txHash), MAX_NOTE_CHARS) } : {}),
      };
      const copy = entries.slice();
      copy[i] = next;
      return copy;
    });
  }

  /** Drop every entry (test/ops reset). */
  clear(): void {
    this.mutate(() => []);
  }

  /* ---------------------------- persistence ------------------------------ */

  /**
   * Read the entries AND the exact bytes they were parsed from. The raw text is
   * the compare-and-swap token (content, not mtime+size — two writes in the same
   * millisecond produce identical stat metadata).
   */
  private snapshot(): { raw: string | null; entries: AgentAction[] } {
    try {
      if (!existsSync(this.path)) return { raw: null, entries: [] };
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== LEDGER_VERSION) {
        return { raw, entries: [] };
      }
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter((e): e is AgentAction => !!e && typeof e === "object" && typeof e.at === "string")
        : [];
      return { raw, entries };
    } catch (err) {
      // A corrupt or unreadable ledger reads as empty rather than throwing into
      // a broadcast path; the next write republishes a clean file.
      debugLog("ledger", `read failed at ${this.path}`, err);
      return { raw: null, entries: [] };
    }
  }

  /**
   * Read-modify-write, serialized across processes and verified at publish.
   * The read MUST happen inside the lock, and `fn` must be a pure function of
   * the entries it is handed (it is re-invoked on a CAS miss). Returning null
   * means "nothing to write".
   */
  private mutate(fn: (entries: AgentAction[]) => AgentAction[] | null): void {
    try {
      withWriteLock(this.path, () => {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
          const { raw, entries } = this.snapshot();
          const next = fn(entries);
          if (!next) return;
          const outcome = this.persist(next, { expect: raw });
          if (outcome !== "stale") return;
          debugLog("ledger", `ledger changed under us; recomputing (attempt ${attempt + 1})`);
          sleepSync(lockBackoffMs(attempt));
        }
        // Lost the CAS CAS_ATTEMPTS times running: a live lock, not a
        // correctness problem. Publish unconditionally — last-writer-wins costs
        // at most one of THEIR rows, whereas returning here drops the record of
        // a transaction that already spent gas.
        const { entries } = this.snapshot();
        const next = fn(entries);
        if (next) this.persist(next);
      });
    } catch (err) {
      debugLog("ledger", `mutate failed (${safeErrorMessage(err)})`);
    }
  }

  /** Atomic write: private temp file + rename, optionally compare-and-swapped. */
  private persist(entries: AgentAction[], cas?: { expect: string | null }): "published" | "stale" | "failed" {
    const tmp = tempStatePath(this.path);
    const file: LedgerFile = { version: LEDGER_VERSION, entries };
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Deliberately AFTER the temp write, so the only gap left between the
      // check and the rename is the rename call itself.
      if (cas && !this.diskStillHolds(cas.expect)) {
        rmSync(tmp, { force: true });
        return "stale";
      }
      renameWithRetry(tmp, this.path);
      return "published";
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Same permission problem that failed the write; nothing more to do.
      }
      debugLog("ledger", `persist failed at ${this.path} (${safeErrorMessage(err)})`);
      return "failed";
    }
  }

  private diskStillHolds(expect: string | null): boolean {
    try {
      const now = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
      return now === expect;
    } catch {
      return false;
    }
  }
}

/* ─────────────────────────── process-wide instance ───────────────────────── */

const instances = new Map<string, AgentLedger>();

/**
 * The ledger for a path (default: the resolved ledger path). Cached per path so
 * every tool and the signer hook share one instance — and so a test that
 * repoints `DEXE_AGENT_LEDGER_PATH` gets a fresh one without a reset call.
 */
export function getAgentLedger(path?: string): AgentLedger {
  const p = path ?? resolveLedgerPath();
  let inst = instances.get(p);
  if (!inst) {
    inst = new AgentLedger(p);
    instances.set(p, inst);
  }
  return inst;
}

/** Test hook: forget cached instances (the files themselves are untouched). */
export function __resetAgentLedgerCache(): void {
  instances.clear();
}

/* ───────────────────────────── action context ────────────────────────────── */

export interface ActionContext {
  /** MCP tool driving the broadcast, e.g. "dexe_agents_fund". */
  tool?: string;
  /** Short description of the step, e.g. "fund agent3 with 0.05 BNB". */
  action?: string;
}

const contextStore = new AsyncLocalStorage<ActionContext>();

/**
 * Run `fn` with an attribution context. Tool handlers wrap their body once and
 * every broadcast inside — including ones several helpers deep — is labelled
 * with the tool and step. Optional: an un-wrapped call site still gets recorded
 * (see `inferToolFromStack`), just with a coarser label.
 */
export function withActionContext<T>(ctx: ActionContext, fn: () => T): T {
  return contextStore.run(ctx, fn);
}

/** The innermost active attribution context, if any. */
export function currentActionContext(): ActionContext | undefined {
  return contextStore.getStore();
}

const STACK_FRAME_RE = /[\\/](tools|lib)[\\/]([A-Za-z0-9_-]+)\.(?:ts|js)/g;

/**
 * Best-effort tool label for a call site that did not set a context: the
 * nearest `src/tools/<name>` frame on the stack.
 *
 * This exists because attribution must not depend on every call site
 * remembering something — `dexe_agents_fund` forgot every broadcast guard, and
 * a logging call is exactly as forgettable. A coarse "tools/agents" is worth
 * far more than "unknown", and it is never load-bearing: `withActionContext`
 * overrides it whenever a caller does the right thing.
 */
export function inferToolFromStack(stack?: string): string | undefined {
  const s = stack ?? new Error().stack;
  if (!s) return undefined;
  STACK_FRAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STACK_FRAME_RE.exec(s))) {
    if (m[1] === "tools") return `tools/${m[2]}`;
  }
  return undefined;
}

/* ────────────────────────── signer broadcast hook ────────────────────────── */

export interface SignerAttribution {
  /** Keyring slot ("agent1", "funder", "primary"). */
  signerKey: string;
  address: string;
  chainId: number;
}

/** Minimal shape of what `attachBroadcastRecorder` needs from a wallet. */
interface BroadcastCapable {
  sendTransaction(tx: unknown): Promise<unknown>;
}

const ATTRIBUTED = Symbol.for("dexe-mcp.agentLedger.attributed");

interface TxLike {
  hash?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  value?: unknown;
  wait?: unknown;
}

function asBigInt(v: unknown): bigint {
  return typeof v === "bigint" ? v : 0n;
}

/** Upper-bound fee for a pending tx: gasLimit × the price the node will charge at most. */
function estimatedFeeWei(tx: TxLike): bigint {
  const price = asBigInt(tx.maxFeePerGas) || asBigInt(tx.gasPrice);
  return asBigInt(tx.gasLimit) * price;
}

function receiptFeeWei(receipt: { fee?: unknown; gasUsed?: unknown; gasPrice?: unknown } | null): bigint {
  if (!receipt) return 0n;
  if (typeof receipt.fee === "bigint") return receipt.fee;
  return asBigInt(receipt.gasUsed) * asBigInt(receipt.gasPrice);
}

/**
 * Make every broadcast from `wallet` attributable, in place.
 *
 * The instance method shadows the prototype's `sendTransaction`, so any call
 * site that ever obtained this wallet — `dexe_tx_send`, the composite flow loop,
 * `dexe_agents_fund`, an ethers `Contract` connected to it, and anything added
 * later — is recorded without opting in. Deliberately NOT a Proxy: ethers
 * wallets hold private (`#`) fields, and a Proxy receiver makes those throw.
 *
 * Recording never affects the broadcast: a ledger failure is swallowed, and the
 * transaction response is returned untouched (only its `wait` is wrapped, and
 * only if the object allows it) so callers see exactly what ethers returned.
 */
export function attachBroadcastRecorder<W extends BroadcastCapable>(
  wallet: W,
  attribution: SignerAttribution,
  ledger: AgentLedger = getAgentLedger(),
): W {
  const marked = wallet as W & { [ATTRIBUTED]?: boolean };
  if (marked[ATTRIBUTED]) return wallet;

  const original = wallet.sendTransaction.bind(wallet);

  const wrapped = async function sendTransaction(tx: unknown): Promise<unknown> {
    const ctx = currentActionContext();
    const tool = ctx?.tool ?? inferToolFromStack() ?? "unknown";
    const req = (tx ?? {}) as TxLike;
    const chainId = Number((req as { chainId?: unknown }).chainId ?? attribution.chainId) || attribution.chainId;
    let sent: unknown;
    try {
      sent = await original(tx);
    } catch (err) {
      // Never broadcast → nothing spent, but the ATTEMPT is what makes a guard
      // refusal or an out-of-gas signer visible per persona.
      try {
        ledger.record({
          signerKey: attribution.signerKey,
          address: attribution.address,
          chainId,
          tool,
          action: ctx?.action ?? describeTx(req),
          outcome: "failed",
          valueWei: asBigInt(req.value),
          note: safeErrorMessage(err),
        });
      } catch (logErr) {
        debugLog("ledger", `record(failed) threw (${safeErrorMessage(logErr)})`);
      }
      throw err;
    }

    const res = sent as TxLike;
    let entryId: string | undefined;
    try {
      const entry = ledger.record({
        signerKey: attribution.signerKey,
        address: attribution.address,
        chainId,
        tool,
        action: ctx?.action ?? describeTx(req),
        ...(typeof res.hash === "string" ? { txHash: res.hash } : {}),
        outcome: "broadcast",
        valueWei: asBigInt(res.value) || asBigInt(req.value),
        gasWei: estimatedFeeWei(res),
      });
      entryId = entry?.id;
    } catch (err) {
      debugLog("ledger", `record(broadcast) threw (${safeErrorMessage(err)})`);
    }

    if (entryId) attachSettlement(res, ledger, entryId);
    return sent;
  };

  try {
    Object.defineProperty(wallet, "sendTransaction", {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(wallet, ATTRIBUTED, {
      value: true,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch (err) {
    // A frozen/sealed signer cannot be instrumented — degrade to no attribution
    // rather than break signing.
    debugLog("ledger", `could not attach recorder (${safeErrorMessage(err)})`);
  }
  return wallet;
}

/**
 * Wrap the response's `wait` so the entry is settled with the real outcome and
 * the actual fee once the receipt lands. Best-effort in both directions: if the
 * response object refuses the property, the entry simply stays `broadcast`
 * (which over-counts gas — the safe direction for a budget).
 */
function attachSettlement(res: TxLike, ledger: AgentLedger, entryId: string): void {
  if (typeof res.wait !== "function") return;
  const originalWait = (res.wait as (...a: unknown[]) => Promise<unknown>).bind(res);
  const wrappedWait = async (...args: unknown[]): Promise<unknown> => {
    try {
      const receipt = (await originalWait(...args)) as {
        status?: unknown;
        fee?: unknown;
        gasUsed?: unknown;
        gasPrice?: unknown;
      } | null;
      try {
        ledger.settle(entryId, {
          outcome: receipt && receipt.status === 0 ? "reverted" : "confirmed",
          gasWei: receiptFeeWei(receipt),
        });
      } catch (err) {
        debugLog("ledger", `settle threw (${safeErrorMessage(err)})`);
      }
      return receipt;
    } catch (err) {
      // A wait timeout does NOT mean the tx failed — it may still land — so the
      // entry keeps its `broadcast` outcome and its estimated gas.
      throw err;
    }
  };
  try {
    Object.defineProperty(res, "wait", {
      value: wrappedWait,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (err) {
    debugLog("ledger", `could not wrap wait (${safeErrorMessage(err)})`);
  }
}

/** Fallback description when no `withActionContext` label is in scope. */
function describeTx(tx: TxLike): string {
  const to = (tx as { to?: unknown }).to;
  const data = (tx as { data?: unknown }).data;
  const selector = typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : undefined;
  const value = asBigInt(tx.value);
  const parts = [
    typeof to === "string" && ADDRESS_RE.test(to) ? `to ${to}` : undefined,
    selector && selector !== "0x" ? `selector ${selector}` : undefined,
    value > 0n ? `value ${value.toString()} wei` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "transaction";
}
