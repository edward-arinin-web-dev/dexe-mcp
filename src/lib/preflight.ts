/**
 * Preflight guards — named checks for the 10 documented recurring failure modes
 * (cross-session memory, encoded here so the model can't re-derive them wrong).
 * Each check returns `{ check, ok, remediation? }`; callers surface a failing
 * check as an actionable tool error rather than silently "fixing" it (except
 * where the flow tools already auto-fix, e.g. auto-deposit/approve).
 *
 * Failure modes covered:
 *   1  approve→deposit→create sequence skipped   → the flow composite IS the fix
 *   2  wrong proposal IPFS metadata shape        → CanonicalProposalMetadataSchema
 *   4  votingPower() vs tokenBalance confusion   → DEPOSITED_POWER_REMEDIATION
 *   5  tokens locked after vote/execute          → checkTokensUnlocked
 *   6  approves GovPool instead of UserKeeper    → checkApproveTarget
 *   7  deploy silent reverts (cap/init/asset)    → checkDeploy*
 *   9  ProposalState enum ordering mistakes      → PROPOSAL_STATE_NAMES / proposalStateName
 *   10 metadata/avatar/offchain/blacklist edges  → checkAvatar*, checkOffchain*, checkBlacklistRecipient
 */
import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import type { DexeConfig } from "../config.js";
import { checkBlacklist, blacklistError } from "./blacklist.js";
import { quorumPctFromRaw } from "./quorumRisk.js";

export interface PreflightResult {
  /** Stable check id, e.g. "deploy.cap-gt-minted". */
  check: string;
  ok: boolean;
  /** Actionable fix when `ok` is false. */
  remediation?: string;
  /** Extra context (values seen). */
  detail?: string;
}

const pass = (check: string, detail?: string): PreflightResult => ({ check, ok: true, detail });
const fail = (check: string, remediation: string, detail?: string): PreflightResult => ({
  check,
  ok: false,
  remediation,
  detail,
});

/** Return the first failing check, or null when all pass. */
export function firstFailure(results: PreflightResult[]): PreflightResult | null {
  return results.find((r) => !r.ok) ?? null;
}

/** Throw on the first failing check (used by flow tools that catch → err()). */
export function assertPreflight(results: PreflightResult[]): void {
  const bad = firstFailure(results);
  if (bad) throw new Error(`Preflight [${bad.check}] failed: ${bad.remediation}${bad.detail ? ` (${bad.detail})` : ""}`);
}

// ==========================================================================
// Mode 9 — canonical ProposalState enum (single source of truth)
// ==========================================================================

/**
 * IGovPool.ProposalState order — Voting(0), WaitingForVotingTransfer(1),
 * ValidatorVoting(2), Defeated(3), SucceededFor(4), SucceededAgainst(5),
 * Locked(6), ExecutedFor(7), ExecutedAgainst(8), Undefined(9). Hardcoding a
 * wrong order (Locked before SucceededFor) mislabels executable proposals.
 */
export const PROPOSAL_STATE_NAMES = [
  "Voting",
  "WaitingForVotingTransfer",
  "ValidatorVoting",
  "Defeated",
  "SucceededFor",
  "SucceededAgainst",
  "Locked",
  "ExecutedFor",
  "ExecutedAgainst",
  "Undefined",
] as const;

export function proposalStateName(n: number): string {
  return PROPOSAL_STATE_NAMES[n] ?? `Unknown(${n})`;
}

/** States from which a proposal is executable (post-quorum). */
export const EXECUTABLE_STATES = new Set([4, 5, 6]); // SucceededFor, SucceededAgainst, Locked

// ==========================================================================
// Mode 2 — canonical proposal metadata shape
// ==========================================================================

/**
 * Every external proposal's IPFS metadata MUST match this shape or the frontend
 * indexer/diff UI breaks. `.passthrough()` keeps type-specific extras.
 */
export const CanonicalProposalMetadataSchema = z
  .object({
    proposalName: z.string().min(1, "proposalName is required"),
    proposalDescription: z.string(),
    category: z.string().optional(),
    isMeta: z.boolean().optional(),
    changes: z
      .object({
        proposedChanges: z.record(z.unknown()),
        currentChanges: z.record(z.unknown()),
      })
      .optional(),
  })
  .passthrough();

export function checkProposalMetadata(meta: unknown): PreflightResult {
  const parsed = CanonicalProposalMetadataSchema.safeParse(meta);
  if (parsed.success) return pass("metadata.shape");
  return fail(
    "metadata.shape",
    "Proposal metadata must be { proposalName, proposalDescription, category?, isMeta?, changes:{proposedChanges,currentChanges} }. " +
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  );
}

/** Mode 1 — a non-offchain proposal with no actions is almost always a mistake. */
export function checkProposalHasActions(
  actionsOnFor: { data?: string }[],
  opts?: { allowEmpty?: boolean },
): PreflightResult {
  if (opts?.allowEmpty || actionsOnFor.length > 0) return pass("actions.present", `${actionsOnFor.length} action(s)`);
  return fail(
    "actions.present",
    "No actionsOnFor to execute. Use dexe_proposal_create with a wired proposalType (see dexe_proposal_catalog) " +
      "or pass actionsOnFor for proposalType='custom'. The composite handles approve→deposit→createProposalAndVote for you.",
  );
}

// ==========================================================================
// Mode 6 — approve UserKeeper, never GovPool
// ==========================================================================

export function checkApproveTarget(approveSpender: string, userKeeper: string, govPool: string): PreflightResult {
  if (approveSpender.toLowerCase() === userKeeper.toLowerCase()) return pass("approve.target");
  if (approveSpender.toLowerCase() === govPool.toLowerCase()) {
    return fail(
      "approve.target",
      `ERC20.approve must target UserKeeper (${userKeeper}), not GovPool (${govPool}). ` +
        "UserKeeper.transferFrom pulls the deposit; approving GovPool leaves the deposit un-pullable.",
    );
  }
  return fail(
    "approve.target",
    `ERC20.approve target ${approveSpender} is neither the DAO UserKeeper (${userKeeper}) nor GovPool. ` +
      "Approve the UserKeeper.",
  );
}

// ==========================================================================
// Mode 4 & 5 — deposited power / locked tokens
// ==========================================================================

export const DEPOSITED_POWER_REMEDIATION =
  "Deposited voting power = UserKeeper.tokenBalance(user,0).balance − ownedBalance (NOT votingPower(), which is 0 " +
  "without an active deposit). The flow composites compute this for you.";

/**
 * Mode 5 — tokens stay locked after a vote/execute until withdrawn. If a user
 * has deposited power but zero currently-available power, a fresh proposal/vote
 * will under-count. Advisory (never blocks): the flow re-reads live power.
 */
export function checkTokensUnlocked(depositedPower: bigint, availablePower: bigint): PreflightResult {
  if (depositedPower === 0n || availablePower > 0n) return pass("tokens.unlocked");
  return fail(
    "tokens.unlocked",
    "Deposited tokens appear locked from a prior vote/execute (available power = 0 while deposited > 0). " +
      "Withdraw between proposals (dexe_vote_build_withdraw) or wait for the lock to clear before re-voting.",
    `deposited=${depositedPower} available=${availablePower}`,
  );
}

// ==========================================================================
// Mode 7 — DAO deploy silent reverts
// ==========================================================================

/**
 * cap rules (verified live on BSC mainnet via eth_call, 2026-07-06):
 *   - `cap = 0` reverts — the gov token is ERC20Capped: "ERC20Capped: cap is 0".
 *     There is NO uncapped mode (the old "cap=0 = uncapped" belief was wrong).
 *   - `cap < mintedTotal` reverts: "ERC20Gov: mintedTotal should not be greater than cap".
 *   - `cap == mintedTotal` is VALID (fixed supply) — the old bug #28 ("cap==minted
 *     reverts") is outdated; it succeeds live.
 * So the rule is simply: `cap ≥ mintedTotal` and `cap > 0`.
 */
export function checkDeployCap(cap: string, mintedTotal: string, isTokenCreation: boolean): PreflightResult {
  if (!isTokenCreation) return pass("deploy.cap");
  const capBn = BigInt(cap);
  const mintedBn = BigInt(mintedTotal);
  if (capBn <= 0n) {
    return fail(
      "deploy.cap",
      `tokenParams.cap must be > 0 — the gov token is ERC20Capped and cap=0 reverts ("ERC20Capped: cap is 0"). ` +
        `There is no uncapped mode. Set cap ≥ mintedTotal (${mintedBn}); cap == mintedTotal is a valid fixed supply.`,
    );
  }
  if (capBn < mintedBn) {
    return fail(
      "deploy.cap",
      `tokenParams.cap (${capBn}) must be ≥ mintedTotal (${mintedBn}) — otherwise deployGovPool reverts ` +
        `"ERC20Gov: mintedTotal should not be greater than cap". cap == mintedTotal is allowed (fixed supply).`,
    );
  }
  return pass("deploy.cap", `cap=${capBn} minted=${mintedBn}`);
}

/** LINEAR vote power needs the `__LinearPower_init()` selector, never 0x. */
export const LINEAR_POWER_INIT_SELECTOR = "0x892aea1f";

export function checkLinearInitData(voteType: string, initData: string | undefined): PreflightResult {
  if (voteType !== "LINEAR_VOTES") return pass("deploy.linear-init");
  const d = (initData ?? "").toLowerCase();
  // Omitted / empty / "0x" is the CORRECT default: the deploy builder
  // auto-encodes __LinearPower_init() (0x892aea1f). Only a non-empty override
  // that isn't the right selector is a mistake.
  if (d === "" || d === "0x") return pass("deploy.linear-init", "auto-encoded by deploy builder");
  if (d.startsWith(LINEAR_POWER_INIT_SELECTOR)) return pass("deploy.linear-init");
  return fail(
    "deploy.linear-init",
    `LINEAR_VOTES votePower initData override '${initData}' is not the __LinearPower_init selector (${LINEAR_POWER_INIT_SELECTOR}). ` +
      "The deploy tool auto-encodes this — do NOT override initData for LINEAR; omit it.",
  );
}

/** `__PolynomialPower_init(uint256,uint256,uint256)` selector (frontend PolynomialPower.json). */
export const POLYNOMIAL_POWER_INIT_SELECTOR = "0x4064b0fa";

/**
 * CUSTOM vote power ships an operator-provided contract: the factory calls
 * `presetAddress.call(initData)` and reverts "PoolFactory: power init failed"
 * on any mismatch. Nothing else validates this path (the builder auto-encodes
 * initData only for LINEAR/POLYNOMIAL), so guard the leaves here:
 *   - CUSTOM requires a non-zero presetAddress and well-formed hex initData
 *     ("0x" is allowed — some presets are init-free).
 *   - POLYNOMIAL with a raw initData override that isn't the
 *     __PolynomialPower_init selector is a mistake (generalizes
 *     checkLinearInitData; the builder auto-encodes from coefficients).
 */
export function checkCustomVotePower(
  voteType: string,
  initData: string | undefined,
  presetAddress: string,
): PreflightResult {
  const d = (initData ?? "").toLowerCase();
  if (voteType === "CUSTOM_VOTES") {
    if (!isAddress(presetAddress) || presetAddress === ZeroAddress) {
      return fail(
        "deploy.custom-vote-power",
        "CUSTOM_VOTES requires votePowerParams.presetAddress = the deployed custom vote-power contract " +
          "(non-zero). LINEAR/POLYNOMIAL use presetAddress 0x0 and auto-encoded initData instead.",
      );
    }
    if (d !== "" && d !== "0x" && !/^0x[0-9a-f]{8,}$/.test(d)) {
      return fail(
        "deploy.custom-vote-power",
        `CUSTOM_VOTES initData '${initData}' is not valid call data (0x-prefixed hex, 4-byte selector minimum, ` +
          'or "0x" for init-free presets). The factory calls presetAddress with exactly these bytes and reverts ' +
          '"PoolFactory: power init failed" on a mismatch.',
      );
    }
    return pass("deploy.custom-vote-power");
  }
  if (voteType === "POLYNOMIAL_VOTES" && d !== "" && d !== "0x" && !d.startsWith(POLYNOMIAL_POWER_INIT_SELECTOR)) {
    return fail(
      "deploy.custom-vote-power",
      `POLYNOMIAL_VOTES initData override '${initData}' is not the __PolynomialPower_init selector ` +
        `(${POLYNOMIAL_POWER_INIT_SELECTOR}). The deploy tool auto-encodes this from polynomialCoefficients — ` +
        "do NOT override initData; omit it.",
    );
  }
  return pass("deploy.custom-vote-power");
}

/**
 * Validators-side coherence — GovValidators init (`GovValidatorsUtils.sol:63-76`)
 * requires duration > 0, 0 < quorum ≤ 1e27, and non-zero validator addresses;
 * beyond the contract, a duplicate validator or a zero balance ships a
 * governance-dead validator seat (it can never vote). Address format and
 * validators/balances length parity are checked by the deploy builder already.
 */
export function checkValidatorsCoherence(args: {
  validators: string[];
  balances: string[];
  duration: string;
  quorum: string;
}): PreflightResult {
  const bad: string[] = [];
  const dur = BigInt(args.duration);
  const q = BigInt(args.quorum);
  if (dur <= 0n) bad.push(`validatorsParams.proposalSettings.duration must be > 0 (got ${dur})`);
  if (q <= 0n || q > PERCENTAGE_100) bad.push(`validatorsParams.proposalSettings.quorum must be 0 < q ≤ 1e27 (got ${q})`);
  const seen = new Set<string>();
  args.validators.forEach((v, i) => {
    const lower = v.toLowerCase();
    if (lower === ZeroAddress) bad.push(`validators[${i}] is the zero address`);
    else if (seen.has(lower)) bad.push(`validators[${i}] (${v}) is a duplicate`);
    seen.add(lower);
    if (BigInt(args.balances[i] ?? "0") <= 0n) bad.push(`balances[${i}] is 0 — validator ${v} could never vote`);
  });
  if (bad.length === 0) return pass("deploy.validators", `${args.validators.length} validator(s)`);
  return fail(
    "deploy.validators",
    `Validator config would revert GovValidators init or ship a dead validator seat: ${bad.join("; ")}. ` +
      "(GovValidatorsUtils validateProposalSettings/validateChangeBalances; durations in seconds, quorum at 1e25-per-percent scale)",
  );
}

/** UserKeeper needs at least one non-zero governance asset (token or NFT). */
export function checkUserKeeperAsset(tokenAddress: string, nftAddress: string, isTokenCreation: boolean): PreflightResult {
  if (isTokenCreation) return pass("deploy.userkeeper-asset", "new token creation");
  const hasToken = isAddress(tokenAddress) && tokenAddress !== ZeroAddress;
  const hasNft = isAddress(nftAddress) && nftAddress !== ZeroAddress;
  if (hasToken || hasNft) return pass("deploy.userkeeper-asset");
  return fail(
    "deploy.userkeeper-asset",
    "GovUserKeeper requires a non-zero governance asset: set userKeeperParams.tokenAddress (existing ERC20), " +
      "userKeeperParams.nftAddress (existing ERC721), or tokenParams.name to create a new token.",
  );
}

/**
 * Treasury is an IMPLICIT remainder. `sum(amounts)` may be LESS than
 * `mintedTotal`: the contract mints the difference to the DAO (govPool) itself.
 * This is the frontend's proven pattern (`useCreateDAO.ts` — `users`/`amounts`
 * cover only the wallet distribution; the treasury is never an explicit
 * recipient), shipped to BSC mainnet daily. The earlier "mainnet needs
 * mintedTotal == sum(amounts)" belief (old bug #32) was wrong and forced the
 * treasury address into `users[]`. Only OVER-distribution (sum > minted) is
 * invalid. See also `checkNoTreasuryRecipient`.
 */
export function checkTreasuryRemainder(
  mintedTotal: string,
  amounts: string[],
  isTokenCreation: boolean,
): PreflightResult {
  if (!isTokenCreation) return pass("deploy.treasury-remainder");
  const minted = BigInt(mintedTotal);
  const sum = amounts.reduce((a, b) => a + BigInt(b), 0n);
  if (sum > minted) {
    return fail(
      "deploy.treasury-remainder",
      `sum(amounts) (${sum}) exceeds tokenParams.mintedTotal (${minted}) — cannot distribute more than the total ` +
        "mint. Lower the recipient amounts or raise mintedTotal.",
      `over=${sum - minted}`,
    );
  }
  return pass("deploy.treasury-remainder", `treasuryRemainder=${minted - sum}`);
}

// ==========================================================================
// DAO governance coherence — frontend parity (never ship a broken/unusable DAO)
// ==========================================================================
//
// The frontend (C:/dev/investing-dashboard, source of truth) BLOCKS DAO configs
// where governance can never function. dexe-mcp had none of these, so the model
// could (and did) ship a DAO whose quorum was unreachable or whose treasury was
// jammed into the voter list. These guards mirror the frontend's create-DAO
// validation (`DefaultProposalStep`, `TokenCreationStep`, `GovSettings.sol`).

/** DeXe percentage base: 100% = 1e27 (a quorum setting is pct × 1e25). */
const PERCENTAGE_100 = 10n ** 27n;

/**
 * Meritocratic (polynomial) voting power for `votes` at a given `totalSupply`,
 * ported from the frontend `calcMeritocraticVotingPower`
 * (`utils/votePowerMath.ts`) with the default holder coefficient k3 = 0.97.
 * Below the 7%-of-supply threshold, power is linear (== votes); above it the
 * cubic curve applies. Token-amount math stays in bigint (wei); only the
 * dimensionless percentage `t` uses float, at 6-decimal precision.
 */
export function meritocraticVotingPower(votes: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return votes;
  const threshold = (totalSupply * 7n) / 100n - 7n;
  if (votes < threshold) return votes;
  // t = (votes/totalSupply)×100 − 7, in percentage points, 6-dec precision.
  const t = Number((votes * 1_000_000n) / totalSupply) / 1_000_000 * 100 - 7;
  let poly = t * 1.041 + t * t * -0.007211 + t * t * t * 0.00001994;
  poly = poly * 0.97; // k3 (holders)
  // power above threshold = poly% of totalSupply (poly scaled ×1e6 to stay integer).
  const aboveWei = (BigInt(Math.round(poly * 1_000_000)) * totalSupply) / (100n * 1_000_000n);
  const above = aboveWei > 0n ? aboveWei : 0n;
  return above + threshold;
}

/**
 * Quorum must be REACHABLE by the votable (wallet-held) token distribution —
 * treasury/undistributed tokens can't vote. Mirrors the frontend's blocking
 * `isLteThanInitialDistribution` (LINEAR) / `isDistributionCanReachQuorum`
 * (POLYNOMIAL). Token-creation only (an external token's supply/distribution
 * is unknown at deploy time, so the frontend skips it too).
 */
export function checkQuorumReachable(args: {
  voteType: string;
  quorumRaw: string;
  mintedTotal: string;
  votable: string;
  isTokenCreation: boolean;
}): PreflightResult {
  if (!args.isTokenCreation) return pass("deploy.quorum-reachable", "external token");
  const quorum = BigInt(args.quorumRaw);
  const supply = BigInt(args.mintedTotal);
  const votable = BigInt(args.votable);
  if (supply <= 0n) return pass("deploy.quorum-reachable", "no supply");
  const quorumInTokens = (quorum * supply) / PERCENTAGE_100;
  const power = args.voteType === "POLYNOMIAL_VOTES" ? meritocraticVotingPower(votable, supply) : votable;
  if (power >= quorumInTokens) {
    return pass("deploy.quorum-reachable", `quorumTokens=${quorumInTokens} ≤ votablePower=${power}`);
  }
  const quorumPct = quorumPctFromRaw(args.quorumRaw);
  const reachablePct = Number((power * 10000n) / supply) / 100;
  return fail(
    "deploy.quorum-reachable",
    `Quorum ${quorumPct}% is UNREACHABLE: it requires ${quorumInTokens} vote-power but the votable token ` +
      `distribution only provides ${power} (~${reachablePct}% of supply). Treasury/undistributed tokens cannot ` +
      `vote. Fix: lower quorum to ≤ ${reachablePct}%, distribute more tokens to voters, or shrink the treasury ` +
      `share. The frontend blocks this exact config (DefaultProposalStep isLteThanInitialDistribution).`,
    `voteType=${args.voteType}`,
  );
}

/**
 * `minVotesForVoting` / `minVotesForCreating` must not exceed the largest single
 * recipient's balance — otherwise no holder can ever create or vote. Mirrors the
 * frontend `value-lower-than-distribution` rule. Token-creation only.
 */
export function checkMinVotesVsDistribution(
  minVotesForVoting: string,
  minVotesForCreating: string,
  amounts: string[],
  isTokenCreation: boolean,
): PreflightResult {
  if (!isTokenCreation || amounts.length === 0) return pass("deploy.min-votes");
  const largest = amounts.reduce((m, a) => (BigInt(a) > m ? BigInt(a) : m), 0n);
  const bad: string[] = [];
  if (BigInt(minVotesForVoting) > largest) bad.push(`minVotesForVoting (${minVotesForVoting})`);
  if (BigInt(minVotesForCreating) > largest) bad.push(`minVotesForCreating (${minVotesForCreating})`);
  if (bad.length === 0) return pass("deploy.min-votes", `largestRecipient=${largest}`);
  return fail(
    "deploy.min-votes",
    `${bad.join(" and ")} exceed the largest single recipient's balance (${largest}). No holder could then create ` +
      "or vote on a proposal. Set these ≤ the biggest voter's token balance (frontend: value-lower-than-distribution).",
  );
}

/**
 * Contract-level init bounds (`GovSettings.sol:94-106`, `GovValidators.sol`):
 * `0 < quorum ≤ 1e27`, `0 < quorumValidators ≤ 1e27`, `duration > 0`,
 * `durationValidators > 0`. Violations revert `deployGovPool` with an empty
 * reason — catch them here with a readable message.
 */
export function checkSettingsBounds(s: {
  quorum: string;
  quorumValidators: string;
  duration: string;
  durationValidators: string;
}): PreflightResult {
  const q = BigInt(s.quorum);
  const qv = BigInt(s.quorumValidators);
  const d = BigInt(s.duration);
  const dv = BigInt(s.durationValidators);
  const bad: string[] = [];
  if (q <= 0n || q > PERCENTAGE_100) bad.push(`quorum must be 0 < q ≤ 1e27 (got ${q})`);
  if (qv <= 0n || qv > PERCENTAGE_100) bad.push(`quorumValidators must be 0 < q ≤ 1e27 (got ${qv})`);
  if (d <= 0n) bad.push(`duration must be > 0 (got ${d})`);
  if (dv <= 0n) bad.push(`durationValidators must be > 0 (got ${dv})`);
  if (bad.length === 0) return pass("deploy.settings-bounds");
  return fail("deploy.settings-bounds", `GovSettings/GovValidators init would revert: ${bad.join("; ")}.`);
}

/**
 * The DAO treasury (predicted govPool) must NEVER be a token recipient in
 * `tokenParams.users` — treasury tokens can't vote, and the frontend never
 * lists it (the remainder is minted to the DAO implicitly). Listing it inflates
 * `sum(amounts)`, hides an unreachable quorum, and diverges from the frontend
 * calldata shape.
 */
export function checkNoTreasuryRecipient(users: string[], predictedGovPool?: string): PreflightResult {
  if (!predictedGovPool) return pass("deploy.no-treasury-recipient");
  const gp = predictedGovPool.toLowerCase();
  if (users.some((u) => u.toLowerCase() === gp)) {
    return fail(
      "deploy.no-treasury-recipient",
      `Do not list the DAO treasury (predicted govPool ${predictedGovPool}) in tokenParams.users. Treasury tokens ` +
        "cannot vote. Leave the treasury as an IMPLICIT remainder: set mintedTotal = full supply and users/amounts = " +
        "external holders only (sum(amounts) < mintedTotal); the contract mints the remainder to the DAO. " +
        "(matches frontend useCreateDAO — govPool is never in users[])",
    );
  }
  return pass("deploy.no-treasury-recipient");
}

// ==========================================================================
// Mode 10 — edge cases (avatar, offchain, blacklist)
// ==========================================================================

/** Avatar must be a real JPEG, not SVG bytes with a .jpeg name (browser rejects). */
export function checkAvatarIsJpeg(fileName: string, firstBytes?: Uint8Array): PreflightResult {
  const looksSvg =
    firstBytes && firstBytes.length >= 5
      ? new TextDecoder().decode(firstBytes.slice(0, 5)).trimStart().startsWith("<")
      : false;
  const jpegExt = /\.(jpe?g)$/i.test(fileName);
  if (looksSvg) {
    return fail(
      "avatar.jpeg",
      `Avatar bytes look like SVG/XML but the name is '${fileName}'. Pin a real JPEG (dexe_ipfs_upload_avatar), ` +
        "not SVG bytes with a .jpeg name — ipfs-cache.dexe.io rejects the mismatch (bug generate_avatar).",
    );
  }
  if (!jpegExt && fileName.length > 0) {
    return {
      check: "avatar.jpeg",
      ok: true,
      detail: `avatar name '${fileName}' is not .jpeg — acceptable if the bytes match the content-type`,
    };
  }
  return pass("avatar.jpeg");
}

/**
 * Off-chain proposal metadata: backend wants type = "default_single_option_type"
 * (not a unix timestamp) and quorum as a decimal fraction (0.5), not a whole
 * percent (50) — bug #27.
 */
export function checkOffchainMetadata(input: { type?: string; quorum?: number | string }): PreflightResult {
  const problems: string[] = [];
  if (input.type !== undefined && /^\d{10,}$/.test(String(input.type))) {
    problems.push(`type='${input.type}' looks like a unix timestamp; backend expects 'default_single_option_type'`);
  }
  if (input.quorum !== undefined) {
    const q = Number(input.quorum);
    if (Number.isFinite(q) && q > 1) {
      problems.push(`quorum=${input.quorum} must be a decimal fraction (0.5 for 50%), not a whole percent`);
    }
  }
  if (problems.length === 0) return pass("offchain.metadata");
  return fail("offchain.metadata", problems.join("; "));
}

/** Blacklist precheck before any treasury→recipient token transfer. */
export async function checkBlacklistRecipient(
  config: DexeConfig,
  token: string,
  recipient: string,
): Promise<PreflightResult> {
  if (!token || token === ZeroAddress) return pass("recipient.blacklist", "native/no-token transfer");
  const bl = await checkBlacklist(config, token, recipient);
  if (bl.status === "blacklisted") return fail("recipient.blacklist", blacklistError(token, recipient));
  if (bl.status === "skipped") return { check: "recipient.blacklist", ok: true, detail: `skipped: ${bl.reason}` };
  return pass("recipient.blacklist", "recipient not blacklisted");
}
