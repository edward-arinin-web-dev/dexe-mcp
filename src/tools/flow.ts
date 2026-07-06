import { z } from "zod";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { TxPayload } from "../lib/calldata.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { PinataClient, fetchIpfs, toCidV1 } from "../lib/ipfs.js";
import { buildAvatarUrl, pinAvatarFromInput } from "../lib/avatarUpload.js";
import { checkAvatarCidBytes } from "../lib/imageSniff.js";
import { resolveGateways } from "./ipfs.js";
import { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { qrFallbackUrl, wcQrBlocks, type PairingContent } from "../lib/qr.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { pinataUploadHint } from "../lib/requireEnv.js";
import { runBroadcastGuards } from "../lib/broadcastGuards.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import {
  classifyTreasuryActions,
  quorumPctFromRaw,
  judgeQuorum,
  treasuryExecuteAdvisory,
  TREASURY_RISK_ADVISORY,
  type TreasuryHit,
} from "../lib/quorumRisk.js";
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
import type { StateStore } from "../lib/stateStore.js";

// ---------- ABI fragments ----------

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
  "function createProposal(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function execute(uint256 proposalId)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
  "function editDescriptionURL(string newDescriptionURL)",
  "function getProposalState(uint256 proposalId) view returns (uint8)",
  "function getProposalRequiredQuorum(uint256 proposalId) view returns (uint256)",
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
    return { error: e instanceof Error ? e.message : String(e) };
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

  return { treasuryHits, quorumPct, belowFloor, controllingHoldersVotedFor, reasons };
}

/**
 * Compute a treasury-safety advisory string for an execute step, or null when
 * there's nothing to say. ADVISORY ONLY — never blocks; it surfaces the note and
 * proceeds. Fail-soft on read errors. The durable control is an adequate on-chain
 * quorum threshold configured per DAO.
 */
async function treasuryExecuteGuard(args: {
  provider: JsonRpcProvider;
  govPool: string;
  proposalId: number;
  cfg: DexeConfig;
}): Promise<string | null> {
  if (args.cfg.treasuryGuard === "off") return null;
  const risk = await assessExecuteRisk(args.provider, args.govPool, args.proposalId, args.cfg);
  if ("error" in risk) return `⚠ treasury-risk pre-check skipped: ${risk.error}`;
  if (risk.treasuryHits.length === 0) return null;
  // Treasury-touching with a failing check (low quorum or no controlling
  // participation) → the pointed advisory; otherwise the static one.
  return risk.reasons.length > 0 ? treasuryExecuteAdvisory(risk.reasons) : TREASURY_RISK_ADVISORY;
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

  // Batch 3: ERC20 balance + allowance
  const batch3: Call[] = [
    { target: tokenAddress, iface: ERC20_ABI, method: "balanceOf", args: [user] },
    { target: tokenAddress, iface: ERC20_ABI, method: "allowance", args: [user, userKeeper] },
  ];
  const res3 = await multicall(provider, batch3);

  const walletBalance = res3[0]!.success ? (res3[0]!.value as bigint) : 0n;
  const currentAllowance = res3[1]!.success ? (res3[1]!.value as bigint) : 0n;

  return {
    userKeeper,
    settings,
    tokenAddress,
    walletBalance,
    currentAllowance,
    depositedPower,
    minVotesForCreating: defaultSettings.minVotesForCreating,
    minVotesForVoting: defaultSettings.minVotesForVoting,
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

export async function sendOrCollect(
  signer: SignerManager,
  payloads: TxPayload[],
  opts?: { dryRun?: boolean; chainId?: number; wc?: WalletConnectManager },
): Promise<{
  mode: "executed" | "payloads" | "dryRun" | "failed";
  steps: FlowStep[];
  failure?: FlowFailure;
  enableWrites?: string;
  pairing?: FlowPairing;
  /** QR content blocks (ASCII + PNG) — pass to `attachPairingQr` so the QR renders inline. */
  pairingContent?: PairingContent[];
}> {
  const steps: FlowStep[] = [];

  // `dryRun` and "no signer" both return calldata without broadcasting, but
  // they're tagged distinctly so the swarm orchestrator's mcpFallbackDispatcher
  // (which auto-broadcasts on `mode === "payloads"`) leaves dryRun responses
  // alone. No-signer remains "payloads" so external callers get the same
  // ordered TxPayload contract the public docs promise.
  if (opts?.dryRun) {
    for (const p of payloads) {
      steps.push({ label: p.description, skipped: false, payload: p });
    }
    return { mode: "dryRun", steps };
  }
  if (!signer.hasSigner()) {
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

  const sg = signer.trySigner(opts?.chainId);
  if ("error" in sg) throw new Error(`${sg.error}\n${sg.remediation}`);
  const wallet = sg.ok;
  const cfg = signer.getConfig();
  for (const p of payloads) {
    // Any step failing mid-sequence: STOP (dependent steps must not run on top
    // of unchanged state — R3), report which steps already landed (gas spent),
    // and tell the caller how to resume (R7). Composites re-check completed
    // work (allowance, deposited power, proposal state) on re-run, so "fix the
    // cause and re-run this same call" is the correct resume for every flow.
    try {
      // Same B6/B7/B10 broadcast guards as dexe_tx_send. B9 simulation is skipped:
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
      const tx = await signer.withBroadcastLock(Number(p.chainId), () =>
        wallet.sendTransaction({
          to: p.to,
          data: p.data,
          value: BigInt(p.value),
          chainId: BigInt(p.chainId),
        }),
      );
      const receipt = await waitWithTimeout(tx, { timeoutMs: txWaitTimeoutMs() });
      assertReceiptSuccess(receipt, p.description);
      steps.push({
        label: p.description,
        skipped: false,
        txHash: receipt?.hash ?? tx.hash,
      });
    } catch (e) {
      const landed = steps.filter((s) => s.txHash);
      const actionable = toActionableError(e, p.description);
      return {
        mode: "failed",
        steps,
        failure: {
          failedStep: p.description,
          error: actionable.message,
          landedSteps: landed,
          resume:
            landed.length > 0
              ? `${landed.length} earlier step(s) already landed on-chain (see landedSteps txHashes). ` +
                "Fix the cause above and re-run this same call — already-satisfied steps (approve / deposit / vote) " +
                "are detected on-chain and skipped automatically."
              : "No steps landed on-chain. Fix the cause above and re-run this same call.",
        },
      };
    }
  }
  return { mode: "executed", steps };
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
  /** When true, return ordered TxPayloads even if a signer is configured. */
  dryRun?: boolean;
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

      if (!ctx.config.pinataJwt) return err(pinataUploadHint("to create a proposal"));

      const user = input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!user) return err("Provide 'user' address or set DEXE_PRIVATE_KEY.");

      const pinata = new PinataClient(ctx.config.pinataJwt);
      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const govPool = input.govPool;

      // Step 1: resolve prerequisites
      let prereqs: Prereqs;
      try {
        prereqs = await resolvePrereqs(rpc, govPool, user, ctx.config, chainId);
      } catch (e) {
        return err(`Failed to resolve prerequisites: ${e instanceof Error ? e.message : String(e)}`);
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
        return err(
          `Insufficient tokens for proposal creation. Need ${prereqs.minVotesForCreating} but have ${totalAvailable} (wallet: ${prereqs.walletBalance}, deposited: ${prereqs.depositedPower}).`,
        );
      }

      // Step 3: build actions + metadata based on type
      let actionsOnFor: Array<{ executor: string; value: bigint; data: string }>;
      let proposalExtra: Record<string, unknown>;

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
            currentMetaFetchError = e instanceof Error ? e.message : String(e);
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
          const descRes = await pinata.pinJson(descSlate, { name: `dao-desc:${govPool.slice(0, 10)}` });
          descriptionRef = `ipfs://${descRes.cid}`;
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
          const pinned = await pinAvatarFromInput({
            filePath: input.newAvatarPath,
            base64: input.newAvatarBase64,
            pinata,
          });
          daoMeta.avatarCID = pinned.avatarCID;
          daoMeta.avatarFileName = pinned.avatarFileName;
          daoMeta.avatarUrl = pinned.avatarUrl;
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
        const daoMetaRes = await pinata.pinJson(daoMeta, { name: `dao-meta:${govPool.slice(0, 10)}` });
        const newDescriptionURL = `ipfs://${daoMetaRes.cid}`;

        actionsOnFor = [{
          executor: govPool,
          value: 0n,
          data: GOV_POOL_ABI.encodeFunctionData("editDescriptionURL", [newDescriptionURL]),
        }];

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
          return err(`Failed to build ${input.proposalType} actions: ${e instanceof Error ? e.message : String(e)}`);
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
      const proposalMetaRes = await pinata.pinJson(proposalMeta, { name: `proposal:${input.title.slice(0, 30)}` });
      const descriptionURL = `ipfs://${proposalMetaRes.cid}`;

      // Step 5: build tx payloads
      const payloads: TxPayload[] = [];
      const skippedSteps: FlowStep[] = [];

      // Determine how much to deposit
      const voteAmount = input.voteAmount ? BigInt(input.voteAmount) : prereqs.depositedPower + prereqs.walletBalance;
      if (voteAmount === 0n) {
        return err("No voting power available (wallet + deposited = 0). Deposit tokens first.");
      }
      const needDeposit = voteAmount > prereqs.depositedPower ? voteAmount - prereqs.depositedPower : 0n;

      if (needDeposit > prereqs.walletBalance) {
        return err(
          `Need to deposit ${needDeposit} but wallet only has ${prereqs.walletBalance}. Missing ${needDeposit - prereqs.walletBalance}.`,
        );
      }

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

      // Build GovPool calls to batch via multicall
      const govPoolCalls: string[] = [];

      // Deposit (if needed)
      if (needDeposit > 0n) {
        govPoolCalls.push(
          GOV_POOL_ABI.encodeFunctionData("deposit", [needDeposit, []]),
        );
      } else {
        skippedSteps.push({ label: "GovPool.deposit", skipped: true, reason: "Sufficient deposited power" });
      }

      // createProposalAndVote
      const actionsForTuple = actionsOnFor.map(a => [a.executor, a.value, a.data]);
      govPoolCalls.push(
        GOV_POOL_ABI.encodeFunctionData("createProposalAndVote", [
          descriptionURL,
          actionsForTuple,
          [], // actionsOnAgainst
          voteAmount,
          input.voteNftIds.map(id => BigInt(id)),
        ]),
      );

      // Wrap in multicall if >1 call, otherwise single tx
      if (govPoolCalls.length > 1) {
        payloads.push({
          to: govPool,
          data: GOV_POOL_ABI.encodeFunctionData("multicall", [govPoolCalls]),
          value: "0",
          chainId,
          description: `GovPool.multicall([deposit, createProposalAndVote])`,
        });
      } else {
        payloads.push({
          to: govPool,
          data: govPoolCalls[0]!,
          value: "0",
          chainId,
          description: `GovPool.createProposalAndVote("${input.title}")`,
        });
      }

      // Step 6: send or return
      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc: deps.wc });
      if (result.mode === "failed") {
        return flowFailureResult(result, { descriptionURL, proposalMetadataCID: proposalMetaRes.cid });
      }

      // Phase 3: record a broadcast proposal so dexe_context surfaces it next
      // session. Best-effort — a state-write error never breaks the broadcast.
      if (result.mode === "executed" && deps.state) {
        try {
          const txHash = [...result.steps].reverse().find((s) => s.txHash)?.txHash;
          deps.state.recordProposal({
            govPool,
            chainId,
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
          descriptionURL,
          proposalMetadataCID: proposalMetaRes.cid,
          prereqs: {
            walletBalance: prereqs.walletBalance.toString(),
            depositedPower: prereqs.depositedPower.toString(),
            allowance: prereqs.currentAllowance.toString(),
            minVotesForCreating: prereqs.minVotesForCreating.toString(),
            tokenAddress: prereqs.tokenAddress,
          },
          steps: [...skippedSteps, ...result.steps],
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
  if (!ctx.config.pinataJwt) return err(pinataUploadHint("to create an internal proposal"));

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
    return err(e instanceof Error ? e.message : String(e));
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
  const pinata = new PinataClient(ctx.config.pinataJwt);
  const proposalMeta = {
    proposalName: input.title,
    proposalDescription: JSON.stringify(markdownToSlate(input.description)),
    category: built.category,
    ...built.metadataExtra,
  };
  let cid: string;
  try {
    const res = await pinata.pinJson(proposalMeta, { name: `proposal:${input.title.slice(0, 30)}` });
    cid = res.cid;
  } catch (e) {
    return err(toActionableError(e, "upload internal-proposal metadata").message);
  }
  const descriptionURL = `ipfs://${cid}`;

  const validatorsIface = new Interface(GOV_VALIDATORS_CREATE_ABI as unknown as string[]);
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

  const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc: deps.wc });
  if (result.mode === "failed") {
    return flowFailureResult(result, {
      proposalKind: "internal",
      descriptionURL,
      note: "Internal proposals can only be created by a CURRENT validator of this DAO — a non-validator sender reverts.",
    });
  }

  if (result.mode === "executed" && deps.state) {
    try {
      const txHash = [...result.steps].reverse().find((s) => s.txHash)?.txHash;
      deps.state.recordProposal({
        govPool,
        chainId,
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
      descriptionURL,
      proposalMetadataCID: cid,
      summary: built.summary,
      steps: result.steps,
      note:
        "Internal proposals are created and voted on by the DAO's validators only (their own validator balances — " +
        "no token deposit). The sender must be a current validator or the tx reverts.",
      ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
      ...(result.pairing ? { pairing: result.pairing } : {}),
    }),
    result.pairingContent,
  );
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
    "Create ANY governance proposal in ONE call — handles the whole approve→deposit→createProposalAndVote " +
      "sequence, uploads correct IPFS metadata (category/isMeta/changes), signs+broadcasts when a signer is " +
      "configured (else returns ordered TxPayloads + a WalletConnect QR).\n\n" +
      "proposalType (every DeXe catalog type is wired):\n" +
      "• 'modify_dao_profile' — top-level fields (newDaoName/newDaoDescription/newWebsiteUrl/newSocialLinks; avatar via " +
      "newAvatarPath — a local image path the server uploads itself — or newAvatarCID).\n" +
      "• 'custom' — your own actionsOnFor [{executor,value,data}] (+ optional category).\n" +
      "• On-chain external types (inputs go in `params`): 'token_transfer' {token,recipient,amount,isNative?}, " +
      "'withdraw_treasury' {receiver,token?,amount?,nftAddress?,nftIds?}, 'change_voting_settings' {govSettings,settings[],settingsIds?}, " +
      "'add_expert'/'remove_expert' {expertNftContract,scope,nominatedUser,uri?}, 'token_distribution', 'token_sale', " +
      "'token_sale_whitelist' {tokenSaleProposal,requests[]}, 'token_sale_recover' {tokenSaleProposal,tierIds[]}, " +
      "'manage_validators'/'validators_allocation' {govValidators,changes[{user,balance}]}, " +
      "'delegate_to_expert'/'revoke_from_expert' {expert,amount,nftIds?}, 'create_staking_tier', " +
      "'change_math_model' {newVotePower}, 'blacklist' {erc20Gov,addAddresses?,removeAddresses?}, " +
      "'reward_multiplier' {mode,...}, 'apply_to_dao' {token,receiver,amount,treasuryBalance?}, " +
      "'new_proposal_type'/'enable_staking' {govSettings,settings,executors,newSettingId}, 'custom_abi' {target,signature,method,args?}.\n" +
      "• Internal (validators-only, auto-routed to GovValidators.createInternalProposal): " +
      "'change_validator_balances' {changes[]}, 'change_validator_settings' {duration,executionDelay,quorum}, " +
      "'monthly_withdraw' {withdrawals[],destination}, 'offchain_internal_proposal' {}.\n" +
      "• Off-chain backend types ('offchain_single_option' etc.) are rejected with the exact backend flow to use instead.\n" +
      "Full per-type recipes with examples: docs/PLAYBOOK.md (dexe://playbook resource) or dexe_proposal_catalog.",
    {
      govPool: z.string().describe("GovPool contract address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target chain id. Defaults to the MCP's default chain. Rejects if no RPC is configured for the requested chain.",
        ),
      proposalType: z
        .enum(FLOW_PROPOSAL_TYPES as unknown as [string, ...string[]])
        .default("custom")
        .describe(
          "One of the wired types listed in the tool description. Unknown values are rejected with the valid list.",
        ),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Type-specific builder inputs for the chosen proposalType (recipes: tool description / dexe://playbook)."),
      title: z.string().describe("Proposal title"),
      description: z.string().default("").describe("Proposal description (markdown supported)"),
      newDaoName: z.string().optional(),
      newDaoDescription: z.string().optional(),
      newWebsiteUrl: z.string().optional(),
      newAvatarCID: z.string().optional(),
      newAvatarFileName: z.string().optional(),
      newAvatarPath: z.string().optional().describe(
        "Local image path for the new avatar (JPEG/PNG/WebP/GIF, max 10 MB) — the server uploads + validates it. " +
        "Preferred over reading the file yourself; replaces the separate dexe_ipfs_upload_avatar call.",
      ),
      newAvatarBase64: z.string().optional().describe("Base64 image bytes — only when the image isn't a local file."),
      newSocialLinks: z.array(z.tuple([z.string(), z.string()])).optional(),
      actionsOnFor: z.array(z.object({
        executor: z.string(),
        value: z.string().default("0"),
        data: z.string(),
      })).default([]).describe("Actions for custom proposals"),
      category: z.string().optional().describe("Proposal category (included in IPFS metadata)."),
      proposalMetadataExtra: z.record(z.unknown()).optional().describe("Extra fields merged into IPFS metadata."),
      voteAmount: z.string().optional().describe("Auto-vote amount (18-dec wei). Defaults to all deposited power."),
      voteNftIds: z.array(z.string()).default([]),
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
    },
    (input) => runProposalCreate(input as ProposalCreateInput, { ctx, signer, rpc, state, wc }),
  );

  // =============================================
  // dexe_proposal_vote_and_execute
  // =============================================
  server.tool(
    "dexe_proposal_vote_and_execute",
    "Vote on a proposal and optionally execute it. " +
      "Checks proposal state, deposits tokens if needed, votes, and when autoExecute is true " +
      "attempts to execute after voting. When DEXE_PRIVATE_KEY is set, signs and broadcasts. " +
      "Otherwise returns ordered TxPayload list.",
    {
      govPool: z.string().describe("GovPool contract address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target chain id. Defaults to the MCP's default chain. Rejects if no RPC is configured for the requested chain.",
        ),
      proposalId: z.number().int().min(1).describe("Proposal ID (1-indexed)"),
      isVoteFor: z.boolean().default(true).describe("Vote for (true) or against (false)"),
      voteAmount: z.string().optional().describe("Vote amount (18-dec wei). Defaults to all deposited power."),
      voteNftIds: z.array(z.string()).default([]),
      depositFirst: z.boolean().default(false).describe("Deposit wallet tokens before voting"),
      autoExecute: z.boolean().default(true).describe("Attempt execute if proposal passes after vote"),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set (preview without broadcasting)."),
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
    },
    async (input) => {
      const user = input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
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
        const treasuryRisk = await treasuryExecuteGuard({
          provider,
          govPool,
          proposalId,
          cfg: ctx.config,
        });
        const execResult = await sendOrCollect(signer, [
          makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
        ], { dryRun: input.dryRun, chainId, wc });
        if (execResult.mode === "failed") {
          return flowFailureResult(execResult, { proposalId, proposalStateBefore: stateName });
        }
        return attachPairingQr(ok({
          mode: execResult.mode,
          proposalId,
          proposalStateBefore: stateName,
          ...(treasuryRisk ? { treasuryRisk } : {}),
          steps: [
            { label: "GovPool.vote", skipped: true, reason: `Proposal already in "${stateName}" — no vote needed` },
            ...execResult.steps,
          ],
          executed: execResult.mode === "executed",
          ...(execResult.enableWrites ? { enableWrites: execResult.enableWrites } : {}),
          ...(execResult.pairing ? { pairing: execResult.pairing } : {}),
        }), execResult.pairingContent);
      }

      if (stateNum !== 0) {
        return err(`Proposal #${proposalId} is in state "${stateName}" — voting requires "Voting" state.`);
      }

      // Step 2: resolve prereqs for deposit check
      let prereqs: Prereqs | undefined;
      if (input.depositFirst) {
        prereqs = await resolvePrereqs(rpc, govPool, user, ctx.config, chainId);
      }

      const payloads: TxPayload[] = [];
      const skippedSteps: FlowStep[] = [];

      // Step 3: optional deposit
      if (input.depositFirst && prereqs && prereqs.walletBalance > 0n) {
        // Approve if needed
        if (prereqs.currentAllowance < prereqs.walletBalance) {
          // W10: exact-amount approve, never MAX_UINT256.
          payloads.push(makeTxPayload(
            prereqs.tokenAddress, ERC20_ABI, "approve",
            [prereqs.userKeeper, prereqs.walletBalance], chainId,
            `ERC20.approve(${prereqs.userKeeper}, ${prereqs.walletBalance})`,
          ));
        }
        // Deposit
        payloads.push(makeTxPayload(
          govPool, GOV_POOL_ABI, "deposit",
          [prereqs.walletBalance, []], chainId,
          `GovPool.deposit(${prereqs.walletBalance})`,
        ));
      }

      // Step 4: vote
      const voteAmt = input.voteAmount
        ? BigInt(input.voteAmount)
        : (prereqs ? prereqs.depositedPower + prereqs.walletBalance : 0n);

      if (voteAmt === 0n) {
        return err("No voting power available. Deposit tokens before voting.");
      }

      // Check minVotesForVoting threshold
      if (!prereqs && !input.voteAmount) {
        // Need prereqs to validate threshold — fetch them
        prereqs = await resolvePrereqs(rpc, govPool, user, ctx.config, chainId);
      }
      if (prereqs && prereqs.minVotesForVoting > 0n && voteAmt < prereqs.minVotesForVoting) {
        return err(
          `Insufficient voting power. Need ${prereqs.minVotesForVoting} but voting with ${voteAmt}.`,
        );
      }

      payloads.push(makeTxPayload(
        govPool, GOV_POOL_ABI, "vote",
        [proposalId, input.isVoteFor, voteAmt, input.voteNftIds.map(id => BigInt(id))],
        chainId,
        `GovPool.vote(${proposalId}, ${input.isVoteFor}, ${voteAmt})`,
      ));

      // Step 5: send or collect
      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc });
      if (result.mode === "failed") {
        return flowFailureResult(result, { proposalId, proposalStateBefore: stateName });
      }

      // Step 6: auto-execute (only in executed mode)
      let executed = false;
      if (input.autoExecute && result.mode === "executed") {
        // Re-read state after vote
        const postRes = await multicall(provider, [
          { target: govPool, iface: GOV_POOL_ABI, method: "getProposalState", args: [proposalId] },
        ]);
        const postState = Number(postRes[0]!.value);
        const postStateName = proposalStateName(postState);

        if (postState === 4 || postState === 5) {
          // SucceededFor or SucceededAgainst — execute (attach treasury advisory).
          const treasuryRisk = await treasuryExecuteGuard({
            provider,
            govPool,
            proposalId,
            cfg: ctx.config,
          });
          if (treasuryRisk) {
            skippedSteps.push({ label: "treasury-risk", skipped: true, reason: treasuryRisk });
          }
          const execResult = await sendOrCollect(signer, [
            makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
          ], { dryRun: input.dryRun, chainId, wc });
          result.steps.push(...execResult.steps);
          if (execResult.mode === "failed") {
            // The vote landed; only the execute failed. Surface the ledger —
            // the proposal stays executable via a re-run or dexe_vote_build_execute.
            return flowFailureResult(
              { steps: result.steps, failure: execResult.failure },
              { proposalId, proposalStateBefore: stateName, voteLanded: true },
            );
          }
          executed = true;
        } else {
          skippedSteps.push({
            label: "GovPool.execute",
            skipped: true,
            reason: `Proposal in state "${postStateName}" after vote — not ready for execution`,
          });
        }
      }

      return attachPairingQr(ok({
        mode: result.mode,
        proposalId,
        proposalStateBefore: stateName,
        steps: [...skippedSteps, ...result.steps],
        executed,
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
    },
  );
}
