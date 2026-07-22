import { z } from "zod";
import { nextAfter } from "../knowledge/nextSteps.js";
import type { StateStore } from "./stateStore.js";

/**
 * Composite-side glue for the knowledge layer's structured chaining (Phase B).
 * dexe_guide pre-fills `flowContext: {flow, step}` into its paramsTemplates;
 * a composite that receives it attaches `flowProgress` + `next` to its success
 * payload and persists the journey position in the StateStore. Everything is
 * best-effort: a stale/typo'd flowContext or a state-write failure must never
 * break a broadcast that already landed.
 */

export const flowContextSchema = z
  .object({
    flow: z.string().describe("Flow id from dexe_guide (e.g. 'launch_token_economy')"),
    step: z.string().describe("Step id within that flow (e.g. 'leg_otc')"),
  })
  .optional()
  .describe(
    "Guided-flow position, pre-filled by dexe_guide's step templates. When present, the success payload " +
      "gains flowProgress + next (what to call next) and the position persists across sessions.",
  );

export type FlowContext = { flow: string; step: string };

export interface FlowChainFields {
  flowProgress?: { flow: string; title: string; step: string; stepIndex: number; of: number };
  next?: Array<{ tool: string; when: string; why: string }>;
  flowDone?: boolean;
}

/** Compute the chaining fields for a SUCCESSFUL step and persist progress. */
export function flowChainFields(
  flowContext: FlowContext | undefined,
  state: StateStore | undefined,
  info: { chainId: number; govPool?: string },
): FlowChainFields {
  if (!flowContext) return {};
  const ns = nextAfter(flowContext.flow, flowContext.step);
  if (!ns) return {};
  try {
    if (state) {
      if (ns.done) state.clearActiveFlow();
      else
        state.setActiveFlow({
          flow: flowContext.flow,
          step: flowContext.step,
          chainId: info.chainId,
          ...(info.govPool ? { govPool: info.govPool } : {}),
        });
    }
  } catch {
    // best-effort — never fail a landed broadcast over state persistence
  }
  return {
    flowProgress: ns.flowProgress,
    next: ns.next,
    ...(ns.done ? { flowDone: true } : {}),
  };
}
