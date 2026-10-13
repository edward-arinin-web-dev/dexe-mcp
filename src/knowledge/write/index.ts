import type { KnowledgeCorpus } from "@dexe-network/dexe-mcp/core";
import { FLOWS } from "./flows.js";
import { WRITE_CORPUS_GOTCHAS } from "./gotchas.js";

/**
 * The WRITE edition's knowledge: the eight step journeys (deploy, propose,
 * vote/execute, distribute, sell, stake, the whole launch, the agent team),
 * the gotchas they cite — the read ones included, by id — and the protocol the
 * calling agent must follow while running one.
 *
 * Steps also call read tools (dexe_proposal_state, dexe_dao_predict_addresses,
 * dexe_read_staking_info, dexe_read_token_sales, dexe_dao_report). The
 * corpus only names them; where they come from is the tool locator's answer
 * (a toolset here, or `providedBy` the read server).
 */

export const AGENT_PROTOCOL =
  "PROTOCOL FOR THE AGENT: (1) Ask the user each `interview` question in order; offer the defaults; when an answer " +
  "is unusual, explain its `riskIfUnusual` before accepting. (2) Echo the final parameter set back and get explicit " +
  "confirmation BEFORE any broadcast. (3) Call the step tools in the listed order with the collected params — do " +
  "not substitute tools, invent parameters, or skip the gotchas. (4) If there is a chainNote, relay it to the " +
  "user verbatim before starting. (5) After each successful step, relay `reportOnSuccess` (placeholders filled). " +
  "(6) On FAILURE read `resume`, fix, re-run the SAME call: approve/deposit/create/vote are re-derived and " +
  "skipped; GovPool.execute and the validator round are NOT — after a timeout check dexe_tx_status first.";

/** Composites that accept `flowContext` and return structured `next` chaining. */
export const CHAINING_TOOLS: ReadonlySet<string> = new Set([
  "dexe_dao_create",
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_otc_dao_open_sale",
]);

export const WRITE_CORPUS: KnowledgeCorpus = {
  flows: FLOWS,
  topics: [],
  gotchas: WRITE_CORPUS_GOTCHAS,
  agentProtocol: AGENT_PROTOCOL,
  chainingTools: CHAINING_TOOLS,
  umbrellaFlow: "launch_token_economy",
};

export { FLOWS, FLOW_BY_ID } from "./flows.js";
export { WRITE_GOTCHAS, WRITE_CORPUS_GOTCHAS } from "./gotchas.js";
