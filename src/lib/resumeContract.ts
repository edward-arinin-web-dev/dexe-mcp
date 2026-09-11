/**
 * The RESUME CONTRACT, in one sentence — the ambient/standing form of
 * `RESUME_RECHECKS` (src/tools/flow.ts), which enumerates the same rule step by
 * step inside a failure payload.
 *
 * Why this exists: 0.33.0 fixed the composites so a re-run genuinely re-derives
 * approve/deposit/create/vote from chain state — but it did NOT make execute or
 * the validator round idempotent, and it did not touch the two places that
 * promise a blanket "completed steps are skipped" to every agent BEFORE any
 * failure happens (the MCP handshake instructions and the guide's
 * AGENT_PROTOCOL). An agent holding the blanket promise reads "DO NOT re-run
 * this call yet" in the payload and the opposite in its standing instructions;
 * the cheapest resolution it can reach for is a second execute.
 *
 * Keep this string and `RESUME_RECHECKS` in agreement — they are pinned against
 * each other by tests/knowledge/resume-contract-consistency.test.ts.
 */
export const RESUME_SUMMARY =
  "On re-run, ERC20.approve / GovPool.deposit / createProposalAndVote / GovPool.vote are re-derived from chain " +
  "state and skipped; GovPool.execute and the validator round are NOT — and a receipt-wait TIMEOUT means the " +
  "transaction was already broadcast, so check dexe_tx_status before any re-run and never re-send blindly.";
