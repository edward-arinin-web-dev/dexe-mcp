import type {
  Flow,
  Gotcha,
  KnowledgeCorpus,
  ParamSpec,
  Topic,
  TopicSection,
  ToolLocation,
  ToolLocator,
} from "./types.js";

/**
 * The knowledge engine — pure query functions over ONE corpus, no I/O, no
 * server types. A corpus and a tool locator go in; the index tier, the detail
 * tiers and the intent matcher come out. `dexe_guide` (src/tools/guide.ts) is a
 * thin wrapper over the result; scripts/gen-knowledge.ts renders the same data
 * through ./render.ts.
 *
 * The engine names no corpus and no toolset. Which flows, topics and gotchas
 * exist is the corpus's business; where a tool comes from — a toolset on this
 * server, or another server altogether — is the locator's. That is what lets a
 * write edition serve its flows with "provided by the read server" next to the
 * read tools they call (`createToolLocator({ elsewhere })`).
 */

export interface FlowIndexEntry {
  flow: string;
  title: string;
  summary: string;
  triggers: string[];
}

export interface TopicIndexEntry {
  topic: string;
  title: string;
  summary: string;
  triggers: string[];
}

export interface ResolvedGotcha {
  id: string;
  severity: Gotcha["severity"];
  text: string;
}

export interface FlowStepDetail extends ToolLocation {
  id: string;
  tool: string;
  purpose: string;
  /**
   * Argument template for the step's tool. Values are mostly `{{placeholder}}`
   * strings, but NOT all: `flowContext` is emitted as the OBJECT the composites'
   * schema requires (see below), so an agent can copy the template verbatim.
   */
  paramsTemplate: Record<string, unknown>;
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

/** A tool a reference topic documents, located the same way as a flow step's. */
export interface TopicToolRef extends ToolLocation {
  tool: string;
}

/** The detail tier for one reference topic (~1-2k tokens serialized). */
export interface TopicDetail {
  topic: string;
  title: string;
  summary: string;
  sections: TopicSection[];
  tools: TopicToolRef[];
  gotchas: ResolvedGotcha[];
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

/** One corpus, bound to a tool locator: everything `dexe_guide` serves. */
export interface Knowledge {
  readonly corpus: KnowledgeCorpus;
  readonly flowById: ReadonlyMap<string, Flow>;
  readonly topicById: ReadonlyMap<string, Topic>;
  readonly gotchaById: ReadonlyMap<string, Gotcha>;
  /** Flow ids, then topic ids — the closed set the guide's `flow` argument accepts. */
  readonly ids: readonly string[];
  /** The compact index tier (~300 tokens serialized). */
  flowIndex(): FlowIndexEntry[];
  /** Reference topics for the index tier — fetched the same way as flows. */
  topicIndex(): TopicIndexEntry[];
  /** The detail tier for one flow (~1-2k tokens serialized). */
  flowDetail(id: string, opts?: { chainId?: number }): FlowDetail | null;
  topicDetail(id: string, opts?: { chainId?: number }): TopicDetail | null;
  matchIntent(text: string): IntentMatch[];
  bestMatch(text: string): string | null;
}

/**
 * The standard locator: a tool in the default profile needs nothing; a tool in
 * a gated set names the set(s) that expose it; a tool this server does not
 * register at all but `elsewhere` lists is reported as provided by that server.
 *
 * `defaultTools` must come from the gate's own default-profile resolution,
 * never a hardcoded list: `DEFAULT_TOOLSETS` moved once (0.31.0, core+proposals
 * → core) and a copy would have kept telling agents that tools they can see
 * need enabling — and, worse, kept silent about the ones that genuinely do.
 */
export function createToolLocator(opts: {
  toolsets: Readonly<Record<string, ReadonlySet<string>>>;
  defaultTools: ReadonlySet<string>;
  elsewhere?: { tools: ReadonlySet<string>; providedBy: string };
}): ToolLocator {
  return (tool) => {
    if (opts.defaultTools.has(tool)) return {};
    const sets = Object.entries(opts.toolsets)
      .filter(([, names]) => names.has(tool))
      .map(([set]) => set);
    if (sets.length) return { requiresToolset: sets.join("|") };
    if (opts.elsewhere?.tools.has(tool)) return { providedBy: opts.elsewhere.providedBy };
    return {};
  };
}

const SEVERITY_RANK = { danger: 0, warn: 1, info: 2 } as const;

export function createKnowledge(corpus: KnowledgeCorpus, locate: ToolLocator): Knowledge {
  if (corpus.flows.length > 0 && !corpus.agentProtocol) {
    throw new Error("knowledge corpus: a corpus with flows needs an agentProtocol");
  }
  const flowById: ReadonlyMap<string, Flow> = new Map(corpus.flows.map((f) => [f.id, f]));
  const topicById: ReadonlyMap<string, Topic> = new Map(corpus.topics.map((t) => [t.id, t]));
  const gotchaById: ReadonlyMap<string, Gotcha> = new Map(corpus.gotchas.map((g) => [g.id, g]));
  const chainingTools: ReadonlySet<string> = corpus.chainingTools ?? new Set();

  /** The locator's answer with only the fields it set, in a fixed key order. */
  function location(tool: string): ToolLocation {
    const loc = locate(tool);
    return {
      ...(loc.requiresToolset ? { requiresToolset: loc.requiresToolset } : {}),
      ...(loc.providedBy ? { providedBy: loc.providedBy } : {}),
    };
  }

  function resolveGotchas(ids: readonly string[] | undefined, chainId?: number): ResolvedGotcha[] {
    if (!ids?.length) return [];
    const out: ResolvedGotcha[] = [];
    for (const id of ids) {
      const g = gotchaById.get(id);
      if (!g) continue; // integrity test guarantees this never happens in practice
      if (chainId !== undefined && g.applies.chains && !g.applies.chains.includes(chainId)) continue;
      out.push({ id: g.id, severity: g.severity, text: g.text });
    }
    // danger first — the agent reads top-down.
    return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }

  function flowDetail(id: string, opts?: { chainId?: number }): FlowDetail | null {
    const f = flowById.get(id);
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
        ...location(s.tool),
        purpose: s.purpose,
        // Chaining composites get their guided-flow position pre-filled: pass it
        // through verbatim and the success payload returns flowProgress + next.
        // `flowContext` is an OBJECT: src/lib/flowChain.ts declares it as
        // z.object({flow, step}), so the JSON-STRING form this used to emit was
        // rejected by MCP input validation before the handler ran — and an agent's
        // likeliest recovery (drop the field) silently disables flowProgress/next.
        paramsTemplate: chainingTools.has(s.tool)
          ? { ...s.paramsTemplate, flowContext: { flow: f.id, step: s.id } }
          : s.paramsTemplate,
        ...(s.bindsFrom ? { bindsFrom: s.bindsFrom } : {}),
        ...(s.optionalWhen ? { optionalWhen: s.optionalWhen } : {}),
        gotchas: resolveGotchas(s.gotchaIds, chainId),
        reportOnSuccess: s.reportOnSuccess,
        ...(s.next ? { next: s.next } : {}),
      })),
      gotchas: resolveGotchas(f.gotchaIds, chainId),
      ...(f.subFlows ? { subFlows: [...f.subFlows] } : {}),
      agentProtocol: corpus.agentProtocol!,
    };
  }

  function topicDetail(id: string, opts?: { chainId?: number }): TopicDetail | null {
    const t = topicById.get(id);
    if (!t) return null;
    return {
      topic: t.id,
      title: t.title,
      summary: t.summary,
      sections: [...t.sections],
      tools: t.tools.map((tool) => ({ tool, ...location(tool) })),
      gotchas: resolveGotchas(t.gotchaIds, opts?.chainId),
    };
  }

  /**
   * Deliberately dumb keyword scoring over `triggers` — the calling model does
   * the semantic matching once it sees the index; a wrong confident match would
   * be worse than a visible menu. Scores flows and reference topics in one
   * pass (shared id namespace). Returns matches sorted by score desc.
   */
  function matchIntent(text: string): IntentMatch[] {
    const t = text.toLowerCase();
    const candidates: Array<Pick<Flow | Topic, "id" | "triggers">> = [...corpus.flows, ...corpus.topics];
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
   * + staking in one breath) is the corpus's umbrella journey — a single-leg
   * match would silently drop the rest of the request.
   */
  function bestMatch(text: string): string | null {
    const m = matchIntent(text);
    if (m.length === 0) return null;
    const umbrella = corpus.umbrellaFlow;
    const spansMany = umbrella !== undefined && m.length >= 3 && m.some((x) => x.flow === umbrella);
    if (spansMany) return umbrella;
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

  return {
    corpus,
    flowById,
    topicById,
    gotchaById,
    ids: [...corpus.flows.map((f) => f.id), ...corpus.topics.map((t) => t.id)],
    flowIndex: () => corpus.flows.map((f) => ({ flow: f.id, title: f.title, summary: f.summary, triggers: f.triggers })),
    topicIndex: () =>
      corpus.topics.map((t) => ({ topic: t.id, title: t.title, summary: t.summary, triggers: t.triggers })),
    flowDetail,
    topicDetail,
    matchIntent,
    bestMatch,
  };
}
