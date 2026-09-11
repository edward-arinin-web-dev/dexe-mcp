import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { StateStore } from "../lib/stateStore.js";
import {
  flowIndex,
  flowDetail,
  topicIndex,
  topicDetail,
  matchIntent,
  bestMatch,
  FLOWS,
  TOPICS,
} from "../knowledge/index.js";
import { nextAfter } from "../knowledge/nextSteps.js";
import { renderSkillRecipe } from "../knowledge/render.js";

/**
 * `dexe_guide` — the protocol knowledge tool (Phase A of the knowledge layer).
 *
 * Design premise: weak models reliably CALL TOOLS when instructions say to,
 * but do not reliably read resources or long system instructions. So the
 * protocol knowledge (flow plans, interview questions, gotchas) is served as a
 * tool result — it lands in the context window right before the agent's next
 * decision, which is the highest-leverage position.
 *
 * Two tiers keep token cost low:
 *  - index tier (no args / ambiguous intent): flow menu, ~300 tokens
 *  - detail tier (flow id / confident intent): full plan, ~1-2k tokens
 */
/**
 * MCP prompts (Phase B) — one per flow, for hosts that support the prompts
 * surface. Body = the same generated recipe the skills carry. Prompts are not
 * tools: they are not gated by DEXE_TOOLSETS and don't affect the tool count.
 */
export function registerKnowledgePrompts(server: McpServer): void {
  for (const flow of FLOWS) {
    server.registerPrompt(
      `dexe-flow-${flow.id}`,
      { description: flow.summary },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: renderSkillRecipe(flow.id) },
          },
        ],
      }),
    );
  }
}

/**
 * The complete, compile-time-known set of ids `flow` accepts, built from the
 * same constants the handler resolves against — so adding a flow or a topic
 * publishes it in the schema with no second edit. Published as a `z.enum`
 * (not free text) because the set is closed: an agent that guessed at an id
 * used to pay an index round-trip to learn the ten it could have read here.
 */
const GUIDE_IDS = [...FLOWS.map((f) => f.id), ...TOPICS.map((t) => t.id)] as [string, ...string[]];

export function registerGuideTools(
  server: McpServer,
  config: DexeConfig,
  state: StateStore,
): void {
  server.tool(
    "dexe_guide",
    "Read-only, local. Call this FIRST for any multi-step or unfamiliar DeXe request — 'create a DAO', " +
      "'launch a token with distribution/OTC/staking', 'open a sale', 'pass this proposal'. Returns the ordered " +
      "plan (which tools, in what order, with what params), the questions to ask the user with per-parameter risk " +
      "notes, and the known pitfalls for that journey. Never improvise a governance flow without it. Reference " +
      "topics answer data questions the same way (flow:\"read_dao_data\" covers the whole read surface). No args " +
      "or a free-text `intent` returns the menu; `flow` returns the full plan.",
    {
      intent: z
        .string()
        .optional()
        .describe("The user's request in free text — matched against the flow triggers (e.g. 'create a token and sell 20% via OTC')."),
      flow: z
        .enum(GUIDE_IDS)
        .optional()
        .describe("Exact flow or topic id. Takes precedence over `intent`; omit both for the menu."),
      chainId: z
        .number()
        .int()
        .optional()
        .describe("Target chain (56 mainnet / 97 testnet). Defaults to the last-used, then the configured default chain."),
    },
    async ({ intent, flow, chainId }) => {
      const st = state.getState();
      const resolvedChainId = chainId ?? st.lastChainId ?? config.defaultChainId;

      // Session context prefill: a known DAO means most flows can skip the
      // "which govPool?" question — surface it so the agent offers reuse.
      const lastDao = st.knownDaos[0];
      // Cross-session resume: a mid-journey flow recorded by the composites.
      const active = st.activeFlow;
      const activeProgress = active ? nextAfter(active.flow, active.step) : null;
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
        ...(active && activeProgress
          ? {
              activeFlow: {
                ...active,
                progress: `${activeProgress.flowProgress.stepIndex} of ${activeProgress.flowProgress.of} (last completed: ${active.step})`,
                next: activeProgress.next,
                hint:
                  `A prior session left flow '${active.flow}' mid-journey. Confirm with the user, then continue ` +
                  `from the 'next' pointer (or call dexe_guide {flow:"${active.flow}"} for the full plan).`,
              },
            }
          : {}),
      };

      const wanted = flow ?? (intent ? bestMatch(intent) : null);

      if (wanted) {
        const detail = flowDetail(wanted, { chainId: resolvedChainId });
        if (detail) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ mode: "flow-detail", context, ...detail }, null, 2) },
            ],
          };
        }
        const topic = topicDetail(wanted, { chainId: resolvedChainId });
        if (topic) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ mode: "topic-detail", context, ...topic }, null, 2) },
            ],
          };
        }
        // Unknown explicit flow/topic id → fall through to the index with a note.
      }

      const candidates = intent ? matchIntent(intent).map((m) => m.flow) : [];
      const index = {
        mode: "flow-index" as const,
        ...(flow && !flowDetail(flow) && !topicDetail(flow)
          ? { note: `Unknown flow '${flow}'. Pick one of the ids below.` }
          : {}),
        ...(intent && candidates.length > 1
          ? {
              note:
                `The request matches several flows (${candidates.join(", ")}). If it genuinely spans more than one ` +
                "(create + distribute + sale + staking), pick launch_token_economy; otherwise pick the single best fit.",
            }
          : {}),
        context,
        flows: flowIndex(),
        topics: topicIndex(),
        next:
          "Call dexe_guide again with flow:\"<id>\" to get the full plan (interview questions, step order, gotchas) " +
          "— topic ids work the same way (e.g. flow:\"read_dao_data\" for the data-read reference).",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }] };
    },
  );
}
