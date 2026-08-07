import type { Interface } from "ethers";
import {
  checkSettingsBounds,
  checkMinVotesVsDistribution,
  checkQuorumReachable,
  meritocraticVotingPower,
  type PreflightResult,
} from "./preflight.js";
import { checkQuorumMargin, judgeQuorum, lowQuorumAdvisory, quorumPctFromRaw } from "./quorumRisk.js";

/**
 * deployGovPool encode → decode round-trip verifier.
 *
 * The `PoolFactory.deployGovPool` argument is a large, deeply-nested tuple that
 * `buildDeployGovPool` encodes POSITIONALLY. A stale ABI, a reordered tuple, or
 * an offset-corrupting mistake in one dynamic sub-field silently shifts later
 * fields — the classic symptom is an empty `name`, which reverts on-chain with
 * `"PoolFactory: pool name cannot be empty"` after burning gas. A param-value
 * guard cannot see this because the corruption happens at ENCODE time.
 *
 * `roundTripDeployCalldata` decodes the freshly-built calldata with the same
 * Interface and asserts every load-bearing field survived — a cheap, offline
 * complement to the B9 eth_call simulation (which only runs at broadcast). It
 * catches positional/field drift immediately, at build time, with a precise
 * field-level diff instead of an opaque revert.
 */

export interface DeployFieldMismatch {
  field: string;
  expected: string;
  got: string;
}

// ==========================================================================
// Governance coherence across ALL FIVE settings slots (0.33.0)
// ==========================================================================
/**
 * `deployGovPool` takes FIVE `proposalSettings` entries, one per executor
 * family, and every one of them governs a different class of proposal. Checking
 * only `proposalSettings[0]` passes a DAO whose default proposals work while its
 * internal / validator / distribution / token-sale proposals are permanently
 * un-passable (quorum above the votable supply, min-votes above every holder,
 * duration 0). That DAO is UNRECOVERABLE: changing those settings requires
 * passing a proposal, under the settings that cannot pass.
 *
 * `checkAllProposalSettings` runs the deploy coherence checks over every slot
 * the caller supplies (1 pre-expansion or 5 post-expansion) and labels each
 * failure with the executor family it bricks.
 */

/** The five GovSettings executor slots, in on-chain order. */
export const PROPOSAL_SETTINGS_SLOTS = [
  "default",
  "internal",
  "validators",
  "distributionProposal",
  "tokenSale",
] as const;

export type ProposalSettingsSlot = (typeof PROPOSAL_SETTINGS_SLOTS)[number] | "extra";

/** Name of slot `i`, or `extra` for an out-of-range index. */
export function settingsSlotName(index: number): ProposalSettingsSlot {
  return PROPOSAL_SETTINGS_SLOTS[index] ?? "extra";
}

/** The settings fields the coherence checks read (structural — extras welcome). */
export interface ProposalSettingsSlotView {
  quorum: string;
  quorumValidators: string;
  duration: string;
  durationValidators: string;
  minVotesForVoting: string;
  minVotesForCreating: string;
}

export interface SettingsSlotIssue {
  index: number;
  slot: ProposalSettingsSlot;
  /** Stable check id from preflight, or `deploy.quorum-margin`. */
  check: string;
  remediation: string;
  detail?: string;
}

export interface SettingsSlotFacts {
  index: number;
  slot: ProposalSettingsSlot;
  quorumPct: number;
  /** % of the votable POWER that must turn out. Null when incomputable. */
  requiredTurnoutPct: number | null;
  reachable: boolean;
  marginOk: boolean;
  floorOk: boolean;
}

export interface AllSettingsVerdict {
  /** Empty ⇒ every slot can govern itself. Non-empty ⇒ refuse the deploy. */
  issues: SettingsSlotIssue[];
  /** Below-floor-quorum advisories, one per offending slot. Never blocking. */
  advisories: string[];
  slots: SettingsSlotFacts[];
  /** Votable tokens as a % of minted supply. */
  votablePct: number;
  /** Votable VOTE POWER as a % of supply (== votablePct under LINEAR). */
  votablePowerPct: number;
}

const HUNDRED_BPS = 10000n;

/**
 * Run the deploy coherence checks over EVERY supplied settings slot.
 * Pure + offline: no RPC, never throws (a malformed numeric string surfaces as
 * an issue, not an exception). `votable` defaults to the sum of `amounts` —
 * correct because the treasury is an implicit remainder that is never a
 * recipient (enforced separately by `checkNoTreasuryRecipient`).
 */
export function checkAllProposalSettings(args: {
  proposalSettings: readonly ProposalSettingsSlotView[];
  amounts: readonly string[];
  mintedTotal: string;
  voteType: string;
  isTokenCreation: boolean;
  votable?: string;
  /** Advisory quorum floor (DEXE_MIN_SAFE_QUORUM_PCT). Default 50. */
  floorPct?: number;
  /** Turnout ceiling override; see QUORUM_TURNOUT_CEILING. */
  turnoutCeiling?: number;
}): AllSettingsVerdict {
  const floorPct = args.floorPct ?? 50;
  const issues: SettingsSlotIssue[] = [];
  const advisories: string[] = [];
  const slots: SettingsSlotFacts[] = [];
  const belowFloor: Array<{ index: number; slot: ProposalSettingsSlot; quorumPct: number }> = [];

  let supply = 0n;
  let votable = 0n;
  try {
    supply = BigInt(args.mintedTotal || "0");
    votable =
      args.votable !== undefined
        ? BigInt(args.votable)
        : args.amounts.reduce((a, b) => a + BigInt(b || "0"), 0n);
  } catch {
    // Unparseable token math — the token guards (checkDeployCap etc.) own that
    // failure; here we simply cannot judge the slots.
    supply = 0n;
    votable = 0n;
  }
  const votablePower =
    args.voteType === "POLYNOMIAL_VOTES" && supply > 0n ? meritocraticVotingPower(votable, supply) : votable;
  const votablePct = supply > 0n ? Number((votable * HUNDRED_BPS) / supply) / 100 : 0;
  const votablePowerPct = supply > 0n ? Number((votablePower * HUNDRED_BPS) / supply) / 100 : 0;

  args.proposalSettings.forEach((s, index) => {
    const slot = settingsSlotName(index);
    const add = (r: PreflightResult) => {
      if (!r.ok) {
        issues.push({
          index,
          slot,
          check: r.check,
          remediation: r.remediation ?? "",
          ...(r.detail ? { detail: r.detail } : {}),
        });
      }
    };

    let bounds: PreflightResult;
    let minVotes: PreflightResult;
    let reach: PreflightResult;
    try {
      bounds = checkSettingsBounds({
        quorum: s.quorum,
        quorumValidators: s.quorumValidators,
        duration: s.duration,
        durationValidators: s.durationValidators,
      });
      minVotes = checkMinVotesVsDistribution(
        s.minVotesForVoting,
        s.minVotesForCreating,
        [...args.amounts],
        args.isTokenCreation,
      );
      reach = checkQuorumReachable({
        voteType: args.voteType,
        quorumRaw: s.quorum,
        mintedTotal: supply.toString(),
        votable: votable.toString(),
        isTokenCreation: args.isTokenCreation,
      });
    } catch {
      issues.push({
        index,
        slot,
        check: "deploy.settings-unparseable",
        remediation:
          `proposalSettings[${index}] (${slot}) holds a non-numeric quorum/duration/min-votes value. ` +
          `All of these are decimal strings in wei / 1e25-percent units.`,
      });
      return;
    }
    add(bounds);
    add(minVotes);
    add(reach);

    const quorumPct = quorumPctFromRaw(s.quorum);
    // Margin is only meaningful for a DAO whose distribution we know (token
    // creation); an external token's holders are unknown at deploy time — the
    // same reason checkQuorumReachable exempts it.
    const margin = args.isTokenCreation
      ? checkQuorumMargin({
          quorumPct,
          votablePct: votablePowerPct,
          ...(args.turnoutCeiling !== undefined ? { ceiling: args.turnoutCeiling } : {}),
        })
      : null;
    // Reachability failing already says "impossible"; don't pile the margin text
    // on top of it — one cause, one fix.
    if (margin && !margin.ok && reach.ok) {
      issues.push({
        index,
        slot,
        check: "deploy.quorum-margin",
        remediation:
          `proposalSettings[${index}] (${slot}): ${margin.remediation} ` +
          `Every ${slot} proposal is governed by this slot — a slot that cannot pass leaves that whole ` +
          `class of proposal permanently un-passable, and no proposal can repair it.`,
      });
    }

    const floorOk = judgeQuorum(quorumPct, floorPct) === "SAFE";
    if (!floorOk) belowFloor.push({ index, slot, quorumPct });

    slots.push({
      index,
      slot,
      quorumPct,
      requiredTurnoutPct: margin?.requiredTurnoutPct ?? null,
      reachable: reach.ok,
      marginOk: margin ? margin.ok : true,
      floorOk,
    });
  });

  // One advisory per distinct below-floor quorum, naming every slot it governs —
  // the 1→5 auto-expansion clones one setting, and five identical paragraphs
  // train the reader to skip them.
  for (const pct of [...new Set(belowFloor.map((b) => b.quorumPct))]) {
    const where = belowFloor.filter((b) => b.quorumPct === pct).map((b) => `[${b.index}] ${b.slot}`);
    advisories.push(`proposalSettings ${where.join(", ")} — ${lowQuorumAdvisory(pct, floorPct)}`);
  }

  return { issues, advisories, slots, votablePct, votablePowerPct };
}

/** One-line-per-issue rendering for a tool error message. */
export function formatSettingsSlotIssues(issues: readonly SettingsSlotIssue[]): string {
  return issues
    .map((i) => `• proposalSettings[${i.index}] (${i.slot}) [${i.check}]: ${i.remediation}${i.detail ? ` (${i.detail})` : ""}`)
    .join("\n");
}

export interface RoundTripResult {
  ok: boolean;
  mismatches: DeployFieldMismatch[];
}

/** Minimal named view of the deployGovPool struct (both the intended object and the decoded Result satisfy this via named access). */
export interface DeployStructView {
  name: unknown;
  descriptionURL: unknown;
  verifier: unknown;
  onlyBABTHolders: unknown;
  votePowerParams: { voteType: unknown; initData: unknown; presetAddress: unknown };
  settingsParams: {
    proposalSettings: ArrayLike<any> & Iterable<any>;
    additionalProposalExecutors: ArrayLike<unknown> & Iterable<unknown>;
  };
  validatorsParams: {
    name: unknown;
    symbol: unknown;
    proposalSettings: { duration: unknown; executionDelay: unknown; quorum: unknown };
    validators: ArrayLike<unknown> & Iterable<unknown>;
    balances: ArrayLike<unknown> & Iterable<unknown>;
  };
  userKeeperParams: { tokenAddress: unknown; nftAddress: unknown; individualPower: unknown; nftsTotalSupply: unknown };
  tokenParams: {
    name: unknown;
    symbol: unknown;
    users: ArrayLike<unknown> & Iterable<unknown>;
    cap: unknown;
    mintedTotal: unknown;
    amounts: ArrayLike<unknown> & Iterable<unknown>;
  };
}

/** Canonicalize a scalar (bigint / ethers v6 numeric / bool / hex / string) so the
 *  intended object (strings) and the ABI-decoded Result (bigints) compare equal. */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // ethers v5 BigNumber fallback; v6 returns native bigint (handled above)
    const o = v as { toString(): string; _isBigNumber?: boolean; _hex?: string };
    if (o._isBigNumber || o._hex) return BigInt(o.toString()).toString();
    return String(v);
  }
  const s = String(v);
  return /^0x[0-9a-fA-F]*$/.test(s) ? s.toLowerCase() : s;
}

function extract(p: DeployStructView): Record<string, string> {
  const o: Record<string, string> = {};
  o["name"] = canon(p.name);
  o["descriptionURL"] = canon(p.descriptionURL);
  o["verifier"] = canon(p.verifier);
  o["onlyBABTHolders"] = canon(p.onlyBABTHolders);
  o["votePower.voteType"] = canon(p.votePowerParams.voteType);
  o["votePower.initData"] = canon(p.votePowerParams.initData);
  o["votePower.presetAddress"] = canon(p.votePowerParams.presetAddress);

  Array.from(p.settingsParams.additionalProposalExecutors).forEach((e, i) => {
    o[`executors[${i}]`] = canon(e);
  });
  Array.from(p.settingsParams.proposalSettings).forEach((s: any, i: number) => {
    for (const f of [
      "earlyCompletion",
      "delegatedVotingAllowed",
      "validatorsVote",
      "duration",
      "durationValidators",
      "executionDelay",
      "quorum",
      "quorumValidators",
      "minVotesForVoting",
      "minVotesForCreating",
      "executorDescription",
    ]) {
      o[`ps[${i}].${f}`] = canon(s[f]);
    }
    const ri = s.rewardsInfo ?? {};
    for (const f of ["rewardToken", "creationReward", "executionReward", "voteRewardsCoefficient"]) {
      o[`ps[${i}].rewards.${f}`] = canon(ri[f]);
    }
  });

  const vp = p.validatorsParams;
  o["val.name"] = canon(vp.name);
  o["val.symbol"] = canon(vp.symbol);
  o["val.ps.duration"] = canon(vp.proposalSettings.duration);
  o["val.ps.executionDelay"] = canon(vp.proposalSettings.executionDelay);
  o["val.ps.quorum"] = canon(vp.proposalSettings.quorum);
  Array.from(vp.validators).forEach((v, i) => (o[`val.validators[${i}]`] = canon(v)));
  Array.from(vp.balances).forEach((v, i) => (o[`val.balances[${i}]`] = canon(v)));

  const uk = p.userKeeperParams;
  o["uk.tokenAddress"] = canon(uk.tokenAddress);
  o["uk.nftAddress"] = canon(uk.nftAddress);
  o["uk.individualPower"] = canon(uk.individualPower);
  o["uk.nftsTotalSupply"] = canon(uk.nftsTotalSupply);

  const tp = p.tokenParams;
  o["tp.name"] = canon(tp.name);
  o["tp.symbol"] = canon(tp.symbol);
  o["tp.cap"] = canon(tp.cap);
  o["tp.mintedTotal"] = canon(tp.mintedTotal);
  Array.from(tp.users).forEach((u, i) => (o[`tp.users[${i}]`] = canon(u)));
  Array.from(tp.amounts).forEach((a, i) => (o[`tp.amounts[${i}]`] = canon(a)));

  return o;
}

/**
 * Decode `data` (the built deployGovPool calldata) with `iface`, then assert
 * every load-bearing field equals the `expected` intended struct. Returns the
 * field-level mismatches; empty ⇒ the calldata faithfully encodes the intent.
 *
 * Throws only if `data` cannot be parsed as a deployGovPool call at all (that is
 * itself a fatal encoding error — surface it as "do not broadcast").
 */
export function roundTripDeployCalldata(
  data: string,
  iface: Interface,
  expected: DeployStructView,
): RoundTripResult {
  const parsed = iface.parseTransaction({ data });
  if (!parsed || parsed.name !== "deployGovPool") {
    return {
      ok: false,
      mismatches: [{ field: "<decode>", expected: "deployGovPool(...)", got: parsed?.name ?? "unparseable" }],
    };
  }
  const decoded = parsed.args[0] as unknown as DeployStructView;
  const a = extract(expected);
  const b = extract(decoded);
  const mismatches: DeployFieldMismatch[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ea = a[k] ?? "(absent)";
    const eb = b[k] ?? "(absent)";
    if (ea !== eb) mismatches.push({ field: k, expected: ea, got: eb });
  }
  return { ok: mismatches.length === 0, mismatches };
}
