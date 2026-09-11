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

const flowContextObject = z.object({
  flow: z.string().describe("Flow id from dexe_guide (e.g. 'launch_token_economy')"),
  step: z.string().describe("Step id within that flow (e.g. 'leg_otc')"),
});

/**
 * Accepts the object the schema always required — and, tolerantly, the JSON
 * STRING older/cached dexe_guide output emitted for it.
 *
 * An agent that copies a paramsTemplate literally is the ONLY consumer of this
 * field, so a `-32602 Invalid arguments` there is a dead end it cannot debug:
 * the value it was handed is the value the server rejected. The preprocess is a
 * server-side net, not a widened contract — `z.union([object, string])` would
 * publish an `anyOf` on four composite schemas and cost `tools/list` bytes for
 * a shape nobody should send. ZodEffects is emitted by the SDK's
 * zod-to-json-schema bridge as its INNER schema, so the advertised JSON Schema
 * stays byte-identical to the pre-0.34.0 object form.
 */
export const flowContextSchema = z
  .preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === "object" && parsed !== null ? parsed : v;
    } catch {
      return v;
    }
  }, flowContextObject)
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

/**
 * Compute the chaining fields for a step and (only for a step that actually
 * landed) persist progress.
 *
 * `landed: false` is the PREVIEW form — a dryRun or a no-signer `payloads`
 * response. Those broadcast nothing, so the journey position must NOT move:
 * `setActiveFlow` is rendered back to the agent as COMPLETED work
 * (operationalContext's "last completed step", dexe_guide's "progress: N of M"),
 * and a preview that advanced it would make the next session resume past a step
 * that never happened. The pointers themselves are still worth returning — "what
 * comes after this" is exactly what a caller previewing a step wants — so they
 * are returned with their `when` re-tensed to say the broadcast has not happened.
 */
export function flowChainFields(
  flowContext: FlowContext | undefined,
  state: StateStore | undefined,
  info: { chainId: number; govPool?: string },
  opts?: { landed?: boolean },
): FlowChainFields {
  if (!flowContext) return {};
  const ns = nextAfter(flowContext.flow, flowContext.step);
  if (!ns) return {};
  const landed = opts?.landed !== false;
  try {
    if (state && landed) {
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
    next: landed
      ? ns.next
      : ns.next.map((n) => ({ ...n, when: `after you broadcast this step: ${n.when}` })),
    ...(ns.done && landed ? { flowDone: true } : {}),
  };
}
