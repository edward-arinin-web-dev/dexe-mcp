import type { Flow, Gotcha } from "./types.js";
import { FLOWS } from "./flows.js";
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
