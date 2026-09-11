/**
 * The build-time harm pass — ONE place, driven by the emitted calldata.
 *
 * Every guard in 0.33.0 was wired at whichever call site the reviewer happened
 * to be looking at: `findForbiddenSelector` reached 2 of 30 proposal builders,
 * `checkAddSettingsTrap` reached the registry but neither standalone settings
 * builder, `findVestingTiers` reached `dexe_otc_dao_open_sale` and none of the
 * three token-sale proposal surfaces, and `checkApproveTarget` reached nothing
 * at all. Each hole is the same mistake with a different name.
 *
 * The fix is not "remember harder". It is to derive every finding FROM THE
 * CALLDATA a builder actually emitted, exactly the way `checkAddSettingsTrap`
 * already did, so the branch that produced it cannot matter — including a
 * hand-rolled `custom_abi` action, `proposalType: "custom"`, or a catalog type
 * added next year. Caller-supplied structured hints (`tiers`, `settings`,
 * `blacklistTargets`) are deliberately NOT accepted: an input a call site has
 * to remember to pass is a guard a call site can forget to pass.
 *
 * Two halves, because they have different costs and different failure modes:
 *
 *   assessBuildPure     synchronous, ZERO RPC, always runs, never throws.
 *   assessBuildContext  async, one multicall + one getCode batch, 30 s cache,
 *                       the whole body in try/catch. NEVER blocks and never
 *                       produces a `block: "hard"` finding — a missing RPC must
 *                       degrade with a note, never wedge a build.
 *
 * Chain-keyed findings raised against a chain the caller never named come out
 * at WARN / block:"none" with `assumedChainPrefix`. A default-97 install must
 * not hard-refuse a build the user meant for 56.
 */
import { Interface, isAddress, ZeroAddress, type JsonRpcProvider } from "ethers";
import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { safeErrorMessage } from "./redact.js";
import { multicall, type Call } from "./multicall.js";
import { findForbiddenSelector, dangerousSelectorError } from "./dangerousSelectors.js";
import {
  checkAddSettingsTrap,
  VESTING_WITHDRAW_ADVISORY,
  TOKEN_SALE_CREATE_TIERS_SELECTOR,
  BLACKLIST_SELECTOR,
  decodeCreateTiersVesting,
  decodeBlacklistAdditions,
} from "./protocolAdvisories.js";
import {
  classifyTreasuryActions,
  TREASURY_RISK_ADVISORY,
  type TreasuryGuardMode,
  type TreasuryHit,
} from "./quorumRisk.js";
import { formatAmount } from "./units.js";
import { renderUntrusted } from "./sanitize.js";
import {
  assumedChainPrefix,
  type BuildWarning,
  type WarningBlock,
  type WarningSeverity,
} from "./buildWarning.js";

// ---------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------

/** The minimum an action has to look like to be assessed. */
export interface AssessableAction {
  executor?: string | null;
  value?: string | null;
  data?: string | null;
}

export interface AssessBuildInput {
  /** Chain the emitted calldata targets. */
  chainId: number;
  /**
   * False when `chainId` was defaulted rather than named by the caller. Every
   * chain-keyed finding is then downgraded to WARN / block:"none".
   */
  chainIdExplicit: boolean;
  actions: readonly AssessableAction[];
  /** Treasury posture; "off" silences the (always advisory) `treasury.*` codes. */
  treasuryGuard?: TreasuryGuardMode;
  /** DAO GovPool, when the surface knows it. Enables the self-harm checks. */
  govPool?: string;
}

/** DeXe percentage base: 100% = 1e27 (a quorum setting is pct × 1e25). */
export const PERCENTAGE_100 = 10n ** 27n;

const ZERO = ZeroAddress.toLowerCase();

function lower(a: string | null | undefined): string | null {
  return typeof a === "string" && a.length > 0 ? a.toLowerCase() : null;
}

/**
 * Downgrade a chain-keyed finding raised against an assumed chain. Never
 * refuses on a chain the caller did not name.
 */
function forAssumedChain(w: BuildWarning, explicit: boolean, chainId: number): BuildWarning {
  if (explicit) return w;
  return {
    ...w,
    severity: "WARN",
    block: "none",
    message: `${assumedChainPrefix(chainId)}${w.message}`,
  };
}

// ---------------------------------------------------------------------------
// GovSettings bounds — contract-exact (GovSettings.sol:94-105)
// ---------------------------------------------------------------------------

const GOV_SETTINGS_TUPLE =
  "tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)";

const SETTINGS_DECODE_IFACE = new Interface([
  `function addSettings(${GOV_SETTINGS_TUPLE}[] settings)`,
  `function editSettings(uint256[] ids, ${GOV_SETTINGS_TUPLE}[] params)`,
]);

export const EDIT_SETTINGS_SELECTOR = SETTINGS_DECODE_IFACE.getFunction("editSettings")!.selector;
export const ADD_SETTINGS_DECODE_SELECTOR =
  SETTINGS_DECODE_IFACE.getFunction("addSettings")!.selector;

export type SettingsBoundField = "duration" | "durationValidators" | "quorum" | "quorumValidators";

export interface SettingsBoundViolation {
  field: SettingsBoundField;
  got: string;
  /** The exact string GovSettings reverts with, or "" for an unparseable value. */
  revert: string;
}

/**
 * Exactly the four `require`s in `GovSettings._validateProposalSettings`
 * (D:\dev\DeXe-Protocol\contracts\gov\settings\GovSettings.sol:94-105), which
 * runs on BOTH `addSettings` and `editSettings`:
 *
 *   require(duration > 0)                       "GovSettings: invalid vote duration value"
 *   require(quorum <= PERCENTAGE_100)           "GovSettings: invalid quorum value"
 *   require(quorum > 0)                         "GovSettings: invalid quorum value"
 *   require(durationValidators > 0)             "GovSettings: invalid validator vote duration value"
 *   require(quorumValidators <= PERCENTAGE_100) "GovSettings: invalid validator quorum value"
 *
 * There is deliberately NO `quorumValidators > 0` rule — the contract has no
 * lower bound there, `src/lib/deployRevertMap.ts` already documents it that
 * way, and `settingsAdvisories` treats quorumValidators=0 with
 * validatorsVote=false as a legal config. `checkSettingsBounds`
 * (src/lib/preflight.ts) is stricter because the DEPLOY tuple also carries the
 * validators' own settings struct; it stays as it is and is not reused here.
 * Never throws — a non-numeric value yields a violation with an empty `revert`.
 */
export function govSettingsBoundViolations(s: {
  quorum: unknown;
  quorumValidators: unknown;
  duration: unknown;
  durationValidators: unknown;
}): SettingsBoundViolation[] {
  const out: SettingsBoundViolation[] = [];
  const big = (v: unknown): bigint | null => {
    try {
      if (typeof v === "bigint") return v;
      const s2 = String(v).trim();
      return /^[0-9]+$/.test(s2) ? BigInt(s2) : null;
    } catch {
      return null;
    }
  };
  const push = (field: SettingsBoundField, raw: unknown, revert: string) =>
    out.push({ field, got: String(raw), revert });

  const d = big(s.duration);
  if (d === null) push("duration", s.duration, "");
  else if (d === 0n) push("duration", s.duration, "GovSettings: invalid vote duration value");

  const dv = big(s.durationValidators);
  if (dv === null) push("durationValidators", s.durationValidators, "");
  else if (dv === 0n)
    push("durationValidators", s.durationValidators, "GovSettings: invalid validator vote duration value");

  const q = big(s.quorum);
  if (q === null) push("quorum", s.quorum, "");
  else if (q === 0n || q > PERCENTAGE_100)
    push("quorum", s.quorum, "GovSettings: invalid quorum value");

  const qv = big(s.quorumValidators);
  if (qv === null) push("quorumValidators", s.quorumValidators, "");
  else if (qv > PERCENTAGE_100)
    push("quorumValidators", s.quorumValidators, "GovSettings: invalid validator quorum value");

  return out;
}

// ---------------------------------------------------------------------------
// Staking window — the same silent no-op, at BOTH call sites
// ---------------------------------------------------------------------------

/**
 * `StakingProposal.createStaking` does NOT revert on a stale window: it bounces
 * the reward back to the treasury and emits `StakingRejected`
 * (StakingProposal.sol:78-83), so the execute succeeds with status 1 and NO
 * tier exists. Proven on-chain 2026-07-23 (a mainnet proposal executed with a
 * 2024 deadline → 0 tiers). There is no revert receipt to diagnose from, so the
 * whole governance cycle is spent for nothing.
 *
 * The catalog builder has refused this since 0.29; the standalone
 * `dexe_proposal_build_create_staking_tier` handler re-implements the encode
 * and went straight to `encodeFunctionData` with no time check at all — the
 * same drift this whole module exists to end. One guard, both call sites.
 *
 * Throws with the remedy attached. Never silently passes a stale window.
 */
export function assertStakingWindow(startedAt: string, deadline: string, nowSec?: bigint): void {
  const now = nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  let start: bigint;
  let end: bigint;
  try {
    start = BigInt(String(startedAt).trim());
    end = BigInt(String(deadline).trim());
  } catch {
    throw new Error(
      `create_staking_tier: startedAt (${startedAt}) and deadline (${deadline}) must be unix timestamps in ` +
        `SECONDS, digits only.`,
    );
  }
  if (start >= end) {
    throw new Error(
      `create_staking_tier: startedAt (${startedAt}) must be BEFORE deadline (${deadline}) — the contract ` +
        `reverts 'SP: Invalid settings'.`,
    );
  }
  if (end <= now) {
    throw new Error(
      `create_staking_tier: deadline ${deadline} (${new Date(Number(end) * 1000).toISOString()}) is in the PAST — ` +
        `current unix time is ~${now}. The contract would SILENTLY reject the tier at execute (transaction succeeds, ` +
        `no tier is created, the reward returns to the treasury). Use future timestamps computed from the current time — ` +
        `never guess the date — and leave headroom for the voting period before execution.`,
    );
  }
}

function pctOf(raw: string): string {
  try {
    const v = BigInt(raw);
    const whole = v / 10n ** 25n;
    const frac = (v % 10n ** 25n) / 10n ** 23n;
    return frac === 0n ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
  } catch {
    return "unparseable";
  }
}

function boundsMessage(v: SettingsBoundViolation, index: number): { message: string; remedy: string } {
  const where = `actionsOnFor[${index}]`;
  if (v.field === "quorum" || v.field === "quorumValidators") {
    const range =
      v.field === "quorum"
        ? `0 < quorum ≤ 1000000000000000000000000000 (1e27 = 100%; 1% = 1e25)`
        : `quorumValidators ≤ 1000000000000000000000000000 (1e27 = 100%)`;
    return {
      message:
        `${where}: ${v.field}=${v.got}${v.revert ? ` (${pctOf(v.got)})` : ""} is out of range. ` +
        `GovSettings._validateProposalSettings requires ${range}, so addSettings/editSettings reverts ` +
        `${v.revert ? `"${v.revert}"` : "on decode"} WHEN THIS PROPOSAL EXECUTES — after it has already passed ` +
        `the vote, burning the whole voting period with nothing to undo.`,
      remedy:
        v.field === "quorum"
          ? `Set quorum ≤ "1000000000000000000000000000"; 51% is "510000000000000000000000000".`
          : `Set quorumValidators ≤ "1000000000000000000000000000"; 51% is "510000000000000000000000000".`,
    };
  }
  return {
    message:
      `${where}: ${v.field}=${v.got} is out of range. GovSettings._validateProposalSettings requires ` +
      `${v.field} > 0 seconds, so addSettings/editSettings reverts ${v.revert ? `"${v.revert}"` : "on decode"} ` +
      `WHEN THIS PROPOSAL EXECUTES — after it has already passed the vote.`,
    remedy: `Set ${v.field} to a non-zero number of seconds (86400 = 1 day).`,
  };
}

/** Decode the settings tuples an action carries, if it carries any. Never throws. */
function settingsInCalldata(data: string): {
  quorum: unknown;
  quorumValidators: unknown;
  duration: unknown;
  durationValidators: unknown;
}[] {
  const d = data.toLowerCase();
  const isAdd = d.startsWith(ADD_SETTINGS_DECODE_SELECTOR);
  const isEdit = d.startsWith(EDIT_SETTINGS_SELECTOR);
  if (!isAdd && !isEdit) return [];
  try {
    const decoded = SETTINGS_DECODE_IFACE.decodeFunctionData(isAdd ? "addSettings" : "editSettings", data);
    const tuples = (isAdd ? decoded[0] : decoded[1]) as unknown as readonly unknown[];
    return [...tuples].map((t) => {
      const r = t as Record<string, unknown> & readonly unknown[];
      return {
        duration: r.duration ?? r[3],
        durationValidators: r.durationValidators ?? r[4],
        quorum: r.quorum ?? r[6],
        quorumValidators: r.quorumValidators ?? r[7],
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ERC20 approve / transfer decode (approve.target, treasury.*)
// ---------------------------------------------------------------------------

const ERC20_DECODE_IFACE = new Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);
const APPROVE_SELECTOR = ERC20_DECODE_IFACE.getFunction("approve")!.selector;

/** Decoded `approve(spender, amount)` args, or null. Never throws. */
function approveInCalldata(data: string): { spender: string; amount: bigint } | null {
  if (!data.toLowerCase().startsWith(APPROVE_SELECTOR)) return null;
  try {
    const d = ERC20_DECODE_IFACE.decodeFunctionData("approve", data);
    return { spender: String(d[0]), amount: BigInt(d[1] as bigint) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PHASE A — pure, zero RPC, always runs
// ---------------------------------------------------------------------------

/**
 * Every finding that can be reached from the calldata alone. Synchronous and
 * side-effect free, so it is safe on the hot path of every builder and keeps
 * `PROPOSAL_BUILDERS` offline-testable.
 */
export function assessBuildPure(input: AssessBuildInput): BuildWarning[] {
  const out: BuildWarning[] = [];
  const actions = input.actions ?? [];
  const govPool = lower(input.govPool);

  actions.forEach((a, index) => {
    const data = typeof a?.data === "string" ? a.data : "";
    const executor = typeof a?.executor === "string" ? a.executor : "";

    // --- action.zero-executor -------------------------------------------
    // `isAddress(ZeroAddress)` is true, so every `if (!isAddress(x))` guard in
    // the builders waves 0x000…0 through. GovPool.execute runs an action with a
    // raw `executor.call{value:…}(data)` and reverts only on `!status`
    // (GovPoolExecute.sol:60-68) — a call to an address with NO CODE returns
    // status=true. The proposal passes, is marked Executed, and does nothing,
    // with no revert receipt to diagnose from; any `value` attached is burned.
    // Hard, because no override can make a zero target work.
    if (executor.toLowerCase() === ZERO) {
      out.push(
        ({
          code: "action.zero-executor",
          severity: "DANGER",
          block: "hard",
          actionIndex: index,
          message:
            `actionsOnFor[${index}].executor is the zero address. GovPool.execute uses a raw .call, which ` +
            `SUCCEEDS against an address with no code (GovPoolExecute.sol:60-68) — this proposal would pass ` +
            `its vote, be marked Executed, and do nothing, with no revert receipt to diagnose. Any value or ` +
            `approval attached to it is lost.`,
          remedy:
            "Supply the real contract address for this action (dexe_dao_info resolves a DAO's helpers; " +
            "a zero StakingProposal means it is not deployed yet — call GovUserKeeper.deployStakingProposal first).",
        }),
      );
    }

    if (!data.startsWith("0x") || data.length < 10) return;

    // --- dangerous.selector ---------------------------------------------
    // Hard block, no override — the posture src/lib/dangerousSelectors.ts has
    // always published. Re-expressed here so it reaches all 30 builders instead
    // of the 2 that remembered to call it.
    const forbidden = findForbiddenSelector(data);
    if (forbidden) {
      out.push(
        ({
          code: "dangerous.selector",
          severity: "DANGER",
          block: "hard",
          actionIndex: index,
          message: dangerousSelectorError(forbidden, executor || undefined),
          remedy: "Remove this action. There is no override for a privileged GovUserKeeper accounting call.",
        }),
      );
    }

    // --- settings.bounds -------------------------------------------------
    for (const s of settingsInCalldata(data)) {
      for (const v of govSettingsBoundViolations(s)) {
        const { message, remedy } = boundsMessage(v, index);
        out.push(
          ({
            code: "settings.bounds",
            severity: "DANGER",
            block: "confirmable",
            actionIndex: index,
            message,
            remedy,
          }),
        );
      }
    }

    // --- tier.vesting-blocked (upstream F15) ------------------------------
    for (const t of decodeCreateTiersVesting(data)) {
      out.push(
        ({
          code: "tier.vesting-blocked",
          severity: "DANGER",
          block: "confirmable",
          actionIndex: index,
          id: VESTING_WITHDRAW_ADVISORY.id,
          upstream: VESTING_WITHDRAW_ADVISORY.upstream,
          message:
            `${VESTING_WITHDRAW_ADVISORY.text} Carried by actionsOnFor[${index}]: tier[${t.index}] ` +
            `"${renderUntrusted(t.name, 40)}" has vestingPercentage=${t.vestingPercentage}.`,
          remedy:
            'Set vestingSettings.vestingPercentage to "0" on that tier — buyers then receive the whole ' +
            "allocation through `claim`, which works. To open it anyway on a known pre-SphereX pool, re-run " +
            "with acknowledgeVestingBlocked: true (OTC/token-sale tools) or confirmRisky: true (composites).",
        }),
      );
    }

    // --- blacklist.self-harm (tier 1: no RPC) -----------------------------
    for (const target of decodeBlacklistAdditions(data)) {
      const t = target.toLowerCase();
      const isToken = executor.toLowerCase() === t;
      const isPool = govPool !== null && t === govPool;
      if (!isToken && !isPool) continue;
      out.push(
        ({
          code: "blacklist.self-harm",
          severity: "WARN",
          block: "none",
          actionIndex: index,
          message: isPool
            ? `actionsOnFor[${index}] blacklists ${target}, this DAO's own GovPool. ` +
              `ERC20Gov._beforeTokenTransfer reverts on any transfer whose from OR to is blacklisted ` +
              `(ERC20Gov.sol:91-102), so the treasury could never transfer this token out again. Deposits ` +
              `are unaffected (they transfer into the GovUserKeeper), so this IS reversible by a follow-up ` +
              `proposal that un-blacklists it.`
            : `actionsOnFor[${index}] blacklists ${target}, which is the token contract executing the call. ` +
              `A token cannot be its own transfer counterparty, so this entry does nothing.`,
          remedy: `Remove ${target} from addAddresses unless the freeze is deliberate.`,
        }),
      );
    }

    // --- approve.target (locally decidable half) --------------------------
    const approve = approveInCalldata(data);
    if (approve && govPool !== null && approve.spender.toLowerCase() === govPool) {
      out.push(
        ({
          code: "approve.target",
          severity: "DANGER",
          block: "hard",
          actionIndex: index,
          message:
            `ERC20.approve must target this DAO's GovUserKeeper, not its GovPool (${input.govPool}). ` +
            `GovUserKeeper.depositTokens pulls the deposit with transferFrom into the GovUserKeeper ` +
            `(GovUserKeeper.sol:100-112) — the GovPool is never the ERC20 spender, so this allowance can ` +
            `never be used and the deposit still reverts "ERC20: insufficient allowance".`,
          remedy:
            "Re-call with spender = the DAO's GovUserKeeper (dexe_dao_info → helpers.userKeeper). " +
            "Omit `govPool` if you deliberately want the raw encode.",
        }),
      );
    }
  });

  // --- upstream #36 — chain-keyed, selector-keyed --------------------------
  const trap = checkAddSettingsTrap({ chainId: input.chainId, actions });
  if (trap.blocked && trap.advisory) {
    const where = trap.actionIndices.map((i) => `actionsOnFor[${i}]`).join(", ");
    out.push(
      forAssumedChain(
        ({
          code: "upstream.add-settings-chain",
          severity: "DANGER",
          block: "confirmable",
          actionIndex: trap.actionIndices[0],
          id: trap.advisory.id,
          upstream: trap.advisory.upstream,
          message: `${trap.advisory.text} Carried by ${where}.`,
          remedy:
            "Pass settingsIds so the proposal targets editSettings (always allowed), or build for chainId 56.",
        }),
        input.chainIdExplicit,
        input.chainId,
      ),
    );
  }

  // --- treasury.risk — ALWAYS block:"none" (project rule) ------------------
  if ((input.treasuryGuard ?? "warn") !== "off") {
    const hits = classifyTreasuryActions(
      actions.map((a) => ({
        executor: typeof a?.executor === "string" ? a.executor : "",
        value: typeof a?.value === "string" ? a.value : "0",
        data: typeof a?.data === "string" ? a.data : "0x",
      })),
    );
    if (hits.length > 0) {
      out.push(
        ({
          code: "treasury.risk",
          severity: "WARN",
          block: "none",
          message: TREASURY_RISK_ADVISORY,
          remedy: "Run dexe_proposal_risk_assess for the quorum + balance readout before voting.",
        }),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// PHASE B — context, best-effort, never blocks
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 200;
const contextCache = new Map<string, { v: unknown; t: number }>();

function cacheGet(key: string): unknown | undefined {
  const hit = contextCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    contextCache.delete(key);
    return undefined;
  }
  return hit.v;
}

function cacheSet(key: string, v: unknown): void {
  if (contextCache.size >= CACHE_MAX) {
    const oldest = contextCache.keys().next();
    if (!oldest.done) contextCache.delete(oldest.value);
  }
  contextCache.set(key, { v, t: Date.now() });
}

/** Test seam — clears the 30 s context cache. */
export function resetBuildContextCache(): void {
  contextCache.clear();
}

const GOV_POOL_HELPERS_IFACE = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
]);
const ERC20_READ_IFACE = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export interface AssessBuildContextInput extends AssessBuildInput {
  cfg: DexeConfig;
  /** Injected for tests; defaults to the config's provider for `chainId`. */
  provider?: JsonRpcProvider;
}

const UNAVAILABLE_CODE = "context.unavailable";

function unavailable(chainId: number, reason: string): BuildWarning {
  return {
    code: UNAVAILABLE_CODE,
    severity: "INFO",
    block: "none",
    message:
      `Balance / helper-address / codeless-executor context could not be read on chain ${chainId} ` +
      `(${reason}) — those checks did not run. The calldata itself was still fully checked.`,
    remedy: "Set a working RPC for this chain (dexe_doctor) and rebuild if you want those checks.",
  };
}

/**
 * The context half. One multicall + one `getCode` batch, cached for 30 s so a
 * composite that builds and then re-reads pays one round trip, not two.
 *
 * Contract: NEVER throws, NEVER emits `block: "hard"`, and emits at most one
 * `context.unavailable` INFO. A caller that gets `[]` back has lost nothing —
 * the pure pass already ran.
 */
export async function assessBuildContext(input: AssessBuildContextInput): Promise<BuildWarning[]> {
  const out: BuildWarning[] = [];
  const actions = input.actions ?? [];
  if (actions.length === 0) return out;

  let provider: JsonRpcProvider;
  if (input.provider) {
    provider = input.provider;
  } else {
    let resolved: JsonRpcProvider | null = null;
    let reason = "no RPC configured";
    try {
      const pr = new RpcProvider(input.cfg).tryProvider(input.chainId);
      if ("error" in pr) reason = pr.error;
      else resolved = pr.ok;
    } catch (e) {
      reason = safeErrorMessage(e);
    }
    if (!resolved) {
      // Only worth saying when there was actually something to look up.
      return needsContext(actions, input) ? [unavailable(input.chainId, reason)] : [];
    }
    provider = resolved;
  }

  try {
    return await assessContextInner(provider, input, actions, out);
  } catch (e) {
    return needsContext(actions, input)
      ? [...out, unavailable(input.chainId, safeErrorMessage(e))]
      : out;
  }
}

/** True when at least one context check would have had something to say. */
function needsContext(actions: readonly AssessableAction[], input: AssessBuildInput): boolean {
  if (input.govPool && actions.some((a) => typeof a?.data === "string" && decodeBlacklistAdditions(a.data).length > 0))
    return true;
  if (
    input.govPool &&
    classifyTreasuryActions(
      actions.map((a) => ({
        executor: typeof a?.executor === "string" ? a.executor : "",
        value: typeof a?.value === "string" ? a.value : "0",
        data: typeof a?.data === "string" ? a.data : "0x",
      })),
    ).length > 0
  )
    return true;
  return false;
}

async function assessContextInner(
  provider: JsonRpcProvider,
  input: AssessBuildContextInput,
  actions: readonly AssessableAction[],
  out: BuildWarning[],
): Promise<BuildWarning[]> {
  const govPool = input.govPool;
  const chainId = input.chainId;

  const normalized = actions.map((a) => ({
    executor: typeof a?.executor === "string" ? a.executor : "",
    value: typeof a?.value === "string" ? a.value : "0",
    data: typeof a?.data === "string" ? a.data : "0x",
  }));
  const hits = classifyTreasuryActions(normalized);

  // ---- one multicall: helpers + gov token + per-token balance/supply/decimals
  const calls: Call[] = [];
  const slots: { kind: "helpers" | "token" | "erc20"; token?: string }[] = [];
  if (govPool && isAddress(govPool)) {
    calls.push({ target: govPool, iface: GOV_POOL_HELPERS_IFACE, method: "getHelperContracts", args: [], allowFailure: true });
    slots.push({ kind: "helpers" });
  }
  const erc20Executors = [
    ...new Set(
      hits
        .filter((h) => h.kind !== "nativeValue" && h.kind !== "nftTransfer" && isAddress(h.executor))
        .map((h) => h.executor),
    ),
  ];
  if (govPool && isAddress(govPool)) {
    for (const t of erc20Executors) {
      calls.push({ target: t, iface: ERC20_READ_IFACE, method: "balanceOf", args: [govPool], allowFailure: true });
      calls.push({ target: t, iface: ERC20_READ_IFACE, method: "totalSupply", args: [], allowFailure: true });
      calls.push({ target: t, iface: ERC20_READ_IFACE, method: "decimals", args: [], allowFailure: true });
      calls.push({ target: t, iface: ERC20_READ_IFACE, method: "symbol", args: [], allowFailure: true });
      slots.push({ kind: "erc20", token: t });
    }
  }

  let helpers: string[] | null = null;
  const balances = new Map<string, { balance: bigint; totalSupply: bigint | null; decimals: number | null; symbol: string | null }>();

  if (calls.length > 0) {
    const key = `${chainId}:${govPool ?? "-"}:ctx:${erc20Executors.join(",")}`;
    const cached = cacheGet(key) as
      | { helpers: string[] | null; balances: [string, { balance: string; totalSupply: string | null; decimals: number | null; symbol: string | null }][] }
      | undefined;
    if (cached) {
      helpers = cached.helpers;
      for (const [t, v] of cached.balances) {
        balances.set(t, {
          balance: BigInt(v.balance),
          totalSupply: v.totalSupply === null ? null : BigInt(v.totalSupply),
          decimals: v.decimals,
          symbol: v.symbol,
        });
      }
    } else {
      const res = await multicall(provider, calls);
      let i = 0;
      for (const slot of slots) {
        if (slot.kind === "helpers") {
          const r = res[i++];
          if (r?.success) {
            const v = r.value as unknown as Record<string, string>;
            helpers = [v.settings, v.userKeeper, v.validators, v.poolRegistry, v.votePower].filter(
              (a): a is string => typeof a === "string",
            );
          }
        } else if (slot.kind === "erc20" && slot.token) {
          const bal = res[i++];
          const sup = res[i++];
          const dec = res[i++];
          const sym = res[i++];
          if (bal?.success) {
            balances.set(slot.token, {
              balance: bal.value as bigint,
              totalSupply: sup?.success ? (sup.value as bigint) : null,
              decimals: dec?.success ? Number(dec.value) : null,
              symbol: sym?.success ? String(sym.value) : null,
            });
          }
        }
      }
      cacheSet(key, {
        helpers,
        balances: [...balances.entries()].map(([t, v]) => [
          t,
          {
            balance: v.balance.toString(),
            totalSupply: v.totalSupply === null ? null : v.totalSupply.toString(),
            decimals: v.decimals,
            symbol: v.symbol,
          },
        ]),
      });
    }
  }

  // ---- blacklist.protocol-address (tier 2) --------------------------------
  if (helpers && govPool) {
    const roles: Record<string, string> = {};
    const names = ["GovSettings", "GovUserKeeper", "GovValidators", "PoolRegistry", "VotePower"];
    helpers.forEach((h, idx) => {
      if (typeof h === "string" && h.toLowerCase() !== ZERO) roles[h.toLowerCase()] = names[idx] ?? "helper";
    });
    normalized.forEach((a, index) => {
      for (const target of decodeBlacklistAdditions(a.data)) {
        const role = roles[target.toLowerCase()];
        if (!role) continue;
        const isKeeper = role === "GovUserKeeper";
        out.push({
          code: "blacklist.protocol-address",
          severity: "DANGER",
          block: "confirmable",
          actionIndex: index,
          message: isKeeper
            ? `actionsOnFor[${index}] blacklists ${target}, this DAO's GovUserKeeper. ` +
              `ERC20Gov._beforeTokenTransfer reverts on any transfer whose from OR to is blacklisted ` +
              `(ERC20Gov.sol:91-102), and GovUserKeeper.depositTokens transfers INTO the UserKeeper — so every ` +
              `deposit and every withdrawal would revert permanently. No NEW voting power could ever be acquired, ` +
              `so only holders who have ALREADY deposited could pass the proposal that un-blacklists it.`
            : `actionsOnFor[${index}] blacklists ${target}, this DAO's ${role}. Blacklisting the DAO's own ` +
              `protocol contracts is never part of a legitimate blacklist proposal and is almost always a ` +
              `mis-pasted address.`,
          remedy: `Remove ${target} from addAddresses. If this is deliberate, re-run with confirmRisky: true.`,
        });
      }
    });
  }

  // ---- treasury.over-balance / over-allowance (always advisory) -----------
  if (govPool && (input.treasuryGuard ?? "warn") !== "off") {
    out.push(...overBalanceWarnings(hits, balances, govPool));
  }

  // ---- action.codeless-executor ------------------------------------------
  const probeTargets = [
    ...new Set(
      normalized
        .filter((a) => a.data !== "0x" && isAddress(a.executor) && a.executor.toLowerCase() !== ZERO)
        .map((a) => a.executor),
    ),
  ];
  if (probeTargets.length > 0) {
    const codes = await Promise.all(
      probeTargets.map(async (t) => {
        const key = `${chainId}:${t.toLowerCase()}:code`;
        const cached = cacheGet(key);
        if (typeof cached === "string") return [t, cached] as const;
        try {
          const c = await provider.getCode(t);
          cacheSet(key, c);
          return [t, c] as const;
        } catch {
          return [t, null] as const;
        }
      }),
    );
    const codeless = new Set(
      codes.filter(([, c]) => typeof c === "string" && /^0x0*$/i.test(c)).map(([t]) => t.toLowerCase()),
    );
    normalized.forEach((a, index) => {
      if (!codeless.has(a.executor.toLowerCase())) return;
      out.push({
        code: "action.codeless-executor",
        severity: "WARN",
        block: "none",
        actionIndex: index,
        message:
          `actionsOnFor[${index}].executor ${a.executor} has no contract code on chain ${chainId}. ` +
          `GovPool.execute uses a raw .call, which SUCCEEDS against a codeless address — the proposal would ` +
          `pass, be marked Executed, and do nothing. The usual cause is an address copied from another chain.`,
        remedy: `Verify the address exists on chain ${chainId} before voting (dexe_dao_info / a block explorer).`,
      });
    });
  }

  return out;
}

function overBalanceWarnings(
  hits: readonly TreasuryHit[],
  balances: ReadonlyMap<string, { balance: bigint; totalSupply: bigint | null; decimals: number | null; symbol: string | null }>,
  govPool: string,
): BuildWarning[] {
  const out: BuildWarning[] = [];
  // Per token, sum the OUTFLOW kinds. Allowances are scored per action: an
  // over-balance approve does not revert, it authorises a standing drain.
  const outflow = new Map<string, { total: bigint; indices: number[] }>();
  for (const h of hits) {
    const token = h.executor?.toLowerCase();
    // ERC721 shares selector 0x23b872dd with ERC20 transferFrom and its
    // "amount" is a tokenId — a token whose decimals() failed is skipped, which
    // is the cheap discriminator that stops an NFT-count comparison.
    if (!token || h.amount === null) continue;
    const row = balances.get(h.executor);
    if (!row || row.decimals === null) continue;
    const amount = (() => {
      try {
        return BigInt(h.amount);
      } catch {
        return null;
      }
    })();
    if (amount === null) continue;
    const fmt = (v: bigint) => formatAmount(v, row.decimals ?? 18, row.symbol ? renderUntrusted(row.symbol, 40) : undefined);

    if (h.kind === "approve" || h.kind === "increaseAllowance") {
      if (amount <= row.balance) continue;
      out.push({
        code: "treasury.over-allowance",
        severity: "WARN",
        block: "none",
        actionIndex: h.index,
        message:
          `actionsOnFor[${h.index}] approves ${fmt(amount)} to ${h.recipient ?? "a spender"} but the treasury ` +
          `(${govPool}) holds ${fmt(row.balance)}. This does NOT revert — approve succeeds regardless of ` +
          `balance — it authorises that spender to take every unit the treasury holds now and everything it ` +
          `ever receives.`,
        remedy: "Approve only the amount the spend actually needs.",
      });
      continue;
    }
    if (h.kind !== "transfer") continue;
    const cur = outflow.get(h.executor) ?? { total: 0n, indices: [] };
    cur.total += amount;
    cur.indices.push(h.index);
    outflow.set(h.executor, cur);
  }

  for (const [token, agg] of outflow) {
    const row = balances.get(token);
    if (!row || row.decimals === null) continue;
    if (agg.total <= row.balance) continue;
    const fmt = (v: bigint) => formatAmount(v, row.decimals ?? 18, row.symbol ? renderUntrusted(row.symbol, 40) : undefined);
    const supplyHint =
      row.totalSupply !== null && agg.total > row.totalSupply
        ? ` — this also exceeds the token's entire supply (${fmt(row.totalSupply)}), so it is almost certainly a ` +
          `decimals mistake: 1,000 units is "1${"0".repeat(row.decimals)}" wei.`
        : "";
    out.push({
      code: "treasury.over-balance",
      severity: "WARN",
      block: "none",
      actionIndex: agg.indices[0],
      message:
        `actionsOnFor[${agg.indices.join(", ")}] transfer ${fmt(agg.total)} but the treasury (${govPool}) ` +
        `holds ${fmt(row.balance)}${supplyHint}. Unless an earlier action in this same proposal funds the ` +
        `treasury first, ERC20.transfer reverts and GovPool.execute reverts with it — the proposal stays ` +
        `SucceededFor and can be executed again once the treasury is funded, but the gas and the round trip ` +
        `are spent.`,
      remedy: `Lower the amount to ≤ ${row.balance.toString()} wei, or fund the treasury first (confirm with dexe_read_treasury).`,
    });
  }
  return out;
}

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

export type { WarningSeverity, WarningBlock };
export { TOKEN_SALE_CREATE_TIERS_SELECTOR, BLACKLIST_SELECTOR };
