/**
 * The ONE renderer every build surface returns through.
 *
 * 0.33.0 had four copy-pasted return helpers with divergent advisory plumbing
 * (`proposalBuild.payloadResult`, `proposalBuildMore.wrapperResult`,
 * `proposalBuildComplex.wrapperResult`, `voteBuild.payloadResult`), and two of
 * the four never put the advisory in `structuredContent` at all — so a
 * `dexe_proposal_build_token_transfer` caller reading the structured payload
 * saw `{metadata, actions, nextStep}` and nothing else, while the treasury
 * advisory had in fact been computed and thrown away.
 *
 * `withWarnings` fixes that in one place, and MERGES rather than replaces:
 * `structuredContent.warnings` is always added when there is anything to say,
 * and each file's 0.33.0 channel (`advisories` for voteBuild,
 * `governanceAdvisories` for the two wrapper modules) is preserved alongside it
 * via the `legacy` hook, so nothing parsing the old shape breaks.
 *
 * REFUSAL POLICY — see the tier model in src/lib/buildWarning.ts:
 *   • `block: "hard"` refuses here, always, with the guard's verbatim wording.
 *   • `block: "confirmable"` refuses ONLY when the surface actually has an
 *     override input (i.e. it passed `confirmRisky`). A pure calldata builder
 *     with no override never refuses — it annotates and returns the calldata,
 *     which is the posture src/lib/quorumRisk.ts states for the build stage
 *     ("emits calldata only. NEVER blocks") and the reason the `proposals`
 *     toolset exists at all: to inspect actions before creating them. The gate
 *     that matters lives on the composites, which do broadcast.
 *   • `block: "none"` never refuses anywhere.
 */
import type { ToolContext } from "./context.js";
import {
  assessBuildPure,
  type AssessableAction,
} from "../lib/buildAdvisories.js";
import {
  refusalText,
  renderWarningBlock,
  warningLine,
  type BuildWarning,
} from "../lib/buildWarning.js";

export type { BuildWarning };

/**
 * The single entry point every build tool uses to work out what is wrong with
 * the calldata it is about to hand back. Derives `chainIdExplicit` from whether
 * the caller actually named a chain, so a chain-keyed finding raised against an
 * assumed default is downgraded rather than acted on.
 */
export function assessActions(args: {
  ctx: Pick<ToolContext, "config"> | undefined;
  /** Exactly what the caller passed — `undefined` means "not supplied". */
  chainId: number | undefined;
  actions: readonly AssessableAction[];
  govPool?: string;
  /** Defaults to the configured posture. Pass "off" for personal (non-treasury) payloads. */
  treasuryGuard?: "off" | "warn" | "block";
}): BuildWarning[] {
  const cfg = args.ctx?.config as { defaultChainId?: number; treasuryGuard?: "off" | "warn" | "block" } | undefined;
  const chainId = args.chainId ?? cfg?.defaultChainId ?? 56;
  return assessBuildPure({
    chainId,
    chainIdExplicit: args.chainId !== undefined,
    actions: args.actions,
    treasuryGuard: args.treasuryGuard ?? cfg?.treasuryGuard ?? "warn",
    govPool: args.govPool,
  });
}

export interface WithWarningsOptions {
  /**
   * Pass ONLY from a surface that publishes an override input. Its presence is
   * what makes `block: "confirmable"` enforceable here; a pure builder omits it
   * and therefore annotates instead of refusing.
   */
  confirmRisky?: boolean;
  /**
   * This file's pre-0.34.0 advisory channel. Called with the same warnings so
   * the legacy key and `warnings` can never disagree.
   */
  legacy?: (warnings: BuildWarning[]) => Record<string, unknown>;
}

export interface ToolResultShape {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Warnings that stop this call, given the surface's override posture. */
export function blockingWarnings(
  warnings: readonly BuildWarning[],
  opts?: WithWarningsOptions,
): BuildWarning[] {
  const hard = warnings.filter((w) => w.block === "hard");
  if (opts?.confirmRisky === undefined || opts.confirmRisky) return hard;
  return [...hard, ...warnings.filter((w) => w.block === "confirmable")];
}

export function withWarnings<T extends Record<string, unknown>>(
  base: { text: string; structured: T },
  warnings: readonly BuildWarning[],
  opts?: WithWarningsOptions,
): ToolResultShape {
  const list = [...warnings];
  const blocking = blockingWarnings(list, opts);
  if (blocking.length > 0) {
    return {
      content: [{ type: "text" as const, text: refusalText(blocking) }],
      structuredContent: { mode: "blocked-risky", warnings: list },
      isError: true,
    };
  }
  const block = renderWarningBlock(list);
  return {
    content: [{ type: "text" as const, text: base.text + (block ? `\n\n${block}` : "") }],
    structuredContent: {
      ...base.structured,
      ...(list.length > 0 ? { warnings: list } : {}),
      ...(list.length > 0 && opts?.legacy ? opts.legacy(list) : {}),
    },
  };
}

/** `governanceAdvisories`-shaped legacy channel (the two wrapper modules). */
export function legacyGovernanceAdvisories(existing: readonly string[] = []) {
  return (warnings: BuildWarning[]): Record<string, unknown> => {
    const lines = [...existing, ...warnings.map(warningLine)];
    return lines.length > 0 ? { governanceAdvisories: lines } : {};
  };
}

/** `advisories: [{id,severity,upstream,text}]` legacy channel (voteBuild). */
export function legacyUpstreamAdvisories(
  existing: readonly { id: string; severity: string; upstream: string; text: string }[] = [],
) {
  return (warnings: BuildWarning[]): Record<string, unknown> => {
    const fromWarnings = warnings
      .filter((w) => w.upstream !== undefined)
      .map((w) => ({
        id: w.id ?? w.code,
        severity: w.severity,
        upstream: w.upstream!,
        text: w.message,
      }));
    const all = [...existing, ...fromWarnings];
    return all.length > 0 ? { advisories: all } : {};
  };
}
