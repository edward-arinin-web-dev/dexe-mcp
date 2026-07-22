import { FLOW_BY_ID } from "./flows.js";

/**
 * Structured next-step chaining (Phase B). Composites that receive a
 * `flowContext: {flow, step}` (pre-filled by dexe_guide's paramsTemplates)
 * attach the result of `nextAfter()` to their success payload — so the agent
 * reads "what to call next" right in the tool result instead of re-deriving
 * the journey.
 */

export interface FlowProgress {
  flow: string;
  title: string;
  step: string;
  /** 1-based position of `step` in the flow. */
  stepIndex: number;
  of: number;
}

export interface NextPointer {
  /** MCP tool to call (dexe_guide for sub-flow legs). */
  tool: string;
  when: string;
  why: string;
}

export interface NextSteps {
  flowProgress: FlowProgress;
  next: NextPointer[];
  /** True when this was the flow's final step — the journey is complete. */
  done: boolean;
}

/**
 * Resolve what comes after `stepId` of `flowId`. Returns null for unknown
 * flow/step ids — callers treat that as "no chaining info" and omit the
 * fields (a stale or hand-typed flowContext must never break a composite).
 */
export function nextAfter(flowId: string, stepId: string): NextSteps | null {
  const flow = FLOW_BY_ID.get(flowId);
  if (!flow) return null;
  const idx = flow.steps.findIndex((s) => s.id === stepId);
  if (idx === -1) return null;
  const step = flow.steps[idx]!;

  const next: NextPointer[] = [];
  if (step.next?.length) {
    for (const n of step.next) {
      if (n.flowRef) {
        // Cross-flow pointer — fetch the next journey's plan via dexe_guide.
        next.push({
          tool: "dexe_guide",
          when: n.when,
          why: `${n.why} — call dexe_guide with flow:"${n.flowRef}" for the plan`,
        });
        continue;
      }
      const target = flow.steps.find((s) => s.id === n.stepId);
      if (!target) continue;
      next.push({ tool: target.tool, when: n.when, why: n.why });
    }
  } else if (idx + 1 < flow.steps.length) {
    const following = flow.steps[idx + 1]!;
    next.push({
      tool: following.tool,
      when: following.optionalWhen ? `unless: ${following.optionalWhen}` : "always",
      why: following.purpose.split(".")[0] ?? following.purpose,
    });
  }

  const done = next.length === 0;
  return {
    flowProgress: {
      flow: flow.id,
      title: flow.title,
      step: step.id,
      stepIndex: idx + 1,
      of: flow.steps.length,
    },
    next,
    done,
  };
}
