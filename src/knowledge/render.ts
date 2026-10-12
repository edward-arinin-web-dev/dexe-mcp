import type { Flow, Gotcha, KnowledgeCorpus, Topic } from "./types.js";
import { knownFailures, type KnownFailure } from "../lib/errors.js";

/**
 * Markdown renderers for a knowledge corpus. Used by scripts/gen-knowledge.ts
 * to rewrite the marked GENERATED regions of docs/PLAYBOOK.md and the skill
 * bodies, and by the MCP prompts. Deterministic output — CI diff-checks it.
 *
 * Every renderer takes the corpus it renders: the engine knows no corpus of
 * its own (./engine.ts).
 */

const SEVERITY_MARK: Record<Gotcha["severity"], string> = {
  danger: "🔴",
  warn: "⚠",
  info: "ℹ",
};

const SEVERITY_RANK = { danger: 0, warn: 1, info: 2 } as const;

function renderFlow(f: Flow): string {
  const lines: string[] = [];
  lines.push(`### ${f.title} (\`${f.id}\`)`);
  lines.push("");
  lines.push(f.summary);
  if (f.chainNotes) {
    for (const [chain, note] of Object.entries(f.chainNotes)) {
      lines.push(`- **chain ${chain}:** ${note}`);
    }
  }
  lines.push("");
  lines.push("**Ask the user:**");
  for (const p of f.interview) {
    const bits = [p.ask];
    if (p.default) bits.push(`default \`${p.default}\``);
    if (p.constraint) bits.push(`constraint: ${p.constraint}`);
    if (p.riskIfUnusual) bits.push(`⚠ ${p.riskIfUnusual}`);
    lines.push(`- \`${p.name}\`${p.required ? "" : " (optional)"} — ${bits.join(" · ")}`);
  }
  lines.push("");
  lines.push("**Steps:**");
  f.steps.forEach((s, i) => {
    const opt = s.optionalWhen ? ` _(skip when: ${s.optionalWhen})_` : "";
    lines.push(`${i + 1}. \`${s.tool}\` — ${s.purpose}${opt}`);
  });
  return lines.join("\n");
}

/** The `flows` generated region: every flow as a compact recipe. */
export function renderFlowsSection(corpus: KnowledgeCorpus): string {
  return corpus.flows.map(renderFlow).join("\n\n");
}

function renderTopic(corpus: KnowledgeCorpus, t: Topic): string {
  const gotchas = corpus.gotchas
    .filter((g) => (t.gotchaIds ?? []).includes(g.id))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const lines: string[] = [];
  lines.push(`### ${t.title} (\`${t.id}\`)`);
  lines.push("");
  lines.push(t.summary);
  for (const s of t.sections) {
    lines.push("");
    lines.push(`#### ${s.heading}`);
    lines.push("");
    lines.push(s.text);
  }
  if (gotchas.length) {
    lines.push("");
    lines.push("**Pitfalls (danger first):**");
    for (const g of gotchas) lines.push(`- ${SEVERITY_MARK[g.severity]} ${g.text}`);
  }
  return lines.join("\n");
}

/** The `topics` generated region: reference topics (non-journey knowledge). */
export function renderTopicsSection(corpus: KnowledgeCorpus): string {
  return corpus.topics.map((t) => renderTopic(corpus, t)).join("\n\n");
}

/** The `gotchas` generated region: the corpus's full rule set, danger-first. */
export function renderGotchasSection(corpus: KnowledgeCorpus): string {
  const sorted = [...corpus.gotchas].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return sorted
    .map((g) => `- ${SEVERITY_MARK[g.severity]} **${g.id}** — ${g.text}`)
    .join("\n");
}

/**
 * The `error-slugs` generated region: rendered from the known-failure table
 * (one source). Defaults to the table registered in this process; gen:knowledge
 * passes the single server's combined read + write table explicitly.
 */
export function renderErrorTable(table: readonly KnownFailure[] = knownFailures()): string {
  const rows = table.map(
    (k) => `| \`${k.slug}\` | ${k.what} | ${k.remedy.replace(/\n/g, " ")} |`,
  );
  return ["| Failure | What it means | Do this |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Per-flow recipe for a skill's generated region (and the MCP prompts): the
 * flow recipe + its gotchas, danger-first — chain-agnostic, so every gotcha is
 * included. The closing line points at the guide tool that serves the
 * machine-readable plan for this corpus.
 */
export function renderSkillRecipe(corpus: KnowledgeCorpus, flowId: string, guideTool = "dexe_guide"): string {
  const f = corpus.flows.find((x) => x.id === flowId);
  if (!f) throw new Error(`renderSkillRecipe: unknown flow '${flowId}'`);
  const ids = new Set<string>([...f.gotchaIds, ...f.steps.flatMap((s) => s.gotchaIds ?? [])]);
  const gotchas = corpus.gotchas
    .filter((g) => ids.has(g.id))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const lines: string[] = [renderFlow(f)];
  lines.push("");
  lines.push("**Pitfalls (danger first):**");
  for (const g of gotchas) lines.push(`- ${SEVERITY_MARK[g.severity]} ${g.text}`);
  lines.push("");
  lines.push(
    "_For the machine-readable plan (interview questions with risk notes, step templates with `flowContext` " +
      "chaining), call the `" + guideTool + "` tool with `flow:\"" + f.id + "\"`._",
  );
  return lines.join("\n");
}
