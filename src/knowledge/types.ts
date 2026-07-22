/**
 * Protocol knowledge layer (Phase A) — the single machine-readable source of
 * truth for "how DeXe governance actually works". Everything an AI agent needs
 * to run a multi-step flow without external research lives here as data:
 * ordered steps, the questions to ask the user (with per-parameter risk
 * notes), and the known protocol gotchas.
 *
 * Consumed by:
 *  - `dexe_guide` (src/tools/guide.ts) — serves the index / flow-detail tiers
 *  - `scripts/gen-knowledge.ts` — renders the generated sections of
 *    docs/PLAYBOOK.md (drift-checked in CI via gen:knowledge:check)
 *
 * Rules for authors:
 *  - Encode the CORRECTED protocol rules (e.g. cap ≥ minted > 0, treasury
 *    remainder is valid), never superseded early findings.
 *  - `text` fields must be self-contained imperatives with tool names spelled
 *    out — they are shown to a model with no surrounding context.
 *  - Flows reference composites (dexe_dao_create / dexe_proposal_create /
 *    dexe_otc_*); the knowledge layer never re-implements their sequencing.
 */

export type GotchaSeverity = "danger" | "warn" | "info";

export interface Gotcha {
  /** Stable kebab-case id, referenced from flows/steps. */
  id: string;
  severity: GotchaSeverity;
  /** Self-contained imperative statement, tool names included. */
  text: string;
  /** Where this gotcha is relevant — used for filtering and rendering. */
  applies: {
    flows?: string[];
    /** `dexe_proposal_create` proposalType ids. */
    proposalTypes?: string[];
    tools?: string[];
    /** Only relevant on these chain ids. */
    chains?: number[];
  };
}

export type ParamKind =
  | "address"
  | "amount"
  | "percent"
  | "duration"
  | "string"
  | "addressList"
  | "boolean";

/** One question the agent must put to the user before running a flow. */
export interface ParamSpec {
  /** Maps to a composite input name or a `{{placeholder}}` in step templates. */
  name: string;
  /** The literal question to ask the user. */
  ask: string;
  kind: ParamKind;
  required: boolean;
  /** Safe default the agent may offer ("press enter for 51"). */
  default?: string;
  /** Risk to explain when the user picks an unusual value. */
  riskIfUnusual?: string;
  /** Hard constraint the value must satisfy. */
  constraint?: string;
}

export interface FlowStep {
  id: string;
  /** MCP tool to call — must exist in the gate.ts toolset union (test-enforced). */
  tool: string;
  purpose: string;
  /**
   * Argument template. `{{name}}` placeholders bind to interview params or to
   * prior-step outputs declared in `bindsFrom`.
   */
  paramsTemplate: Record<string, string>;
  /** placeholder → "stepId.outputField" for values produced by earlier steps. */
  bindsFrom?: Record<string, string>;
  gotchaIds?: string[];
  /**
   * What to tell the user after this step succeeds. May contain `{{…}}`
   * placeholders, e.g. a link template "https://app.dexe.io/dao/{{govPool}}".
   */
  reportOnSuccess: string;
  /** Powers Phase B structured next-step chaining. */
  next?: Array<{ when: string; stepId: string; why: string }>;
  /** Step only applies in some situations ("only when the DAO has validators"). */
  optionalWhen?: string;
}

export interface Flow {
  id: string;
  title: string;
  /** Lowercase keyword/phrase list for intent matching. */
  triggers: string[];
  /** One sentence for the index tier. */
  summary: string;
  /** chainId → note the agent MUST relay before running the flow there. */
  chainNotes?: Record<number, string>;
  interview: ParamSpec[];
  steps: FlowStep[];
  /** Flow-level gotchas (step-level ones live on the steps). */
  gotchaIds: string[];
  /** Composition: this flow runs other flows in order (fetch each via dexe_guide). */
  subFlows?: string[];
}
