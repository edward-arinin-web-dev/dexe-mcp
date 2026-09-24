import { z } from "zod";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { TxPayload } from "../lib/calldata.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { fetchIpfs, toCidV1, pinJsonOrPreview } from "../lib/ipfs.js";
import { ipfsPreviewBlock, type IpfsArtifact } from "../lib/ipfsPreview.js";
import { buildAvatarUrl, pinAvatarFromInput, previewAvatarFromInput } from "../lib/avatarUpload.js";
import { checkAvatarCidBytes } from "../lib/imageSniff.js";
import { resolveGateways } from "./ipfs.js";
import { SignerManager, HOT_KEY_SAFETY, hotKeySafetyFields } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { qrFallbackUrl, wcQrBlocks, type PairingContent } from "../lib/qr.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { pinataForWrites } from "../lib/requireEnv.js";
import { runBroadcastGuards } from "../lib/broadcastGuards.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import {
  classifyTreasuryActions,
  quorumPctFromRaw,
  judgeQuorum,
  treasuryGate,
  treasuryGuardMode,
  type TreasuryHit,
} from "../lib/quorumRisk.js";
import {
  executeAddSettingsAdvisory,
  findAddSettingsActions,
  POST_EXECUTE_LOCK_ADVISORY,
  voteLockAtCreateAdvisory,
  withdrawCallHint,
  type UpstreamAdvisory,
} from "../lib/protocolAdvisories.js";
import { assessBuildPure, assessBuildContext } from "../lib/buildAdvisories.js";
import {
  dedupeWarnings,
  warningLine,
  worstBlock,
  type BuildWarning,
} from "../lib/buildWarning.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";
import { resolveControllingHoldersVotedFor } from "../lib/controllingVoters.js";
import {
  PROPOSAL_BUILDERS,
  INTERNAL_PROPOSAL_BUILDERS,
  OFFCHAIN_FLOW_TYPES,
  FLOW_PROPOSAL_TYPES,
} from "../lib/proposalBuilders.js";
import { GOV_VALIDATORS_CREATE_ABI } from "./proposalBuild.js";
import { PROPOSAL_CATALOG } from "../lib/proposalCatalog.js";
import { checkProposalMetadata, proposalStateName } from "../lib/preflight.js";
import { waitWithTimeout, assertReceiptSuccess, txWaitTimeoutMs } from "../lib/txWait.js";
import { toActionableError } from "../lib/errors.js";
import { flowChainFields, flowContextSchema, type FlowContext } from "../lib/flowChain.js";
import { parseAmount, formatAmount, formatUnitsWithSymbol } from "../lib/units.js";
import { unixToUtc } from "../lib/time.js";
import { signerKeyParam, govPoolParam, PROPOSAL_ID_DESC, NFT_IDS_OWN_DESC } from "../lib/params.js";
import type { StateStore } from "../lib/stateStore.js";
import { safeErrorMessage } from "../lib/redact.js";
import { withActionContext, currentActionContext } from "../lib/agentLedger.js";

// ---------- ABI fragments ----------

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
  "function createProposal(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function moveProposalToValidators(uint256 proposalId)",
  "function execute(uint256 proposalId)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
  "function editDescriptionURL(string newDescriptionURL)",
  "function getProposalState(uint256 proposalId) view returns (uint8)",
  "function getProposalRequiredQuorum(uint256 proposalId) view returns (uint256)",
  // Resume-ledger idempotency reads (finding A). `latestProposalId` +
  // `getProposals` bound the duplicate-create scan; `getUserVotes` tells a
  // re-run whether this wallet's vote already landed.
  "function latestProposalId() view returns (uint256)",
  "function getUserVotes(uint256 proposalId, address voter, uint8 voteType) view returns (tuple(bool isVoteFor, uint256 totalVoted, uint256 tokensVoted, uint256 totalRawVoted, uint256[] nftsVoted))",
  // Full IGovPool.ProposalView[] — lets the execute-gate read a proposal's
  // on-chain actions + its own quorum setting without compiled artifacts.
  GET_PROPOSALS_FRAGMENT,
]);

const USER_KEEPER_ABI = new Interface([
  "function tokenAddress() view returns (address)",
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
]);

const SETTINGS_ABI = new Interface([
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
]);

const GOV_VALIDATORS_VOTE_ABI = new Interface([
  "function isValidator(address user) view returns (bool)",
  "function govValidatorsToken() view returns (address)",
  // Arg order differs from GovPool.vote — amount BEFORE isVoteFor.
  "function voteExternalProposal(uint256 proposalId, uint256 amount, bool isVoteFor)",
]);

const VALIDATOR_TOKEN_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
]);

// ---------- types ----------

interface FlowStep {
  label: string;
  skipped: boolean;
  reason?: string;
  txHash?: string;
  payload?: TxPayload;
}

interface Prereqs {
  userKeeper: string;
  settings: string;
  tokenAddress: string;
  walletBalance: bigint;
  currentAllowance: bigint;
  depositedPower: bigint;
  minVotesForCreating: bigint;
  minVotesForVoting: bigint;
  /** Gov-token decimals (best-effort read, defaults 18) — used to render amounts in human units. */
  tokenDecimals: number;
  /** Gov-token symbol (best-effort read, may be ""). */
  tokenSymbol: string;
}

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/**
 * Uniform composite-failure response (R7): failed step + actionable error +
 * ledger of steps that already landed (gas spent) + how to resume.
 */
export function flowFailureResult(
  result: { steps: FlowStep[]; failure?: FlowFailure },
  extra?: Record<string, unknown>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { mode: "failed", ...(extra ?? {}), failure: result.failure, steps: result.steps },
          bigintReplacer,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function makeTxPayload(to: string, iface: Interface, method: string, args: unknown[], chainId: number, description: string, value?: bigint): TxPayload {
  return {
    to,
    data: iface.encodeFunctionData(method, args),
    value: (value ?? 0n).toString(),
    chainId,
    description,
  };
}

// ---------- treasury-safety execute advisory (Layer 5) ----------

interface ExecuteRisk {
  treasuryHits: TreasuryHit[];
  quorumPct: number;
  belowFloor: boolean;
  /** Whether a controlling member (founder/validator/top holder) voted For. null = unknown (no subgraph / testnet). */
  controllingHoldersVotedFor: boolean | null;
  reasons: string[];
  /** True when one of the proposal's actions is `GovSettings.addSettings` (the #36 execute trap). */
  hasAddSettings: boolean;
}

/**
 * Read a proposal's on-chain `actionsOnFor` + its own quorum setting and judge
 * treasury-safety risk. Pure-ish: one getProposals read, then quorumRisk logic.
 * Returns `{ error }` when the read fails (caller fails soft — never bricks
 * execute on an RPC hiccup).
 */
async function assessExecuteRisk(
  provider: JsonRpcProvider,
  govPool: string,
  proposalId: number,
  cfg: DexeConfig,
): Promise<ExecuteRisk | { error: string }> {
  let value: unknown;
  try {
    const [res] = await multicall(provider, [
      { target: govPool, iface: GOV_POOL_ABI, method: "getProposals", args: [proposalId - 1, 1] },
    ]);
    if (!res?.success) return { error: res?.error ?? "getProposals reverted" };
    value = res.value;
  } catch (e) {
    return { error: safeErrorMessage(e) };
  }
  const arr = value as unknown[];
  if (!Array.isArray(arr) || arr.length === 0) return { error: `Proposal ${proposalId} not found` };

  const decoded = decodeProposalView(arr[0]);
  if (!decoded) return { error: "failed to decode proposal view" };

  const floor = cfg.minSafeQuorumPct;
  const quorumPct = quorumPctFromRaw(decoded.quorumRaw);
  const belowFloor = judgeQuorum(quorumPct, floor) !== "SAFE";
  const treasuryHits = classifyTreasuryActions(decoded.actionsOnFor);

  const reasons: string[] = [];
  if (belowFloor) {
    reasons.push(
      `the proposal's quorum=${Number.isFinite(quorumPct) ? `${quorumPct}%` : "unparseable"} is below the ${floor}% safe floor (DEXE_MIN_SAFE_QUORUM_PCT)`,
    );
  }

  // Founder/validator participation signal. Subgraph/mainnet-only; resolves
  // to null off-chain. Informational alert only — a confirmed `false` (set
  // enumerated, nobody voted For) adds an advisory reason but never blocks.
  const controllingHoldersVotedFor = await resolveControllingHoldersVotedFor({
    provider,
    govPool,
    proposalId,
    cfg,
    chainId: cfg.chainId,
  });
  if (treasuryHits.length > 0 && controllingHoldersVotedFor === false) {
    reasons.push(
      "no controlling member (validator / top token-holder) voted For — possible low-participation capture",
    );
  }

  return {
    treasuryHits,
    quorumPct,
    belowFloor,
    controllingHoldersVotedFor,
    reasons,
    hasAddSettings: findAddSettingsActions(decoded.actionsOnFor).length > 0,
  };
}

/**
 * Everything the caller is owed BEFORE `GovPool.execute` goes on the wire, plus
 * the broadcast result when it was allowed to go.
 */
interface ExecuteDecision {
  /** True iff the treasury guard refused: NOTHING was broadcast. */
  blocked: boolean;
  /** Why it was refused, and every way forward. Present iff `blocked`. */
  refusal: string | null;
  /** Treasury-safety advisory for this execute, or null when there is none. */
  treasuryRisk: string | null;
  /** Execute-time upstream protocol defects (#36, deposit lock). */
  advisories: UpstreamAdvisory[];
  /**
   * Ledger entries for the advisories above, ordered so they precede the
   * execute step in the response — the advisory is delivered ahead of the act,
   * not narrated after it.
   */
  preSteps: FlowStep[];
  /** The broadcast outcome. Absent iff `blocked`. */
  result?: Awaited<ReturnType<typeof sendOrCollect>>;
}

/**
 * Execute a passed proposal — the ONE place this composite broadcasts
 * `GovPool.execute`, and therefore the one place the execute-time guards have
 * to be wired.
 *
 * Two defects are fixed by that single funnel:
 *
 *  • The build-only `dexe_vote_build_execute` carried the #36 execute trap and
 *    the deposit-lock warning; this path — the one the server instructions tell
 *    agents to PREFER, and the only one that actually spends gas — carried
 *    neither. The warning sat on the path nobody is told to take.
 *
 *  • The treasury guard computed its advisory, pushed it into the step ledger
 *    and called `sendOrCollect` in the same breath, so the advisory reached the
 *    caller only after the irreversible act. Here the gate decides FIRST, and
 *    under `DEXE_TREASURY_GUARD=block` a treasury-moving execute whose safety
 *    checks failed is refused with nothing broadcast.
 *
 * Wired in one function on purpose: 0.32.0 shipped a guard that a second
 * entrypoint walked straight past, so each of the three execute call sites
 * below calls this instead of re-deriving the rule.
 */
async function executeProposal(args: {
  provider: JsonRpcProvider;
  signer: SignerManager;
  wc?: WalletConnectManager;
  cfg: DexeConfig;
  chainId: number;
  govPool: string;
  proposalId: number;
  dryRun: boolean;
  signerKey?: string;
}): Promise<ExecuteDecision> {
  const { provider, cfg, chainId, govPool, proposalId } = args;
  const act = `GovPool.execute(${proposalId})`;

  // ---- treasury gate: decided BEFORE anything is signed --------------------
  // Env-first resolution (the same one daoCreate uses) is what lets `block`
  // work through a config field that only carries off|warn.
  const mode = treasuryGuardMode({ configured: cfg.treasuryGuard });
  let treasuryRisk: string | null = null;
  let blocked = false;
  let refusal: string | null = null;
  // null = the actions were not read (guard off, or the read failed), so the
  // chain-scoped #36 warning below has to stay blind and fire regardless.
  let addSettingsPresent: boolean | null = null;
  if (mode !== "off") {
    const risk = await assessExecuteRisk(provider, govPool, proposalId, cfg);
    if ("error" in risk) {
      // Fail-soft: an RPC hiccup must never brick an execute — but say so, so
      // "no advisory" is never mistaken for "no risk".
      treasuryRisk = `⚠ treasury-risk pre-check skipped: ${risk.error}`;
    } else {
      addSettingsPresent = risk.hasAddSettings;
      const gate = treasuryGate({
        mode,
        stage: "execute",
        hits: risk.treasuryHits,
        reasons: risk.reasons,
        act,
      });
      treasuryRisk = gate.advisory;
      blocked = gate.blocked;
      refusal = gate.refusal;
    }
  }

  // ---- upstream defects that fire AT execute -------------------------------
  // #36 is chain-scoped (null off the affected chains) AND action-scoped: when
  // the proposal's actions were read above and none is an addSettings call, the
  // warning is noise on every testnet execute and is dropped. It stays blind
  // (fires on the chain alone) only when the actions could not be read. The
  // deposit lock always applies, because execute is what creates the lock that
  // breaks the NEXT vote.
  const advisories = [
    addSettingsPresent === false ? null : executeAddSettingsAdvisory(chainId),
    POST_EXECUTE_LOCK_ADVISORY,
  ].filter((a): a is UpstreamAdvisory => Boolean(a));

  // Ledger markers, not copies: the full text lives once, in the response's
  // `treasuryRisk` / `advisories` fields. These exist to put the advisory ahead
  // of the execute step in `steps`, which is where "delivered BEFORE the act"
  // is visible.
  const preSteps: FlowStep[] = [];
  if (treasuryRisk) {
    preSteps.push({ label: "treasury-risk", skipped: true, reason: "see `treasuryRisk` — read it before this executes" });
  }
  for (const a of advisories) {
    preSteps.push({ label: `advisory:${a.id}`, skipped: true, reason: `${a.severity} — see \`advisories\` (${a.upstream})` });
  }

  if (blocked) return { blocked, refusal, treasuryRisk, advisories, preSteps };

  const result = await sendOrCollect(
    args.signer,
    [makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, act)],
    { dryRun: args.dryRun, chainId, wc: args.wc, signerKey: args.signerKey },
  );
  return { blocked: false, refusal: null, treasuryRisk, advisories, preSteps, result };
}

/** The advisory fields every execute response carries, ready to spread. */
function executeAdvisoryFields(d: ExecuteDecision): Record<string, unknown> {
  return {
    ...(d.treasuryRisk ? { treasuryRisk: d.treasuryRisk } : {}),
    ...(d.advisories.length > 0
      ? {
          advisories: d.advisories.map((a) => ({
            id: a.id,
            severity: a.severity,
            upstream: a.upstream,
            text: a.text,
          })),
        }
      : {}),
  };
}

/**
 * Response for an execute the treasury guard refused. It is an error (the
 * caller asked for something that did not happen) and it carries the ledger of
 * whatever DID land earlier in the flow, so a blocked execute after a landed
 * vote is not mistaken for a lost vote.
 */
function executeBlockedResult(
  d: ExecuteDecision,
  priorSteps: FlowStep[],
  extra: Record<string, unknown>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            mode: "blocked-treasury",
            ...extra,
            ...executeAdvisoryFields(d),
            refusal: d.refusal,
            steps: [...priorSteps, ...d.preSteps],
            next:
              "NOTHING was broadcast for the execute. The proposal stays executable: fix the cause, or set " +
              "DEXE_TREASURY_GUARD=warn and restart the MCP server to make this an advisory, then re-run this " +
              "same call.",
          },
          bigintReplacer,
          2,
        ),
      },
    ],
    isError: true,
  };
}

const POOL_REGISTRY_ISGOV_ABI = ["function isGovPool(address) view returns (bool)"];

/**
 * W10 refusal decision: a definitive `isGovPool === false` aborts the flow; a
 * `true` or `null` (could-not-verify) proceeds (the exact-amount approve bounds
 * the residual risk).
 */
export function refuseIfNotGovPool(govPool: string, isGovPool: boolean | null): void {
  if (isGovPool === false) {
    throw new Error(
      `Refusing: ${govPool} is not a registered DeXe GovPool (PoolRegistry.isGovPool == false). ` +
        `A fake govPool returns attacker-controlled helper addresses and would route the ` +
        `auto-approve to an attacker contract (W10). Double-check the govPool address.`,
    );
  }
}

/**
 * W10: verify `govPool` is a registered DeXe GovPool against the CANONICAL
 * PoolRegistry for the chain — never the helper addresses the pool itself
 * reports (an attacker fully controls those for a fake "govPool", and the
 * composite flow would then auto-approve the attacker's keeper). A definitive
 * `isGovPool == false` aborts the flow; if the registry can't be resolved on
 * this chain we proceed, since the exact-amount approve still bounds the risk.
 */
async function assertRegisteredGovPool(
  provider: JsonRpcProvider,
  rpc: RpcProvider,
  config: DexeConfig,
  chainId: number | undefined,
  govPool: string,
): Promise<void> {
  let isGov: boolean;
  try {
    const book = new AddressBook({
      provider,
      chainId: rpc.resolveChainId(chainId),
      registryOverride: config.registryOverride,
    });
    const registryAddr = await book.resolve(CONTRACT_NAMES.POOL_REGISTRY);
    const reg = new Contract(registryAddr, POOL_REGISTRY_ISGOV_ABI, provider);
    isGov = (await reg.getFunction("isGovPool").staticCall(govPool)) as boolean;
  } catch {
    return; // registry unresolvable / call failed — cannot verify, proceed
  }
  refuseIfNotGovPool(govPool, isGov);
}

// ---------- resume-ledger idempotency (finding A) ----------

/**
 * How many of the most recent proposals the duplicate-create scan reads.
 *
 * A resumed create is always at the END of the list: the create payload is the
 * LAST step of the sequence, so the only way one lands and the caller still
 * re-runs is a failure at (or after) the final tx. 20 covers that with room for
 * concurrent DAO activity in between, in one `getProposals` call.
 */
const CREATE_DEDUPE_SCAN = 20;

/**
 * Proposal states from which a proposal is still ACTIONABLE — Voting,
 * WaitingForVotingTransfer, ValidatorVoting, SucceededFor, SucceededAgainst,
 * Locked. A duplicate is only suppressed against one of these: re-proposing
 * something that was Defeated (3) or already Executed (7/8) is a legitimate
 * intent (retry a lost vote, run next month's transfer), and blocking it would
 * make the guard a nuisance rather than a safety net.
 */
const LIVE_PROPOSAL_STATES = new Set([0, 1, 2, 4, 5, 6]);

export interface ExistingProposal {
  proposalId: number;
  state: number;
  stateName: string;
  /** core.voteEnd, Unix seconds (0 when the decoder could not read it). */
  voteEnd: number;
}

/**
 * Find a still-live proposal on `govPool` whose `descriptionURL` equals
 * `descriptionURL`.
 *
 * This is the create leg's idempotency key. A proposal's descriptionURL is the
 * CID of its pinned metadata, so re-running the SAME `dexe_proposal_create`
 * with the SAME arguments re-derives the SAME URL — which makes "did my create
 * already land?" answerable BEFORE spending gas. GovPool itself does not dedupe
 * descriptionURL (GovPoolCreate just assigns it), so without this a resumed
 * flow mints a second identical proposal, silently, for real gas — and the DAO
 * is left voting on two copies of the same thing.
 *
 * Fail-soft by construction: any read/decode problem returns null and the
 * caller proceeds exactly as it did before. A missed duplicate is the old
 * behavior; a false positive would block a legitimate create, so every
 * uncertain path resolves to "no duplicate".
 */
export async function findLiveProposalByDescriptionURL(
  provider: JsonRpcProvider,
  govPool: string,
  descriptionURL: string,
  scan: number = CREATE_DEDUPE_SCAN,
): Promise<ExistingProposal | null> {
  if (!descriptionURL) return null;
  try {
    const [latestRes] = await multicall(provider, [
      { target: govPool, iface: GOV_POOL_ABI, method: "latestProposalId", args: [], allowFailure: true },
    ]);
    if (!latestRes?.success) return null;
    const latest = Number(latestRes.value as bigint);
    if (!Number.isSafeInteger(latest) || latest <= 0) return null;

    const limit = Math.min(scan, latest);
    // getProposals is 0-indexed over a 1-indexed proposal space:
    // proposalId === offset + index + 1.
    const offset = latest - limit;
    const [res] = await multicall(provider, [
      {
        target: govPool,
        iface: GOV_POOL_ABI,
        method: "getProposals",
        args: [offset, limit],
        allowFailure: true,
      },
    ]);
    if (!res?.success) return null;
    const rows = res.value as unknown[];
    if (!Array.isArray(rows)) return null;

    // Newest first — a duplicate is far likelier to be the last thing created.
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const decoded = decodeProposalView(rows[i]);
      if (!decoded || decoded.descriptionURL !== descriptionURL) continue;
      if (!LIVE_PROPOSAL_STATES.has(decoded.proposalState)) continue;
      return {
        proposalId: offset + i + 1,
        state: decoded.proposalState,
        stateName: proposalStateName(decoded.proposalState),
        voteEnd: Number(decoded.voteEnd ?? 0n),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Backoff between post-create id lookups, in ms — the whole budget is 1.2s.
 *
 * Deliberately small. This is a cosmetic read on a create that ALREADY
 * succeeded and whose receipt this process has already seen; the only thing it
 * buys is tolerance for a load-balanced pool answering from a node one block
 * behind. Anything longer would tax every successful create to decorate a field
 * the caller can recover with one dexe_proposal_list call.
 */
const RESOLVE_CREATED_BACKOFF_MS = [400, 800];

/** `GovPool.latestProposalId()`, or null when unreadable. Fail-soft. */
export async function readLatestProposalId(
  provider: JsonRpcProvider,
  govPool: string,
): Promise<number | null> {
  try {
    const [r] = await multicall(provider, [
      { target: govPool, iface: GOV_POOL_ABI, method: "latestProposalId", args: [], allowFailure: true },
    ]);
    if (!r?.success) return null;
    const n = Number(r.value as bigint);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the id of a create that JUST landed.
 *
 * `floor` is `latestProposalId` as read BEFORE the broadcast (0 when unknown):
 * the answer must be strictly greater. That is what makes this safe under
 * `allowDuplicate:true`, where an identical earlier copy is still live and a
 * lagging node would otherwise hand back the OLD proposal's id — which the
 * response would then present as "the one you just created", and a vote on the
 * wrong proposal cannot be undone in one call ("Gov: need cancel").
 *
 * Bounded by RESOLVE_CREATED_BACKOFF_MS (3 attempts, 1.2s of sleep). A node
 * that lags longer degrades to "id unknown" — never to a hang, and never to an
 * error on a create that already landed.
 * Naming the id is a nicety; the create itself already succeeded.
 */
export async function resolveCreatedProposal(
  provider: JsonRpcProvider,
  govPool: string,
  descriptionURL: string,
  floor: number,
): Promise<ExistingProposal | null> {
  for (let attempt = 0; ; attempt++) {
    const found = await findLiveProposalByDescriptionURL(provider, govPool, descriptionURL);
    if (found && found.proposalId > floor) return found;
    const backoff = RESOLVE_CREATED_BACKOFF_MS[attempt];
    if (backoff === undefined) return null;
    await flowSleep(backoff);
  }
}

/** A wallet's existing personal vote on one proposal. */
export interface PriorVote {
  /** True when GovPool would reject a second vote from this wallet. */
  voted: boolean;
  isVoteFor: boolean;
  /** Personal ERC20 weight already locked into this vote. */
  tokensVoted: bigint;
  /** Voter-level total across personal/micropool/treasury. */
  totalVoted: bigint;
  nftCount: number;
}

/**
 * Read this wallet's existing vote on `proposalId`.
 *
 * The vote leg's idempotency key. `GovPoolVote._canVote` asserts
 * `!_isVoted(voteInfo)` — a SECOND vote from the same wallet on the same
 * proposal reverts "Gov: need cancel", and `_vote` assigns `tokensVoted =
 * amount` (absolute, not additive), so there is no such thing as topping a vote
 * up in one call. Re-running a composite after its vote landed therefore burned
 * gas on a guaranteed revert AND could never reach the execute step queued
 * behind it. Knowing this before broadcasting turns that into a skip.
 *
 * Fail-soft: a null return means "could not tell", and the caller votes as it
 * always did.
 */
export async function readPriorVote(
  provider: JsonRpcProvider,
  govPool: string,
  proposalId: number,
  voter: string,
): Promise<PriorVote | null> {
  try {
    const [res] = await multicall(provider, [
      {
        target: govPool,
        iface: GOV_POOL_ABI,
        method: "getUserVotes",
        // voteType 0 = PersonalVote; `totalVoted` on the view is voter-level, so
        // a micropool/treasury-only vote is still visible through it.
        args: [proposalId, voter, 0],
        allowFailure: true,
      },
    ]);
    if (!res?.success || res.value == null) return null;
    const v = res.value as {
      isVoteFor: boolean;
      totalVoted: bigint;
      tokensVoted: bigint;
      nftsVoted: unknown;
    };
    const tokensVoted = BigInt(v.tokensVoted ?? 0n);
    const totalVoted = BigInt(v.totalVoted ?? 0n);
    const nftCount = Array.isArray(v.nftsVoted) ? v.nftsVoted.length : 0;
    return {
      voted: tokensVoted > 0n || totalVoted > 0n || nftCount > 0,
      isVoteFor: Boolean(v.isVoteFor),
      tokensVoted,
      totalVoted,
      nftCount,
    };
  } catch {
    return null;
  }
}

async function resolvePrereqs(
  rpc: RpcProvider,
  govPool: string,
  user: string,
  config: DexeConfig,
  chainId?: number,
): Promise<Prereqs> {
  const pr = rpc.tryProvider(chainId);
  if ("error" in pr) throw new Error(`${pr.error}\n${pr.remediation}`);
  const provider = pr.ok;
  // W10: refuse a fake govPool before reading its helpers / auto-approving.
  await assertRegisteredGovPool(provider, rpc, config, chainId, govPool);

  // Batch 1: get helper addresses
  const batch1: Call[] = [
    { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
  ];
  const res1 = await multicall(provider, batch1);
  if (!res1[0]!.success) throw new Error("Failed to read getHelperContracts");
  const helpers = res1[0]!.value as [string, string, string, string, string];
  const [settings, userKeeper] = helpers;

  // Batch 2: token address + settings
  const batch2: Call[] = [
    { target: userKeeper, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [] },
    { target: settings, iface: SETTINGS_ABI, method: "getDefaultSettings", args: [] },
    {
      target: userKeeper,
      iface: USER_KEEPER_ABI,
      method: "tokenBalance",
      args: [user, 0],
      allowFailure: true,
    },
  ];
  const res2 = await multicall(provider, batch2);
  if (!res2[0]!.success) throw new Error("Failed to read tokenAddress");
  if (!res2[1]!.success) throw new Error("Failed to read getDefaultSettings");

  const tokenAddress = res2[0]!.value as string;
  const defaultSettings = res2[1]!.value as {
    minVotesForCreating: bigint;
    minVotesForVoting: bigint;
  };

  let depositedPower = 0n;
  if (res2[2]!.success) {
    const [balance, ownedBalance] = res2[2]!.value as [bigint, bigint];
    depositedPower = balance - ownedBalance;
  }

  // Batch 3: ERC20 balance + allowance + display metadata (best-effort)
  const batch3: Call[] = [
    { target: tokenAddress, iface: ERC20_ABI, method: "balanceOf", args: [user] },
    { target: tokenAddress, iface: ERC20_ABI, method: "allowance", args: [user, userKeeper] },
    { target: tokenAddress, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
    { target: tokenAddress, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true },
  ];
  const res3 = await multicall(provider, batch3);

  const walletBalance = res3[0]!.success ? (res3[0]!.value as bigint) : 0n;
  const currentAllowance = res3[1]!.success ? (res3[1]!.value as bigint) : 0n;
  const tokenDecimals = res3[2]!.success ? Number(res3[2]!.value) : 18;
  const tokenSymbol = res3[3]!.success ? String(res3[3]!.value) : "";

  return {
    userKeeper,
    settings,
    tokenAddress,
    walletBalance,
    currentAllowance,
    depositedPower,
    minVotesForCreating: defaultSettings.minVotesForCreating,
    minVotesForVoting: defaultSettings.minVotesForVoting,
    tokenDecimals,
    tokenSymbol,
  };
}

/**
 * Guidance surfaced whenever a write flow could not broadcast because the
 * session has no local signer. Tells the user the two ways to enable writes —
 * WalletConnect (preferred, keys stay on their device) or a hot private key
 * (⚠️ plaintext on disk). Consumed by every composite so the advice is uniform.
 */
export const ENABLE_WRITES_HINT =
  "⚠️ Read-only session — the steps below are UNSIGNED transaction payloads; nothing was broadcast. " +
  "To actually execute this write:\n" +
  "  • ✅ RECOMMENDED — connect a wallet: if WalletConnect is configured, a scannable QR is already attached " +
  "to this response — just scan it and approve on your phone (keys never touch this machine). Otherwise run " +
  "`dexe_wc_connect` to print one.\n" +
  "  • ⚠️ NOT SAFE — set `DEXE_PRIVATE_KEY` in .env so the server auto-signs: a hot key then lives in " +
  "PLAINTEXT on disk. Use only a throwaway/test wallet, never a treasury or personal key. Restart Claude Code " +
  "after editing .env.\n" +
  "Then re-run this call to broadcast.";

/**
 * Best-effort WalletConnect auto-pairing for no-signer write flows. Returns
 * `undefined` (never throws) when WC isn't configured or the relay is
 * unreachable, so a pairing failure can never break the payloads response.
 * When a session is already live it returns `{ connected: true }` with a hint
 * to feed the payloads to dexe_tx_send.
 */
async function tryAutoPair(
  wc: WalletConnectManager | undefined,
  chainId?: number,
): Promise<{ pairing: FlowPairing; content: PairingContent[] } | undefined> {
  if (!wc?.isConfigured()) return undefined;
  try {
    const pr = await wc.ensurePairing(chainId);
    if (pr.connected) {
      return {
        pairing: {
          connected: true,
          account: pr.account,
          chainId: pr.chainId,
          note: "WalletConnect session is live — feed each payload above to dexe_tx_send to broadcast via your phone wallet.",
        },
        content: [],
      };
    }
    if (pr.uri) {
      const content = await wcQrBlocks(pr.uri);
      return {
        pairing: {
          connected: false,
          uri: pr.uri,
          chainId: pr.chainId,
          qrFallbackUrl: qrFallbackUrl(pr.uri),
          renderHint: content.length
            ? "A scannable QR (PNG image + ASCII) is attached to this tool response — show it so the user can scan it. After phone approval, re-run this call or feed the payloads to dexe_tx_send."
            : "QR rendering unavailable — open `qrFallbackUrl` for a scannable image, or paste `uri` into the wallet.",
        },
        content,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** WalletConnect pairing info surfaced alongside no-signer `payloads` responses. */
export interface FlowPairing {
  connected: boolean;
  account?: string | null;
  uri?: string;
  chainId?: number;
  qrFallbackUrl?: string;
  note?: string;
  renderHint?: string;
}

/**
 * Prepend the WalletConnect QR content blocks (ASCII + PNG image) to a tool
 * response so the QR renders inline in MCP clients — identical presentation
 * to `dexe_wc_connect`. No-op when there is nothing to attach.
 */
export function attachPairingQr(
  res: { content: Array<{ type: "text"; text: string }>; isError?: boolean },
  pairingContent?: PairingContent[],
): { content: PairingContent[]; isError?: boolean } {
  if (!pairingContent?.length) return res;
  return { ...res, content: [...pairingContent, ...res.content] };
}

/**
 * Partial-failure record (R7): which steps landed on-chain (gas spent), which
 * step failed, and how to proceed. Composites surface this verbatim so a
 * mid-sequence failure is never a bare "broadcast failed".
 */
export interface FlowFailure {
  failedStep: string;
  error: string;
  /** Steps that DID land before the failure — their txHashes are real, gas was spent. */
  landedSteps: FlowStep[];
  resume: string;
}

/**
 * What a re-run ACTUALLY re-derives from chain state, named step by step.
 *
 * The previous wording promised that "approve / deposit / vote" were all
 * "detected on-chain and skipped automatically". Two of the three were true.
 * The create leg was never checked at all (a re-run minted a duplicate
 * proposal) and the vote leg was never checked either (a re-run reverted "Gov:
 * need cancel"). Both are now genuinely re-derived — but the lesson is that an
 * idempotency claim has to enumerate, not generalize, so this string names the
 * steps that are skipped AND the steps that are not.
 */
export const RESUME_RECHECKS =
  "On re-run this flow re-reads chain state first and skips what is already true: " +
  "ERC20.approve (allowance already covers the deposit), GovPool.deposit (deposited power already covers the vote), " +
  "createProposalAndVote (a still-live proposal with the same metadata URL already exists — no duplicate is minted), " +
  "and GovPool.vote (this wallet already voted on this proposal; GovPool reverts a second vote with \"Gov: need cancel\"). " +
  "NOT auto-skipped: GovPool.execute and the validator round (moveProposalToValidators / validator vote) — " +
  "if one of those was the failing step, check dexe_proposal_state first so the re-run does not repeat a step that landed.";

/**
 * Resume text for a flow that is ONE payload — a DAO deploy.
 *
 * `RESUME_RECHECKS` enumerates the proposal composites' legs
 * (approve/deposit/create/vote). A deploy has none of them, so the shared
 * string told a user whose deploy failed that `createProposalAndVote` and
 * `GovPool.vote` would be skipped and that the validator round would not —
 * four facts, all about steps that do not exist in the call they just made.
 */
export const DEPLOY_RESUME_RECHECKS =
  "A DAO deploy is a SINGLE transaction — there are no earlier steps to skip. Re-running the same call is safe " +
  "against a duplicate DAO: the pool address is derived from your wallet plus the DAO name (CREATE2), and the " +
  "build refuses up-front with \"PoolFactory: pool name is already taken\" if a pool already has code at that " +
  "address, so a re-run after a deploy that actually landed fails BEFORE broadcasting anything. Keep the SAME " +
  "daoName on a re-run — changing it deploys a second, separate DAO. To inspect the existing one: dexe_dao_info.";

/**
 * True when a step failed because the RECEIPT WAIT timed out rather than
 * because the transaction failed. `waitWithTimeout` normalizes ethers'
 * TimeoutError into this sentence (src/lib/txWait.ts) and ethers itself tags
 * the raw error `code: "TIMEOUT"`.
 *
 * The distinction is the whole point: a timed-out step was BROADCAST. Telling
 * the caller to "re-run this same call" there is an instruction to double-send
 * a transaction that may be one confirmation away from landing — the exact
 * double-execution the ledger exists to prevent.
 */
export function broadcastTimeout(err: unknown): { txHash?: string } | null {
  const raw = safeErrorMessage(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code !== "TIMEOUT" && !/was broadcast but not mined within/i.test(raw)) return null;
  const hash = /0x[0-9a-fA-F]{64}/.exec(raw);
  return hash ? { txHash: hash[0] } : {};
}

/**
 * Resume guidance for a step whose receipt wait timed out. Never says "re-run":
 * the first attempt may still land, so the only safe next move is to look the
 * transaction up.
 */
export function timeoutResume(
  step: string,
  chainId: number,
  landed: FlowStep[],
  txHash?: string,
  rechecks: string = RESUME_RECHECKS,
): string {
  const hashArg = txHash ? `"${txHash}"` : '"<the 0x… hash in the error above>"';
  return (
    `DO NOT re-run this call yet. "${step}" WAS BROADCAST — the wait for its receipt timed out, which is not the ` +
    `same as the transaction failing, and it may still be mined. Re-sending now risks executing it twice.\n` +
    `Next step: dexe_tx_status {"txHash":${hashArg},"chainId":${chainId}}.\n` +
    `  • reports success → that step is DONE; re-run this same call to continue from the step after it.\n` +
    `  • still pending → wait and check again; do nothing else.\n` +
    `  • not_found (dropped from the mempool) → nothing landed for this step; re-run this same call.\n` +
    (landed.length > 0
      ? `${landed.length} earlier step(s) already landed on-chain (see landedSteps txHashes). `
      : "") +
    rechecks
  );
}

const flowSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The persona behind a broadcast: the keyring label the agent ledger attributes
 * to, plus the resolved EOA. Composites report it so "who did what" is answerable
 * from the tool response, not only from the ledger file.
 *
 * Falls back to the wallet's own address if the signer cannot label it (a key
 * that is configured but matches no slot) — an unlabelled broadcast is still an
 * attributable one.
 */
export function describeBroadcaster(
  signer: SignerManager,
  wallet: { address: string },
  signerKey?: string,
): { signerKey: string; address: string } {
  try {
    return signer.describeSigner(signerKey);
  } catch {
    return { signerKey: signerKey?.trim().toLowerCase() || "primary", address: wallet.address };
  }
}

/**
 * The four questions a human asks before letting a composite spend their money,
 * answered in one block: what happens, who pays, how many transactions, and
 * what cannot be undone.
 *
 * Nested under `preview` on purpose. `next` at the TOP level belongs to
 * {@link FlowChainFields} and is an ARRAY of guide pointers; a second `next` of
 * a different type there would clobber it in every dexe_guide-driven journey
 * (later spread wins) and break the structuredContent contract for the exact
 * caller this is meant to serve.
 *
 * Emitted for EVERY mode, not just previews: the one-call path (a configured
 * hot key, no dryRun) is where most agents land, and it is the path where "what
 * did that just do, and with whose wallet?" is asked after the gas is spent.
 * `broadcast` says which of the two it is, so no tense is ever a lie.
 */
export function previewBlock(a: {
  chainId: number;
  /** One human sentence naming the act, the DAO and the amounts. */
  act: string;
  /** Resolved payer, when a key is configured. */
  who?: { signerKey: string; address: string };
  txCount: number;
  /** What cannot be undone once this lands. */
  irreversible: string;
  /** True only when this response reports a real broadcast. */
  broadcast: boolean;
  /**
   * The exact next call, named with its JSON params. Omitted by a surface that
   * already carries a top-level `next` string of its own (dexe_dao_create), so
   * the same sentence is never paid for twice.
   */
  next?: string;
}): { preview: Record<string, unknown> } {
  return {
    preview: {
      whatHappens: a.act,
      whoPays: a.who
        ? `${a.who.signerKey} (${a.who.address}) pays the gas on chain ${a.chainId}`
        : "no signing key is configured — nobody pays yet; see `enableWrites` for the two ways to enable writes",
      txCount: a.txCount,
      irreversible: a.irreversible,
      mainnet: a.chainId === 56 || a.chainId === 1,
      broadcast: a.broadcast,
      ...(a.next ? { next: a.next } : {}),
    },
  };
}

/**
 * The `prereqs` diagnostic block, with human companions.
 *
 * The wei-valued keys are LEGACY and never renamed or removed. The `*Human`
 * siblings exist because a 24-digit integer is not a number a person can read:
 * `"153000000000000000000000"` and `"153000000000000000000"` differ by three
 * characters and by a factor of a thousand. `tokenSymbol`/`tokenDecimals` are
 * emitted too — without them the caller could not do the conversion itself.
 *
 * `formatUnitsWithSymbol`, not `formatAmount`: the latter appends its own
 * `(raw …)` tail, which would print every amount's wei twice in one object.
 */
export function prereqsBlock(p: Prereqs): Record<string, unknown> {
  const d = p.tokenDecimals;
  const sym = p.tokenSymbol;
  return {
    walletBalance: p.walletBalance.toString(),
    depositedPower: p.depositedPower.toString(),
    allowance: p.currentAllowance.toString(),
    minVotesForCreating: p.minVotesForCreating.toString(),
    tokenAddress: p.tokenAddress,
    tokenSymbol: sym,
    tokenDecimals: d,
    walletBalanceHuman: formatUnitsWithSymbol(p.walletBalance, d, sym),
    depositedPowerHuman: formatUnitsWithSymbol(p.depositedPower, d, sym),
    minVotesForCreatingHuman: formatUnitsWithSymbol(p.minVotesForCreating, d, sym),
    // These were read BEFORE this call's approve/deposit landed, so in
    // `mode: "executed"` they are already out of date by the deposit amount.
    asOf: "read before this call's transactions",
  };
}

/**
 * Truthful `votedWith` for the vote composite.
 *
 * When the vote was ALREADY cast this call skips it, so reporting the amount it
 * *would* have used publishes a number that was never voted — worse than the
 * present no-number state. The honest source is the prior on-chain vote, and
 * `readPriorVote` is fail-soft, so an unreadable prior vote reports nothing.
 */
export function votedWithFields(
  voteAlreadyCast: boolean,
  priorVote: { tokensVoted: bigint } | null,
  voteAmt: bigint,
  decimals: number,
  symbol: string,
): Record<string, unknown> {
  if (!voteAlreadyCast) {
    return {
      votedWith: voteAmt.toString(),
      votedWithHuman: formatUnitsWithSymbol(voteAmt, decimals, symbol),
      votedWithSource: "this call",
    };
  }
  if (!priorVote) return {};
  return {
    votedWith: priorVote.tokensVoted.toString(),
    votedWithHuman: formatUnitsWithSymbol(priorVote.tokensVoted, decimals, symbol),
    votedWithSource: "prior on-chain vote",
  };
}

/**
 * What to do next for a proposal that is NOT executable after this call's vote.
 *
 * This branch fires for five different states and the old skip reason
 * ("not ready for execution") was written for one of them. Quorum is already
 * reached in 1/2, voting is over in 3, and in 6 the remedy is the execution
 * delay, not more votes — so "more voting power is needed" would be false in
 * four cases out of five.
 */
export function postVoteNextStep(
  state: number,
  govPool: string,
  proposalId: number,
  chainId: number,
): string {
  const self = `{"govPool":"${govPool}","proposalId":${proposalId},"chainId":${chainId}}`;
  const inspect = `Track it with dexe_proposal_state ${self}.`;
  switch (state) {
    case 0:
      return (
        `Quorum is not reached yet — more holders must vote. Each one calls ` +
        `dexe_proposal_vote_and_execute ${self} (add "signerKey":"agent2" to vote as another keyring persona). ` +
        inspect
      );
    case 1:
      return (
        `Quorum IS reached and the proposal is waiting to be moved to the validators. Re-run ` +
        `dexe_proposal_vote_and_execute with the same arguments plus "driveValidatorRound":true. ` + inspect
      );
    case 2:
      return (
        `Quorum IS reached and the DAO's VALIDATORS are voting now — member votes no longer matter. If this ` +
        `signer is a validator, re-run dexe_proposal_vote_and_execute with "driveValidatorRound":true; otherwise ` +
        `wait for them. ` + inspect
      );
    case 3:
      return (
        `It was DEFEATED — voting is over and no further vote can change it. Create a new proposal with ` +
        `dexe_proposal_create if the change is still wanted.`
      );
    case 6:
      return (
        `It PASSED and is Locked while the execution delay runs. Re-run dexe_proposal_vote_and_execute ${self} ` +
        `once the delay elapses (autoExecute is on by default). ` + inspect
      );
    default:
      return inspect;
  }
}

export async function sendOrCollect(
  signer: SignerManager,
  payloads: TxPayload[],
  opts?: {
    dryRun?: boolean;
    chainId?: number;
    wc?: WalletConnectManager;
    signerKey?: string;
    /**
     * MCP tool this sequence belongs to, recorded on every ledger entry. Omit
     * inside a `withActionContext` block (the enclosing tool's label is
     * inherited); the recorder falls back to a stack guess if neither is set.
     */
    tool?: string;
    /**
     * Awaited after a payload's receipt succeeds and before the next payload is
     * sent. Best-effort: a throwing hook never fails the flow. Used to wait out
     * read-lag between dependent txs (e.g. deposit → createProposalAndVote).
     */
    postStep?: (payloadIndex: number, payload: TxPayload) => Promise<void>;
    /**
     * What a re-run of THIS flow actually re-derives, enumerated. Defaults to
     * {@link RESUME_RECHECKS}, which describes the proposal composites' legs —
     * correct for dexe_proposal_create / dexe_proposal_vote_and_execute, and
     * pure noise for a single-payload flow like dexe_dao_create, which has none
     * of those steps. An idempotency claim has to enumerate, not generalize.
     */
    resumeRechecks?: string;
  },
): Promise<{
  mode: "executed" | "payloads" | "dryRun" | "failed";
  steps: FlowStep[];
  failure?: FlowFailure;
  enableWrites?: string;
  pairing?: FlowPairing;
  /** QR content blocks (ASCII + PNG) — pass to `attachPairingQr` so the QR renders inline. */
  pairingContent?: PairingContent[];
  /**
   * Which persona signed, or — under `dryRun` — WOULD sign.
   *
   * `safety` is the discriminator, not presence: `sendOrCollect` only ever
   * broadcasts with a LOCAL key (the no-signer leg returns `mode: "payloads"`
   * before reaching the wallet), so a signer object carrying the NOT-SAFE note
   * is by construction a hot-key signature. A dryRun signer carries no `safety`
   * — it names the payer of a transaction that was not sent.
   */
  signer?: { signerKey: string; address: string; safety?: string };
}> {
  const steps: FlowStep[] = [];
  const rechecks = opts?.resumeRechecks ?? RESUME_RECHECKS;

  // `dryRun` and "no signer" both return calldata without broadcasting, but
  // they're tagged distinctly so the swarm orchestrator's mcpFallbackDispatcher
  // (which auto-broadcasts on `mode === "payloads"`) leaves dryRun responses
  // alone. No-signer remains "payloads" so external callers get the same
  // ordered TxPayload contract the public docs promise.
  if (opts?.dryRun) {
    for (const p of payloads) {
      steps.push({ label: p.description, skipped: false, payload: p });
    }
    // Name the wallet that WOULD pay. A preview whose whole purpose is "should
    // I let this happen?" and that cannot answer "with whose money?" is missing
    // the first question a human asks.
    //
    // Every step of the resolution is optional and swallowed: a keyless session
    // must still get its preview (contrast the broadcast path below, which
    // throws), and naming the payer must never be the reason a preview fails.
    // No `safety` field — nothing was signed.
    let whoDry: { signerKey: string; address: string } | undefined;
    try {
      if (signer.hasSigner(opts?.signerKey)) {
        const sgDry = signer.trySigner?.(opts?.chainId, opts?.signerKey);
        if (sgDry && !("error" in sgDry)) {
          whoDry = describeBroadcaster(signer, sgDry.ok, opts?.signerKey);
        }
      }
    } catch {
      /* a preview never fails over naming its payer */
    }
    return { mode: "dryRun", steps, ...(whoDry ? { signer: whoDry } : {}) };
  }
  if (!opts?.signerKey && !signer.hasSigner()) {
    for (const p of payloads) {
      steps.push({ label: p.description, skipped: false, payload: p });
    }
    // Auto-print the WalletConnect QR so the user can connect and then feed
    // these payloads to dexe_tx_send (which broadcasts via the phone). This is
    // best-effort: `mode` and `steps` stay byte-identical whether or not
    // pairing succeeds, so the swarm mcpFallbackDispatcher is unaffected.
    const paired = await tryAutoPair(opts?.wc, opts?.chainId);
    return {
      mode: "payloads",
      steps,
      enableWrites: ENABLE_WRITES_HINT,
      ...(paired ? { pairing: paired.pairing, pairingContent: paired.content } : {}),
    };
  }

  const sg = signer.trySigner(opts?.chainId, opts?.signerKey);
  if ("error" in sg) throw new Error(`${sg.error}\n${sg.remediation}`);
  const wallet = sg.ok;
  const cfg = signer.getConfig();
  // Attribution for this whole sequence: the persona, and the tool label every
  // ledger entry is stamped with. `opts.tool` wins; otherwise the enclosing
  // `withActionContext` (set by the tool handler) carries through.
  const who = describeBroadcaster(signer, wallet, opts?.signerKey);
  const tool = opts?.tool ?? currentActionContext()?.tool;
  for (const [i, p] of payloads.entries()) {
    // Any step failing mid-sequence: STOP (dependent steps must not run on top
    // of unchanged state — R3), report which steps already landed (gas spent),
    // and tell the caller how to resume (R7). What a re-run actually
    // re-derives is enumerated once, in RESUME_RECHECKS — approve / deposit /
    // create / vote yes, execute and the validator round NO. This comment used
    // to claim "the correct resume for every flow"; it was not, which is why
    // the resume text now names the steps instead of generalizing.
    try {
      // Same B6/B7/B10/B11 broadcast guards as dexe_tx_send. B9 simulation is skipped:
      // these payloads are an ordered, *dependent* sequence, so simming a later
      // step against pre-sequence state would falsely revert. A BroadcastGuardError
      // aborts the flow before the offending send (gas spent only on prior steps).
      await runBroadcastGuards(
        {
          to: p.to,
          data: p.data,
          value: p.value,
          chainId: Number(p.chainId),
          from: wallet.address,
        },
        cfg,
        { skipSimulation: true },
      );
      const tx = await withActionContext(
        { ...(tool ? { tool } : {}), action: p.description },
        () =>
          signer.withBroadcastLock(
            Number(p.chainId),
            () =>
              wallet.sendTransaction({
                to: p.to,
                data: p.data,
                value: BigInt(p.value),
                chainId: BigInt(p.chainId),
              }),
            wallet.address,
          ),
      );
      const receipt = await waitWithTimeout(tx, { timeoutMs: txWaitTimeoutMs() });
      assertReceiptSuccess(receipt, p.description);
      steps.push({
        label: p.description,
        skipped: false,
        txHash: receipt?.hash ?? tx.hash,
      });
      if (opts?.postStep) {
        try {
          await opts.postStep(i, p);
        } catch {
          /* best-effort wait — never fails the flow */
        }
      }
    } catch (e) {
      const landed = steps.filter((s) => s.txHash);
      const actionable = toActionableError(e, p.description);
      // A receipt-wait timeout is NOT a failed step — the tx is in flight. It
      // gets its own resume that points at dexe_tx_status and never says
      // "re-run" (re-running is how a broadcast tx becomes two).
      const timedOut = broadcastTimeout(e);
      return {
        mode: "failed",
        steps,
        // Only claim a hot-key signature when something actually landed: this
        // return is also reached when the FIRST payload is rejected by
        // runBroadcastGuards, before anything was signed.
        signer: landed.length > 0 ? { ...who, safety: HOT_KEY_SAFETY } : who,
        failure: {
          failedStep: p.description,
          error: actionable.message,
          landedSteps: landed,
          resume: timedOut
            ? timeoutResume(p.description, Number(p.chainId), landed, timedOut.txHash, rechecks)
            : landed.length > 0
              ? `${landed.length} earlier step(s) already landed on-chain (see landedSteps txHashes). ` +
                `Fix the cause above and re-run this same call. ${rechecks}`
              : `No steps landed on-chain. Fix the cause above and re-run this same call. ${rechecks}`,
        },
      };
    }
  }
  return { mode: "executed", steps, signer: { ...who, safety: HOT_KEY_SAFETY } };
}

// ---------- exported runner ----------

export interface ProposalCreateInput {
  govPool: string;
  /** Target chain id. Defaults to the MCP's default chain. */
  chainId?: number;
  /**
   * `modify_dao_profile`, `custom`, or any wired catalog type
   * (token_transfer, withdraw_treasury, change_voting_settings, add_expert,
   * remove_expert, token_distribution, token_sale, custom_abi). Wired types
   * read their inputs from `params`.
   */
  proposalType?: string;
  /** Type-specific builder params for wired catalog `proposalType`s. */
  params?: Record<string, unknown>;
  title: string;
  description?: string;
  newDaoName?: string;
  newDaoDescription?: string;
  newWebsiteUrl?: string;
  newAvatarCID?: string;
  newAvatarFileName?: string;
  /** Local image path — the server uploads + validates it, no separate upload call needed. */
  newAvatarPath?: string;
  /** Base64 image bytes — only when the image isn't a local file. */
  newAvatarBase64?: string;
  newSocialLinks?: [string, string][];
  actionsOnFor?: { executor: string; value?: string; data: string }[];
  category?: string;
  proposalMetadataExtra?: Record<string, unknown>;
  voteAmount?: string;
  voteNftIds?: string[];
  user?: string;
  /** Keyring selector: omit = primary DEXE_PRIVATE_KEY; 'agent<n>' / address = DEXE_AGENT_PK_* key. */
  signerKey?: string;
  /** When true, return ordered TxPayloads even if a signer is configured. */
  dryRun?: boolean;
  /**
   * IPFS refs a WRAPPING composite already resolved (e.g. the OTC merkle
   * whitelists in `dexe_otc_dao_open_sale`), so the response's `ipfs`
   * disclosure block covers every artifact that rode into the calldata, not
   * just the ones this function pinned. Internal — not a tool input.
   */
  extraIpfsArtifacts?: IpfsArtifact[];
  /**
   * Required to proceed when the built proposal carries a DANGER
   * governance-safety advisory (e.g. quorum lowered into treasury-drain
   * territory). Without it the flow refuses BEFORE any transaction.
   */
  confirmRisky?: boolean;
  /**
   * Opt out of the duplicate-create guard. By default a create is suppressed
   * when a still-live proposal on this DAO already carries the same metadata
   * URL (i.e. this exact call already landed). Set true to mint a second copy
   * on purpose.
   */
  allowDuplicate?: boolean;
  /** Guided-flow position (from dexe_guide) — enables flowProgress/next chaining. */
  flowContext?: { flow: string; step: string };
}

export interface ProposalCreateDeps {
  ctx: ToolContext;
  signer: SignerManager;
  rpc: RpcProvider;
  /** Phase 3 — when present, a broadcast proposal is recorded for dexe_context. */
  state?: StateStore;
  /** When present, no-signer responses auto-attach a WalletConnect pairing QR. */
  wc?: WalletConnectManager;
}

/**
 * Pure runner behind `dexe_proposal_create`. Exposed for composite tools
 * (e.g. `dexe_otc_dao_open_sale`) that build their own `actionsOnFor` and
 * want the same prereq + IPFS + multicall flow without going through the
 * MCP tool layer.
 */
export async function runProposalCreate(
  inputRaw: ProposalCreateInput,
  deps: ProposalCreateDeps,
) {
  const input = {
    proposalType: "custom" as string,
    description: "",
    actionsOnFor: [] as { executor: string; value?: string; data: string }[],
    voteNftIds: [] as string[],
    ...inputRaw,
  };
  const { ctx, signer, rpc } = deps;

      // Off-chain proposal types live on the DeXe backend, not on any contract —
      // reject with the exact alternative flow instead of a dead-end.
      if ((OFFCHAIN_FLOW_TYPES as readonly string[]).includes(input.proposalType)) {
        const buildTool = `dexe_proposal_build_${input.proposalType}`;
        return err(
          `proposalType '${input.proposalType}' is an OFF-CHAIN proposal — it is created on the DeXe backend ` +
            `(api.dexe.io), not on-chain, so this composite cannot broadcast it. Flow instead:\n` +
            `1) ${buildTool} → returns the ready-to-send HTTP request (JSON:API body).\n` +
            `2) Authenticate: dexe_auth_request_nonce (get the message), sign it with the user's wallet, ` +
            `dexe_auth_login_request (exchange for access_token).\n` +
            `3) Send the request with 'Authorization: Bearer <access_token>'.\n` +
            `Note: the backend indexes BSC mainnet (56) DAOs only.`,
        );
      }

      // Internal proposal types are created on GovValidators (validators-only
      // voting, no token deposit) — a different single-tx path.
      const internalBuilder = INTERNAL_PROPOSAL_BUILDERS[input.proposalType];
      if (internalBuilder) {
        return runInternalProposalCreate(input, deps, internalBuilder);
      }

      // Pinata is needed only by the pins further down — a dryRun preview pins
      // nothing, so it must not be gated on a key it will never use. Demanding
      // it here also meant the creation-threshold check, the DANGER gate and
      // the #36 trap gate never got to answer a keyless caller.
      const pin = pinataForWrites(
        ctx.config.pinataJwt,
        input.dryRun ?? false,
        "to create a proposal (dryRun:true previews need no Pinata key)",
      );
      if ("error" in pin) return err(pin.error);
      const pinata = pin.ok;

      const user =
        input.user ?? (signer.hasSigner(input.signerKey) ? signer.getAddress(input.signerKey) : undefined);
      if (!user) return err("Provide 'user' address or set DEXE_PRIVATE_KEY.");

      const ipfsArtifacts: IpfsArtifact[] = [...(input.extraIpfsArtifacts ?? [])];
      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const govPool = input.govPool;

      // Step 1: resolve prerequisites
      let prereqs: Prereqs;
      try {
        prereqs = await resolvePrereqs(rpc, govPool, user, ctx.config, chainId);
      } catch (e) {
        const a = toActionableError(e, "resolve DAO prerequisites");
        return err(
          a.slug
            ? a.message
            : `${a.message}\nIf this repeats, verify the govPool address is a DeXe GovPool on chain ${chainId} (dexe_dao_info) — a wrong address or chain yields exactly this read failure.`,
        );
      }

      // Mode 6 guard: the auto-approve targets the UserKeeper (which does
      // transferFrom on deposit). If the resolved keeper collapses onto the
      // GovPool address, refuse rather than approve the wrong contract.
      if (prereqs.userKeeper.toLowerCase() === govPool.toLowerCase()) {
        return err(
          "Refusing: resolved UserKeeper equals the GovPool address — the auto-approve would target GovPool, " +
            "not the keeper (failure mode 6). Re-check the govPool address.",
        );
      }

      // Step 2: check creation threshold
      const totalAvailable = prereqs.walletBalance + prereqs.depositedPower;
      if (prereqs.minVotesForCreating > 0n && totalAvailable < prereqs.minVotesForCreating) {
        const d = prereqs.tokenDecimals;
        const sym = prereqs.tokenSymbol;
        return err(
          `Insufficient tokens to create a proposal on this DAO. The DAO requires ${formatAmount(prereqs.minVotesForCreating, d, sym)} ` +
            `but ${user} has ${formatAmount(totalAvailable, d, sym)} total (wallet ${formatAmount(prereqs.walletBalance, d, sym)}, ` +
            `deposited ${formatAmount(prereqs.depositedPower, d, sym)}). ` +
            `Next step: acquire more ${sym || "gov tokens"} (token ${prereqs.tokenAddress}), or have a holder with enough tokens create the proposal.`,
        );
      }

      // Step 3: build actions + metadata based on type
      let actionsOnFor: Array<{ executor: string; value: bigint; data: string }>;
      let proposalExtra: Record<string, unknown>;
      let governanceAdvisories: string[] | undefined;
      /**
       * One human sentence for `preview.whatHappens`. The catalog builders
       * already produce it (`built.summary`) and it was thrown away; the
       * `custom` / `modify_dao_profile` branches synthesize their own.
       */
      let actionSummary = "";
      /** What the catalog builder already reported, in the structured shape. */
      let builtWarnings: BuildWarning[] | undefined;
      /** Everything Step 3c ends up with — emitted as `warnings`. */
      let buildWarnings: BuildWarning[] = [];

      if (input.proposalType === "modify_dao_profile") {
        // Read current on-chain descriptionURL up front so we can both:
        //   (a) merge its IPFS payload with the user's partial-update inputs,
        //   (b) record the prior URL in `changes.currentChanges` for the diff UI.
        let currentDescriptionURL = "";
        try {
          const pr = rpc.tryProvider(chainId);
          if ("error" in pr) throw new Error(`${pr.error}\n${pr.remediation}`);
          const provider = pr.ok;
          const descIface = new Interface(["function descriptionURL() view returns (string)"]);
          const batch: Call[] = [{ target: govPool, iface: descIface, method: "descriptionURL", args: [] }];
          const res = await multicall(provider, batch);
          if (res[0]!.success) currentDescriptionURL = res[0]!.value as string;
        } catch { /* best effort */ }

        // Pull the existing DAO metadata so unspecified fields stay intact.
        // Without this, calling modify_dao_profile with only `newAvatarCID` would
        // blank `daoName`, `websiteUrl`, `socialLinks`, and `documents` — a
        // destructive partial update that bricks the DAO header on the frontend.
        let currentMeta: Record<string, unknown> = {};
        let currentMetaFetchError: string | null = null;
        if (currentDescriptionURL) {
          const fallbackGateways = (process.env.DEXE_IPFS_GATEWAYS_FALLBACK ?? "")
            .split(",").map(s => s.trim()).filter(Boolean);
          const primary = process.env.DEXE_IPFS_GATEWAY?.trim();
          // ALWAYS append public gateways as last-resort for this read-only fetch.
          // Pinata dedicated gateways require DEXE_PINATA_GATEWAY_TOKEN auth and
          // 403 anonymous reads; without the token + no configured fallback the
          // fetch would throw → empty merge → blanked metadata. Public gateways
          // (ipfs.io, dweb.link) serve any pinned CID, so they're a safe fallback
          // for read-only loads of already-public metadata.
          const gateways = Array.from(new Set([
            primary,
            ...fallbackGateways,
            "https://ipfs.io",
            "https://dweb.link",
          ].filter(Boolean))) as string[];
          try {
            const fetched = await fetchIpfs(currentDescriptionURL, { gateways, perRequestTimeoutMs: 6000 });
            if (fetched.json && typeof fetched.json === "object") {
              currentMeta = fetched.json as Record<string, unknown>;
            } else {
              currentMetaFetchError = `fetched but not JSON object (contentType=${fetched.contentType})`;
            }
          } catch (e) {
            currentMetaFetchError = safeErrorMessage(e);
          }
        }
        // Hard guard: if we wanted to merge but couldn't fetch the current
        // metadata AND the caller is doing a partial update (any field unset),
        // refuse to broadcast. Silently blanking fields is worse than aborting.
        const isPartialUpdate =
          input.newDaoName === undefined ||
          input.newWebsiteUrl === undefined ||
          input.newSocialLinks === undefined;
        if (currentDescriptionURL && Object.keys(currentMeta).length === 0 && isPartialUpdate) {
          return err(
            "Cannot fetch current DAO metadata at " + currentDescriptionURL +
            " to merge partial update — refusing to broadcast (would blank unspecified fields). " +
            (currentMetaFetchError ? `Last error: ${currentMetaFetchError}. ` : "") +
            "Either set DEXE_IPFS_GATEWAY to a reachable gateway or pass all fields explicitly " +
            "(newDaoName, newWebsiteUrl, newDaoDescription, newSocialLinks, newAvatarPath or newAvatarCID/newAvatarFileName).",
          );
        }

        // Decide which description body to use:
        //   - if caller passed newDaoDescription (or generic description), upload fresh
        //   - else preserve the existing `description` ipfs:// pointer
        let descriptionRef = typeof currentMeta.description === "string" ? currentMeta.description : "";
        if (input.newDaoDescription !== undefined || (input.description && input.description.length > 0)) {
          const descSlate = markdownToSlate(input.newDaoDescription ?? input.description ?? "");
          const r = await pinJsonOrPreview(descSlate, {
            dryRun: input.dryRun ?? false,
            pinata,
            name: `dao-desc:${govPool.slice(0, 10)}`,
          });
          descriptionRef = r.uri;
          ipfsArtifacts.push({ field: "daoDescription", uri: r.uri, pinned: r.pinned, exact: r.exact });
        }

        // Merge: start from current, override only fields the caller explicitly supplied.
        // socialLinks/documents replace fully when supplied (lists are atomic in the UI).
        const daoMeta: Record<string, unknown> = {
          ...currentMeta,
          daoName: input.newDaoName ?? (currentMeta.daoName as string | undefined) ?? "",
          websiteUrl: input.newWebsiteUrl ?? (currentMeta.websiteUrl as string | undefined) ?? "",
          description: descriptionRef,
          socialLinks: input.newSocialLinks ?? (Array.isArray(currentMeta.socialLinks) ? currentMeta.socialLinks : []),
          documents: Array.isArray(currentMeta.documents) ? currentMeta.documents : [],
        };
        if ((input.newAvatarPath || input.newAvatarBase64) && input.newAvatarCID) {
          return err("Pass either `newAvatarCID` or `newAvatarPath`/`newAvatarBase64`, not both.");
        }
        if (input.newAvatarPath || input.newAvatarBase64) {
          // One-call avatar rotation: read + validate (magic bytes) + pin the
          // image server-side. The agent should never read image files itself.
          //
          // A dryRun reads and validates but does NOT publish the user's image
          // to public IPFS — a preview that uploads a picture is not a preview.
          // No CID is synthesized (Pinata wraps the file in a directory, so any
          // local CID would produce a permanently dead avatarUrl).
          try {
            if (input.dryRun || !pinata) {
              const preview = await previewAvatarFromInput({
                filePath: input.newAvatarPath,
                base64: input.newAvatarBase64,
              });
              daoMeta.avatarFileName = preview.avatarFileName;
            } else {
              const pinned = await pinAvatarFromInput({
                filePath: input.newAvatarPath,
                base64: input.newAvatarBase64,
                pinata,
              });
              daoMeta.avatarCID = pinned.avatarCID;
              daoMeta.avatarFileName = pinned.avatarFileName;
              daoMeta.avatarUrl = pinned.avatarUrl;
            }
          } catch (e) {
            // Validation now also fires in the preview, so it must surface as a
            // clean tool error rather than a raw throw out of the handler.
            return err(safeErrorMessage(e));
          }
        } else if (input.newAvatarCID) {
          // By-reference CID — the local byte gate never saw these bytes, so
          // best-effort fetch + sniff (hard-block only on confirmed non-raster).
          const avatarCidV1 = toCidV1(input.newAvatarCID);
          const avatarFileName = input.newAvatarFileName ?? "avatar.jpeg";
          const check = await checkAvatarCidBytes(avatarCidV1, avatarFileName, resolveGateways(ctx));
          if (!check.ok) return err(check.error ?? "newAvatarCID failed raster validation");
          daoMeta.avatarCID = avatarCidV1;
          daoMeta.avatarFileName = avatarFileName;
          // The frontend rebuilds the URL itself (parseAvatarFromIpfsResponse)
          // so the field is informational, but the CID + filename pair is
          // load-bearing.
          daoMeta.avatarUrl = buildAvatarUrl(avatarCidV1, avatarFileName);
        }
        const daoMetaPin = await pinJsonOrPreview(daoMeta, {
          dryRun: input.dryRun ?? false,
          pinata,
          name: `dao-meta:${govPool.slice(0, 10)}`,
        });
        const newDescriptionURL = daoMetaPin.uri;
        ipfsArtifacts.push({
          field: "editDescriptionURL",
          uri: daoMetaPin.uri,
          pinned: daoMetaPin.pinned,
          exact: daoMetaPin.exact,
        });

        actionsOnFor = [{
          executor: govPool,
          value: 0n,
          data: GOV_POOL_ABI.encodeFunctionData("editDescriptionURL", [newDescriptionURL]),
        }];

        actionSummary = `edits the DAO profile (descriptionURL → ${newDescriptionURL})`;
        proposalExtra = {
          category: "daoProfileModification",
          isMeta: false,
          changes: {
            proposedChanges: { descriptionUrl: newDescriptionURL },
            currentChanges: { descriptionUrl: currentDescriptionURL },
          },
        };
      } else if (input.proposalType === "custom") {
        // custom
        actionsOnFor = input.actionsOnFor.map(a => ({
          executor: a.executor,
          value: BigInt(a.value ?? "0"),
          data: a.data,
        }));
        const userExtra = input.proposalMetadataExtra ?? {};
        proposalExtra = {
          ...(input.category ? { category: input.category } : {}),
          isMeta: false,
          ...userExtra,
        };
        // Frontend's modify-profile diff UI (useGovPoolProposalProfileModel.ts:80)
        // assumes isMeta=true means the action wraps a createProposal; for the
        // single-action editDescriptionURL of daoProfileModification that decode
        // path throws, blanking the diff table. Force isMeta=false regardless of
        // what the caller passed so the UI renders correctly.
        if (input.category === "daoProfileModification") {
          proposalExtra.isMeta = false;
        }
        // No builder ran, so there is no summary to reuse: describe the raw
        // actions, naming a treasury movement when one is decodable.
        const hits = classifyTreasuryActions(
          actionsOnFor.map((a) => ({ executor: a.executor, value: a.value.toString(), data: a.data })),
        );
        const targets = [...new Set(actionsOnFor.map((a) => a.executor))];
        actionSummary =
          `runs ${actionsOnFor.length} custom action(s) on ${targets.join(", ")}` +
          (hits.length > 0
            ? ` — including ${hits
                .map((h) => `${h.kind}${h.recipient ? ` → ${h.recipient}` : ""}${h.amount ? ` (${h.amount})` : ""}`)
                .join("; ")}`
            : "");
      } else {
        // wired catalog type — build actionsOnFor + metadata server-side so
        // "create proposal X" is a single call with correct calldata + category.
        const builder = PROPOSAL_BUILDERS[input.proposalType];
        if (!builder) {
          const entry = PROPOSAL_CATALOG.find((e) => e.id.endsWith(`.${input.proposalType}`));
          if (entry && entry.mcpTool) {
            return err(
              `proposalType '${input.proposalType}' is not wired into dexe_proposal_create yet. ` +
                `Build its actions with the dedicated tool '${entry.mcpTool}', then call dexe_proposal_create ` +
                `with proposalType='custom', actionsOnFor=<its actions>, and category from that tool's metadata. ` +
                `Wired types: ${Object.keys(PROPOSAL_BUILDERS).join(", ")}.`,
            );
          }
          return err(
            `Unknown proposalType '${input.proposalType}'. Supported: ${FLOW_PROPOSAL_TYPES.join(", ")}. See dexe_proposal_catalog.`,
          );
        }
        const parsed = builder.schema.safeParse(input.params ?? {});
        if (!parsed.success) {
          return err(
            `Invalid params for proposalType '${input.proposalType}': ` +
              parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
          );
        }
        let built: Awaited<ReturnType<typeof builder.build>>;
        try {
          built = await builder.build(parsed.data, { ctx, govPool, chainId });
        } catch (e) {
          return err(toActionableError(e, `build ${input.proposalType} actions`).message);
        }
        actionsOnFor = built.actionsOnFor.map((a) => ({
          executor: a.executor,
          value: BigInt(a.value ?? "0"),
          data: a.data,
        }));
        proposalExtra = {
          ...(built.category ? { category: built.category } : {}),
          isMeta: false,
          ...built.metadataExtra,
        };
        actionSummary = built.summary;
        builtWarnings = built.warnings;
        if (built.advisories?.length) {
          governanceAdvisories = built.advisories;
          // DANGER gate: refuse BEFORE any tx (no approve/deposit/create has
          // run yet) unless the caller explicitly accepted the risk.
          if (built.risk === "DANGER" && !input.confirmRisky) {
            return ok({
              mode: "blocked-risky",
              proposalType: input.proposalType,
              risk: "DANGER",
              governanceAdvisories: built.advisories,
              ...(built.warnings?.length ? { warnings: built.warnings } : {}),
              note:
                "No transaction was broadcast. The built proposal degrades governance safety " +
                "(see governanceAdvisories — e.g. a quorum low enough that a market buyer could pass " +
                "treasury-moving proposals alone). If this is intentional, re-call dexe_proposal_create " +
                "with the SAME arguments plus confirmRisky:true.",
            });
          }
        }
      }

      // Step 3c: the full build-time harm pass on the FINAL actions, whatever
      // produced them.
      //
      // The catalog builders are already wrapped by the registry chokepoint,
      // but the `custom` branch above takes caller-supplied actionsOnFor
      // verbatim and never touches PROPOSAL_BUILDERS — so it bypassed that
      // guard entirely. This is the third time in this codebase that a
      // "custom"/raw-calldata path has walked around a check every other path
      // passes through (0.32.0: the GovUserKeeper denylist). Running it HERE,
      // once, on the assembled actions means the branch that produced them
      // cannot matter — including any branch added later.
      //
      // Deduped by code + actionIndex against what the builder already
      // reported, so a catalog build is never annotated twice.
      {
        const priorWarnings = builtWarnings ?? [];
        const assessInput = {
          chainId,
          chainIdExplicit: true,
          actions: actionsOnFor.map((a) => ({
            executor: a.executor,
            value: a.value.toString(),
            data: a.data,
          })),
          treasuryGuard: ctx.config.treasuryGuard,
          govPool,
        };
        const pure = assessBuildPure(assessInput);
        // Context is best-effort by contract: it never throws, never blocks,
        // and returns [] rather than wedging the composite when the RPC is out.
        const context = await assessBuildContext({ ...assessInput, cfg: ctx.config });
        const fresh = dedupeWarnings([...priorWarnings, ...pure, ...context]).filter(
          (w) => !priorWarnings.some((p) => p.code === w.code && p.actionIndex === w.actionIndex),
        );
        buildWarnings = dedupeWarnings([...priorWarnings, ...pure, ...context]);
        if (fresh.length > 0) {
          governanceAdvisories = [
            ...(governanceAdvisories ?? []),
            // `context.unavailable` is an infrastructure note, not a governance
            // advisory — it must never stamp the channel documented as
            // "never empty when present".
            ...fresh.filter((w) => w.code !== "context.unavailable").map(warningLine),
          ];
          if (governanceAdvisories.length === 0) governanceAdvisories = undefined;
        }
        const hard = buildWarnings.filter((w) => w.block === "hard");
        if (hard.length > 0) {
          return err(hard.map((w) => `${w.message} ${w.remedy}`).join("\n\n"));
        }
        if (worstBlock(buildWarnings) === "confirmable" && !input.confirmRisky) {
          return ok({
            mode: "blocked-risky",
            proposalType: input.proposalType,
            risk: "DANGER",
            governanceAdvisories,
            warnings: buildWarnings,
            note:
              "No transaction was broadcast. The built proposal would either degrade governance " +
              "safety or PASS the vote and then revert at execute, burning a full governance cycle " +
              "and leaving nothing to undo it. See warnings[] for the exact cause and remedy. " +
              "Re-run with the SAME arguments plus confirmRisky: true only if you accept it.",
          });
        }
      }

      // Step 4: upload proposal metadata (field names must match frontend exactly)
      const proposalMeta = {
        proposalName: input.title,
        proposalDescription: JSON.stringify(markdownToSlate(input.description)),
        ...proposalExtra,
      };
      // Mode 2 guard: the metadata shape is load-bearing for the frontend
      // indexer/diff UI and immutable once pinned — validate before upload.
      const metaCheck = checkProposalMetadata(proposalMeta);
      if (!metaCheck.ok) return err(`Proposal metadata preflight failed: ${metaCheck.remediation}`);
      // dryRun stays side-effect-free: the CID is computed locally and nothing
      // is pinned. It is the SAME CID a real pin returns, so the previewed
      // createProposalAndVote calldata matches the real run byte for byte.
      const metaPin = await pinJsonOrPreview(proposalMeta, {
        dryRun: input.dryRun ?? false,
        pinata,
        name: `proposal:${input.title.slice(0, 30)}`,
      });
      const proposalMetaCid = metaPin.cid;
      const descriptionURL = metaPin.uri;
      ipfsArtifacts.push({
        field: "descriptionURL",
        uri: metaPin.uri,
        pinned: metaPin.pinned,
        exact: metaPin.exact,
      });

      // Step 4b: duplicate-create guard (finding A).
      //
      // Every composite failure tells the caller "fix the cause and re-run this
      // same call — completed steps are skipped". For the CREATE leg that was
      // false: nothing checked whether the create had already landed, and
      // GovPool does not dedupe descriptionURL, so a re-run after a timed-out
      // receipt / a failed later step minted a SECOND identical proposal —
      // silently, for real gas, leaving the DAO voting on two copies.
      //
      // The pinned metadata CID makes the same call produce the same URL, so
      // the duplicate is detectable BEFORE the transaction. Still skipped under
      // dryRun — since 0.34.0 the preview CID WOULD match a live proposal, but
      // a preview broadcasts nothing, so the extra on-chain scan buys nothing
      // and a preview should not depend on RPC reachability.
      if (!input.dryRun && !input.allowDuplicate) {
        const prDup = rpc.tryProvider(chainId);
        if (!("error" in prDup)) {
          const existing = await findLiveProposalByDescriptionURL(prDup.ok, govPool, descriptionURL);
          if (existing) {
            // The proposal is real even though THIS call did not create it — the
            // run that did may have died before recording it. Best-effort, so a
            // state-write error never turns a clean no-op into a failure.
            if (deps.state) {
              try {
                deps.state.recordProposal({
                  govPool,
                  chainId,
                  title: input.title,
                  descriptionURL,
                  createdAt: new Date().toISOString(),
                });
              } catch {
                /* ignore */
              }
            }
            return ok({
              mode: "already-created",
              govPool,
              chainId,
              proposalId: existing.proposalId,
              proposalState: existing.stateName,
              descriptionURL,
              proposalMetadataCID: proposalMetaCid,
              steps: [
                {
                  label: "GovPool.createProposalAndVote",
                  skipped: true,
                  reason:
                    `Proposal #${existing.proposalId} on this DAO already carries this exact descriptionURL ` +
                    `and is still live ("${existing.stateName}") — this call already landed.`,
                },
              ],
              note:
                "NOTHING WAS BROADCAST. Creating it again would mint a second identical proposal (GovPool does not " +
                "reject duplicate descriptionURLs) and split the DAO's votes across two copies. " +
                `Continue with the existing one: dexe_proposal_vote_and_execute {"govPool":"${govPool}",` +
                `"proposalId":${existing.proposalId},"chainId":${chainId}} — or inspect it with dexe_proposal_state. ` +
                "If a second copy is genuinely intended, re-call with allowDuplicate:true.",
            });
          }
        }
      }

      // Step 5: build tx payloads
      const payloads: TxPayload[] = [];
      const skippedSteps: FlowStep[] = [];

      // Determine how much to deposit. voteAmount accepts raw wei (digits-only)
      // or human units with a decimal point, scaled by the gov token's decimals.
      let voteAmount: bigint;
      try {
        voteAmount = input.voteAmount
          ? parseAmount(input.voteAmount, prereqs.tokenDecimals)
          : prereqs.depositedPower + prereqs.walletBalance;
      } catch (e) {
        return err(safeErrorMessage(e));
      }
      if (voteAmount === 0n) {
        return err(
          `No voting power available — ${user} holds 0 ${prereqs.tokenSymbol || "gov tokens"} (wallet + deposited). ` +
            `Acquire the DAO's gov token (${prereqs.tokenAddress}) first, then re-run.`,
        );
      }
      // Units trap: a digits-only voteAmount is RAW WEI. "1000" = 1000 wei —
      // below minVotesForVoting it reaches the chain and reverts
      // "Gov: low voting power" with no hint. Refuse up-front instead.
      if (prereqs.minVotesForVoting > 0n && voteAmount < prereqs.minVotesForVoting) {
        const d = prereqs.tokenDecimals;
        const sym = prereqs.tokenSymbol;
        return err(
          `voteAmount ${voteAmount} wei is below this DAO's minVotesForVoting ` +
            `(${formatAmount(prereqs.minVotesForVoting, d, sym)}) — the create would revert "Gov: low voting power". ` +
            (input.voteAmount
              ? `Note: digits-only amounts are RAW WEI; for human units use a decimal point (e.g. '${input.voteAmount}.0' ` +
                `= ${input.voteAmount} whole tokens), or omit voteAmount to vote with all available power.`
              : `You omitted voteAmount, so this is your entire wallet + deposited balance — it is below the DAO's ` +
                `minimum to create. Acquire more of the gov token (${prereqs.tokenAddress}) first, then re-run.`),
        );
      }
      // The branch actually taken at the `voteAmount` assignment above is
      // truthiness, not `=== undefined`: voteAmount:"" takes the default too.
      const votedAll = !input.voteAmount;
      const voteAmountHuman = formatUnitsWithSymbol(
        voteAmount,
        prereqs.tokenDecimals,
        prereqs.tokenSymbol,
      );
      const needDeposit = voteAmount > prereqs.depositedPower ? voteAmount - prereqs.depositedPower : 0n;

      if (needDeposit > prereqs.walletBalance) {
        const d = prereqs.tokenDecimals;
        const sym = prereqs.tokenSymbol;
        return err(
          `Not enough tokens: voting with ${formatAmount(voteAmount, d, sym)} needs a deposit of ${formatAmount(needDeposit, d, sym)} ` +
            `but the wallet only holds ${formatAmount(prereqs.walletBalance, d, sym)}. ` +
            `Next step: lower voteAmount to at most ${formatAmount(prereqs.depositedPower + prereqs.walletBalance, d, sym)}, or acquire more tokens.`,
        );
      }

      // The lock warning belongs BEFORE the act in the ledger, not after the
      // gas is spent — same placement as the execute path's preSteps. The text
      // itself lives in `advisories` so the ledger stays a list of steps.
      skippedSteps.push({
        label: "advisory:tokens-locked-after-execute",
        skipped: true,
        reason: "WARN — see `advisories`; read it before this broadcasts",
      });

      // Approve (if needed)
      if (needDeposit > 0n && prereqs.currentAllowance < needDeposit) {
        // W10: approve exactly what the deposit needs, never MAX_UINT256 — a
        // residual unlimited allowance to a (possibly attacker-supplied) keeper
        // is the drain primitive.
        payloads.push(makeTxPayload(
          prereqs.tokenAddress, ERC20_ABI, "approve",
          [prereqs.userKeeper, needDeposit], chainId,
          `ERC20.approve(${prereqs.userKeeper}, ${needDeposit})`,
        ));
      } else {
        skippedSteps.push({ label: "ERC20.approve", skipped: true, reason: "Allowance sufficient" });
      }

      // Deposit (if needed) — a SEPARATE tx, never bundled. Newly deployed
      // pools ship with SphereX protection that rejects the old
      // multicall([deposit, createProposalAndVote]) wrap with
      // "SphereX error: disallowed tx pattern" (verified live on chain 97,
      // v0.22). Sequential txs pass, and the failure ledger makes the
      // two-step sequence safely resumable.
      let depositPayloadIndex = -1;
      if (needDeposit > 0n) {
        depositPayloadIndex = payloads.length;
        payloads.push(makeTxPayload(
          govPool, GOV_POOL_ABI, "deposit",
          [needDeposit, []], chainId,
          `GovPool.deposit(${needDeposit})`,
        ));
      } else {
        skippedSteps.push({ label: "GovPool.deposit", skipped: true, reason: "Sufficient deposited power" });
      }

      // Bug #35 unbundle race: on a fresh DAO the very first
      // createProposalAndVote can revert "Gov: low creating power" — the
      // deposit tx has landed but the RPC node's state read still lags it.
      // After the deposit confirms, poll the keeper until the deposited power
      // reflects the new amount (bounded; a timeout proceeds anyway and the
      // failure ledger keeps the sequence resumable).
      const awaitDepositReflected = async () => {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return;
        const provider = pr.ok;
        const target = prereqs.depositedPower + needDeposit;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const res = await multicall(provider, [
              {
                target: prereqs.userKeeper,
                iface: USER_KEEPER_ABI,
                method: "tokenBalance",
                args: [user, 0],
                allowFailure: true,
              },
            ]);
            if (res[0]?.success) {
              const [balance, ownedBalance] = res[0].value as [bigint, bigint];
              if (balance - ownedBalance >= target) return;
            }
          } catch {
            /* transient RPC error — keep polling */
          }
          await flowSleep(2500);
        }
      };

      const actionsForTuple = actionsOnFor.map(a => [a.executor, a.value, a.data]);
      payloads.push(makeTxPayload(
        govPool, GOV_POOL_ABI, "createProposalAndVote",
        [descriptionURL, actionsForTuple, [], voteAmount, input.voteNftIds.map(id => BigInt(id))],
        chainId,
        `GovPool.createProposalAndVote("${input.title}", vote ${voteAmountHuman} FOR)`,
      ));

      // Step 6: send or return.
      //
      // Read latestProposalId BEFORE broadcasting: the post-create lookup below
      // only accepts an id strictly greater than this, which is what stops a
      // lagging RPC node from handing back the caller's own earlier duplicate.
      let idFloor = 0;
      if (!input.dryRun) {
        const prFloor = rpc.tryProvider(chainId);
        if (!("error" in prFloor)) idFloor = (await readLatestProposalId(prFloor.ok, govPool)) ?? 0;
      }
      const result = await sendOrCollect(signer, payloads, {
        dryRun: input.dryRun,
        chainId,
        wc: deps.wc,
        signerKey: input.signerKey,
        postStep:
          depositPayloadIndex >= 0
            ? async (i) => {
                if (i === depositPayloadIndex) await awaitDepositReflected();
              }
            : undefined,
      });
      if (result.mode === "failed") {
        return flowFailureResult(result, {
          descriptionURL,
          proposalMetadataCID: proposalMetaCid,
          ...(result.signer ? { signer: result.signer } : {}),
          ...hotKeySafetyFields(Boolean(result.signer?.safety)),
        });
      }

      // The one fact the rest of the journey depends on: the id the DAO just
      // assigned. Nothing here re-read chain state after the create, so the
      // success payload was LESS informative than the duplicate-guard no-op —
      // and the knowledge layer's `bindsFrom: {proposalId: "create.proposalId"}`
      // could never resolve. Fail-soft: naming the id is a nicety, never a
      // failure of a create that already landed.
      let created: ExistingProposal | undefined;
      if (result.mode === "executed") {
        try {
          const prPost = rpc.tryProvider(chainId);
          if (!("error" in prPost)) {
            created =
              (await resolveCreatedProposal(prPost.ok, govPool, descriptionURL, idFloor)) ?? undefined;
          }
        } catch {
          /* best-effort */
        }
      }

      // Phase 3: record a broadcast proposal so dexe_context surfaces it next
      // session. Best-effort — a state-write error never breaks the broadcast.
      if (result.mode === "executed" && deps.state) {
        try {
          const txHash = [...result.steps].reverse().find((s) => s.txHash)?.txHash;
          deps.state.recordProposal({
            govPool,
            chainId,
            ...(created ? { proposalId: created.proposalId } : {}),
            title: input.title,
            descriptionURL,
            txHash,
            createdAt: new Date().toISOString(),
          });
        } catch {
          /* ignore */
        }
      }

      const broadcast = result.mode === "executed";
      const voteCall = created
        ? `dexe_proposal_vote_and_execute {"govPool":"${govPool}","proposalId":${created.proposalId},"chainId":${chainId}}`
        : "";
      return attachPairingQr(
        ok({
          mode: result.mode,
          ...(created ? { proposalId: created.proposalId, proposalState: created.stateName } : {}),
          ...(created?.voteEnd
            ? { votingEndsAt: unixToUtc(created.voteEnd), votingEndsAtUnix: created.voteEnd }
            : {}),
          descriptionURL,
          proposalMetadataCID: proposalMetaCid,
          ...ipfsPreviewBlock(ipfsArtifacts),
          ...previewBlock({
            chainId,
            act:
              `Creates proposal "${input.title}" on ${govPool} — it ${actionSummary || "runs its configured actions"}; ` +
              `votes FOR with ${voteAmountHuman}` +
              (needDeposit > 0n
                ? `, depositing ${formatUnitsWithSymbol(needDeposit, prereqs.tokenDecimals, prereqs.tokenSymbol)} first.`
                : "."),
            ...(result.signer ? { who: result.signer } : {}),
            txCount: payloads.length,
            irreversible:
              "A created proposal cannot be deleted or edited, and the FOR vote cast with it cannot be changed " +
              "without cancelling first. Gas is spent whether or not it passes.",
            broadcast,
            next: broadcast
              ? created
                ? `Pass it with ${voteCall} — it votes, drives the validator round and executes.`
                : `The create landed but the new id could not be read back (the node is behind). Find it with ` +
                  `dexe_proposal_list {"govPool":"${govPool}","chainId":${chainId}} — the entry whose ` +
                  `descriptionURL is ${descriptionURL}. Do NOT guess it: a vote on the wrong proposal cannot be undone in one call.`
              : input.dryRun
                ? "NOTHING WAS BROADCAST (dryRun), so no proposal exists yet and there is no id. Re-run with dryRun:false to create it."
                : "NOTHING WAS BROADCAST (no signing key). Broadcast the payloads above with dexe_tx_send, then read the id with " +
                  `dexe_proposal_list {"govPool":"${govPool}","chainId":${chainId}}.`,
          }),
          autoVote: {
            amount: voteAmountHuman,
            amountWei: voteAmount.toString(),
            allAvailablePower: votedAll,
            note: votedAll
              ? "voteAmount was omitted, so ALL your available power (wallet + deposited) was voted FOR, the " +
                "wallet half deposited first. Pass voteAmount to vote with less — '10.0' is human units, " +
                "digits-only is raw wei."
              : `Voted FOR with ${voteAmountHuman}, as requested.`,
          },
          advisories: [
            voteLockAtCreateAdvisory({
              amount: voteAmountHuman,
              broadcast,
              govPool,
              chainId,
              ...(created ? { proposalId: created.proposalId } : {}),
              ...(result.signer?.address ? { receiver: result.signer.address } : {}),
              amountWei: voteAmount.toString(),
            }),
          ].map((a) => ({ id: a.id, severity: a.severity, upstream: a.upstream, text: a.text })),
          prereqs: prereqsBlock(prereqs),
          steps: [...skippedSteps, ...result.steps],
          ...(result.signer ? { signer: result.signer } : {}),
          ...hotKeySafetyFields(Boolean(result.signer?.safety)),
          ...(governanceAdvisories ? { governanceAdvisories } : {}),
          ...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {}),
          // The guide pointers are worth returning in a preview too, but the
          // journey position must NOT advance for a call that broadcast nothing.
          ...flowChainFields(input.flowContext, deps.state, { chainId, govPool }, { landed: broadcast }),
          ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
          ...(result.pairing ? { pairing: result.pairing } : {}),
        }),
        result.pairingContent,
      );
}

/**
 * v0.22 — internal-proposal path of `dexe_proposal_create`. Internal proposals
 * (change_validator_balances / change_validator_settings / monthly_withdraw /
 * offchain_internal_proposal) are created on GovValidators via
 * `createInternalProposal(uint8, descriptionURL, bytes)` — validators vote with
 * their own balances, so there is no approve/deposit sequence. Only a current
 * validator can create one; the response notes that requirement.
 */
async function runInternalProposalCreate(
  inputRaw: ProposalCreateInput,
  deps: ProposalCreateDeps,
  builder: (typeof INTERNAL_PROPOSAL_BUILDERS)[string],
) {
  const input = { proposalType: "custom", description: "", ...inputRaw };
  const { ctx, signer, rpc } = deps;
  // Same lazy-Pinata rule as the external path: the only pin is dryRun-gated,
  // so a preview must not be refused for the want of a key it never uses.
  const pin = pinataForWrites(
    ctx.config.pinataJwt,
    input.dryRun ?? false,
    "to create an internal proposal (dryRun:true previews need no Pinata key)",
  );
  if ("error" in pin) return err(pin.error);

  const parsed = builder.schema.safeParse(input.params ?? {});
  if (!parsed.success) {
    return err(
      `Invalid params for proposalType '${input.proposalType}': ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  let built: ReturnType<typeof builder.build>;
  try {
    built = builder.build(parsed.data);
  } catch (e) {
    return err(toActionableError(e, `build ${input.proposalType}`).message);
  }

  const chain = resolveChain(ctx.config, input.chainId);
  const chainId = chain.chainId;
  const govPool = input.govPool;
  const pr = rpc.tryProvider(chainId);
  if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
  const provider = pr.ok;

  // W10: same registered-pool check as the external flow.
  try {
    await assertRegisteredGovPool(provider, rpc, ctx.config, chainId, govPool);
  } catch (e) {
    return err(safeErrorMessage(e));
  }

  // Resolve the GovValidators helper from the pool.
  let validators: string;
  try {
    const res = await multicall(provider, [
      { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
    ]);
    if (!res[0]!.success) throw new Error(res[0]!.error ?? "getHelperContracts reverted");
    const helpers = res[0]!.value as [string, string, string, string, string];
    validators = helpers[2]!;
  } catch (e) {
    return err(toActionableError(e, "resolve GovValidators").message);
  }

  // Metadata shape mirrors dexe_proposal_build_change_validator_* exactly
  // (internal metadata carries no isMeta field).
  // F14 preflight: an internal monthly_withdraw against an UNFUNDED credit
  // line executes into "Validators: failed to execute" — the real cause
  // ("GPC: Current credit permission < amount to withdraw") is swallowed by
  // the low-level self-call in GovValidatorsExecute. Check GovPool.
  // getCreditInfo() up-front and refuse with the funding recipe. Best-effort:
  // any read failure skips the check (never blocks offline).
  let creditWarning: string | undefined;
  if (built.internalType === 2) {
    try {
      const creditIface = new Interface([
        "function getCreditInfo() view returns (tuple(address token, uint256 monthLimit, uint256 currentWithdrawLimit)[])",
      ]);
      const [creditR] = await multicall(provider, [
        { target: govPool, iface: creditIface, method: "getCreditInfo", args: [], allowFailure: true },
      ]);
      if (creditR?.success) {
        const rows = creditR.value as unknown as Array<{
          token: string;
          monthLimit: bigint;
          currentWithdrawLimit: bigint;
        }>;
        const info = new Map(
          rows.map((r) => [
            r.token.toLowerCase(),
            { monthLimit: BigInt(r.monthLimit), currentLimit: BigInt(r.currentWithdrawLimit) },
          ]),
        );
        const wanted = (input.params ?? {}) as { withdrawals?: Array<{ token: string; amount: string }> };
        const withdrawals = wanted.withdrawals ?? [];
        // HARD refuse only when the token's static monthLimit cannot cover the
        // amount — that shortfall reverts at execute regardless of timing.
        const unfunded = withdrawals.filter((w) => BigInt(w.amount) > (info.get(w.token.toLowerCase())?.monthLimit ?? 0n));
        if (unfunded.length > 0) {
          return err(
            `monthly_withdraw would execute into "Validators: failed to execute": the validators' credit line ` +
              `does not cover ${unfunded
                .map((w) => `${w.amount} of ${w.token} (month limit ${info.get(w.token.toLowerCase())?.monthLimit ?? 0n})`)
                .join("; ")}. ` +
              `Fund it first with an EXTERNAL proposal: dexe_proposal_create proposalType:'validators_allocation' ` +
              `params:{credits:[{token, amount}]} — after it executes, re-run this monthly_withdraw. ` +
              `Note: setCreditInfo only raises the month limit; it does not reset the rolling 30-day withdrawal history, ` +
              `so the new limit must exceed what was already drawn this window.`,
          );
        }
        // ADVISORY only: the line is funded (monthLimit ≥ amount) but the rolling
        // currentWithdrawLimit is temporarily drained. A Succeeded internal proposal
        // never expires, so a deferred execute after the 30-day window rolls will
        // still succeed — do NOT block, just warn.
        const drained = withdrawals.filter((w) => {
          const row = info.get(w.token.toLowerCase());
          return row !== undefined && BigInt(w.amount) > row.currentLimit && BigInt(w.amount) <= row.monthLimit;
        });
        if (drained.length > 0) {
          creditWarning =
            `The credit line is funded but its rolling 30-day limit is temporarily drained for ` +
            `${drained
              .map((w) => `${w.token} (current ${info.get(w.token.toLowerCase())?.currentLimit ?? 0n} of ${w.amount})`)
              .join("; ")}. ` +
            `Executing NOW would revert; execute after the 30-day window rolls (or once earlier draws age out).`;
        }
      }
    } catch {
      /* best-effort — proceed without the check */
    }
  }

  const proposalMeta = {
    proposalName: input.title,
    proposalDescription: JSON.stringify(markdownToSlate(input.description)),
    category: built.category,
    ...built.metadataExtra,
  };
  let metaPin;
  try {
    // Side-effect-free preview: the CID is computed locally (identical to what
    // a pin returns) and nothing is uploaded.
    metaPin = await pinJsonOrPreview(proposalMeta, {
      dryRun: input.dryRun ?? false,
      pinata: pin.ok,
      name: `proposal:${input.title.slice(0, 30)}`,
    });
  } catch (e) {
    return err(toActionableError(e, "upload internal-proposal metadata").message);
  }
  const cid = metaPin.cid;
  const descriptionURL = metaPin.uri;
  const ipfsArtifacts: IpfsArtifact[] = [
    { field: "descriptionURL", uri: metaPin.uri, pinned: metaPin.pinned, exact: metaPin.exact },
  ];

  const validatorsIface = new Interface(GOV_VALIDATORS_CREATE_ABI as unknown as string[]);
  // Read-only companion: GovValidators keeps its OWN id space
  // (`latestInternalProposalId`, `++`-assigned per create), so the GovPool
  // resolver above cannot be reused here and the ids must not be confused.
  const validatorsCountIface = new Interface([
    "function latestInternalProposalId() view returns (uint256)",
  ]);
  const readInternalLatest = async (): Promise<number | null> => {
    try {
      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return null;
      const [r] = await multicall(pr.ok, [
        {
          target: validators,
          iface: validatorsCountIface,
          method: "latestInternalProposalId",
          args: [],
          allowFailure: true,
        },
      ]);
      if (!r?.success) return null;
      const n = Number(r.value as bigint);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  };
  const internalFloor = input.dryRun ? null : await readInternalLatest();
  const payloads: TxPayload[] = [
    makeTxPayload(
      validators,
      validatorsIface,
      "createInternalProposal",
      [built.internalType, descriptionURL, built.data],
      chainId,
      `GovValidators.createInternalProposal(${built.summary})`,
    ),
  ];

  const result = await sendOrCollect(signer, payloads, {
    dryRun: input.dryRun,
    chainId,
    wc: deps.wc,
    signerKey: input.signerKey,
  });
  if (result.mode === "failed") {
    return flowFailureResult(result, {
      proposalKind: "internal",
      ...(result.signer ? { signer: result.signer } : {}),
      ...hotKeySafetyFields(Boolean(result.signer?.safety)),
      descriptionURL,
      note: "Internal proposals can only be created by a CURRENT validator of this DAO — a non-validator sender reverts.",
    });
  }

  // A single landed create moves latestInternalProposalId by EXACTLY one, so
  // `floor + 1` is attributable to this call and anything else means a
  // concurrent validator create — in which case the id is not ours to claim.
  let internalProposalId: number | undefined;
  if (result.mode === "executed" && internalFloor !== null) {
    const after = await readInternalLatest();
    if (after === internalFloor + 1) internalProposalId = after;
  }

  if (result.mode === "executed" && deps.state) {
    try {
      const txHash = [...result.steps].reverse().find((s) => s.txHash)?.txHash;
      deps.state.recordProposal({
        govPool,
        chainId,
        ...(internalProposalId !== undefined ? { proposalId: internalProposalId } : {}),
        title: input.title,
        descriptionURL,
        txHash,
        createdAt: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }
  }

  return attachPairingQr(
    ok({
      mode: result.mode,
      proposalKind: "internal",
      validators,
      internalType: built.internalType,
      ...(internalProposalId !== undefined
        ? { proposalId: internalProposalId, proposalScope: "internal" }
        : {}),
      descriptionURL,
      proposalMetadataCID: cid,
      ...ipfsPreviewBlock(ipfsArtifacts),
      ...previewBlock({
        chainId,
        act: `Creates an INTERNAL proposal on GovValidators ${validators} — ${built.summary}.`,
        ...(result.signer ? { who: result.signer } : {}),
        txCount: payloads.length,
        irreversible:
          "An internal proposal cannot be deleted or edited once created; its descriptionURL and encoded data are " +
          "fixed. Gas is spent whether or not the validators pass it.",
        broadcast: result.mode === "executed",
        next:
          internalProposalId !== undefined
            ? `Validators vote with dexe_vote_build_validator_vote {"govValidators":"${validators}","proposalId":${internalProposalId}} ` +
              `and it is executed with dexe_vote_build_execute {"scope":"internal","govValidators":"${validators}","proposalId":${internalProposalId}}.`
            : result.mode === "executed"
              ? `The create landed but the id could not be attributed to this call — read GovValidators.latestInternalProposalId() on ${validators}.`
              : "NOTHING WAS BROADCAST, so no internal proposal exists yet and there is no id.",
      }),
      summary: built.summary,
      steps: result.steps,
      ...(result.signer ? { signer: result.signer } : {}),
      ...hotKeySafetyFields(Boolean(result.signer?.safety)),
      note:
        "Internal proposals are created and voted on by the DAO's validators only (their own validator balances — " +
        "no token deposit). The sender must be a current validator or the tx reverts.",
      ...(creditWarning ? { creditWarning } : {}),
      ...flowChainFields(
        input.flowContext,
        deps.state,
        { chainId, govPool },
        { landed: result.mode === "executed" },
      ),
      ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
      ...(result.pairing ? { pairing: result.pairing } : {}),
    }),
    result.pairingContent,
  );
}

/**
 * P1-a: drive a proposal through the VALIDATOR round after member voting.
 * DeXe proposals with validators need a second stage the member-vote path does
 * not touch: GovPool.moveProposalToValidators → GovValidators.voteExternalProposal
 * → (state becomes SucceededFor/Against) → execute. Previously an agent had to
 * hand-build these ~3 raw txs. This helper advances as far as the configured
 * signer can: it always moves a WaitingForVotingTransfer proposal, and casts a
 * validator vote ONLY when the signer is itself a validator with a balance.
 * Returns the resulting steps + final state. Never throws — read failures just
 * stop progress and return the current state. Skipped entirely under dryRun
 * (state can't advance without real broadcasts).
 */
async function driveValidatorRound(args: {
  provider: JsonRpcProvider;
  signer: SignerManager;
  wc?: WalletConnectManager;
  chainId: number;
  govPool: string;
  validators: string;
  proposalId: number;
  isVoteFor: boolean;
  signerAddress: string;
  dryRun: boolean;
  signerKey?: string;
}): Promise<{ steps: FlowStep[]; state: number; failure?: FlowFailure }> {
  const { provider, signer, wc, chainId, govPool, validators, proposalId, isVoteFor, signerAddress, dryRun, signerKey } = args;
  const steps: FlowStep[] = [];

  const readState = async (): Promise<number> => {
    const r = await multicall(provider, [
      { target: govPool, iface: GOV_POOL_ABI, method: "getProposalState", args: [proposalId] },
    ]);
    return r[0]!.success ? Number(r[0]!.value) : -1;
  };

  // A state-changing tx and the getProposalState read can land in the same block
  // on some RPCs, so an immediate single read lags (the just-cast validator vote
  // that meets quorum still reads as ValidatorVoting). Poll a few times until the
  // state moves off `from`, so a single call can carry the proposal to execute.
  const readStateSettled = async (from: number): Promise<number> => {
    let s = await readState();
    for (let i = 0; i < 4 && s === from; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      s = await readState();
    }
    return s;
  };

  let state = await readState();

  // Stage 1 — move a member-passed proposal into the validator queue.
  if (state === 1) {
    const r = await sendOrCollect(
      signer,
      [makeTxPayload(govPool, GOV_POOL_ABI, "moveProposalToValidators", [proposalId], chainId, `GovPool.moveProposalToValidators(${proposalId})`)],
      { dryRun, chainId, wc, signerKey },
    );
    steps.push(...r.steps);
    if (r.mode === "failed") return { steps, state, failure: r.failure };
    if (r.mode !== "executed") return { steps, state }; // dryRun/payloads — can't progress
    state = await readStateSettled(1);
  }

  // Stage 2 — cast the signer's validator vote, only if it IS a validator with a balance.
  if (state === 2) {
    const vr = await multicall(provider, [
      { target: validators, iface: GOV_VALIDATORS_VOTE_ABI, method: "isValidator", args: [signerAddress] },
      { target: validators, iface: GOV_VALIDATORS_VOTE_ABI, method: "govValidatorsToken", args: [] },
    ]);
    const isVal = vr[0]?.success ? Boolean(vr[0]!.value) : false;
    const tokenAddr = vr[1]?.success ? (vr[1]!.value as string) : undefined;
    if (!isVal || !tokenAddr) {
      steps.push({
        label: "GovValidators.voteExternalProposal",
        skipped: true,
        reason: isVal
          ? "Could not resolve the validators token to read the signer's balance."
          : "The configured signer is not a validator of this DAO — its validators must cast their own votes.",
      });
      return { steps, state };
    }
    const balRes = await multicall(provider, [
      { target: tokenAddr, iface: VALIDATOR_TOKEN_ABI, method: "balanceOf", args: [signerAddress] },
    ]);
    const balance = balRes[0]?.success ? (balRes[0]!.value as bigint) : 0n;
    if (balance === 0n) {
      steps.push({ label: "GovValidators.voteExternalProposal", skipped: true, reason: "Signer's validator balance is 0." });
      return { steps, state };
    }
    const r = await sendOrCollect(
      signer,
      [makeTxPayload(validators, GOV_VALIDATORS_VOTE_ABI, "voteExternalProposal", [proposalId, balance, isVoteFor], chainId, `GovValidators.voteExternalProposal(${proposalId}, ${balance}, ${isVoteFor})`)],
      { dryRun, chainId, wc, signerKey },
    );
    steps.push(...r.steps);
    if (r.mode === "failed") return { steps, state, failure: r.failure };
    if (r.mode !== "executed") return { steps, state };
    state = await readStateSettled(2);
  }

  return { steps, state };
}

// ---------- register ----------

export function registerFlowTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
  wc: WalletConnectManager,
  state?: StateStore,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_proposal_create — thin shim around runProposalCreate
  // =============================================
  server.tool(
    "dexe_proposal_create",
    "Broadcasts when a signer is configured. Creates ANY governance proposal in ONE call: runs " +
      "approve\u2192deposit\u2192createProposalAndVote and uploads correct IPFS metadata " +
      "(category/isMeta/changes). Without a signer it returns ordered TxPayloads + a WalletConnect QR.\\n" +
      "Pass `proposalType` \u2014 the enum lists every wired type \u2014 with its inputs in `params`:\\n" +
      "\u2022 'custom': your own actionsOnFor [{executor,value,data}]. 'modify_dao_profile' reads the top-level " +
      "newDaoName/newDaoDescription/newWebsiteUrl/newSocialLinks/newAvatarPath fields, not `params`.\\n" +
      "\u2022 External: token_transfer {token,recipient,amount,isNative?} \u00b7 withdraw_treasury " +
      "{receiver,token?,amount?,nftAddress?,nftIds?} \u00b7 change_voting_settings {govSettings?,settings[],settingsIds?} " +
      "\u00b7 add_expert/remove_expert {expertNftContract,scope,nominatedUser,uri?} \u00b7 token_sale_whitelist " +
      "{tokenSaleProposal,requests[]} \u00b7 token_sale_recover {tokenSaleProposal,tierIds[]} \u00b7 manage_validators " +
      "{govValidators,changes[]} \u00b7 validators_allocation {credits[]} \u00b7 delegate_to_expert/revoke_from_expert " +
      "{expert,amount,nftIds?} \u00b7 change_math_model {newVotePower} \u00b7 blacklist " +
      "{erc20Gov,addAddresses?,removeAddresses?} \u00b7 apply_to_dao {token,receiver,amount} \u00b7 " +
      "new_proposal_type/enable_staking {govSettings?,settings,executors,newSettingId} \u00b7 custom_abi " +
      "{target,signature,method,args?} \u00b7 token_distribution \u00b7 token_sale \u00b7 create_staking_tier \u00b7 " +
      "reward_multiplier.\\n" +
      "\u2022 Internal (validators-only): change_validator_balances {changes[]} \u00b7 change_validator_settings " +
      "{duration,executionDelay,quorum} \u00b7 monthly_withdraw {withdrawals[],destination} \u00b7 " +
      "offchain_internal_proposal {}.\\n" +
      "Off-chain backend types are rejected with the flow to use instead. Full recipes with examples: " +
      "dexe://playbook, or dexe_proposal_catalog.",
    {
      govPool: govPoolParam,
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain (56 mainnet, 97 testnet); needs an RPC for it. Default: the MCP's default chain."),
      // 0.34.0: `.default("custom")` removed. A published `default` told the
      // model it could omit the one field that decides what the proposal DOES,
      // and the silent fallback then built a zero-action `custom` proposal that
      // GovPoolCreate._validateProposal reverts unconditionally. `.optional()`
      // drops the misleading default from the JSON Schema WITHOUT narrowing the
      // published `required` array, and runProposalCreate still falls back to
      // "custom" for programmatic callers, so no working call changes.
      proposalType: z
        .enum(FLOW_PROPOSAL_TYPES as unknown as [string, ...string[]])
        .optional()
        .describe(
          "What kind of proposal to create — required in practice. 'custom' means you supply actionsOnFor. Unsure? Call dexe_proposal_catalog.",
        ),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Type-specific builder inputs for the chosen proposalType (recipes: tool description / dexe://playbook)."),
      title: z.string().describe("Proposal title"),
      description: z.string().default("").describe("Proposal description (markdown supported)"),
      newDaoName: z.string().optional().describe("modify_dao_profile: the DAO's new display name."),
      newDaoDescription: z.string().optional().describe("modify_dao_profile: the DAO's new description (markdown)."),
      newWebsiteUrl: z.string().optional().describe("modify_dao_profile: the DAO's new website URL."),
      newAvatarCID: z.string().optional().describe("modify_dao_profile: IPFS CID of an already-pinned avatar."),
      newAvatarFileName: z.string().optional().describe("modify_dao_profile: file name stored with newAvatarCID."),
      newAvatarPath: z.string().optional().describe(
        "Local avatar image path (JPEG/PNG/WebP/GIF, max 10 MB) — the server validates and pins it for you.",
      ),
      newAvatarBase64: z.string().optional().describe("Base64 image bytes — only when the image isn't a local file."),
      newSocialLinks: z
        .array(z.tuple([z.string(), z.string()]))
        .optional()
        .describe("modify_dao_profile: [[network, url], ...]."),
      actionsOnFor: z.array(z.object({
        executor: z.string().describe("Contract the action calls."),
        value: z.string().default("0").describe("Native coin sent with the action, RAW base units (wei)."),
        data: z.string().describe("0x-hex calldata for the action."),
      })).default([]).describe("Actions run when the proposal passes. Required for proposalType:'custom'."),
      category: z.string().optional().describe("Proposal category (included in IPFS metadata)."),
      proposalMetadataExtra: z.record(z.unknown()).optional().describe("Extra fields merged into IPFS metadata."),
      voteAmount: z
        .string()
        .optional()
        .describe(
          "Auto-vote amount: raw wei (digits only) or human units with a decimal point ('12.5'). Default: all available power.",
        ),
      voteNftIds: z.array(z.string()).default([]).describe(NFT_IDS_OWN_DESC),
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
      signerKey: signerKeyParam,
      dryRun: z
        .boolean()
        .default(false)
        .describe(
          "Preview: no broadcast, no IPFS pin, no Pinata key needed. The metadata CID is right but unpinned " +
            "— do NOT broadcast this calldata.",
        ),
      confirmRisky: z
        .boolean()
        .default(false)
        .describe(
          "Required when the built proposal carries a DANGER governance-safety advisory. Without it the flow " +
            "refuses BEFORE any transaction.",
        ),
      allowDuplicate: z
        .boolean()
        .default(false)
        .describe(
          "The create is SKIPPED when a live proposal already carries the same IPFS metadata URL (a resumed " +
            "run). True mints a second identical proposal on purpose.",
        ),
      flowContext: flowContextSchema,
    },
    // Every broadcast underneath — approve, deposit, createProposalAndVote, and
    // the validator-round helpers several calls deep — is stamped with this tool
    // name in the agent ledger. Set once, at the boundary, so no call site can
    // forget it.
    (input) =>
      withActionContext({ tool: "dexe_proposal_create" }, () =>
        runProposalCreate(input as ProposalCreateInput, { ctx, signer, rpc, state, wc }),
      ),
  );

  // =============================================
  // dexe_proposal_vote_and_execute
  // =============================================
  server.tool(
    "dexe_proposal_vote_and_execute",
    "Broadcasts when a signer is configured. The ONE call for 'vote on / pass / execute proposal N': checks " +
      "proposal state, AUTO-DEPOSITS wallet tokens when voting power is short (approve UserKeeper → deposit → " +
      "vote, the frontend's bundled shape), and with autoExecute executes once the vote passes. Without a signer " +
      "it returns ordered TxPayloads + a WalletConnect QR. Unsure of the lifecycle (validator round, locked " +
      "tokens)? Call dexe_guide (flow:'vote_execute') first.",
    {
      govPool: govPoolParam,
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain (56 mainnet, 97 testnet); needs an RPC for it. Default: the MCP's default chain."),
      proposalId: z.number().int().min(1).describe(PROPOSAL_ID_DESC),
      isVoteFor: z.boolean().default(true).describe("Vote for (true) or against (false)"),
      voteAmount: z
        .string()
        .optional()
        .describe(
          "Vote amount: raw wei (digits only) or human units with a decimal point ('12.5'). Default: ALL " +
            "available power (deposited + wallet).",
        ),
      voteNftIds: z.array(z.string()).default([]).describe(NFT_IDS_OWN_DESC),
      depositFirst: z
        .union([z.boolean(), z.literal("auto")])
        .default("auto")
        .describe(
          "'auto': deposit exactly what is missing when deposited power is short. true: deposit the whole " +
            "wallet balance. false: never deposit.",
        ),
      autoExecute: z.boolean().default(true).describe("Attempt execute if proposal passes after vote"),
      driveValidatorRound: z
        .boolean()
        .default(true)
        .describe(
          "With autoExecute, drive the validator stage too: moveProposalToValidators, cast the signer's " +
            "validator vote if it is one, then execute. False stops after the member vote.",
        ),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set (preview without broadcasting)."),
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
      signerKey: signerKeyParam,
      flowContext: flowContextSchema,
    },
    // Vote, validator round, and execute can each broadcast; the ledger labels
    // all of them with this tool (see dexe_proposal_create above).
    (input) => withActionContext({ tool: "dexe_proposal_vote_and_execute" }, async () => {
      const user =
        input.user ?? (signer.hasSigner(input.signerKey) ? signer.getAddress(input.signerKey) : undefined);
      if (!user) return err("Provide 'user' address or set DEXE_PRIVATE_KEY.");

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;
      const govPool = input.govPool;
      const proposalId = input.proposalId;

      // Step 1: read proposal state
      const stateCalls: Call[] = [
        { target: govPool, iface: GOV_POOL_ABI, method: "getProposalState", args: [proposalId] },
      ];
      const stateRes = await multicall(provider, stateCalls);
      if (!stateRes[0]!.success) return err(`Failed to read proposal state: ${stateRes[0]!.error}`);

      // Mode 9: canonical ProposalState ordering lives in preflight.ts (a
      // mis-ordered inline enum previously mislabeled Locked/SucceededFor).
      const stateNum = Number(stateRes[0]!.value);
      const stateName = proposalStateName(stateNum);

      // Already past voting — skip vote, go straight to execute. State 4 =
      // SucceededFor, 5 = SucceededAgainst, 6 = Locked (post-quorum, post-
      // validator window if any, executable once delay elapsed). When the
      // open_sale composite votes with enough power to clear quorum +
      // earlyCompletion, the proposal lands directly in Locked, so we must
      // recognize it here as executable.
      if ((stateNum === 4 || stateNum === 5 || stateNum === 6) && input.autoExecute) {
        const voteSkipped: FlowStep = {
          label: "GovPool.vote",
          skipped: true,
          reason: `Proposal already in "${stateName}" — no vote needed`,
        };
        const decision = await executeProposal({
          provider,
          signer,
          wc,
          cfg: ctx.config,
          chainId,
          govPool,
          proposalId,
          dryRun: input.dryRun,
          signerKey: input.signerKey,
        });
        if (decision.blocked) {
          return executeBlockedResult(decision, [voteSkipped], {
            proposalId,
            proposalStateBefore: stateName,
          });
        }
        const execResult = decision.result!;
        if (execResult.mode === "failed") {
          return flowFailureResult(
            { steps: [...decision.preSteps, ...execResult.steps], failure: execResult.failure },
            {
              proposalId,
              proposalStateBefore: stateName,
              ...executeAdvisoryFields(decision),
              ...(execResult.signer ? { signer: execResult.signer } : {}),
              ...hotKeySafetyFields(Boolean(execResult.signer?.safety)),
            },
          );
        }
        return attachPairingQr(ok({
          mode: execResult.mode,
          proposalId,
          proposalStateBefore: stateName,
          ...(execResult.signer ? { signer: execResult.signer } : {}),
          ...hotKeySafetyFields(Boolean(execResult.signer?.safety)),
          ...executeAdvisoryFields(decision),
          steps: [
            voteSkipped,
            ...decision.preSteps,
            ...execResult.steps,
          ],
          executed: execResult.mode === "executed",
          ...(execResult.mode === "executed"
            ? flowChainFields(input.flowContext as FlowContext | undefined, state, { chainId, govPool })
            : {}),
          ...(execResult.enableWrites ? { enableWrites: execResult.enableWrites } : {}),
          ...(execResult.pairing ? { pairing: execResult.pairing } : {}),
        }), execResult.pairingContent);
      }

      // Entry in the validator stage (1/2): a re-run can advance it without a
      // fresh member vote. Drive the validator round + execute when asked.
      if ((stateNum === 1 || stateNum === 2) && input.autoExecute && input.driveValidatorRound && !input.dryRun) {
        const helpers = await multicall(provider, [
          { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
        ]);
        const validators = helpers[0]!.success ? ((helpers[0]!.value as unknown[])[2] as string) : undefined;
        if (validators) {
          const drive = await driveValidatorRound({
            provider, signer, wc, chainId, govPool, validators, proposalId,
            isVoteFor: input.isVoteFor, signerAddress: user, dryRun: false,
            signerKey: input.signerKey,
          });
          if (drive.failure) {
            return flowFailureResult({ steps: drive.steps, failure: drive.failure }, { proposalId, proposalStateBefore: stateName });
          }
          const execSteps: FlowStep[] = [];
          let executed = false;
          let decision: ExecuteDecision | undefined;
          const voteSkipped: FlowStep = {
            label: "GovPool.vote",
            skipped: true,
            reason: `Proposal already past member voting ("${stateName}") — drove the validator round`,
          };
          if (drive.state === 4 || drive.state === 5) {
            decision = await executeProposal({
              provider, signer, wc, cfg: ctx.config, chainId, govPool, proposalId,
              dryRun: false, signerKey: input.signerKey,
            });
            if (decision.blocked) {
              return executeBlockedResult(decision, [voteSkipped, ...drive.steps], {
                proposalId,
                proposalStateBefore: stateName,
                proposalStateAfter: proposalStateName(drive.state),
              });
            }
            const execResult = decision.result!;
            execSteps.push(...decision.preSteps, ...execResult.steps);
            if (execResult.mode === "failed") {
              return flowFailureResult(
                { steps: [...drive.steps, ...execSteps], failure: execResult.failure },
                { proposalId, proposalStateBefore: stateName, ...executeAdvisoryFields(decision) },
              );
            }
            executed = true;
          }
          return attachPairingQr(ok({
            mode: "executed",
            proposalId,
            proposalStateBefore: stateName,
            proposalStateAfter: proposalStateName(drive.state),
            ...(decision ? executeAdvisoryFields(decision) : {}),
            steps: [
              voteSkipped,
              ...drive.steps,
              ...execSteps,
            ],
            executed,
            // The validator-round branch runs up to three sendOrCollect calls
            // and discards their `signer`, so this leg used to broadcast with a
            // hot key and say nothing. A landed txHash is the proof.
            ...hotKeySafetyFields(
              [...drive.steps, ...execSteps].some((s) => Boolean(s.txHash)),
            ),
            ...(executed
              ? flowChainFields(input.flowContext as FlowContext | undefined, state, { chainId, govPool })
              : {}),
          }), undefined);
        }
      }

      if (stateNum !== 0) {
        const remedies: Record<number, string> = {
          1: "It is waiting for the validator-voting transfer — re-run with driveValidatorRound:true (default) once past voting, or check dexe_proposal_state.",
          2: "It is in validator voting — the DAO's validators must vote; if the configured signer is a validator, re-run with driveValidatorRound:true.",
          3: "It was DEFEATED — voting is over. Create a new proposal if the change is still wanted.",
          4: "It already PASSED — re-run this call with autoExecute:true (the default) to execute it, no vote needed.",
          5: "It already passed AGAINST — re-run this call with autoExecute:true to execute the against-actions.",
          6: "It is Locked (passed, execution delay running) — re-run this call with autoExecute:true once the delay elapses.",
          7: "It was already EXECUTED (for) — nothing left to do.",
          8: "It was already EXECUTED (against) — nothing left to do.",
        };
        return err(
          `Proposal #${proposalId} is in state "${stateName}" — voting is only possible in "Voting". ` +
            (remedies[stateNum] ?? "Check dexe_proposal_state for details."),
        );
      }

      // Step 2: resolve prereqs — always needed now (auto-deposit detection +
      // minVotes threshold + human-unit rendering).
      const prereqs = await resolvePrereqs(rpc, govPool, user, ctx.config, chainId);
      const d = prereqs.tokenDecimals;
      const sym = prereqs.tokenSymbol;

      const payloads: TxPayload[] = [];
      const skippedSteps: FlowStep[] = [];

      // Step 2b: already-voted read (finding A).
      //
      // `GovPoolVote._canVote` asserts `!_isVoted(voteInfo)` — a SECOND vote
      // from the same wallet on the same proposal reverts "Gov: need cancel" —
      // and `_vote` assigns `tokensVoted = amount` (absolute, not additive), so
      // a vote cannot be topped up in one call either. Yet the failure ledger
      // told callers to re-run and promised the vote step was skipped when
      // already satisfied. It was not: a re-run after a landed vote burned gas
      // on a guaranteed revert and, worse, could never reach the execute step
      // queued behind it.
      //
      // Read BEFORE the vote-amount guards below: those guards protect the vote
      // that is about to be sent, and when no vote will be sent they would fail
      // a resumed call over an amount nobody is going to use (an NFT-only voter
      // holding zero tokens hits "No voting power available" on every re-run).
      //
      // Fail-soft: a null read leaves the pre-existing behavior untouched.
      const priorVote = await readPriorVote(provider, govPool, proposalId, user);
      const alreadyVoted = priorVote?.voted === true;

      // Step 3: target vote amount (raw wei digits-only, or human decimal).
      let voteAmt: bigint;
      try {
        voteAmt = input.voteAmount
          ? parseAmount(input.voteAmount, d)
          : input.depositFirst === false
            ? prereqs.depositedPower
            : prereqs.depositedPower + prereqs.walletBalance;
      } catch (e) {
        return err(safeErrorMessage(e));
      }

      if (voteAmt === 0n && !alreadyVoted) {
        return err(
          input.depositFirst === false
            ? `No deposited voting power (wallet holds ${formatAmount(prereqs.walletBalance, d, sym)}, deposited 0). ` +
              `Re-run with depositFirst:'auto' (the default) to deposit-and-vote in one call.`
            : `No voting power available — ${user} holds 0 ${sym || "gov tokens"} (wallet + deposited). ` +
              `Acquire the DAO's gov token (${prereqs.tokenAddress}) first.`,
        );
      }
      // Units trap (same as proposal_create): digits-only voteAmount is RAW
      // WEI — below minVotesForVoting the vote reverts "Gov: low voting power".
      if (!alreadyVoted && prereqs.minVotesForVoting > 0n && voteAmt < prereqs.minVotesForVoting) {
        return err(
          `voteAmount ${voteAmt} wei is below this DAO's minVotesForVoting ` +
            `(${formatAmount(prereqs.minVotesForVoting, d, sym)}) — the vote would revert "Gov: low voting power". ` +
            (input.voteAmount
              ? `Digits-only amounts are RAW WEI; use a decimal point for human units (e.g. '${input.voteAmount}.0'), ` +
                `or omit voteAmount to vote with all available power.`
              : `You omitted voteAmount, so this is your entire wallet + deposited balance (${formatAmount(
                  prereqs.depositedPower + prereqs.walletBalance,
                  d,
                  sym,
                )}) — below the DAO's minimum. Acquire more of the gov token (${prereqs.tokenAddress}) first.`),
        );
      }

      // Step 3b: turn the already-voted read into the skip + its advisories.
      let voteAlreadyCast: string | undefined;
      let voteChangeAdvisory: string | undefined;
      if (priorVote?.voted) {
        voteAlreadyCast =
          `${user} has already voted on proposal #${proposalId} — ${priorVote.isVoteFor ? "FOR" : "AGAINST"}, ` +
          `${formatAmount(priorVote.tokensVoted, d, sym)}` +
          `${priorVote.nftCount > 0 ? ` + ${priorVote.nftCount} NFT(s)` : ""}. ` +
          `GovPool rejects a second vote from the same wallet ("Gov: need cancel"), so this call did NOT re-send it: ` +
          `no gas was spent on a guaranteed revert.`;
        const wantsDifferent =
          priorVote.isVoteFor !== input.isVoteFor ||
          voteAmt > priorVote.tokensVoted ||
          input.voteNftIds.length > priorVote.nftCount;
        if (wantsDifferent) {
          voteChangeAdvisory =
            `⚠ This call asked to vote ${input.isVoteFor ? "FOR" : "AGAINST"} with ${formatAmount(voteAmt, d, sym)}, ` +
            `which differs from the vote already on-chain — and it was NOT applied. ` +
            `A vote cannot be amended or topped up: GovPool.vote SETS the amount and refuses a second call. ` +
            `Changing it takes two transactions — cancel the existing vote ` +
            `(dexe_vote_build_cancel_vote (needs DEXE_TOOLSETS=core,vote)), then re-run this call. ` +
            `⚠ HARM WARNING: cancelling REMOVES your weight from the tally first, which can drop the proposal below ` +
            `quorum — and if voting closes before the new vote lands, your weight is gone from the result entirely.`;
        }
      }

      // Step 4: deposit decision.
      //   'auto'  → deposit exactly the shortfall (frontend-equivalent bundled deposit+vote)
      //   true    → legacy explicit: deposit the full wallet balance
      //   false   → never deposit
      let depositAmount = 0n;
      if (voteAlreadyCast) {
        // The approve + deposit exist only to fund the vote that is being
        // skipped. Sending them anyway would spend gas to lock tokens for a
        // transaction that can never be broadcast.
        skippedSteps.push({
          label: "GovPool.deposit",
          skipped: true,
          reason: "Vote already cast — the deposit exists only to fund it, so it is not needed.",
        });
      } else if (input.depositFirst === true) {
        depositAmount = prereqs.walletBalance;
      } else if (input.depositFirst !== false && voteAmt > prereqs.depositedPower) {
        const shortfall = voteAmt - prereqs.depositedPower;
        if (shortfall > prereqs.walletBalance) {
          return err(
            `Not enough tokens: voting with ${formatAmount(voteAmt, d, sym)} needs ${formatAmount(shortfall, d, sym)} more deposited, ` +
              `but the wallet only holds ${formatAmount(prereqs.walletBalance, d, sym)} ` +
              `(deposited ${formatAmount(prereqs.depositedPower, d, sym)}). ` +
              `Lower voteAmount to at most ${formatAmount(prereqs.depositedPower + prereqs.walletBalance, d, sym)}, or acquire more tokens.`,
          );
        }
        depositAmount = shortfall;
      }

      if (depositAmount > 0n && prereqs.currentAllowance < depositAmount) {
        // Approve if needed — W10: exact-amount approve to the UserKeeper
        // (never GovPool, never MAX_UINT256).
        payloads.push(makeTxPayload(
          prereqs.tokenAddress, ERC20_ABI, "approve",
          [prereqs.userKeeper, depositAmount], chainId,
          `ERC20.approve(${prereqs.userKeeper}, ${depositAmount})`,
        ));
      }
      if (!voteAlreadyCast && depositAmount === 0n && input.depositFirst !== false) {
        skippedSteps.push({ label: "GovPool.deposit", skipped: true, reason: "Deposited power already covers voteAmount" });
      }

      // (minVotesForVoting is enforced up-front, before the deposit decision —
      // the earlier guard returns first, so no duplicate check is needed here.)

      if (voteAlreadyCast) {
        skippedSteps.push({ label: "GovPool.vote", skipped: true, reason: voteAlreadyCast });
      } else {
        // SphereX on new pools rejects a raw top-level vote(); the frontend
        // always sends multicall([...maybe deposit, vote]) (useGovPoolVote.ts),
        // so mirror that exact shape (verified live on chain 97, F4 2026-07-21).
        const govCalls: string[] = [];
        if (depositAmount > 0n) {
          govCalls.push(GOV_POOL_ABI.encodeFunctionData("deposit", [depositAmount, []]));
        }
        govCalls.push(GOV_POOL_ABI.encodeFunctionData("vote", [proposalId, input.isVoteFor, voteAmt, input.voteNftIds.map(id => BigInt(id))]));
        payloads.push(makeTxPayload(
          govPool, GOV_POOL_ABI, "multicall",
          [govCalls],
          chainId,
          `GovPool.multicall([${depositAmount > 0n ? `deposit(${depositAmount}), ` : ""}vote(${proposalId}, ${input.isVoteFor}, ${voteAmt})])`,
        ));
      }

      // Step 5: send or collect. With the vote skipped there is nothing left to
      // broadcast for this leg — do NOT call sendOrCollect with an empty list
      // (a no-signer session would answer "payloads" with zero payloads and an
      // enable-writes hint for a write that no longer exists). Synthesize the
      // no-op so the autoExecute stage below can still carry the proposal
      // forward, which is the whole point: a re-run after a landed vote used to
      // revert here and never reach execute.
      const nothingToBroadcast = payloads.length === 0;
      const result: Awaited<ReturnType<typeof sendOrCollect>> = nothingToBroadcast
        ? { mode: input.dryRun ? "dryRun" : "executed", steps: [] }
        : await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc, signerKey: input.signerKey });
      if (result.mode === "failed") {
        return flowFailureResult(result, {
          proposalId,
          proposalStateBefore: stateName,
          ...(result.signer ? { signer: result.signer } : {}),
          ...hotKeySafetyFields(Boolean(result.signer?.safety)),
        });
      }

      // Step 6: auto-execute (only in executed mode)
      let executed = false;
      let executeDecision: ExecuteDecision | undefined;
      /** Post-vote state name + tally, when the proposal did not become executable. */
      let proposalStateAfter: string | undefined;
      let postVoteNext: string | undefined;
      let tally: Record<string, unknown> | undefined;
      if (input.autoExecute && result.mode === "executed") {
        // Re-read state after vote
        const postRes = await multicall(provider, [
          { target: govPool, iface: GOV_POOL_ABI, method: "getProposalState", args: [proposalId] },
        ]);
        let postState = Number(postRes[0]!.value);

        // P1-a: if the member vote pushed the proposal into the validator stage,
        // drive it (move + validator vote when the signer is a validator) before
        // deciding on execute. Under dryRun state can't advance, so skip.
        if ((postState === 1 || postState === 2) && input.driveValidatorRound && !input.dryRun) {
          const helpers = await multicall(provider, [
            { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
          ]);
          const validators = helpers[0]!.success ? ((helpers[0]!.value as unknown[])[2] as string) : undefined;
          if (validators) {
            const drive = await driveValidatorRound({
              provider, signer, wc, chainId, govPool, validators, proposalId,
              isVoteFor: input.isVoteFor, signerAddress: user, dryRun: false,
              signerKey: input.signerKey,
            });
            result.steps.push(...drive.steps);
            if (drive.failure) {
              return flowFailureResult({ steps: result.steps, failure: drive.failure }, { proposalId, proposalStateBefore: stateName, voteLanded: true });
            }
            postState = drive.state;
          }
        }
        const postStateName = proposalStateName(postState);

        if (postState === 4 || postState === 5) {
          // SucceededFor or SucceededAgainst — execute through the ONE funnel,
          // which decides the treasury gate and assembles the execute-time
          // advisories BEFORE the broadcast.
          executeDecision = await executeProposal({
            provider,
            signer,
            wc,
            cfg: ctx.config,
            chainId,
            govPool,
            proposalId,
            dryRun: input.dryRun,
            signerKey: input.signerKey,
          });
          if (executeDecision.blocked) {
            // The vote landed; only the execute was refused. Report both.
            return executeBlockedResult(
              executeDecision,
              [...skippedSteps, ...result.steps],
              { proposalId, proposalStateBefore: stateName, voteLanded: true },
            );
          }
          const execResult = executeDecision.result!;
          result.steps.push(...executeDecision.preSteps, ...execResult.steps);
          if (execResult.mode === "failed") {
            // The vote landed; only the execute failed. Surface the ledger AND
            // the execute-time advisories — a #36 revert is explained by them —
            // the proposal stays executable via a re-run or dexe_vote_build_execute.
            return flowFailureResult(
              { steps: result.steps, failure: execResult.failure },
              {
                proposalId,
                proposalStateBefore: stateName,
                voteLanded: true,
                ...executeAdvisoryFields(executeDecision),
              },
            );
          }
          executed = true;
        } else {
          skippedSteps.push({
            label: "GovPool.execute",
            skipped: true,
            reason: `Proposal is "${postStateName}" after your vote — not executable yet.`,
          });
          proposalStateAfter = postStateName;
          postVoteNext = postVoteNextStep(postState, govPool, proposalId, chainId);
          // The tally is what turns "not executable yet" into a number the
          // agent can report. Fail-soft: no row, no tally.
          try {
            const rowRes = await multicall(provider, [
              {
                target: govPool,
                iface: GOV_POOL_ABI,
                method: "getProposals",
                args: [proposalId - 1, 1],
                allowFailure: true,
              },
            ]);
            const rows = rowRes[0]?.success ? (rowRes[0].value as unknown[]) : null;
            const row = Array.isArray(rows) && rows.length > 0 ? decodeProposalView(rows[0]) : null;
            if (row) {
              // GovPoolVote._quorumReached is `for >= required OR against >=
              // required` — the two sides are NOT summed, and either alone can
              // carry it. Reporting only `required - votesFor` would claim a
              // huge shortfall for a proposal about to close on the against side.
              const gap = (v: bigint) => (row.requiredQuorum > v ? row.requiredQuorum - v : 0n);
              tally = {
                votesFor: row.votesFor.toString(),
                votesForHuman: formatUnitsWithSymbol(row.votesFor, d, sym),
                votesAgainst: row.votesAgainst.toString(),
                votesAgainstHuman: formatUnitsWithSymbol(row.votesAgainst, d, sym),
                requiredQuorum: row.requiredQuorum.toString(),
                requiredQuorumHuman: formatUnitsWithSymbol(row.requiredQuorum, d, sym),
                stillNeededForHuman: formatUnitsWithSymbol(gap(row.votesFor), d, sym),
                stillNeededAgainstHuman: formatUnitsWithSymbol(gap(row.votesAgainst), d, sym),
                quorumNote:
                  "Either side alone can carry quorum — GovPool checks votesFor OR votesAgainst against requiredQuorum, never their sum.",
                ...(row.voteEnd
                  ? { votingEndsAt: unixToUtc(row.voteEnd), votingEndsAtUnix: Number(row.voteEnd) }
                  : {}),
              };
            }
          } catch {
            /* best-effort — a missing tally never fails a landed vote */
          }
        }
      }

      return attachPairingQr(ok({
        // Don't report "executed" for a call that broadcast nothing: with the
        // vote skipped and no execute to run, the honest answer is that the
        // vote was already on-chain before this call.
        mode: nothingToBroadcast && !executed ? "already-voted" : result.mode,
        proposalId,
        proposalStateBefore: stateName,
        ...(proposalStateAfter ? { proposalStateAfter } : {}),
        ...(executeDecision ? executeAdvisoryFields(executeDecision) : {}),
        ...previewBlock({
          chainId,
          act:
            (voteAlreadyCast
              ? `Proposal #${proposalId} on ${govPool} already carries this wallet's vote`
              : `Votes ${input.isVoteFor ? "FOR" : "AGAINST"} proposal #${proposalId} on ${govPool} with ` +
                `${formatUnitsWithSymbol(voteAmt, d, sym)}` +
                (depositAmount > 0n
                  ? `, depositing ${formatUnitsWithSymbol(depositAmount, d, sym)} first`
                  : "")) +
            (input.autoExecute ? ", then executes it if it has passed." : "."),
          ...(result.signer ? { who: result.signer } : {}),
          txCount: payloads.length,
          irreversible:
            "A cast vote cannot be changed in one call (GovPool reverts a second vote \"Gov: need cancel\") and an " +
            "executed proposal cannot be un-executed. The tokens voted stay locked against withdrawal until the " +
            "proposal leaves voting.",
          broadcast: result.mode === "executed",
          next:
            postVoteNext ??
            (executed
              ? `Executed. Your deposited tokens stay locked until you withdraw: ${withdrawCallHint({
                  govPool,
                  chainId,
                  receiver: result.signer?.address,
                  amountWei: prereqs.depositedPower > 0n ? prereqs.depositedPower.toString() : undefined,
                })}.`
              : `Track it with dexe_proposal_state {"govPool":"${govPool}","proposalId":${proposalId},"chainId":${chainId}}.`),
        }),
        power: {
          deposited: prereqs.depositedPower.toString(),
          depositedHuman: formatUnitsWithSymbol(prereqs.depositedPower, d, sym),
          wallet: prereqs.walletBalance.toString(),
          walletHuman: formatUnitsWithSymbol(prereqs.walletBalance, d, sym),
          ...votedWithFields(Boolean(voteAlreadyCast), priorVote, voteAmt, d, sym),
          tokenSymbol: sym,
          tokenDecimals: d,
          asOf: "deposited/wallet read before this call's transactions",
        },
        ...(tally ? { tally } : {}),
        steps: [...skippedSteps, ...result.steps],
        ...(result.signer ? { signer: result.signer } : {}),
        ...hotKeySafetyFields(Boolean(result.signer?.safety)),
        executed,
        ...(voteAlreadyCast ? { voteAlreadyCast } : {}),
        ...(voteChangeAdvisory ? { voteChangeAdvisory } : {}),
        ...flowChainFields(
          input.flowContext as FlowContext | undefined,
          state,
          { chainId, govPool },
          { landed: executed },
        ),
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
    }),
  );
}
