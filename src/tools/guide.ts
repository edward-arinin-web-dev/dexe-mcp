import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import type { StateStore } from "../lib/stateStore.js";
import { flowIndex, flowDetail, matchIntent, bestMatch } from "../knowledge/index.js";

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
export function registerGuideTools(
  server: McpServer,
  config: DexeConfig,
  state: StateStore,
): void {
  server.tool(
    "dexe_guide",
    "Call this FIRST for any multi-step or unfamiliar DeXe request — 'create a DAO', 'launch a token with " +
      "distribution/OTC/staking', 'open a sale', 'set up staking', 'pass this proposal'. Returns the exact ordered " +
      "plan (which tools, in what order, with what params), the questions to ask the user with per-parameter risk " +
      "notes, and the known protocol pitfalls for that journey. Never improvise a governance flow without it. " +
      "Call with no args (or a free-text `intent`) to get the flow menu; call with `flow` for the full plan.",
    {
      intent: z
        .string()
        .optional()
        .describe("The user's request in free text — matched against the flow triggers (e.g. 'create a token and sell 20% via OTC')."),
      flow: z
        .string()
        .optional()
        .describe("Exact flow id from the index tier (e.g. 'create_dao', 'launch_token_economy'). Takes precedence over intent."),
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
        // Unknown explicit flow id → fall through to the index with a note.
      }

      const candidates = intent ? matchIntent(intent).map((m) => m.flow) : [];
      const index = {
        mode: "flow-index" as const,
        ...(flow && !flowDetail(flow) ? { note: `Unknown flow '${flow}'. Pick one of the ids below.` } : {}),
        ...(intent && candidates.length > 1
          ? {
              note:
                `The request matches several flows (${candidates.join(", ")}). If it genuinely spans more than one ` +
                "(create + distribute + sale + staking), pick launch_token_economy; otherwise pick the single best fit.",
            }
          : {}),
        context,
        flows: flowIndex(),
        next: "Call dexe_guide again with flow:\"<id>\" to get the full plan (interview questions, step order, gotchas).",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }] };
    },
  );
}
