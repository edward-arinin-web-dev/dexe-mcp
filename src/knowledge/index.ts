import type { Flow, Gotcha, ParamSpec } from "./types.js";
import { FLOWS, FLOW_BY_ID } from "./flows.js";
import { GOTCHAS, GOTCHA_BY_ID } from "./gotchas.js";
import { TOOLSETS } from "../tools/gate.js";

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
  next?: Array<{ when: string; stepId: string; why: string }>;
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

const DEFAULT_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  ...TOOLSETS.core!,
  ...TOOLSETS.proposals!,
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
      paramsTemplate: s.paramsTemplate,
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

export interface IntentMatch {
  flow: string;
  score: number;
}

/**
 * Deliberately dumb keyword scoring over `triggers` — the calling model does
 * the semantic matching once it sees the index; a wrong confident match would
 * be worse than a visible menu. Returns matches sorted by score desc.
 */
export function matchIntent(text: string): IntentMatch[] {
  const t = text.toLowerCase();
  const scored = FLOWS.map((f) => {
    let score = 0;
    for (const trigger of f.triggers) {
      if (t.includes(trigger)) score += trigger.split(/\s+/).length + 1; // longer phrases weigh more
      else {
        // partial: count trigger words present individually
        const words = trigger.split(/\s+/).filter((w) => w.length > 3);
        const hits = words.filter((w) => t.includes(w)).length;
        if (words.length > 0 && hits === words.length) score += 1;
      }
    }
    return { flow: f.id, score };
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
  return m[0]!.score >= m[1]!.score * 2 ? m[0]!.flow : null;
}

export { FLOWS, FLOW_BY_ID, GOTCHAS, GOTCHA_BY_ID };
