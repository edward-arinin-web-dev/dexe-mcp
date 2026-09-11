/**
 * The one warning shape every build surface speaks.
 *
 * 0.33.0 shipped three incompatible advisory channels — `advisories`
 * (`{id,severity,upstream,text}`, voteBuild), `governanceAdvisories`
 * (`string[]`, the two wrapper modules) and a text-only advisory string
 * (proposalBuild) — so a guard added at one of them was invisible at the other
 * two, and two of the three never reached `structuredContent` at all. Worse,
 * each guard had to be remembered at N call sites; `src/lib/dangerousSelectors.ts`
 * had already written the lesson down ("a guard each call site has to remember
 * to call is a guard that will be forgotten") and it was applied to the
 * broadcast path only.
 *
 * `BuildWarning` is the convergence type. `src/lib/buildAdvisories.ts` produces
 * it from the EMITTED CALLDATA (never from caller-supplied hints, which is what
 * puts the remembering back on the call site), and `src/tools/buildResult.ts`
 * renders it into every surface — always as `structuredContent.warnings`, and
 * additionally merged into whichever legacy channel that file already
 * published, so nothing parsing 0.33.0 output breaks.
 *
 * ── The two-axis tier model ────────────────────────────────────────────────
 *
 * `severity` is how bad the outcome is. `block` is what the tooling DOES about
 * it. They are deliberately separate: 0.33.0 conflated them and the result was
 * either a DANGER that silently proceeded or a hard refusal on a recoverable
 * mistake.
 *
 *   block: "none"        advisory everywhere. Nothing is ever refused.
 *   block: "confirmable" refused at surfaces that SPEND GAS (the composites),
 *                        overridable with `confirmRisky: true`. Build-only
 *                        surfaces annotate and still return the calldata.
 *   block: "hard"        refused everywhere, no override, at every surface.
 *
 * Why "confirmable" does not refuse a pure builder: `src/lib/quorumRisk.ts`
 * states the project posture — "`build` — emits calldata only. NEVER blocks
 * (refusing here just routes the caller to a hand-crafted custom_abi with no
 * guard at all)". The build tools exist so an agent can INSPECT actions before
 * creating; refusing there removes the only legitimate way to look at the
 * calldata and buys nothing, because the gate that matters already sits on
 * `dexe_proposal_create` / `dexe_proposal_vote_and_execute`.
 *
 * Why "hard" still refuses everywhere: `dangerousSelectors.ts` and the
 * blacklist check have always published "hard block, no override", and routing
 * them through an overridable tier would be a security downgrade.
 *
 * PROJECT RULE, pinned by test: every code beginning `treasury.` MUST carry
 * `block: "none"`. The treasury guard is advisory-only and never blocks.
 */
import { z } from "zod";

export type WarningSeverity = "INFO" | "WARN" | "DANGER";

/** What the tooling does about a warning. See the tier model above. */
export type WarningBlock = "none" | "confirmable" | "hard";

export interface BuildWarning {
  /** Stable + greppable: "settings.bounds", "approve.target", "treasury.over-balance". */
  readonly code: string;
  readonly severity: WarningSeverity;
  readonly block: WarningBlock;
  /** What is wrong, quoting the offending values. */
  readonly message: string;
  /** The exact param change or next call that fixes it. */
  readonly remedy: string;
  /** Where the full story lives, e.g. "docs/UPSTREAM-ISSUES.md (F15)". */
  readonly upstream?: string;
  /**
   * The `UpstreamAdvisory` id ("#36", "F12", "F15") when this warning restates
   * one. Dedupe and the existing upstream-trap tests key on it.
   */
  readonly id?: string;
  /** Index into the action array this warning is about, when it is about one. */
  readonly actionIndex?: number;
}

export const BuildWarningSchema = z.object({
  code: z.string(),
  severity: z.enum(["INFO", "WARN", "DANGER"]),
  block: z.enum(["none", "confirmable", "hard"]),
  message: z.string(),
  remedy: z.string(),
  upstream: z.string().optional(),
  id: z.string().optional(),
  actionIndex: z.number().optional(),
});

/**
 * Zod entry for a tool's `outputSchema`. Optional, so no existing client breaks.
 *
 * Deliberately NO `.describe()`: this field is declared on ~40 tools and every
 * character of it is paid on every `tools/list`, against a byte budget the
 * project treats as a budget and not as debt. The field name plus the per-key
 * descriptions inside `BuildWarningSchema`'s entries carry the meaning.
 */
export const warningsOutputField = z
  .array(
    z.object({
      code: z.string(),
      severity: z.string(),
      block: z.string(),
      message: z.string(),
      remedy: z.string(),
    }),
  )
  .optional();

/**
 * Prefix for a chain-keyed warning raised against a chain the caller never
 * named. Such a warning is downgraded to WARN / block:"none" — refusing on an
 * assumed chain is how a testnet-default install would false-refuse a mainnet
 * build (and vice versa).
 */
export function assumedChainPrefix(chainId: number): string {
  return `chainId was not supplied; assumed ${chainId} — `;
}

/**
 * One line for a human/LLM reader. Warnings that restate an `UpstreamAdvisory`
 * carry its already-prefixed text verbatim (the existing upstream-trap tests
 * match on that wording), everything else is composed here.
 */
export function warningLine(w: BuildWarning): string {
  if (w.upstream) return w.message;
  return `⚠ ${w.severity} — ${w.code}: ${w.message} ${w.remedy}`;
}

/** The `WARNINGS:` block appended to a tool's text output. Null when empty. */
export function renderWarningBlock(warnings: readonly BuildWarning[]): string | null {
  if (warnings.length === 0) return null;
  return `WARNINGS:\n${warnings.map((w) => `- ${warningLine(w)}`).join("\n")}`;
}

/** The strictest `block` across a set. "none" for an empty set. */
export function worstBlock(warnings: readonly BuildWarning[]): WarningBlock {
  if (warnings.some((w) => w.block === "hard")) return "hard";
  if (warnings.some((w) => w.block === "confirmable")) return "confirmable";
  return "none";
}

/** Refusal text for warnings that stop a call. Quotes each message + remedy. */
export function refusalText(warnings: readonly BuildWarning[]): string {
  return warnings.map((w) => `${w.message} ${w.remedy}`).join("\n\n");
}

/**
 * Dedupe by `code` + `actionIndex` + `id`. Used where two passes can see the
 * same calldata (a catalog build annotated by the registry, then re-assessed on
 * the final assembled actions by the composite).
 */
export function dedupeWarnings(warnings: readonly BuildWarning[]): BuildWarning[] {
  const seen = new Set<string>();
  const out: BuildWarning[] = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.actionIndex ?? "-"}|${w.id ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}
