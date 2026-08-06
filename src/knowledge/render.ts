import type { Flow, Gotcha, Topic } from "./types.js";
import { FLOWS } from "./flows.js";
import { TOPICS } from "./topics.js";
import { GOTCHAS } from "./gotchas.js";
import { KNOWN_FAILURES } from "../lib/errors.js";

/**
 * Markdown renderers for the knowledge corpus. Used by scripts/gen-knowledge.ts
 * to rewrite the marked GENERATED regions of docs/PLAYBOOK.md (and, Phase B,
 * skill bodies + MCP prompts). Deterministic output — CI diff-checks it.
 */

const SEVERITY_MARK: Record<Gotcha["severity"], string> = {
  danger: "🔴",
  warn: "⚠",
  info: "ℹ",
};

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
export function renderFlowsSection(): string {
  return FLOWS.map(renderFlow).join("\n\n");
}

function renderTopic(t: Topic): string {
  const rank = { danger: 0, warn: 1, info: 2 } as const;
  const gotchas = GOTCHAS.filter((g) => (t.gotchaIds ?? []).includes(g.id)).sort(
    (a, b) => rank[a.severity] - rank[b.severity],
  );
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
export function renderTopicsSection(): string {
  return TOPICS.map(renderTopic).join("\n\n");
}

/** The `gotchas` generated region: the full rule corpus, danger-first. */
export function renderGotchasSection(): string {
  const rank = { danger: 0, warn: 1, info: 2 } as const;
  const sorted = [...GOTCHAS].sort((a, b) => rank[a.severity] - rank[b.severity]);
  return sorted
    .map((g) => `- ${SEVERITY_MARK[g.severity]} **${g.id}** — ${g.text}`)
    .join("\n");
}

/** The `error-remedies` generated region: rendered from KNOWN_FAILURES (one source). */
export function renderErrorTable(): string {
  const rows = KNOWN_FAILURES.map(
    (k) => `| \`${k.slug}\` | ${k.what} | ${k.remedy.replace(/\n/g, " ")} |`,
  );
  return ["| Failure | What it means | Do this |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Per-flow recipe for a skill's generated region (and the MCP prompts):
 * the flow recipe + its resolved gotchas, danger-first. Uses flowDetail so
 * chain-agnostic (no chainId → all gotchas included).
 */
export function renderSkillRecipe(flowId: string): string {
  const f = FLOWS.find((x) => x.id === flowId);
  if (!f) throw new Error(`renderSkillRecipe: unknown flow '${flowId}'`);
  const rank = { danger: 0, warn: 1, info: 2 } as const;
  const ids = new Set<string>([...f.gotchaIds, ...f.steps.flatMap((s) => s.gotchaIds ?? [])]);
  const gotchas = GOTCHAS.filter((g) => ids.has(g.id)).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const lines: string[] = [renderFlowsSectionFor(f)];
  lines.push("");
  lines.push("**Pitfalls (danger first):**");
  for (const g of gotchas) lines.push(`- ${SEVERITY_MARK[g.severity]} ${g.text}`);
  lines.push("");
  lines.push(
    "_For the machine-readable plan (interview questions with risk notes, step templates with `flowContext` " +
      "chaining), call the `dexe_guide` tool with `flow:\"" + f.id + "\"`._",
  );
  return lines.join("\n");
}

function renderFlowsSectionFor(f: Flow): string {
  return renderFlow(f);
}
