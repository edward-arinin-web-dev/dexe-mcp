import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import type { PersistedState, StateStore } from "../lib/stateStore.js";
import type { Knowledge } from "../knowledge/engine.js";

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
 *
 * The tool serves whatever `Knowledge` it is handed (src/knowledge/engine.ts):
 * the read topics alone in the read edition, the write flows next to them in
 * the single server (src/knowledge/index.ts). Anything that follows a WRITE
 * journey across sessions — the interrupted flow and its `next` pointer — comes
 * in through `extraContext` (src/tools/guideWrite.ts); this file reads only the
 * last-used chain and the known DAOs from the state store, and works without one.
 */

/** The tool's own wording: description, parameter docs, and the index tier's multi-match note. */
export interface GuideText {
  description: string;
  intent: string;
  flow: string;
  /** Index-tier note when a free-text intent matched several ids. */
  multiMatchNote: (candidates: readonly string[]) => string;
}

/** Wording for a guide that serves the read corpus (topics only). */
export const READ_GUIDE_TEXT: GuideText = {
  description:
    "Read-only, local. Reference guide for reading DeXe DAO data — querying the subgraph, the backend and the " +
    "chain, and pulling a whole DAO report — with the relevant tools for each and the known pitfalls. No args or a " +
    "free-text `intent` returns the menu; `flow` returns the full topic.",
  intent:
    "The user's request in free text — matched against the topic triggers (e.g. 'weekly report on my DAO').",
  flow: "Exact topic id. Takes precedence over `intent`; omit both for the menu.",
  multiMatchNote: (candidates) =>
    `The request matches several topics (${candidates.join(", ")}). Pick the single best fit.`,
};

export interface GuideOptions {
  /** The corpus this guide serves, bound to its tool locator. */
  knowledge: Knowledge;
  /** Defaults to READ_GUIDE_TEXT. */
  text?: GuideText;
  /**
   * Extra `context` fields, placed after `knownDao`. Called once per request
   * with the persisted state; never called without a state store.
   */
  extraContext?: (state: PersistedState) => Record<string, unknown>;
}

export function registerGuideTool(
  server: McpServer,
  config: ReadConfig,
  state: StateStore | null,
  opts: GuideOptions,
): void {
  const { knowledge } = opts;
  const text = opts.text ?? READ_GUIDE_TEXT;
  /**
   * The complete, compile-time-known set of ids `flow` accepts, built from the
   * same corpus the handler resolves against — so adding a flow or a topic
   * publishes it in the schema with no second edit. Published as a `z.enum`
   * (not free text) because the set is closed: an agent that guessed at an id
   * used to pay an index round-trip to learn the ten it could have read here.
   */
  const ids = knowledge.ids as [string, ...string[]];
  if (ids.length === 0) throw new Error("dexe_guide: the knowledge corpus is empty");

  server.tool(
    "dexe_guide",
    text.description,
    {
      intent: z.string().optional().describe(text.intent),
      flow: z.enum(ids).optional().describe(text.flow),
      chainId: z
        .number()
        .int()
        .optional()
        .describe("Target chain (56 mainnet / 97 testnet). Defaults to the last-used, then the configured default chain."),
    },
    async ({ intent, flow, chainId }) => {
      const st = state ? state.getState() : null;
      const resolvedChainId = chainId ?? st?.lastChainId ?? config.defaultChainId;

      // Session context prefill: a known DAO means most flows can skip the
      // "which govPool?" question — surface it so the agent offers reuse.
      const lastDao = st?.knownDaos[0];
      const context = {
        chainId: resolvedChainId,
        chainIdSource: chainId !== undefined ? "argument" : st?.lastChainId !== undefined ? "last-used" : "default",
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
        ...(st && opts.extraContext ? opts.extraContext(st) : {}),
      };

      const wanted = flow ?? (intent ? knowledge.bestMatch(intent) : null);

      if (wanted) {
        const detail = knowledge.flowDetail(wanted, { chainId: resolvedChainId });
        if (detail) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ mode: "flow-detail", context, ...detail }, null, 2) },
            ],
          };
        }
        const topic = knowledge.topicDetail(wanted, { chainId: resolvedChainId });
        if (topic) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ mode: "topic-detail", context, ...topic }, null, 2) },
            ],
          };
        }
        // Unknown explicit flow/topic id → fall through to the index with a note.
      }

      const candidates = intent ? knowledge.matchIntent(intent).map((m) => m.flow) : [];
      const index = {
        mode: "flow-index" as const,
        ...(flow && !knowledge.flowDetail(flow) && !knowledge.topicDetail(flow)
          ? { note: `Unknown flow '${flow}'. Pick one of the ids below.` }
          : {}),
        ...(intent && candidates.length > 1 ? { note: text.multiMatchNote(candidates) } : {}),
        context,
        flows: knowledge.flowIndex(),
        topics: knowledge.topicIndex(),
        next:
          "Call dexe_guide again with flow:\"<id>\" to get the full plan (interview questions, step order, gotchas) " +
          "— topic ids work the same way (e.g. flow:\"read_dao_data\" for the data-read reference).",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }] };
    },
  );
}
