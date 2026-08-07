import { id, Interface } from "ethers";
import { selectorOf } from "./dangerousSelectors.js";

/**
 * Low-quorum governance-safety advisories — pure logic, no RPC.
 *
 * Treasury-moving proposals (ERC20 approve/transfer or native value) should pass
 * under an adequate quorum so a true majority is required. This module flags when
 * a DAO's quorum setting is low for such proposals, so an operator/agent verifies
 * the quorum and stakeholder participation before executing. Advisory only — the
 * durable control is an adequate on-chain quorum threshold configured per DAO.
 */

export type RiskLevel = "SAFE" | "CAUTION" | "DANGER";

/** Worst (most dangerous) of a set of risk levels. Empty → SAFE. */
export function worstRisk(...levels: RiskLevel[]): RiskLevel {
  if (levels.includes("DANGER")) return "DANGER";
  if (levels.includes("CAUTION")) return "CAUTION";
  return "SAFE";
}

// ─── quorum units ──────────────────────────────────────────────────────────
// DeXe stores quorum as a fraction of PERCENTAGE_100 = 1e27 (so 50% = 5e26).
// The on-chain getProposalRequiredQuorum(id) instead returns an ABSOLUTE
// token-weight (pct × totalVoteWeight already applied) — never pass that here.
const PERCENTAGE_100 = 10n ** 27n;

/** Convert a raw quorum setting (pct × 1e25) to a human percentage. 5e26 → 50. */
export function quorumPctFromRaw(raw: bigint | string): number {
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(raw);
  } catch {
    return NaN;
  }
  // 2-decimal precision via integer math (avoids float drift on 1e27-scale ints).
  return Number((v * 10000n) / PERCENTAGE_100) / 100;
}

/** SAFE ≥ floor; CAUTION ≥ 0.8×floor; DANGER below. NaN → DANGER (unparseable). */
export function judgeQuorum(pct: number, floorPct: number): RiskLevel {
  if (!Number.isFinite(pct)) return "DANGER";
  if (pct >= floorPct) return "SAFE";
  if (pct >= 0.8 * floorPct) return "CAUTION";
  return "DANGER";
}

// ─── quorum turnout margin (0.33.0) ──────────────────────────────────────────
// Reachability ("votable power ≥ quorum") is a ZERO-margin test: it passes a DAO
// whose quorum needs 100% turnout of every votable token. That is reachable on
// paper and un-passable in practice — the first holder who is asleep, has sold,
// or lost a key freezes governance forever, and no proposal can fix it because
// fixing it requires passing a proposal. Every quorum must therefore leave real
// headroom: the turnout it demands stays at or below QUORUM_TURNOUT_CEILING of
// the votable supply.

/** Max share of votable power a quorum may demand. 0.8 ⇒ 20% headroom. */
export const QUORUM_TURNOUT_CEILING = 0.8;

/** Float slack so an exactly-on-the-ceiling config isn't refused by 1e-15. */
const TURNOUT_EPS = 1e-9;

/** Round down to 2 decimals — quoted limits must be safe to paste back in. */
function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

export interface QuorumMarginResult {
  /** Quorum as a % of total vote weight (supply). */
  quorumPct: number;
  /** Votable (wallet-held, non-treasury) power as a % of total supply. */
  votablePct: number;
  /** % of the votable power that must vote to clear quorum. Null when unknown. */
  requiredTurnoutPct: number | null;
  /** Ceiling applied, as a percent (80 for the 0.8 default). */
  ceilingPct: number;
  ok: boolean;
  /** Highest quorum % that keeps required turnout ≤ ceiling, at this votablePct. */
  maxQuorumPct: number;
  /** Lowest votable % that supports this quorumPct. */
  minVotablePct: number;
  /** Actionable fix — present iff `ok` is false. */
  remediation?: string;
}

/**
 * Does this quorum leave a real participation margin? `quorumPct` and
 * `votablePct` are both percentages OF TOTAL SUPPLY (the denominator the
 * protocol's quorum setting uses), so required turnout = quorum ÷ votable.
 * Pure math, never throws; a non-finite or zero votable share is NOT ok
 * (unknown is never safe).
 */
export function checkQuorumMargin(args: {
  quorumPct: number;
  votablePct: number;
  ceiling?: number;
}): QuorumMarginResult {
  const ceiling = args.ceiling ?? QUORUM_TURNOUT_CEILING;
  const ceilingPct = ceiling * 100;
  const { quorumPct, votablePct } = args;
  const maxQuorumPct = Number.isFinite(votablePct) ? floor2(votablePct * ceiling) : 0;
  const minVotablePct = Number.isFinite(quorumPct) ? Math.min(100, Math.ceil((quorumPct / ceiling) * 100) / 100) : 100;

  if (!Number.isFinite(quorumPct) || !Number.isFinite(votablePct) || votablePct <= 0) {
    return {
      quorumPct,
      votablePct,
      requiredTurnoutPct: null,
      ceilingPct,
      ok: false,
      maxQuorumPct,
      minVotablePct,
      remediation:
        `Quorum margin cannot be computed (quorum=${quorumPct}, votable=${votablePct}% of supply). ` +
        `A DAO whose votable share is 0 or unknown can never pass a proposal — distribute tokens to ` +
        `wallets that can vote before deploying.`,
    };
  }

  const requiredTurnoutPct = Math.round((quorumPct / votablePct) * 10000) / 100;
  const ok = quorumPct <= votablePct * ceiling + TURNOUT_EPS;
  if (ok) {
    return { quorumPct, votablePct, requiredTurnoutPct, ceilingPct, ok, maxQuorumPct, minVotablePct };
  }
  return {
    quorumPct,
    votablePct,
    requiredTurnoutPct,
    ceilingPct,
    ok,
    maxQuorumPct,
    minVotablePct,
    remediation:
      `Quorum ${quorumPct}% needs ${requiredTurnoutPct}% of the votable supply (${votablePct}% of total) to turn ` +
      `out — above the ${ceilingPct}% ceiling, so ordinary abstention makes every proposal fail and the DAO ` +
      `cannot fix itself (fixing quorum requires passing a proposal). Fix: raise the votable share to ` +
      `≥${minVotablePct}% of supply (shrink the treasury / distribute more), or lower quorum to ` +
      `≤${maxQuorumPct}% — note a quorum below 50% is itself a treasury-safety risk, so prefer raising the ` +
      `votable share.`,
  };
}

// ─── treasury-action classification ─────────────────────────────────────────

export type TreasuryHitKind =
  | "approve"
  | "transfer"
  | "transferFrom"
  | "increaseAllowance"
  | "nftTransfer"
  | "nativeValue";

export interface TreasuryHit {
  /** Index of the action in the proposal's action array. */
  index: number;
  /** Target contract of the action. */
  executor: string;
  /** 0x 4-byte selector, or null for a pure native-value transfer. */
  selector: string | null;
  kind: TreasuryHitKind;
  /** Best-effort decoded recipient (spender / `to`), or null when undecodable. */
  recipient: string | null;
  /** Best-effort decoded amount / tokenId as a decimal string, or null. */
  amount: string | null;
}

interface SelectorKind {
  kind: TreasuryHitKind;
  sig: string;
  /** Arg index of the recipient (spender / `to`) in decoded calldata. */
  recipientArg: number;
  /** Arg index of the amount / tokenId in decoded calldata. */
  amountArg: number;
}

/**
 * Value-moving / allowance-granting selectors. ERC20 `transferFrom` and ERC721
 * `transferFrom` share selector 0x23b872dd → classified as `transferFrom`; the
 * ERC721-only `safeTransferFrom` overloads classify as `nftTransfer`.
 */
const TREASURY_SELECTORS: ReadonlyMap<string, SelectorKind> = new Map(
  (
    [
      { kind: "approve", sig: "approve(address,uint256)", recipientArg: 0, amountArg: 1 },
      { kind: "transfer", sig: "transfer(address,uint256)", recipientArg: 0, amountArg: 1 },
      { kind: "transferFrom", sig: "transferFrom(address,address,uint256)", recipientArg: 1, amountArg: 2 },
      { kind: "increaseAllowance", sig: "increaseAllowance(address,uint256)", recipientArg: 0, amountArg: 1 },
      { kind: "nftTransfer", sig: "safeTransferFrom(address,address,uint256)", recipientArg: 1, amountArg: 2 },
      { kind: "nftTransfer", sig: "safeTransferFrom(address,address,uint256,bytes)", recipientArg: 1, amountArg: 2 },
    ] satisfies SelectorKind[]
  ).map((e) => [id(e.sig).slice(0, 10).toLowerCase(), e] as const),
);

/** Decimal selectors of every treasury-touching function (for docs/tests). */
export function treasurySelectors(): string[] {
  return [...TREASURY_SELECTORS.keys()];
}

/**
 * Scan a proposal's actions and report every one that moves treasury value or
 * grants an allowance. Best-effort recipient/amount decode — NEVER throws.
 * A single action can yield two hits (native value + an ERC20 call).
 */
export function classifyTreasuryActions(
  actions: { executor: string; value: string; data: string }[],
): TreasuryHit[] {
  const hits: TreasuryHit[] = [];
  actions.forEach((a, index) => {
    const sel = selectorOf(a.data);

    // Native coin transfer (value > 0) is a treasury movement regardless of data.
    try {
      if (a.value && BigInt(a.value) > 0n) {
        hits.push({
          index,
          executor: a.executor,
          selector: sel,
          kind: "nativeValue",
          recipient: a.executor,
          amount: String(a.value),
        });
      }
    } catch {
      /* non-numeric value — ignore */
    }

    if (sel === null) return;
    const match = TREASURY_SELECTORS.get(sel);
    if (!match) return;

    let recipient: string | null = null;
    let amount: string | null = null;
    try {
      const iface = new Interface([`function ${match.sig}`]);
      const decoded = iface.decodeFunctionData(match.sig, a.data);
      recipient = String(decoded[match.recipientArg]);
      amount = (decoded[match.amountArg] as bigint).toString();
    } catch {
      /* undecodable — leave null, never throw */
    }
    hits.push({ index, executor: a.executor, selector: sel, kind: match.kind, recipient, amount });
  });
  return hits;
}

// ─── quorum-concentration model ──────────────────────────────────────────────

export interface QuorumConcentration {
  /** Absolute voting weight needed to clear quorum, or null when unknown. */
  requiredWeight: bigint | null;
  /** Token total supply used as the denominator, or null when unknown. */
  totalSupply: bigint | null;
  /**
   * Share of total supply required to meet quorum. INDICATIVE: ignores VotePower
   * math, NFT multipliers, and delegation, and uses minted supply as the
   * denominator. Null when supply/weight unknown. A low value indicates a DAO
   * whose decisions need only a small share of supply — a governance-safety flag.
   */
  pctOfSupplyForQuorum: number | null;
  verdict: RiskLevel;
}

/**
 * Estimate the share of token supply required to meet a proposal's quorum.
 * Prefers the on-chain `requiredWeight` (getProposalRequiredQuorum); otherwise
 * derives it from `quorumPct × totalVoteWeight`. When the percentage cannot be
 * computed the verdict is CAUTION (unknown is never SAFE).
 */
export function quorumConcentration(args: {
  quorumPct: number;
  floorPct?: number;
  totalSupply?: bigint;
  requiredWeight?: bigint;
  totalVoteWeight?: bigint;
}): QuorumConcentration {
  const floorPct = args.floorPct ?? 50;

  let requiredWeight: bigint | null = args.requiredWeight ?? null;
  if (requiredWeight === null && args.totalVoteWeight !== undefined && Number.isFinite(args.quorumPct)) {
    // quorumPct% of totalVoteWeight, 2-decimal precision via integer math.
    const bps = BigInt(Math.round(args.quorumPct * 100)); // pct → basis points
    requiredWeight = (args.totalVoteWeight * bps) / 10000n;
  }

  const totalSupply = args.totalSupply ?? null;
  let pctOfSupplyForQuorum: number | null = null;
  if (requiredWeight !== null && totalSupply !== null && totalSupply > 0n) {
    pctOfSupplyForQuorum = Number((requiredWeight * 10000n) / totalSupply) / 100;
  }

  const verdict: RiskLevel =
    pctOfSupplyForQuorum === null ? "CAUTION" : judgeQuorum(pctOfSupplyForQuorum, floorPct);

  return { requiredWeight, totalSupply, pctOfSupplyForQuorum, verdict };
}

// ─── advisory strings (tone mirrors protocolAdvisories.ts) ────────────────────

const ADVISORY_TAG = "[governance-safety advisory]";
const GUARD_TAG = "[governance-safety guard: block]";

// ─── guard posture: off | warn | block (0.33.0) ──────────────────────────────
// `warn` stays the default and the product decision: an advisory names the risk
// and the operator owns the outcome. `block` is the opt-in for operators who
// want the guard to be a control rather than a note — a treasury-moving act
// whose safety checks FAILED is refused instead of narrated.

/** Treasury-guard posture. `block` ⊃ `warn`: it advises AND refuses. */
export type TreasuryGuardMode = "off" | "warn" | "block";

export const TREASURY_GUARD_MODES = ["off", "warn", "block"] as const;

/** The posture used when unset — and the fallback for a malformed value. */
export const TREASURY_GUARD_DEFAULT: TreasuryGuardMode = "warn";

/** 0.30.1-shaped startup issue: what was wrong, and what we did instead. */
export interface TreasuryGuardIssue {
  key: "DEXE_TREASURY_GUARD";
  message: string;
  fallback: string;
}

export interface TreasuryGuardResolution {
  mode: TreasuryGuardMode;
  /** Present iff the raw value was malformed. Never a reason to exit. */
  issue?: TreasuryGuardIssue;
}

/**
 * Parse a raw `DEXE_TREASURY_GUARD` value. NEVER throws and never exits
 * (0.30.1 precedent): a malformed value falls back to the SAFE posture —
 * `warn`, which keeps every advisory on — and records a startup issue.
 * `off` is never chosen implicitly, because a typo must not silence the guard.
 */
export function resolveTreasuryGuardMode(raw: string | undefined | null): TreasuryGuardResolution {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { mode: TREASURY_GUARD_DEFAULT };
  if (v === "off" || v === "warn" || v === "block") return { mode: v };
  return {
    mode: TREASURY_GUARD_DEFAULT,
    issue: {
      key: "DEXE_TREASURY_GUARD",
      message: `DEXE_TREASURY_GUARD must be one of ${TREASURY_GUARD_MODES.join("|")}, got: ${v}`,
      fallback: `using the default '${TREASURY_GUARD_DEFAULT}' (advisories stay on; nothing is blocked)`,
    },
  };
}

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
