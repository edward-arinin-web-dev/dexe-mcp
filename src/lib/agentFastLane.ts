import { Interface, getAddress, isAddress, parseUnits, ZeroAddress } from "ethers";
import { safeErrorMessage } from "./redact.js";
import {
  AGENT_FAST_LANE_ABI,
  AGENT_FAST_LANE_ADMIN_ABI,
  AGENT_FAST_LANE_BYTECODE,
  AGENT_FAST_LANE_SOLC,
  AGENT_FAST_LANE_SOURCE_SHA256,
} from "./abi/agentFastLane.generated.js";

/**
 * The agent treasury's FAST LANE: pure helpers around contracts/AgentFastLane.sol.
 *
 * A DeXe GovPool picks a proposal's voting settings by the executor of its
 * last action and asks that executor `validate(actions)` (30 000-gas
 * staticcall) before creating the proposal. The lane is registered at deploy
 * as an extra executor with its own settings slot — short vote, no validator
 * round — so a small, allowlisted payment needs only the agents' k-of-n vote.
 * The lane bounds what that path can move (per payment, per rolling 30 days,
 * allowlisted recipients) both at creation (`validate`) and at execution
 * (`pay`). The allowlist and the float are changed only through the lane's
 * `admin` child, a different address, so those proposals take the slow lane.
 *
 * TESTNET ONLY (BSC testnet, chain 97). The contract is unaudited.
 */

export const FAST_LANE_CHAIN_ID = 97;
export const FAST_LANE_MAX_ACTIONS = 3;
export const FAST_LANE_WINDOW_DAYS = 30;
/** `validate` reads at most this many expired, non-empty day buckets (gas budget). */
export const FAST_LANE_VALIDATE_SETTLE_READS = 3;

export const FAST_LANE_SOLC = AGENT_FAST_LANE_SOLC;
export const FAST_LANE_SOURCE_SHA256 = AGENT_FAST_LANE_SOURCE_SHA256;
export const FAST_LANE_ABI = AGENT_FAST_LANE_ABI;
export const FAST_LANE_ADMIN_ABI = AGENT_FAST_LANE_ADMIN_ABI;
export const FAST_LANE_BYTECODE = AGENT_FAST_LANE_BYTECODE;

export const laneIface = new Interface(AGENT_FAST_LANE_ABI as unknown as string[]);
export const laneAdminIface = new Interface(AGENT_FAST_LANE_ADMIN_ABI as unknown as string[]);
export const PAY_SIGNATURE = "function pay(address to, uint256 amount)";
export const PAY_SELECTOR = laneIface.getFunction("pay")!.selector;

/** Refuses every chain but BSC testnet. The reason is the message for the caller. */
export function fastLaneChainRefusal(chainId: number): string | undefined {
  if (chainId === FAST_LANE_CHAIN_ID) return undefined;
  const mainnet = chainId === 56 || chainId === 1;
  return (
    `The agent fast lane is TESTNET ONLY: AgentFastLane.sol is unaudited and ships for BSC testnet (chain 97). ` +
    `Refusing chain ${chainId}${mainnet ? " (MAINNET)" : ""}. Nothing was deployed or signed.`
  );
}

export interface FastLaneConfig {
  /** Largest single payment, wei of the lane token. */
  perPaymentCapWei: bigint;
  /** Largest total over any rolling 30-day window, wei. */
  windowCapWei: bigint;
  /** Recipients allowed from the start (checksummed, distinct, non-zero). */
  allowlist: string[];
  /** Voting duration of the fast slot, seconds. */
  voteSeconds: number;
}

export interface FastLaneInput {
  perPaymentCap: string;
  windowCap: string;
  allowlist: string[];
  voteSeconds: number;
  /** Decimals of the lane token (18 for a freshly minted gov token). */
  decimals?: number;
}

export type FastLaneConfigResult = { ok: true; config: FastLaneConfig } | { ok: false; reason: string };

const UINT160_MAX = (1n << 160n) - 1n;

/** Validates and normalises the preset's `fastLane` block. Pure. */
export function resolveFastLaneConfig(input: FastLaneInput): FastLaneConfigResult {
  const decimals = input.decimals ?? 18;
  let perPaymentCapWei: bigint;
  let windowCapWei: bigint;
  try {
    perPaymentCapWei = parseUnits(input.perPaymentCap, decimals);
    windowCapWei = parseUnits(input.windowCap, decimals);
  } catch (e) {
    return { ok: false, reason: `fastLane caps: ${safeErrorMessage(e)}` };
  }
  if (perPaymentCapWei <= 0n) return { ok: false, reason: "fastLane.perPaymentCap must be > 0." };
  if (perPaymentCapWei > windowCapWei) {
    return {
      ok: false,
      reason:
        `fastLane.perPaymentCap (${input.perPaymentCap}) exceeds fastLane.windowCap (${input.windowCap}); ` +
        `a single payment can never exceed the 30-day total.`,
    };
  }
  if (windowCapWei > UINT160_MAX) return { ok: false, reason: "fastLane.windowCap is too large (max 2^160 − 1 wei)." };
  if (input.allowlist.length === 0) {
    return { ok: false, reason: "fastLane.allowlist needs at least one recipient; only the slow lane can add more." };
  }
  const seen = new Set<string>();
  const allowlist: string[] = [];
  for (const [i, a] of input.allowlist.entries()) {
    if (!isAddress(a)) return { ok: false, reason: `fastLane.allowlist[${i}]: invalid address ${a}` };
    const cs = getAddress(a);
    if (cs === ZeroAddress) return { ok: false, reason: `fastLane.allowlist[${i}]: the zero address` };
    if (seen.has(cs)) return { ok: false, reason: `fastLane.allowlist[${i}]: duplicate ${cs}` };
    seen.add(cs);
    allowlist.push(cs);
  }
  if (!Number.isInteger(input.voteSeconds) || input.voteSeconds <= 0) {
    return { ok: false, reason: "fastLane.voteSeconds must be a positive integer." };
  }
  return { ok: true, config: { perPaymentCapWei, windowCapWei, allowlist, voteSeconds: input.voteSeconds } };
}

/** Constructor args in ABI order: (govPool, token, perPaymentCap, windowCap, initialAllowlist). */
export function laneConstructorArgs(govPool: string, token: string, cfg: FastLaneConfig): unknown[] {
  return [getAddress(govPool), getAddress(token), cfg.perPaymentCapWei, cfg.windowCapWei, cfg.allowlist];
}

/** Creation calldata (bytecode + encoded constructor args) for a CREATE transaction. */
export function encodeLaneDeploy(govPool: string, token: string, cfg: FastLaneConfig): string {
  return AGENT_FAST_LANE_BYTECODE + laneIface.encodeDeploy(laneConstructorArgs(govPool, token, cfg)).slice(2);
}

/**
 * The settings slot the lane runs under: the member (agent) quorum and
 * min-votes of the base slot, a short vote, early completion, NO validator
 * round. `durationValidators` is kept non-zero because
 * GovSettings validates it on every slot, even one that never reaches the
 * validators.
 */
export function fastLaneSettings<
  S extends {
    earlyCompletion: boolean;
    delegatedVotingAllowed: boolean;
    validatorsVote: boolean;
    duration: string;
    durationValidators: string;
    executorDescription: string;
  },
>(base: S, voteSeconds: number): S {
  return {
    ...base,
    earlyCompletion: true,
    validatorsVote: false,
    duration: String(voteSeconds),
    durationValidators: BigInt(base.durationValidators || "0") > 0n ? base.durationValidators : base.duration,
    executorDescription: "",
  };
}

/** One `pay` action for a proposal (executor = the lane, value 0). */
export function encodePayAction(lane: string, to: string, amountWei: bigint): { executor: string; value: string; data: string } {
  return {
    executor: getAddress(lane),
    value: "0",
    data: laneIface.encodeFunctionData("pay", [getAddress(to), amountWei]),
  };
}

/** The `dexe_proposal_create` call (custom_abi) that pays `to` through the lane. */
export function payProposalRecipe(args: {
  govPool: string;
  chainId: number;
  lane: string;
  to: string;
  amountWei: bigint;
  amountHuman?: string;
  title?: string;
}): Record<string, unknown> {
  return {
    tool: "dexe_proposal_create",
    args: {
      govPool: args.govPool,
      chainId: args.chainId,
      proposalType: "custom_abi",
      title: args.title ?? `Fast lane: pay ${args.amountHuman ?? `${args.amountWei} wei`} to ${getAddress(args.to)}`,
      params: {
        target: getAddress(args.lane),
        signature: PAY_SIGNATURE,
        method: "pay",
        args: [getAddress(args.to), args.amountWei.toString()],
        value: "0",
      },
    },
    notes: [
      `The lane must be the executor of the LAST action — alone, the proposal runs under the fast slot ` +
        `(agents' vote only, no validator round). Any other executor in the list makes the lane refuse it; ` +
        `the lane last and something else before it is refused too.`,
      `At most ${FAST_LANE_MAX_ACTIONS} pay actions per proposal; each ≤ perPaymentCap and allowlisted; the ` +
        `sum must fit the rolling ${FAST_LANE_WINDOW_DAYS}-day cap.`,
      `Agents vote with dexe_proposal_vote_and_execute; with earlyCompletion the proposal executes as soon as ` +
        `k agents have voted FOR.`,
    ],
  };
}

/** What the lane guarantees, and what it does not, in plain words for the preview. */
export function fastLaneGuarantees(cfg: {
  perPaymentCap: string;
  windowCap: string;
  symbol: string;
  allowlistCount: number;
  voteSeconds: number;
}): string[] {
  return [
    `A fast-lane payment needs only the agents' k-of-n vote (duration ${cfg.voteSeconds} s, early completion, ` +
      `no validator round).`,
    `The fast lane can move at most ${cfg.perPaymentCap} ${cfg.symbol} per payment and ${cfg.windowCap} ` +
      `${cfg.symbol} per rolling ${FAST_LANE_WINDOW_DAYS} days, only to the ${cfg.allowlistCount} allowlisted ` +
      `recipient(s), and never more than the float it holds.`,
    `Both limits are enforced twice: validate() refuses the proposal at creation and pay() refuses it again ` +
      `at execution.`,
    `Changing the allowlist or recalling the float goes through the lane's admin contract — a different ` +
      `executor — so it runs under the DAO's default settings, with the human validator round.`,
    `A proposal that bundles the lane with any other action is refused by the lane (lane last) or runs under ` +
      `the default settings with the validator round (lane not last).`,
    `TESTNET ONLY: AgentFastLane.sol is unaudited (solc ${AGENT_FAST_LANE_SOLC}, source sha256 ` +
      `${AGENT_FAST_LANE_SOURCE_SHA256.slice(0, 12)}…).`,
  ];
}
