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

/** cap must be 0 (uncapped) or strictly greater than mintedTotal. */
export function checkDeployCap(cap: string, mintedTotal: string, isTokenCreation: boolean): PreflightResult {
  if (!isTokenCreation) return pass("deploy.cap");
  const capBn = BigInt(cap);
  const mintedBn = BigInt(mintedTotal);
  if (capBn === 0n || capBn > mintedBn) return pass("deploy.cap", `cap=${capBn} minted=${mintedBn}`);
  return fail(
    "deploy.cap",
    `tokenParams.cap (${capBn}) must be 0 (uncapped) or strictly greater than mintedTotal (${mintedBn}). ` +
      "ERC20Gov init reverts silently otherwise (bug #28).",
  );
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
 * Mode 7 / bug #32 — on mainnet (chain 56) deployGovPool reverts if
 * mintedTotal ≠ sum(amounts). Testnet tolerates a remainder; warn only there.
 */
export function checkTreasuryRemainder(
  mintedTotal: string,
  amounts: string[],
  chainId: number,
  isTokenCreation: boolean,
): PreflightResult {
  if (!isTokenCreation) return pass("deploy.treasury-remainder");
  const minted = BigInt(mintedTotal);
  const sum = amounts.reduce((a, b) => a + BigInt(b), 0n);
  if (minted === sum) return pass("deploy.treasury-remainder", `minted=${minted}`);
  if (chainId === 56) {
    return fail(
      "deploy.treasury-remainder",
      `On BSC mainnet, tokenParams.mintedTotal (${minted}) must equal sum(amounts) (${sum}) — a treasury remainder ` +
        "reverts deployGovPool (bug #32). Distribute the full mintedTotal across recipients.",
      `remainder=${minted - sum}`,
    );
  }
  return { check: "deploy.treasury-remainder", ok: true, detail: `remainder=${minted - sum} tolerated on chain ${chainId} (advisory)` };
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
