import { checkQuorumMargin, QUORUM_TURNOUT_CEILING } from "./quorumRisk.js";

/**
 * Agent-treasury preset — share math (pure, no RPC).
 *
 * n agents each get the SAME share s of the gov-token supply; the rest stays in
 * the DAO treasury (the implicit remainder of a deploy). The member quorum q is
 * a fraction of the whole supply (GovPool.getProposalRequiredQuorum =
 * totalPower × quorum), so the k-of-n property is a statement about s:
 *
 *   k · s  ≥ q + margin     k agents voting FOR reach quorum on their own
 *   (k−1) · s < q           k−1 agents voting FOR do not
 *   n · s  ≤ 100 %          the shares fit in the supply
 *   q ≤ n · s × CEILING     the turnout-margin rule every dexe_dao_create
 *                           config must pass (QUORUM_TURNOUT_CEILING = 0.8)
 *
 * Everything is in basis points (1 bps = 0.01 %). The margin is 50 bps so a
 * rounding step in the token amounts can never drop k agents just under q.
 * s starts at the lowest value that satisfies the first rule and is raised —
 * one bps at a time, never past the second rule's bound — until the turnout
 * rule passes. When no s satisfies all four, the preset refuses.
 *
 * The quorum FORMULA differs between deployments, and the math holds under
 * both: protocol master checks each side alone (votesFor ≥ required OR
 * votesAgainst ≥ required); the GovPool live on BSC testnet 97 still checks
 * turnout ((for + against) / total ≥ q). Under turnout, an AGAINST vote also
 * counts toward quorum, after which the majority decides — see
 * `agentTreasuryGuarantees`.
 */

export const AGENT_SHARE_MARGIN_BPS = 50;
export const AGENT_MIN = 2;
export const AGENT_MAX = 9;

export interface AgentShares {
  n: number;
  k: number;
  quorumPct: number;
  /** Share of supply per agent, bps. */
  shareBps: number;
  /** Share of supply per agent, % (2 decimals). */
  sharePct: number;
  /** n · share, bps / %. */
  agentsTotalBps: number;
  agentsTotalPct: number;
  /** 10000 − n · share. */
  treasuryBps: number;
  treasuryPct: number;
  /** k · share in % — what k FOR votes carry. */
  kForPct: number;
  /** (k−1) · share in % — what k−1 FOR votes carry. */
  kMinusOneForPct: number;
  /** % of the agents' combined power a quorum demands (the turnout-margin rule). */
  requiredTurnoutPct: number | null;
  /** Bounds the search ran over, bps. */
  bounds: { lo: number; hi: number };
  /** True when s had to be raised above `bounds.lo` to pass the turnout rule. */
  raisedForTurnout: boolean;
}

export type AgentSharesResult = { ok: true; shares: AgentShares } | { ok: false; reason: string };

const pct = (bps: number) => Math.round(bps) / 100;

/** Default k for n agents: a strict majority, floor(n/2) + 1. */
export function defaultApprovals(n: number): number {
  return Math.floor(n / 2) + 1;
}

export function computeAgentShares(n: number, k: number, quorumPct: number): AgentSharesResult {
  if (!Number.isInteger(n) || n < AGENT_MIN || n > AGENT_MAX) {
    return { ok: false, reason: `agents: need ${AGENT_MIN}..${AGENT_MAX} agents, got ${n}.` };
  }
  if (!Number.isInteger(k) || k < 2) {
    return {
      ok: false,
      reason:
        `approvalsNeeded must be at least 2 (got ${k}): with k=1 any single agent passes a proposal alone, ` +
        `which is not a k-of-n treasury.`,
    };
  }
  if (k > n) {
    return { ok: false, reason: `approvalsNeeded (${k}) cannot exceed the number of agents (${n}).` };
  }
  if (!Number.isFinite(quorumPct) || quorumPct <= 0 || quorumPct > 100) {
    return { ok: false, reason: `quorumPercent must be in (0, 100], got ${quorumPct}.` };
  }
  const qBps = Math.round(quorumPct * 100);
  const lo = Math.ceil(qBps / k) + AGENT_SHARE_MARGIN_BPS;
  const hi = Math.ceil(qBps / (k - 1)) - 1;
  const fit = Math.floor(10000 / n);
  const top = Math.min(hi, fit);

  if (lo > top) {
    const why =
      lo > fit
        ? `${k} agents need at least ${pct(lo)}% each to reach a ${quorumPct}% quorum, and ${n} × ${pct(lo)}% ` +
          `exceeds 100% of the supply`
        : `the share that lets ${k} agents reach ${quorumPct}% (≥ ${pct(lo)}% each) would also let ${k - 1} ` +
          `reach it (they must stay below ${pct(hi + 1)}% each)`;
    return {
      ok: false,
      reason:
        `No equal share works for ${k}-of-${n} at a ${quorumPct}% quorum: ${why}. ` +
        `Lower quorumPercent, or change approvalsNeeded / the number of agents.`,
    };
  }

  for (let s = lo; s <= top; s++) {
    const m = checkQuorumMargin({ quorumPct, votablePct: (n * s) / 100 });
    if (!m.ok) continue;
    return {
      ok: true,
      shares: {
        n,
        k,
        quorumPct,
        shareBps: s,
        sharePct: pct(s),
        agentsTotalBps: n * s,
        agentsTotalPct: pct(n * s),
        treasuryBps: 10000 - n * s,
        treasuryPct: pct(10000 - n * s),
        kForPct: pct(k * s),
        kMinusOneForPct: pct((k - 1) * s),
        requiredTurnoutPct: m.requiredTurnoutPct,
        bounds: { lo, hi: top },
        raisedForTurnout: s > lo,
      },
    };
  }
  const needAgents = Math.ceil((quorumPct / QUORUM_TURNOUT_CEILING) * 100) / 100;
  return {
    ok: false,
    reason:
      `No equal share works for ${k}-of-${n} at a ${quorumPct}% quorum: the turnout-margin rule needs the agents ` +
      `to hold at least ${needAgents}% of the supply together (quorum ≤ ${QUORUM_TURNOUT_CEILING * 100}% of ` +
      `votable power), which takes ≥ ${pct(Math.ceil((needAgents * 100) / n))}% each — but ${k - 1} agents ` +
      `must stay below the quorum, capping each at ${pct(top)}%. Lower quorumPercent, add agents, or raise ` +
      `approvalsNeeded.`,
  };
}

/**
 * The guarantees block the preview shows. Honest about the two quorum formulas
 * in the field and about the validator round, which is the actual human veto.
 */
export function agentTreasuryGuarantees(s: AgentShares, validatorCount: number): Record<string, string> {
  return {
    kForPasses:
      `${s.k} agents voting FOR carry ${s.kForPct}% of the supply ≥ the ${s.quorumPct}% quorum: they reach ` +
      `quorum on their own (after depositing their tokens into the DAO).`,
    kMinusOneForDoesNot:
      `${s.k - 1} agents voting FOR carry ${s.kMinusOneForPct}% < ${s.quorumPct}%: on their own they never ` +
      `reach quorum.`,
    quorumFormula:
      `Protocol master counts each side alone (votesFor ≥ quorum OR votesAgainst ≥ quorum), so the two lines ` +
      `above hold exactly. The GovPool deployed on BSC testnet 97 still counts turnout ((for + against) / ` +
      `total ≥ quorum): there an AGAINST vote also counts toward quorum, after which the majority decides — ` +
      `so ${s.k - 1} FOR plus any AGAINST that brings turnout to ${s.k} agents reaches quorum, and passes if ` +
      `FOR outweighs AGAINST.`,
    humanVeto:
      `Every proposal that reaches member quorum then goes to the validator round: ${validatorCount} human ` +
      `validator(s) seated at deploy must vote it through before it can execute — under either quorum ` +
      `formula. Validators that vote AGAINST, or do not vote, stop it.`,
    treasury:
      `${s.treasuryPct}% of the supply stays in the DAO treasury and is never votable; it moves only through ` +
      `proposals that pass both rounds.`,
  };
}
