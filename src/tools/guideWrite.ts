import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  renderSkillRecipe,
  type GuideText,
  type Knowledge,
  type KnowledgeCorpus,
  type PersistedState,
  type ReadConfig,
  type StateStore,
} from "@dexe-network/dexe-mcp/core";
import { WRITE_CORPUS } from "../knowledge/write/index.js";
import { nextAfter } from "../knowledge/write/nextSteps.js";

/**
 * The WRITE half of the guide: `dexe_write_guide` (the eight write journeys),
 * what follows a write journey across sessions, and the flow recipes as MCP
 * prompts. The standalone server's `dexe_guide` is the read edition's
 * tools/guide.ts, handed the single-server knowledge and the pieces here.
 */

/** The tool that serves the write journeys — registered in both modes. */
export const WRITE_GUIDE_TOOL = "dexe_write_guide";

/**
 * Wording of the guide that serves the write journeys next to the read topics
 * — the standalone server's `dexe_guide` (DEXE_WRITE_STANDALONE=1).
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

/** `dexe_write_guide`'s wording: the write journeys only. */
export const WRITE_GUIDE_TEXT: GuideText = {
  description:
    "Read-only, local. The plan for a multi-step DeXe write request — 'create a DAO', 'launch a token with " +
    "distribution/OTC/staking', 'open a sale', 'pass this proposal', 'run an agent team': the ordered steps " +
    "(which tools, in what order, with what params), the questions to ask the user with per-parameter risk notes, " +
    "and the known pitfalls for that journey. A step whose tool another server provides says so (providedBy). " +
    "No args or a free-text `intent` returns the menu; `flow` returns the full plan.",
  intent:
    "The user's request in free text — matched against the flow triggers (e.g. 'create a token and sell 20% via OTC').",
  flow: "Exact flow id. Takes precedence over `intent`; omit both for the menu.",
  multiMatchNote: FLOW_GUIDE_TEXT.multiMatchNote,
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
        `from the 'next' pointer (or call ${WRITE_GUIDE_TOOL} {flow:"${active.flow}"} for the full plan).`,
    },
  };
}

/**
 * `dexe_write_guide` — the write journeys as a tool result, in the same two
 * tiers as the read edition's `dexe_guide` (an index of ~300 tokens; a flow's
 * full plan of ~1-2k) over the same knowledge engine. Its knowledge is the
 * write corpus bound to this server's tool locator (src/knowledge/index.ts
 * `writeGuideKnowledge`): on the write-only server a step that reads — the
 * proposal state, the predicted addresses, the staking and sale views, the
 * report — is located `providedBy` the read server.
 *
 * Not the read edition's register function under another name: that one names
 * `dexe_guide` in its own index text, a tool the write-only server does not
 * have.
 */
export function registerWriteGuideTool(
  server: McpServer,
  config: ReadConfig,
  state: StateStore,
  knowledge: Knowledge,
): void {
  const ids = knowledge.ids as [string, ...string[]];
  if (ids.length === 0) throw new Error(`${WRITE_GUIDE_TOOL}: the knowledge corpus is empty`);
  const text = WRITE_GUIDE_TEXT;

  server.registerTool(
    WRITE_GUIDE_TOOL,
    {
      title: "Write flow plans and pitfalls",
      description: text.description,
      inputSchema: {
        intent: z.string().optional().describe(text.intent),
        flow: z.enum(ids).optional().describe(text.flow),
        chainId: z
          .number()
          .int()
          .optional()
          .describe("Target chain (56 mainnet / 97 testnet). Defaults to the last-used, then the configured default chain."),
      },
    },
    async ({ intent, flow, chainId }) => {
      const st = state.getState();
      const resolvedChainId = chainId ?? st.lastChainId ?? config.defaultChainId;
      // A known DAO means most flows can skip the "which govPool?" question.
      const lastDao = st.knownDaos[0];
      const context = {
        chainId: resolvedChainId,
        chainIdSource: chainId !== undefined ? "argument" : st.lastChainId !== undefined ? "last-used" : "default",
        ...(lastDao
          ? {
              knownDao: {
                name: lastDao.name,
                govPool: lastDao.govPool,
                chainId: lastDao.chainId,
                hint: "You already have this DAO from a prior session — confirm reuse with the user instead of asking for an address.",
              },
            }
          : {}),
        ...activeFlowContext(st),
      };

      const wanted = flow ?? (intent ? knowledge.bestMatch(intent) : null);
      const detail = wanted ? knowledge.flowDetail(wanted, { chainId: resolvedChainId }) : null;
      if (detail) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ mode: "flow-detail", context, ...detail }, null, 2) },
          ],
        };
      }

      const candidates = intent ? knowledge.matchIntent(intent).map((m) => m.flow) : [];
      const index = {
        mode: "flow-index" as const,
        ...(flow ? { note: `Unknown flow '${flow}'. Pick one of the ids below.` } : {}),
        ...(intent && candidates.length > 1 ? { note: text.multiMatchNote(candidates) } : {}),
        context,
        flows: knowledge.flowIndex(),
        next:
          `Call ${WRITE_GUIDE_TOOL} again with flow:"<id>" to get the full plan (interview questions, step order, ` +
          "gotchas). Reading DAO data (subgraph queries, reports) is not a write journey: dexe_guide (read server) " +
          "has those reference topics.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }] };
    },
  );
}

/**
 * MCP prompts (Phase B) — one per flow, for hosts that support the prompts
 * surface. Body = the same generated recipe the skills carry, closing with a
 * pointer at `dexe_write_guide` (registered in both modes). Prompts are not
 * tools: they are not gated by DEXE_TOOLSETS and don't affect the tool count.
 */
export function registerKnowledgePrompts(
  server: McpServer,
  opts: {
    corpus?: KnowledgeCorpus;
    /**
     * Applied to each rendered recipe. The write-only server passes
     * `markReadTools`: a recipe lists its steps by tool, and the read steps'
     * tools are the read server's there.
     */
    transform?: (text: string) => string;
  } = {},
): void {
  const corpus = opts.corpus ?? WRITE_CORPUS;
  const transform = opts.transform ?? ((t: string) => t);
  for (const flow of corpus.flows) {
    server.registerPrompt(
      `dexe-flow-${flow.id}`,
      { description: flow.summary },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: transform(renderSkillRecipe(corpus, flow.id, WRITE_GUIDE_TOOL)) },
          },
        ],
      }),
    );
  }
}
