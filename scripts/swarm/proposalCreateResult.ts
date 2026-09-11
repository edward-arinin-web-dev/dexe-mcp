/**
 * `dexe_proposal_create` response classifier — pure, side-effect-free.
 *
 * The orchestrator's inline dispatcher was written in Phase 1.5 against the two
 * modes that existed then (`payloads` / `executed`) and threw
 * `unexpected proposal_create shape` on everything else. 0.33 then added the
 * write-path guards, every one of which returns a THIRD kind of body:
 *
 *   - `dryRun`          — src/tools/flow.ts, `runFlow` collect-only branch
 *   - `blocked-risky`   — DANGER advisory gate + the #36 addSettings trap
 *   - `already-created` — the duplicate-descriptionURL guard
 *
 * All three come back through `ok()` with no `isError`, so they reach the
 * dispatcher and were reported as scenario FAILURES — i.e. the harness scored
 * a guard doing its job exactly like a regression. (`failed` and
 * `blocked-treasury` carry `isError:true` and throw in `mcpCall` before they
 * ever get here; they are listed in the union for the reader, not reachable.)
 *
 * Lives outside `orchestrator.ts` because that module calls `main()` at import
 * time — a test importing it would start a real run.
 */

export type ProposalCreateMode =
  | "payloads"
  | "executed"
  | "dryRun"
  | "blocked-risky"
  | "already-created"
  // Not reachable through mcpCall (isError:true ⇒ it throws first). Kept so a
  // reader does not "add" them thinking they were forgotten.
  | "failed"
  | "blocked-treasury";

export interface TxPayload {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

export interface ProposalCreateStep {
  label: string;
  skipped: boolean;
  reason?: string;
  payload?: TxPayload;
}

export interface ProposalCreateMcpResult {
  mode?: ProposalCreateMode;
  steps?: ProposalCreateStep[];
  descriptionURL?: string;
  proposalId?: string;
  governanceAdvisories?: unknown;
  [k: string]: unknown;
}

export type ProposalCreateVerdict =
  /** mode "payloads": sign and send each non-skipped payload, in order. */
  | { kind: "broadcast"; steps: ProposalCreateStep[]; body: ProposalCreateMcpResult }
  /** executed / dryRun: a first-class result. Return it verbatim. */
  | { kind: "passthrough"; body: ProposalCreateMcpResult }
  /** already-created: the proposal exists; normalize the id so downstream
   *  `{{cap.proposalIdNum}}` still resolves and the run RESUMES against it. */
  | { kind: "resume"; body: ProposalCreateMcpResult }
  /** A refusal. Mark the step skipped and cascade-skip its dependants rather
   *  than landing a "pass" whose capture poisons every later step with "". */
  | { kind: "defer"; body: ProposalCreateMcpResult; reason: string };

/**
 * Decide what the swarm dispatcher does with a `dexe_proposal_create` body.
 * Pure: no network, no broadcast, no process state.
 *
 * Throws ONLY when there is no `mode` at all — that genuinely is an unknown
 * shape (or a pre-0.30 server), and silently passing it would hide a real
 * protocol break.
 */
export function classifyProposalCreateResult(result: unknown): ProposalCreateVerdict {
  const r = (result ?? {}) as ProposalCreateMcpResult;
  if (typeof r !== "object" || Array.isArray(r) || !r.mode) {
    throw new Error(
      `dexe_proposal_create returned no mode — server older than 0.30? Got: ${JSON.stringify(result)?.slice(0, 200)}`,
    );
  }
  if (r.mode === "payloads" && Array.isArray(r.steps)) {
    return { kind: "broadcast", steps: r.steps, body: r };
  }
  // S59-proposal-create-token-transfer-dry asserts `created.mode == 'dryRun'`;
  // it has no downstream consumer, so a verbatim pass is correct there.
  if (r.mode === "executed" || r.mode === "dryRun") return { kind: "passthrough", body: r };
  if (r.mode === "already-created") return { kind: "resume", body: r };
  const advisories = r.governanceAdvisories
    ? ` (${JSON.stringify(r.governanceAdvisories).slice(0, 160)})`
    : "";
  return { kind: "defer", body: r, reason: `dexe_proposal_create refused: mode=${r.mode}${advisories}` };
}

/**
 * The capture a `resume` verdict should land. `already-created` carries
 * `proposalId` as a STRING and no `proposalIdNum`, while scenarios feed numbers
 * downstream (`{{cap.proposalIdNum}}`) because the tool schemas demand
 * `z.number()`. Without this, a resumed run hands the next step `proposalId: ""`.
 */
export function resumeCapture(body: ProposalCreateMcpResult): Record<string, unknown> {
  const pid = String(body.proposalId ?? "");
  const num = Number(pid);
  return {
    ...body,
    proposalId: pid,
    ...(Number.isFinite(num) && pid !== "" ? { proposalIdNum: num } : {}),
    txHashes: [],
  };
}
