import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReviewResult } from "../proposalReview.js";
import { safeErrorMessage } from "../redact.js";
import { parseDecision, type Decision, type ModelAdapter } from "./adapters.js";
import type { CouncilAgent, CouncilConfig } from "./config.js";
import { buildPrompt } from "./prompt.js";

/**
 * The council loop: list Voting proposals → one review packet each → every
 * agent decides → the runner votes for it through dexe_proposal_vote_and_execute.
 *
 * The JSONL log is the memory. Each (chain, pool, proposal, agent) is decided
 * once and voted once, so a restart never asks a model twice or votes twice:
 *  - a "vote" entry with ok:true  → done, skipped;
 *  - a "decision" entry (not dry) → the stored decision is voted, no new model call;
 *  - dry-run entries are ignored by real runs (a dry run must not pre-decide).
 */

export interface VoteOutcome {
  ok: boolean;
  /** The vote tool's mode: executed | already-voted | dryRun | failed | … */
  mode?: string;
  txHashes: string[];
  stateAfter?: string;
  /** Why nothing was sent, when the wallet's vote was already on-chain. */
  note?: string;
  error?: string;
}

/** What the runner needs from the chain; tests pass a fake. */
export interface CouncilChain {
  listActive(): Promise<number[]>;
  review(proposalId: number): Promise<ReviewResult>;
  /** Fresh ProposalState (0 = Voting) read right before each vote. */
  state(proposalId: number): Promise<{ index: number; name: string }>;
  /**
   * Cast the vote. Only called while the proposal is in Voting. An AGAINST
   * vote must never execute anything: the real chain passes autoExecute only
   * with a FOR vote.
   */
  vote(agent: CouncilAgent, proposalId: number, isFor: boolean): Promise<VoteOutcome>;
}

export interface LogEntry {
  ts: string;
  kind: "decision" | "vote" | "error";
  key: string;
  chainId: number;
  govPool: string;
  proposalId: number;
  agent?: string;
  model?: string;
  vote?: "for" | "against";
  reason?: string;
  parsed?: boolean;
  highFlags?: string[];
  dryRun?: boolean;
  ok?: boolean;
  mode?: string;
  txHashes?: string[];
  stateAfter?: string;
  note?: string;
  error?: string;
}

/** After this many failed vote attempts for one key the runner stops retrying it. */
export const MAX_VOTE_ATTEMPTS = 3;

export class CouncilLog {
  private readonly entries: LogEntry[] = [];
  constructor(readonly path: string) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line) as LogEntry);
        } catch {
          /* a torn last line from a crash is skipped, not fatal */
        }
      }
    }
  }
  append(e: LogEntry): void {
    this.entries.push(e);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(e) + "\n", "utf8");
  }
  /** The latest real decision for a key (dry-run ones count only for dry runs). */
  decision(key: string, includeDry: boolean): LogEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === "decision" && e.key === key && (includeDry || !e.dryRun)) return e;
    }
    return undefined;
  }
  voted(key: string): boolean {
    return this.entries.some((e) => e.kind === "vote" && e.key === key && e.ok === true);
  }
  failedVotes(key: string): number {
    return this.entries.filter((e) => e.kind === "vote" && e.key === key && e.ok === false).length;
  }
  all(): readonly LogEntry[] {
    return this.entries;
  }
}

export function decisionKey(chainId: number, govPool: string, proposalId: number, agent: string): string {
  return `${chainId}:${govPool.toLowerCase()}:${proposalId}:${agent}`;
}

export interface RoundOptions {
  dryRun: boolean;
  /** Progress lines (stderr in the CLI). */
  say?: (line: string) => void;
}

export interface RoundSummary {
  proposals: number[];
  decided: number;
  voted: number;
  skipped: number;
  errors: number;
}

/** Ask one agent. Adapter errors and unparseable replies both fail closed (AGAINST). */
export async function decide(adapter: ModelAdapter, agent: CouncilAgent, review: ReviewResult): Promise<Decision> {
  const prompt = buildPrompt(agent.name, agent.role, review);
  let raw: string;
  try {
    raw = await adapter.complete(prompt);
  } catch (e) {
    return { vote: "against", reason: `fail-closed: model call failed (${safeErrorMessage(e).slice(0, 200)})`, parsed: false };
  }
  return parseDecision(raw);
}

/** One pass over the active proposals. */
export async function runRound(
  cfg: CouncilConfig,
  chain: CouncilChain,
  adapters: ReadonlyMap<string, ModelAdapter>,
  log: CouncilLog,
  opts: RoundOptions,
): Promise<RoundSummary> {
  const say = opts.say ?? (() => {});
  const summary: RoundSummary = { proposals: [], decided: 0, voted: 0, skipped: 0, errors: 0 };
  const base = { chainId: cfg.chain, govPool: cfg.govPool };
  const now = () => new Date().toISOString();

  let active: number[];
  try {
    active = await chain.listActive();
  } catch (e) {
    summary.errors++;
    say(`list active proposals failed: ${safeErrorMessage(e)}`);
    return summary;
  }
  summary.proposals = active;
  if (active.length === 0) say("no proposals in Voting");

  for (const id of active) {
    const keys = new Map(cfg.agents.map((a) => [a.name, decisionKey(cfg.chain, cfg.govPool, id, a.name)]));
    const pending = cfg.agents.filter((a) => {
      const k = keys.get(a.name)!;
      if (opts.dryRun) return !log.decision(k, true);
      return !log.voted(k) && log.failedVotes(k) < MAX_VOTE_ATTEMPTS;
    });
    summary.skipped += cfg.agents.length - pending.length;
    if (pending.length === 0) continue;

    // Decisions still missing (a restart may have some already).
    const needDecision = pending.filter((a) => !log.decision(keys.get(a.name)!, false) || opts.dryRun);
    if (needDecision.length > 0) {
      let review: ReviewResult;
      try {
        review = await chain.review(id);
      } catch (e) {
        summary.errors++;
        const msg = safeErrorMessage(e);
        log.append({ ts: now(), kind: "error", key: `${cfg.chain}:${cfg.govPool.toLowerCase()}:${id}`, ...base, proposalId: id, error: msg });
        say(`#${id}: review failed — ${msg}; not voting this round`);
        continue;
      }
      const highFlags = [...new Set(review.packet.flags.filter((f) => f.severity === "high").map((f) => f.code))];
      say(`#${id}: ${review.packet.state}, ${review.packet.actionsFor.length} FOR action(s), high flags: ${highFlags.join(", ") || "none"}`);
      // Agents think in parallel; each one sees the same packet.
      const decisions = await Promise.all(
        needDecision.map(async (a) => ({ a, d: await decide(adapters.get(a.name)!, a, review) })),
      );
      for (const { a, d } of decisions) {
        summary.decided++;
        log.append({
          ts: now(),
          kind: "decision",
          key: keys.get(a.name)!,
          ...base,
          proposalId: id,
          agent: a.name,
          model: adapters.get(a.name)!.label,
          vote: d.vote,
          reason: d.reason,
          parsed: d.parsed,
          highFlags,
          ...(opts.dryRun ? { dryRun: true } : {}),
        });
        say(`#${id} ${a.name}: ${d.vote.toUpperCase()} — ${d.reason}`);
      }
    }
    if (opts.dryRun) continue;

    // Votes one at a time: each may move the proposal (quorum → validators).
    for (const a of pending) {
      const k = keys.get(a.name)!;
      const d = log.decision(k, false);
      if (!d || !d.vote) continue;
      let out: VoteOutcome;
      try {
        // The vote tool would EXECUTE a proposal that already passed; an agent
        // only ever votes while voting is open, and otherwise records why not.
        const st = await chain.state(id);
        out =
          st.index === 0
            ? await chain.vote(a, id, d.vote === "for")
            : { ok: true, mode: "not-in-voting", txHashes: [], stateAfter: st.name };
      } catch (e) {
        out = { ok: false, txHashes: [], error: safeErrorMessage(e) };
      }
      log.append({
        ts: now(),
        kind: "vote",
        key: k,
        ...base,
        proposalId: id,
        agent: a.name,
        vote: d.vote,
        ok: out.ok,
        ...(out.mode ? { mode: out.mode } : {}),
        txHashes: out.txHashes,
        ...(out.stateAfter ? { stateAfter: out.stateAfter } : {}),
        ...(out.note ? { note: out.note } : {}),
        ...(out.error ? { error: out.error.slice(0, 500) } : {}),
      });
      if (out.mode === "not-in-voting" || out.mode?.startsWith("already-voted")) summary.skipped++;
      else if (out.ok) summary.voted++;
      else summary.errors++;
      say(
        `#${id} ${a.name}: vote ${d.vote.toUpperCase()} ${out.mode?.startsWith("already-voted") ? "NOT sent" : out.ok ? "sent" : "FAILED"}` +
          `${out.mode ? ` (${out.mode})` : ""}${out.txHashes.length ? ` tx ${out.txHashes.join(", ")}` : ""}` +
          `${out.stateAfter ? ` → ${out.stateAfter}` : ""}${out.note ? ` — ${out.note}` : ""}${out.error ? ` — ${out.error.slice(0, 200)}` : ""}`,
      );
    }
  }
  return summary;
}
