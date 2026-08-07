import type { Flow, Gotcha, ParamSpec, Topic, TopicSection } from "./types.js";
import { FLOWS, FLOW_BY_ID } from "./flows.js";
import { TOPICS, TOPIC_BY_ID } from "./topics.js";
import { GOTCHAS, GOTCHA_BY_ID } from "./gotchas.js";
import { TOOLSETS, defaultProfileToolNames } from "../tools/gate.js";

/**
 * Pure knowledge-query functions — no I/O, no server types. `dexe_guide`
 * (src/tools/guide.ts) is a thin wrapper over these; scripts/gen-knowledge.ts
 * renders the same data into docs/PLAYBOOK.md.
 */

export interface FlowIndexEntry {
  flow: string;
  title: string;
  summary: string;
  triggers: string[];
}

/** The compact index tier (~300 tokens serialized). */
export function flowIndex(): FlowIndexEntry[] {
  return FLOWS.map((f) => ({ flow: f.id, title: f.title, summary: f.summary, triggers: f.triggers }));
}

export interface TopicIndexEntry {
  topic: string;
  title: string;
  summary: string;
  triggers: string[];
}

/** Reference topics for the index tier — fetched the same way as flows. */
export function topicIndex(): TopicIndexEntry[] {
  return TOPICS.map((t) => ({ topic: t.id, title: t.title, summary: t.summary, triggers: t.triggers }));
}

export interface ResolvedGotcha {
  id: string;
  severity: Gotcha["severity"];
  text: string;
}

export interface FlowStepDetail {
  id: string;
  tool: string;
  /** Toolset(s) that expose the tool, when it is NOT in the default profile. */
  requiresToolset?: string;
  purpose: string;
  paramsTemplate: Record<string, string>;
  bindsFrom?: Record<string, string>;
  optionalWhen?: string;
  gotchas: ResolvedGotcha[];
  reportOnSuccess: string;
  next?: Array<{ when: string; stepId?: string; flowRef?: string; why: string }>;
}

export interface FlowDetail {
  flow: string;
  title: string;
  summary: string;
  /** Present when the active chain has a note the agent MUST relay. */
  chainNote?: { chainId: number; note: string };
  interview: ParamSpec[];
  steps: FlowStepDetail[];
  gotchas: ResolvedGotcha[];
  subFlows?: string[];
  /** The behavioral contract for the calling agent — always relay-and-obey. */
  agentProtocol: string;
}

/**
 * Read from `defaultProfileToolNames()`, never from a hardcoded profile list:
 * `DEFAULT_TOOLSETS` moved once (0.31.0, core+proposals → core) and a copy here
 * would have kept telling agents that tools they can see need enabling — and,
 * worse, kept silent about the ones that genuinely do.
 */
const DEFAULT_PROFILE_TOOLS: ReadonlySet<string> = defaultProfileToolNames();

/** Composites that accept `flowContext` and return structured `next` chaining. */
const CHAINING_TOOLS: ReadonlySet<string> = new Set([
  "dexe_dao_create",
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_otc_dao_open_sale",
]);

/** Which non-default toolset(s) expose `tool`, or undefined if default-visible. */
function requiresToolset(tool: string): string | undefined {
  if (DEFAULT_PROFILE_TOOLS.has(tool) || tool === "dexe_guide") return undefined;
  const sets = Object.entries(TOOLSETS)
    .filter(([, names]) => names.has(tool))
    .map(([set]) => set);
  return sets.length ? sets.join("|") : undefined;
}

function resolveGotchas(ids: readonly string[] | undefined, chainId?: number): ResolvedGotcha[] {
  if (!ids?.length) return [];
  const out: ResolvedGotcha[] = [];
  for (const id of ids) {
    const g = GOTCHA_BY_ID.get(id);
    if (!g) continue; // integrity test guarantees this never happens in practice
    if (chainId !== undefined && g.applies.chains && !g.applies.chains.includes(chainId)) continue;
    out.push({ id: g.id, severity: g.severity, text: g.text });
  }
  // danger first — the agent reads top-down.
  const rank = { danger: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export const AGENT_PROTOCOL =
  "PROTOCOL FOR THE AGENT: (1) Ask the user each `interview` question in order; offer the defaults; when an answer " +
  "is unusual, explain its `riskIfUnusual` before accepting. (2) Echo the final parameter set back and get explicit " +
  "confirmation BEFORE any broadcast. (3) Call the step tools in the listed order with the collected params — do " +
  "not substitute other tools, do not invent parameters, do not skip the gotchas. (4) If there is a chainNote, " +
  "relay it to the user verbatim before starting. (5) After each successful step, tell the user what " +
  "`reportOnSuccess` says (with placeholders filled). (6) On a step failure, follow the error's remediation hint " +
  "and re-run the SAME composite call — completed steps are skipped.";

/** The detail tier for one flow (~1-2k tokens serialized). */
export function flowDetail(id: string, opts?: { chainId?: number }): FlowDetail | null {
  const f = FLOW_BY_ID.get(id);
  if (!f) return null;
  const chainId = opts?.chainId;
  const chainNote =
    chainId !== undefined && f.chainNotes?.[chainId]
      ? { chainId, note: f.chainNotes[chainId]! }
      : undefined;
  return {
    flow: f.id,
    title: f.title,
    summary: f.summary,
    ...(chainNote ? { chainNote } : {}),
    interview: [...f.interview],
    steps: f.steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      ...(requiresToolset(s.tool) ? { requiresToolset: requiresToolset(s.tool) } : {}),
      purpose: s.purpose,
      // Chaining composites get their guided-flow position pre-filled: pass it
      // through verbatim and the success payload returns flowProgress + next.
      paramsTemplate: CHAINING_TOOLS.has(s.tool)
        ? { ...s.paramsTemplate, flowContext: `{"flow":"${f.id}","step":"${s.id}"}` }
        : s.paramsTemplate,
      ...(s.bindsFrom ? { bindsFrom: s.bindsFrom } : {}),
      ...(s.optionalWhen ? { optionalWhen: s.optionalWhen } : {}),
      gotchas: resolveGotchas(s.gotchaIds, chainId),
      reportOnSuccess: s.reportOnSuccess,
      ...(s.next ? { next: s.next } : {}),
    })),
    gotchas: resolveGotchas(f.gotchaIds, chainId),
    ...(f.subFlows ? { subFlows: [...f.subFlows] } : {}),
    agentProtocol: AGENT_PROTOCOL,
  };
}

/** The detail tier for one reference topic (~1-2k tokens serialized). */
export interface TopicToolRef {
  tool: string;
  /** Toolset(s) that expose the tool, when it is NOT in the default profile. */
  requiresToolset?: string;
}

export interface TopicDetail {
  topic: string;
  title: string;
  summary: string;
  sections: TopicSection[];
  tools: TopicToolRef[];
  gotchas: ResolvedGotcha[];
}

export function topicDetail(id: string, opts?: { chainId?: number }): TopicDetail | null {
  const t = TOPIC_BY_ID.get(id);
  if (!t) return null;
  return {
    topic: t.id,
    title: t.title,
    summary: t.summary,
    sections: [...t.sections],
    tools: t.tools.map((tool) => ({
      tool,
      ...(requiresToolset(tool) ? { requiresToolset: requiresToolset(tool) } : {}),
    })),
    gotchas: resolveGotchas(t.gotchaIds, opts?.chainId),
  };
}

export interface IntentMatch {
  /** Flow OR topic id — the two share one id namespace (test-enforced disjoint). */
  flow: string;
  score: number;
  /**
   * How many MULTI-WORD triggers the text contained verbatim. The strong
   * signal: "who voted" appearing literally means something the bag-of-words
   * partial path (which fires on a single shared word) cannot mean.
   */
  phraseHits: number;
}

/**
 * Deliberately dumb keyword scoring over `triggers` — the calling model does
 * the semantic matching once it sees the index; a wrong confident match would
 * be worse than a visible menu. Scores flows and reference topics in one
 * pass (shared id namespace). Returns matches sorted by score desc.
 */
export function matchIntent(text: string): IntentMatch[] {
  const t = text.toLowerCase();
  const candidates: Array<Pick<Flow | Topic, "id" | "triggers">> = [...FLOWS, ...TOPICS];
  const scored = candidates.map((f) => {
    let score = 0;
    let phraseHits = 0;
    for (const trigger of f.triggers) {
      const words = trigger.split(/\s+/);
      if (t.includes(trigger)) {
        score += words.length + 1; // longer phrases weigh more
        if (words.length > 1) phraseHits++;
      } else {
        // partial: count trigger words present individually
        const long = words.filter((w) => w.length > 3);
        const hits = long.filter((w) => t.includes(w)).length;
        if (long.length > 0 && hits === long.length) score += 1;
      }
    }
    return { flow: f.id, score, phraseHits };
  }).filter((m) => m.score > 0);
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Confident when the top match clearly outscores the runner-up (or is alone).
 * Special case: an intent that spans SEVERAL flows (create + distribute + OTC
 * + staking in one breath) is the launch_token_economy journey — a single-leg
 * match would silently drop the rest of the request.
 */
export function bestMatch(text: string): string | null {
  const m = matchIntent(text);
  if (m.length === 0) return null;
  const spansMany = m.length >= 3 && m.some((x) => x.flow === "launch_token_economy");
  if (spansMany) return "launch_token_economy";
  if (m.length === 1) return m[0]!.flow;
  const [top, runnerUp] = [m[0]!, m[1]!];
  if (top.score >= runnerUp.score * 2) return top.flow;
  // The 2× rule compares two different kinds of evidence as if they were one.
  // "who voted on proposal 3" contains the phrase "who voted" (report topic)
  // and merely shares the word "vote" with the vote_execute triggers — 3 vs 2,
  // which the ratio calls a tie and answers with a menu. A verbatim multi-word
  // phrase beating a match with none is not a tie; anything weaker still falls
  // through to the menu, which stays the safe default.
  if (top.phraseHits > 0 && runnerUp.phraseHits === 0 && top.score > runnerUp.score) return top.flow;
  return null;
}

export { FLOWS, FLOW_BY_ID, TOPICS, TOPIC_BY_ID, GOTCHAS, GOTCHA_BY_ID };
