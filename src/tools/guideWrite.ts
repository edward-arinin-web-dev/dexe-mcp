import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  renderSkillRecipe,
  type GuideText,
  type KnowledgeCorpus,
  type PersistedState,
} from "@dexe-network/dexe-mcp/core";
import { WRITE_CORPUS } from "../knowledge/write/index.js";
import { nextAfter } from "../knowledge/write/nextSteps.js";

/**
 * The WRITE half of the guide: what follows a write journey, and the flow
 * recipes as MCP prompts. The tool itself is the read edition's tools/guide.ts; the
 * composition root hands it these.
 */

/**
 * Wording of the guide that serves the write journeys next to the read topics
 * — the single server's `dexe_guide`.
 */
export const FLOW_GUIDE_TEXT: GuideText = {
  description:
    "Read-only, local. The plan for a multi-step or unfamiliar DeXe request — 'create a DAO', " +
    "'launch a token with distribution/OTC/staking', 'open a sale', 'pass this proposal': the ordered steps " +
    "(which tools, in what order, with what params), the questions to ask the user with per-parameter risk " +
    "notes, and the known pitfalls for that journey. Reference topics answer data questions the same way " +
    "(flow:\"read_dao_data\" covers the whole read surface). No args or a free-text `intent` returns the menu; " +
    "`flow` returns the full plan.",
  intent:
    "The user's request in free text — matched against the flow triggers (e.g. 'create a token and sell 20% via OTC').",
  flow: "Exact flow or topic id. Takes precedence over `intent`; omit both for the menu.",
  multiMatchNote: (candidates) =>
    `The request matches several flows (${candidates.join(", ")}). If it genuinely spans more than one ` +
    "(create + distribute + sale + staking), pick launch_token_economy; otherwise pick the single best fit.",
};

/**
 * Cross-session resume: the flow a composite recorded as mid-journey, with the
 * step it reached and what comes next. Goes into the guide's `context`.
 */
export function activeFlowContext(st: PersistedState): Record<string, unknown> {
  const active = st.activeFlow;
  const activeProgress = active ? nextAfter(active.flow, active.step) : null;
  if (!active || !activeProgress) return {};
  return {
    activeFlow: {
      ...active,
      progress: `${activeProgress.flowProgress.stepIndex} of ${activeProgress.flowProgress.of} (last completed: ${active.step})`,
      next: activeProgress.next,
      hint:
        `A prior session left flow '${active.flow}' mid-journey. Confirm with the user, then continue ` +
        `from the 'next' pointer (or call dexe_guide {flow:"${active.flow}"} for the full plan).`,
    },
  };
}

/**
 * MCP prompts (Phase B) — one per flow, for hosts that support the prompts
 * surface. Body = the same generated recipe the skills carry. Prompts are not
 * tools: they are not gated by DEXE_TOOLSETS and don't affect the tool count.
 */
export function registerKnowledgePrompts(server: McpServer, corpus: KnowledgeCorpus = WRITE_CORPUS): void {
  for (const flow of corpus.flows) {
    server.registerPrompt(
      `dexe-flow-${flow.id}`,
      { description: flow.summary },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: renderSkillRecipe(corpus, flow.id) },
          },
        ],
      }),
    );
  }
}
