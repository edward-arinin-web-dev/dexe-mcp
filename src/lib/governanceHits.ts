/**
 * Governance-call classification — the part of the build-time harm pass that
 * `dexe_proposal_risk_assess` reads. Pure: no RPC, no config, no build
 * warnings. ./buildAdvisories.ts imports and re-exports all of it.
 */
import { Interface } from "ethers";
import { treasurySelectors } from "./quorumRisk.js";

/** The minimum an action has to look like to be assessed. */
export interface AssessableAction {
  executor?: string | null;
  value?: string | null;
  data?: string | null;
}

// ---------------------------------------------------------------------------
// GovSettings calldata decoding — shared with the settings-bounds checks in
// ./buildAdvisories.ts
// ---------------------------------------------------------------------------

const GOV_SETTINGS_TUPLE =
  "tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)";

export const SETTINGS_DECODE_IFACE = new Interface([
  `function addSettings(${GOV_SETTINGS_TUPLE}[] settings)`,
  `function editSettings(uint256[] ids, ${GOV_SETTINGS_TUPLE}[] params)`,
]);

export const EDIT_SETTINGS_SELECTOR = SETTINGS_DECODE_IFACE.getFunction("editSettings")!.selector;
export const ADD_SETTINGS_DECODE_SELECTOR =
  SETTINGS_DECODE_IFACE.getFunction("addSettings")!.selector;

// ---------------------------------------------------------------------------
// Governance-call classification (dexe_proposal_risk_assess)
// ---------------------------------------------------------------------------

export type GovernanceHitKind =
  | "blacklist"
  | "pause"
  | "changeVotePower"
  | "setNftMultiplier"
  | "changeSettings"
  | "changeExecutors"
  | "changeValidatorBalances"
  | "unknownPrivileged";

export interface GovernanceHit {
  index: number;
  executor: string;
  selector: string | null;
  kind: GovernanceHitKind;
  /** Decoded address arguments, best-effort. */
  targets: string[];
  /** The subset of (targets ∪ executor) that is one of the DAO's own contracts. */
  protocolTargets: string[];
}

/**
 * Signatures are declared as literals here rather than imported from
 * `src/tools/*` — importing a tools module back into `src/lib` would be a
 * layering inversion, and a module-scope selector table built through a cycle
 * evaluates EMPTY, i.e. the same blind spot with more code. A drift test
 * recomputes each selector from the ABI the builders encode with.
 */
const GOVERNANCE_SIGS: readonly { sig: string; kind: GovernanceHitKind; targetArgs: number[] }[] = [
  { sig: "blacklist(address[],bool)", kind: "blacklist", targetArgs: [0] },
  { sig: "pause()", kind: "pause", targetArgs: [] },
  { sig: "changeVotePower(address)", kind: "changeVotePower", targetArgs: [0] },
  { sig: "setNftMultiplierAddress(address)", kind: "setNftMultiplier", targetArgs: [0] },
  { sig: "changeExecutors(address[],uint256[])", kind: "changeExecutors", targetArgs: [0] },
  { sig: "changeBalances(uint256[],address[])", kind: "changeValidatorBalances", targetArgs: [1] },
];

const GOVERNANCE_SELECTORS: ReadonlyMap<string, { kind: GovernanceHitKind; iface: Interface; name: string; targetArgs: number[] }> =
  (() => {
    const m = new Map<string, { kind: GovernanceHitKind; iface: Interface; name: string; targetArgs: number[] }>();
    for (const e of GOVERNANCE_SIGS) {
      try {
        const iface = new Interface([`function ${e.sig}`]);
        const name = e.sig.slice(0, e.sig.indexOf("("));
        const fn = iface.getFunction(e.sig);
        if (!fn) continue;
        m.set(fn.selector.toLowerCase(), { kind: e.kind, iface, name, targetArgs: e.targetArgs });
      } catch {
        /* a malformed literal must never take the whole table down */
      }
    }
    // addSettings / editSettings via the canonical tuple interface.
    m.set(ADD_SETTINGS_DECODE_SELECTOR.toLowerCase(), {
      kind: "changeSettings",
      iface: SETTINGS_DECODE_IFACE,
      name: "addSettings",
      targetArgs: [],
    });
    m.set(EDIT_SETTINGS_SELECTOR.toLowerCase(), {
      kind: "changeSettings",
      iface: SETTINGS_DECODE_IFACE,
      name: "editSettings",
      targetArgs: [],
    });
    return m;
  })();

/** Value-moving selectors the treasury table owns; never re-scored here. */
const TREASURY_SELECTOR_SET: ReadonlySet<string> = new Set(treasurySelectors().map((s) => s.toLowerCase()));

/** Selectors this classifier recognises (for docs/tests). */
export function governanceSelectors(): string[] {
  return [...GOVERNANCE_SELECTORS.keys()];
}

/**
 * Privileged governance calls a proposal can make that move NO treasury value
 * and are therefore invisible to `classifyTreasuryActions`. Selector match
 * comes FIRST and is independent of the executor, so an RPC hiccup that leaves
 * `protocolAddresses` empty can never silently downgrade a finding.
 */
export function classifyGovernanceActions(
  actions: readonly AssessableAction[],
  ctx: { protocolAddresses: readonly string[] },
): GovernanceHit[] {
  const protocol = new Set(
    ctx.protocolAddresses.filter((a): a is string => typeof a === "string" && a.length > 0).map((a) => a.toLowerCase()),
  );
  const out: GovernanceHit[] = [];
  actions.forEach((a, index) => {
    const data = typeof a?.data === "string" ? a.data : "";
    const executor = typeof a?.executor === "string" ? a.executor : "";
    if (!data.startsWith("0x") || data.length < 10) return;
    const selector = data.slice(0, 10).toLowerCase();
    const entry = GOVERNANCE_SELECTORS.get(selector);

    let kind: GovernanceHitKind;
    let targets: string[] = [];
    if (!entry && TREASURY_SELECTOR_SET.has(selector)) {
      // ERC20.transfer / approve / transferFrom on the DAO's OWN gov token is
      // the ordinary treasury-move that `classifyTreasuryActions` already
      // scores under the quorum model. Falling through to `unknownPrivileged`
      // here turned every token_transfer of the gov token — the most common
      // proposal there is — into a DANGER "calls the DAO's own contract" that
      // contradicted the treasury readout beside it.
      return;
    }
    if (entry) {
      kind = entry.kind;
      try {
        const decoded = entry.iface.decodeFunctionData(entry.name, data);
        for (const argIdx of entry.targetArgs) {
          const v = decoded[argIdx];
          if (Array.isArray(v)) targets.push(...v.map((x) => String(x)));
          else if (typeof v === "string") targets.push(v);
        }
      } catch {
        targets = [];
      }
    } else if (protocol.has(executor.toLowerCase())) {
      kind = "unknownPrivileged";
    } else {
      return;
    }

    const all = [...targets, executor].filter((t) => typeof t === "string" && t.length > 0);
    const protocolTargets = [...new Set(all.filter((t) => protocol.has(t.toLowerCase())))];
    out.push({ index, executor, selector, kind, targets, protocolTargets });
  });
  return out;
}

/** DANGER iff a hit names one of the DAO's own contracts; CAUTION for any hit. */
export function governanceVerdict(hits: readonly GovernanceHit[]): "SAFE" | "CAUTION" | "DANGER" {
  if (hits.some((h) => h.protocolTargets.length > 0)) return "DANGER";
  return hits.length > 0 ? "CAUTION" : "SAFE";
}
