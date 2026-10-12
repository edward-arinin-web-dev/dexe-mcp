import {
  classifyTreasuryActions,
  resolveTreasuryGuardMode,
  type TreasuryGuardMode,
  type TreasuryHit,
} from "./quorumRisk.js";

/**
 * The treasury guard as it acts on writes: the advisory strings builders,
 * deploys and executes attach, the call-time posture lookup, and the one gate
 * that decides whether a treasury-moving act proceeds, warns or is refused.
 * The pure risk math (quorum units, treasury-action classification, the
 * posture parser config and the env schema share) is in ./quorumRisk.ts.
 */

// ─── advisory strings (tone mirrors protocolAdvisories.ts) ────────────────────

const ADVISORY_TAG = "[governance-safety advisory]";
const GUARD_TAG = "[governance-safety guard: block]";

/**
 * The posture in force for a call. The env var is authoritative (it is what the
 * operator set); when it is absent the caller's configured posture applies, and
 * `warn` is the floor.
 *
 * `DexeConfig.treasuryGuard` carries all three postures and is produced by
 * `resolveTreasuryGuardMode` too (src/config.ts), as is the `DEXE_TREASURY_GUARD`
 * validator in the env schema — so config, startup validation and this call-time
 * lookup cannot disagree about what a raw value means. Re-reading the env here
 * only serves callers that hold no config (tests, one-off CLI paths); it
 * resolves through the same parser, so it can never widen the answer.
 */
export function treasuryGuardMode(args?: {
  env?: Record<string, string | undefined>;
  configured?: string | undefined;
}): TreasuryGuardMode {
  const raw = (args?.env ?? process.env).DEXE_TREASURY_GUARD;
  if (raw !== undefined && raw.trim() !== "") return resolveTreasuryGuardMode(raw).mode;
  return resolveTreasuryGuardMode(args?.configured).mode;
}

/** Flag a below-floor quorum SETTING (deploy / change-voting-settings). */
export function lowQuorumAdvisory(pct: number, floorPct: number): string {
  const shown = Number.isFinite(pct) ? `${pct}%` : "unparseable";
  return (
    `⚠ quorum=${shown} is below the ${floorPct}% safe floor (DEXE_MIN_SAFE_QUORUM_PCT). ` +
    `Low quorum reduces the participation required to pass a proposal. For a DAO that holds ` +
    `treasury assets, set quorum ≥50% (51%+ recommended) and verify stakeholder participation ` +
    `before executing treasury-moving proposals; the safe value is DAO-specific. ${ADVISORY_TAG}`
  );
}

/** Flag a treasury-touching proposal at build time (static, no RPC needed). */
export const TREASURY_RISK_ADVISORY =
  `⚠ This proposal moves treasury value (ERC20 approve/transfer/transferFrom or native value). ` +
  `Confirm the DAO's quorum is adequate (≥50%) and that key stakeholders have participated before ` +
  `executing. Run dexe_proposal_risk_assess for a full readout. ${ADVISORY_TAG}`;

/**
 * Build-time advisory for any builder whose actions move treasury value.
 * Returns the static advisory string when there is at least one treasury hit
 * and the guard is enabled, else null. Build-time is WARN-only — it never
 * blocks (refusing would just route users to hand-crafted custom_abi).
 */
export function buildTimeTreasuryAdvisory(
  actions: { executor: string; value: string; data: string }[],
  guard: TreasuryGuardMode,
): string | null {
  if (guard === "off") return null;
  return classifyTreasuryActions(actions).length > 0 ? TREASURY_RISK_ADVISORY : null;
}

/**
 * Advisory message for the vote_and_execute treasury alert. `reasons` are the
 * failing checks (below-floor quorum, no controlling-member participation).
 * Advisory ONLY — the guard never blocks; it surfaces this and proceeds. The
 * durable control is an adequate on-chain quorum threshold configured per DAO.
 */
export function treasuryExecuteAdvisory(reasons: string[]): string {
  return (
    `⚠ Treasury-safety advisory: this proposal moves treasury value AND ${reasons.join("; ")}. ` +
    `Verify adequate quorum and stakeholder participation before executing — ` +
    `responsibility for executing rests with whoever broadcasts it. Run dexe_proposal_risk_assess for a full ` +
    `readout. ${ADVISORY_TAG}`
  );
}

// ─── the gate: ONE decision point for every treasury-risk surface ────────────

/**
 * Which irreversible act is being gated.
 *  - `build`   — emits calldata only. NEVER blocks (refusing here just routes
 *                the caller to a hand-crafted custom_abi with no guard at all).
 *  - `deploy`  — creates a DAO whose quorum cannot later be fixed without
 *                passing a proposal under that same quorum.
 *  - `execute` — moves the treasury. The irreversible act.
 */
export type TreasuryGateStage = "build" | "deploy" | "execute";

export interface TreasuryGateInput {
  mode: TreasuryGuardMode;
  stage: TreasuryGateStage;
  /** Actions to classify. Ignored when `hits` is supplied. */
  actions?: readonly { executor: string; value: string; data: string }[];
  /** Pre-classified hits (when the caller already decoded the proposal). */
  hits?: readonly TreasuryHit[];
  /** Failing safety checks — below-floor quorum, no controlling participation. */
  reasons?: readonly string[];
  /** Human label of the act, e.g. "GovPool.execute(12)" or "deploy 'Aurora'". */
  act?: string;
}

export interface TreasuryGateDecision {
  hits: TreasuryHit[];
  /** The gate has something to say. */
  triggered: boolean;
  /** The caller MUST NOT broadcast. Only ever true in `block` mode. */
  blocked: boolean;
  /** Advisory text — present whenever triggered, in `warn` AND in `block`. */
  advisory: string | null;
  /** Refusal text with the way forward — present iff `blocked`. */
  refusal: string | null;
}

/**
 * Decide what the treasury guard does about one act — the single funnel for
 * build/deploy/execute so a second entrypoint cannot quietly skip the check.
 *
 * `block` refuses ONLY when value moves AND a safety check actually failed: an
 * adequate quorum with real participation is exactly what the guard wants, and
 * refusing it would make `block` unusable. `warn` (the default) returns the same
 * advisory with `blocked: false` — the operator owns the outcome, but the text
 * is produced HERE, before the act, not narrated after it.
 */
export function treasuryGate(input: TreasuryGateInput): TreasuryGateDecision {
  const none: TreasuryGateDecision = { hits: [], triggered: false, blocked: false, advisory: null, refusal: null };
  if (input.mode === "off") return none;

  const hits = input.hits ? [...input.hits] : classifyTreasuryActions([...(input.actions ?? [])]);
  const reasons = [...(input.reasons ?? [])];
  // A deploy moves no value yet — its risk is the config it freezes in, so the
  // failing checks alone trigger it. Build/execute need an actual value move.
  const triggered = input.stage === "deploy" ? reasons.length > 0 : hits.length > 0;
  if (!triggered) return none;

  const advisory =
    reasons.length > 0
      ? input.stage === "deploy"
        ? `⚠ Treasury-safety advisory: ${reasons.join("; ")}. ${ADVISORY_TAG}`
        : treasuryExecuteAdvisory(reasons)
      : TREASURY_RISK_ADVISORY;

  const blocked = input.mode === "block" && input.stage !== "build" && reasons.length > 0;
  return {
    hits,
    triggered: true,
    blocked,
    advisory,
    refusal: blocked ? treasuryBlockRefusal(reasons, input.stage, input.act) : null,
  };
}

/** Refusal text for `block` mode: what failed, and every way forward. */
export function treasuryBlockRefusal(reasons: readonly string[], stage: TreasuryGateStage, act?: string): string {
  const what = act ? `this ${stage} (${act})` : `this ${stage}`;
  return (
    `⛔ Refusing ${what}: DEXE_TREASURY_GUARD=block and the treasury-safety checks failed — ` +
    `${reasons.join("; ")}. Nothing was broadcast. Fix the cause (raise the DAO's quorum, secure ` +
    `stakeholder participation, or shrink what the action moves), or set DEXE_TREASURY_GUARD=warn ` +
    `and restart the MCP server to make this an advisory again — the default posture, where the ` +
    `operator owns the outcome. ${GUARD_TAG}`
  );
}
