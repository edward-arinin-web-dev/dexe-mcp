import { z } from "zod";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { TxPayload } from "../lib/calldata.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { PinataClient, fetchIpfs } from "../lib/ipfs.js";
import { SignerManager } from "../lib/signer.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { runBroadcastGuards } from "../lib/broadcastGuards.js";
import { AddressBook, CONTRACT_NAMES } from "../lib/addresses.js";
import {
  classifyTreasuryActions,
  quorumPctFromRaw,
  judgeQuorum,
  executeRiskRefusal,
  TREASURY_RISK_ADVISORY,
  type TreasuryHit,
} from "../lib/quorumRisk.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";

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

function makeTxPayload(to: string, iface: Interface, method: string, args: unknown[], chainId: number, description: string, value?: bigint): TxPayload {
  return {
    to,
    data: iface.encodeFunctionData(method, args),
    value: (value ?? 0n).toString(),
    chainId,
    description,
  };
}

// ---------- treasury-drain execute gate (Layer 5) ----------

interface ExecuteRisk {
  treasuryHits: TreasuryHit[];
  quorumPct: number;
  belowFloor: boolean;
  /** Whether a controlling member (founder/validator/top holder) voted For. null = unknown (no subgraph / testnet). */
  controllingHoldersVotedFor: boolean | null;
  shouldRefuse: boolean;
  reasons: string[];
}

/**
 * Read a proposal's on-chain `actionsOnFor` + its own quorum setting and judge
 * treasury-drain risk. Pure-ish: one getProposals read, then quorumRisk logic.
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

  // Founder/validator participation is subgraph/mainnet-only — unknown here.
  // null is deliberately NOT treated as a refuse trigger (absence ≠ unsafe).
  const controllingHoldersVotedFor: boolean | null = null;

  const shouldRefuse =
    treasuryHits.length > 0 && (belowFloor || controllingHoldersVotedFor === false);

  return { treasuryHits, quorumPct, belowFloor, controllingHoldersVotedFor, shouldRefuse, reasons };
}

/**
 * Decide whether to BLOCK an execute step or just attach a warning. Blocks only
 * when the guard is enabled, the proposal would actually broadcast, the risk
 * warrants refusal, and the caller has not passed acknowledgeRisk. Fail-soft on
 * read errors (warn, never block).
 */
async function treasuryExecuteGuard(args: {
  provider: JsonRpcProvider;
  govPool: string;
  proposalId: number;
  cfg: DexeConfig;
  wouldBroadcast: boolean;
  acknowledgeRisk: boolean;
}): Promise<{ blocked: true; message: string } | { blocked: false; warning: string | null }> {
  if (args.cfg.treasuryGuard === "off") return { blocked: false, warning: null };
  const risk = await assessExecuteRisk(args.provider, args.govPool, args.proposalId, args.cfg);
  if ("error" in risk) {
    return { blocked: false, warning: `⚠ treasury-risk pre-check skipped: ${risk.error}` };
  }
  if (risk.treasuryHits.length === 0) return { blocked: false, warning: null };
  if (risk.shouldRefuse) {
    if (args.wouldBroadcast && !args.acknowledgeRisk) {
      return { blocked: true, message: executeRiskRefusal(risk.reasons) };
    }
    // Acknowledged, or dry-run preview — proceed but surface the refusal text.
    return { blocked: false, warning: `⚠ ${executeRiskRefusal(risk.reasons)}` };
  }
  // Treasury-touching but quorum healthy → advisory only.
  return { blocked: false, warning: TREASURY_RISK_ADVISORY };
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

export async function sendOrCollect(
  signer: SignerManager,
  payloads: TxPayload[],
  opts?: { dryRun?: boolean; chainId?: number },
): Promise<{ mode: "executed" | "payloads" | "dryRun"; steps: FlowStep[] }> {
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
    return { mode: "payloads", steps };
  }

  const sg = signer.trySigner(opts?.chainId);
  if ("error" in sg) throw new Error(`${sg.error}\n${sg.remediation}`);
  const wallet = sg.ok;
  const cfg = signer.getConfig();
  for (const p of payloads) {
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
    const receipt = await tx.wait(1);
    steps.push({
      label: p.description,
      skipped: false,
      txHash: receipt?.hash ?? tx.hash,
    });
  }
  return { mode: "executed", steps };
}

// ---------- exported runner ----------

export interface ProposalCreateInput {
  govPool: string;
  /** Target chain id. Defaults to the MCP's default chain. */
  chainId?: number;
  proposalType?: "modify_dao_profile" | "custom";
  title: string;
  description?: string;
  newDaoName?: string;
  newDaoDescription?: string;
  newWebsiteUrl?: string;
  newAvatarCID?: string;
  newAvatarFileName?: string;
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
    proposalType: "custom" as const,
    description: "",
    actionsOnFor: [] as { executor: string; value?: string; data: string }[],
    voteNftIds: [] as string[],
    ...inputRaw,
  };
  const { ctx, signer, rpc } = deps;
      if (!ctx.config.pinataJwt) return err("DEXE_PINATA_JWT required for proposal creation (IPFS metadata upload).");

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
            "(newDaoName, newWebsiteUrl, newDaoDescription, newSocialLinks, newAvatarCID/newAvatarFileName).",
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
        if (input.newAvatarCID) {
          daoMeta.avatarCID = input.newAvatarCID;
          daoMeta.avatarFileName = input.newAvatarFileName ?? "avatar.jpeg";
          // dweb.link + path-style resolves directory pins reliably across
          // gateways. The frontend rebuilds the URL itself (see
          // parseAvatarFromIpfsResponse) so the field is informational only,
          // but the CID + filename pair is load-bearing.
          daoMeta.avatarUrl = `https://${input.newAvatarCID}.ipfs.dweb.link/${daoMeta.avatarFileName}`;
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
      } else {
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
      }

      // Step 4: upload proposal metadata (field names must match frontend exactly)
      const proposalMeta = {
        proposalName: input.title,
        proposalDescription: JSON.stringify(markdownToSlate(input.description)),
        ...proposalExtra,
      };
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
      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId });

      return ok({
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
      });
}

// ---------- register ----------

export function registerFlowTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_proposal_create — thin shim around runProposalCreate
  // =============================================
  server.tool(
    "dexe_proposal_create",
    "Create a governance proposal with full prerequisite handling. " +
      "Automatically checks token balance, approves if needed, deposits if needed, " +
      "uploads metadata to IPFS (with correct category/changes fields), and builds " +
      "createProposalAndVote calldata. When DEXE_PRIVATE_KEY is set, signs and broadcasts " +
      "all transactions. Otherwise returns ordered TxPayload list.\n\n" +
      "Supported proposalType values: 'modify_dao_profile', 'custom'.\n\n" +
      "For modify_dao_profile: provide newDaoDescription and/or newAvatarCID to change the DAO profile. " +
      "Tool encodes editDescriptionURL action and uploads both DAO metadata and proposal metadata to IPFS.\n\n" +
      "For custom: provide actionsOnFor array with {executor, value, data} objects.",
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
      proposalType: z.enum(["modify_dao_profile", "custom"]).default("custom"),
      title: z.string().describe("Proposal title"),
      description: z.string().default("").describe("Proposal description (markdown supported)"),
      newDaoName: z.string().optional(),
      newDaoDescription: z.string().optional(),
      newWebsiteUrl: z.string().optional(),
      newAvatarCID: z.string().optional(),
      newAvatarFileName: z.string().optional(),
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
    (input) => runProposalCreate(input as ProposalCreateInput, { ctx, signer, rpc }),
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
      acknowledgeRisk: z
        .boolean()
        .default(false)
        .describe(
          "Override the treasury-drain execute gate. When DEXE_TREASURY_GUARD is not 'off', the tool refuses to broadcast an execute for a treasury-touching proposal whose quorum is below DEXE_MIN_SAFE_QUORUM_PCT; set true to execute anyway (you accept the drain risk).",
        ),
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

      const STATE_NAMES = ["Voting", "WaitingForVotingTransfer", "ValidatorVoting", "Defeated", "SucceededFor", "SucceededAgainst", "Locked", "ExecutedFor", "ExecutedAgainst", "Undefined"];
      const stateNum = Number(stateRes[0]!.value);
      const stateName = STATE_NAMES[stateNum] ?? `Unknown(${stateNum})`;

      // Already past voting — skip vote, go straight to execute. State 4 =
      // SucceededFor, 5 = SucceededAgainst, 6 = Locked (post-quorum, post-
      // validator window if any, executable once delay elapsed). When the
      // open_sale composite votes with enough power to clear quorum +
      // earlyCompletion, the proposal lands directly in Locked, so we must
      // recognize it here as executable.
      if ((stateNum === 4 || stateNum === 5 || stateNum === 6) && input.autoExecute) {
        const guard = await treasuryExecuteGuard({
          provider,
          govPool,
          proposalId,
          cfg: ctx.config,
          wouldBroadcast: signer.hasSigner() && !input.dryRun,
          acknowledgeRisk: input.acknowledgeRisk,
        });
        if (guard.blocked) return err(guard.message);
        const execResult = await sendOrCollect(signer, [
          makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
        ], { dryRun: input.dryRun, chainId });
        return ok({
          mode: execResult.mode,
          proposalId,
          proposalStateBefore: stateName,
          ...(guard.warning ? { treasuryRisk: guard.warning } : {}),
          steps: [
            { label: "GovPool.vote", skipped: true, reason: `Proposal already in "${stateName}" — no vote needed` },
            ...execResult.steps,
          ],
          executed: execResult.mode === "executed",
        });
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
      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId });

      // Step 6: auto-execute (only in executed mode)
      let executed = false;
      if (input.autoExecute && result.mode === "executed") {
        // Re-read state after vote
        const postRes = await multicall(provider, [
          { target: govPool, iface: GOV_POOL_ABI, method: "getProposalState", args: [proposalId] },
        ]);
        const postState = Number(postRes[0]!.value);
        const postStateName = STATE_NAMES[postState] ?? `Unknown(${postState})`;

        if (postState === 4 || postState === 5) {
          // SucceededFor or SucceededAgainst — execute (treasury-drain gate first)
          const guard = await treasuryExecuteGuard({
            provider,
            govPool,
            proposalId,
            cfg: ctx.config,
            wouldBroadcast: signer.hasSigner() && !input.dryRun,
            acknowledgeRisk: input.acknowledgeRisk,
          });
          if (guard.blocked) {
            // Vote already sent; refuse only the execute step and report why.
            return ok({
              mode: result.mode,
              proposalId,
              proposalStateBefore: stateName,
              treasuryRisk: guard.message,
              steps: [
                ...skippedSteps,
                ...result.steps,
                { label: "GovPool.execute", skipped: true, reason: guard.message },
              ],
              executed: false,
            });
          }
          if (guard.warning) {
            skippedSteps.push({ label: "treasury-risk", skipped: true, reason: guard.warning });
          }
          const execResult = await sendOrCollect(signer, [
            makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
          ], { dryRun: input.dryRun, chainId });
          result.steps.push(...execResult.steps);
          executed = true;
        } else {
          skippedSteps.push({
            label: "GovPool.execute",
            skipped: true,
            reason: `Proposal in state "${postStateName}" after vote — not ready for execution`,
          });
        }
      }

      return ok({
        mode: result.mode,
        proposalId,
        proposalStateBefore: stateName,
        steps: [...skippedSteps, ...result.steps],
        executed,
      });
    },
  );
}
