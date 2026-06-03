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
  guard: "off" | "warn",
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
