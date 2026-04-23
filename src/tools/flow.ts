import { z } from "zod";
import { Interface, MaxUint256 } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { TxPayload } from "../lib/calldata.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { PinataClient } from "../lib/ipfs.js";
import { SignerManager } from "../lib/signer.js";
import { markdownToSlate } from "../lib/markdownToSlate.js";

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

async function resolvePrereqs(
  rpc: RpcProvider,
  govPool: string,
  user: string,
): Promise<Prereqs> {
  const provider = rpc.requireProvider();

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

async function sendOrCollect(
  signer: SignerManager,
  payloads: TxPayload[],
): Promise<{ mode: "executed" | "payloads"; steps: FlowStep[] }> {
  const steps: FlowStep[] = [];

  if (!signer.hasSigner()) {
    for (const p of payloads) {
      steps.push({ label: p.description, skipped: false, payload: p });
    }
    return { mode: "payloads", steps };
  }

  const wallet = signer.requireSigner();
  for (const p of payloads) {
    const tx = await wallet.sendTransaction({
      to: p.to,
      data: p.data,
      value: BigInt(p.value),
      chainId: BigInt(p.chainId),
    });
    const receipt = await tx.wait(1);
    steps.push({
      label: p.description,
      skipped: false,
      txHash: receipt?.hash ?? tx.hash,
    });
  }
  return { mode: "executed", steps };
}

// ---------- register ----------

export function registerFlowTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_proposal_create
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
      proposalType: z.enum(["modify_dao_profile", "custom"]).default("custom"),
      title: z.string().describe("Proposal title"),
      description: z.string().default("").describe("Proposal description (markdown supported)"),

      // modify_dao_profile fields
      newDaoName: z.string().optional().describe("New DAO name (for modify_dao_profile)"),
      newDaoDescription: z.string().optional().describe("New DAO description markdown"),
      newWebsiteUrl: z.string().optional().describe("New website URL"),
      newAvatarCID: z.string().optional().describe("CID of avatar image (from dexe_ipfs_upload_file)"),
      newAvatarFileName: z.string().optional().describe("Avatar filename e.g. 'avatar.jpeg'"),
      newSocialLinks: z.array(z.tuple([z.string(), z.string()])).optional(),

      // custom fields
      actionsOnFor: z.array(z.object({
        executor: z.string(),
        value: z.string().default("0"),
        data: z.string(),
      })).default([]).describe("Actions for custom proposals"),
      category: z.string().optional().describe("Proposal category (e.g. 'Token Transfer', 'Change Voting Settings'). Included in IPFS metadata."),
      proposalMetadataExtra: z.record(z.unknown()).optional().describe("Extra fields merged into IPFS metadata (e.g. changes, isMeta). From dexe_proposal_build_* output."),

      // voting
      voteAmount: z.string().optional().describe("Auto-vote amount (18-dec wei). Defaults to all deposited power."),
      voteNftIds: z.array(z.string()).default([]),

      // override
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
    },
    async (input) => {
      if (!ctx.config.pinataJwt) return err("DEXE_PINATA_JWT required for proposal creation (IPFS metadata upload).");

      const user = input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!user) return err("Provide 'user' address or set DEXE_PRIVATE_KEY.");

      const pinata = new PinataClient(ctx.config.pinataJwt);
      const chainId = ctx.config.chainId;
      const govPool = input.govPool;

      // Step 1: resolve prerequisites
      let prereqs: Prereqs;
      try {
        prereqs = await resolvePrereqs(rpc, govPool, user);
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
        // Upload new DAO metadata
        const descSlate = markdownToSlate(input.newDaoDescription ?? input.description ?? "");
        const descRes = await pinata.pinJson(descSlate, { name: `dao-desc:${govPool.slice(0, 10)}` });

        const daoMeta: Record<string, unknown> = {
          daoName: input.newDaoName ?? "",
          websiteUrl: input.newWebsiteUrl ?? "",
          description: `ipfs://${descRes.cid}`,
          socialLinks: input.newSocialLinks ?? [],
          documents: [],
        };
        if (input.newAvatarCID) {
          daoMeta.avatarCID = input.newAvatarCID;
          daoMeta.avatarFileName = input.newAvatarFileName ?? "avatar";
          daoMeta.avatarUrl = `https://${input.newAvatarCID}.ipfs.4everland.io/${daoMeta.avatarFileName}`;
        }
        const daoMetaRes = await pinata.pinJson(daoMeta, { name: `dao-meta:${govPool.slice(0, 10)}` });
        const newDescriptionURL = `ipfs://${daoMetaRes.cid}`;

        // Read current descriptionURL for "currentChanges"
        let currentDescriptionURL = "";
        try {
          const provider = rpc.requireProvider();
          const descIface = new Interface(["function descriptionURL() view returns (string)"]);
          const batch: Call[] = [{ target: govPool, iface: descIface, method: "descriptionURL", args: [] }];
          const res = await multicall(provider, batch);
          if (res[0]!.success) currentDescriptionURL = res[0]!.value as string;
        } catch { /* best effort */ }

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
          value: BigInt(a.value),
          data: a.data,
        }));
        proposalExtra = {
          ...(input.category ? { category: input.category } : {}),
          isMeta: false,
          ...(input.proposalMetadataExtra ?? {}),
        };
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
        payloads.push(makeTxPayload(
          prereqs.tokenAddress, ERC20_ABI, "approve",
          [prereqs.userKeeper, MaxUint256], chainId,
          `ERC20.approve(${prereqs.userKeeper}, MAX_UINT256)`,
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
      const result = await sendOrCollect(signer, payloads);

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
    },
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
      proposalId: z.number().int().min(1).describe("Proposal ID (1-indexed)"),
      isVoteFor: z.boolean().default(true).describe("Vote for (true) or against (false)"),
      voteAmount: z.string().optional().describe("Vote amount (18-dec wei). Defaults to all deposited power."),
      voteNftIds: z.array(z.string()).default([]),
      depositFirst: z.boolean().default(false).describe("Deposit wallet tokens before voting"),
      autoExecute: z.boolean().default(true).describe("Attempt execute if proposal passes after vote"),
      user: z.string().optional().describe("User address. Required when DEXE_PRIVATE_KEY not set."),
    },
    async (input) => {
      const user = input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!user) return err("Provide 'user' address or set DEXE_PRIVATE_KEY.");

      const provider = rpc.requireProvider();
      const chainId = ctx.config.chainId;
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

      // Already succeeded — skip voting, go straight to execute
      if ((stateNum === 4 || stateNum === 5) && input.autoExecute) {
        const execResult = await sendOrCollect(signer, [
          makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
        ]);
        return ok({
          mode: execResult.mode,
          proposalId,
          proposalStateBefore: stateName,
          steps: [
            { label: "GovPool.vote", skipped: true, reason: `Proposal already in "${stateName}" — no vote needed` },
            ...execResult.steps,
          ],
          executed: true,
        });
      }

      if (stateNum !== 0) {
        return err(`Proposal #${proposalId} is in state "${stateName}" — voting requires "Voting" state.`);
      }

      // Step 2: resolve prereqs for deposit check
      let prereqs: Prereqs | undefined;
      if (input.depositFirst) {
        prereqs = await resolvePrereqs(rpc, govPool, user);
      }

      const payloads: TxPayload[] = [];
      const skippedSteps: FlowStep[] = [];

      // Step 3: optional deposit
      if (input.depositFirst && prereqs && prereqs.walletBalance > 0n) {
        // Approve if needed
        if (prereqs.currentAllowance < prereqs.walletBalance) {
          payloads.push(makeTxPayload(
            prereqs.tokenAddress, ERC20_ABI, "approve",
            [prereqs.userKeeper, MaxUint256], chainId,
            `ERC20.approve(${prereqs.userKeeper}, MAX_UINT256)`,
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
        prereqs = await resolvePrereqs(rpc, govPool, user);
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
      const result = await sendOrCollect(signer, payloads);

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
          // SucceededFor or SucceededAgainst — execute
          const execResult = await sendOrCollect(signer, [
            makeTxPayload(govPool, GOV_POOL_ABI, "execute", [proposalId], chainId, `GovPool.execute(${proposalId})`),
          ]);
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
