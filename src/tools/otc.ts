import { z } from "zod";
import { Interface, ZeroAddress, MaxUint256, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { SignerManager } from "../lib/signer.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import type { TxPayload } from "../lib/calldata.js";
import { runProposalCreate, sendOrCollect, type ProposalCreateInput } from "./flow.js";
import {
  buildTokenSaleMultiActions,
  tierSchema,
} from "./proposalBuildComplex.js";
import {
  buildAddressMerkleTree,
  computeLeafHash,
  verifyProof,
} from "../lib/merkleTree.js";
import { simulateCalldata } from "./simulate.js";

// ---------- ABI fragments ----------

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const TOKEN_SALE_ABI = new Interface([
  "function latestTierId() view returns (uint256)",
  "function getTierViews(uint256 offset, uint256 limit) view returns (tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint256 saleStartTime, uint256 saleEndTime, address saleTokenAddress, uint256 claimLockDuration, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 cliffPeriod, uint256 unlockStep, uint256 vestingDuration, uint256 vestingPercentage) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
  "function getUserViews(address user, uint256[] tierIds, bytes32[][] proofs) view returns (tuple(bool canParticipate, tuple(bool isClaimed, bool canClaim, uint64 claimUnlockTime, uint256 claimTotalAmount, uint256 boughtTotalAmount, address[] lockedTokenAddresses, uint256[] lockedTokenAmounts, address[] lockedNftAddresses, uint256[][] lockedNftIds, address[] purchaseTokenAddresses, uint256[] purchaseTokenAmounts) purchaseView, tuple(uint64 latestVestingWithdraw, uint64 nextUnlockTime, uint256 nextUnlockAmount, uint256 vestingTotalAmount, uint256 vestingWithdrawnAmount, uint256 amountToWithdraw, uint256 lockedAmount) vestingUserView)[] userViews)",
  "function buy(uint256 tierId, address tokenToBuyWith, uint256 amount, bytes32[] proof) payable",
  "function claim(uint256[] tierIds)",
  "function vestingWithdraw(uint256[] tierIds)",
]);

const PARTICIPATION_TYPE_NAMES = [
  "DAOVotes",
  "Whitelist",
  "BABT",
  "TokenLock",
  "NftLock",
  "MerkleWhitelist",
] as const;

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

function isNativeSentinel(addr: string): boolean {
  return addr.toLowerCase() === ZeroAddress.toLowerCase();
}

// ---------- register ----------

export function registerOtcTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_otc_dao_open_sale
  // =============================================
  server.tool(
    "dexe_otc_dao_open_sale",
    "OTC composite — propose to open a multi-tier token sale on a deployed OTC DAO. " +
      "Builds the multi-tier `createTiers` envelope (deduped/summed approves, auto-merkle, " +
      "auto-addToWhitelist for plain Whitelist tiers), then runs the full proposal_create " +
      "flow: balance + threshold check, ERC20 approve to UserKeeper if needed, deposit, " +
      "IPFS proposal-metadata upload, `createProposalAndVote`. " +
      "When DEXE_PRIVATE_KEY is set, signs and broadcasts each tx; otherwise returns " +
      "an ordered TxPayload list. The DAO must already have TokenSaleProposal wired as " +
      "an executor (set at deploy time via `dexe_dao_build_deploy`).",
    {
      govPool: z.string().describe("GovPool address"),
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper address"),
      tiers: z.array(tierSchema).min(1),
      latestTierId: z.string().default("0"),
      proposalName: z.string().default("Open OTC Token Sale"),
      proposalDescription: z.string().default(""),
      voteAmount: z.string().optional(),
      voteNftIds: z.array(z.string()).default([]),
      user: z.string().optional(),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
      buildOnly: z.boolean().default(false).describe("If true, return just the envelope (actions + metadata + merkle roots) without running the proposal_create flow. Skips IPFS upload and DAO state reads."),
    },
    async (input) => {
      try {
        const built = buildTokenSaleMultiActions({
          tokenSaleProposal: input.tokenSaleProposal,
          tiers: input.tiers,
          latestTierId: input.latestTierId,
          proposalName: input.proposalName,
          proposalDescription: input.proposalDescription,
        });

        if (input.buildOnly) {
          return ok({
            mode: "buildOnly",
            otc: {
              tokenSaleProposal: input.tokenSaleProposal,
              tierCount: input.tiers.length,
              tierNames: built.tierNames,
              derivedMerkleRoots: built.derivedMerkleRoots,
              whitelistRequests: built.whitelistRequests,
              tierIdsAfterExecute: input.tiers.map(
                (_, i) => (BigInt(input.latestTierId) + 1n + BigInt(i)).toString(),
              ),
            },
            metadata: built.metadata,
            actions: built.actions,
          });
        }

        // Forward to runProposalCreate with the tier-sale envelope's
        // metadata.changes preserved (frontend expects `changes` wrapper +
        // category=tokenSale per Bug #24 / Bug #19).
        const builtChanges = (built.metadata as { changes?: unknown }).changes;
        const proposalInput: ProposalCreateInput = {
          govPool: input.govPool,
          proposalType: "custom",
          title: input.proposalName,
          description: input.proposalDescription,
          actionsOnFor: built.actions,
          category: "tokenSale",
          proposalMetadataExtra: {
            isMeta: false,
            ...(builtChanges ? { changes: builtChanges } : {}),
          },
          voteAmount: input.voteAmount,
          voteNftIds: input.voteNftIds,
          user: input.user,
          dryRun: input.dryRun,
        };
        const result = await runProposalCreate(proposalInput, { ctx, signer, rpc });

        // Surface the OTC-specific extras alongside the proposal_create body.
        // Tool result already carries content[0].text → JSON; we wrap with an
        // augmented response that prepends the OTC extras into the same JSON.
        let resultJson: Record<string, unknown> = {};
        try {
          const txt = result.content?.[0]?.text ?? "{}";
          resultJson = JSON.parse(txt) as Record<string, unknown>;
        } catch {
          // proposal_create returned an error string — pass through unchanged.
          return result;
        }

        return ok({
          ...resultJson,
          otc: {
            tokenSaleProposal: input.tokenSaleProposal,
            tierCount: input.tiers.length,
            tierNames: built.tierNames,
            derivedMerkleRoots: built.derivedMerkleRoots,
            whitelistRequests: built.whitelistRequests,
            tierIdsAfterExecute: input.tiers.map(
              (_, i) => (BigInt(input.latestTierId) + 1n + BigInt(i)).toString(),
            ),
          },
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // =============================================
  // dexe_otc_buyer_status
  // =============================================
  server.tool(
    "dexe_otc_buyer_status",
    "OTC buyer aggregator — reads tier params + user state across N tiers and returns a " +
      "render-ready summary (purchasable status, claimable amount, vesting withdrawable, " +
      "lockup ETA). When `whitelistUsers` is supplied per tier, computes the merkle proof " +
      "for the user against that list. Read-only.",
    {
      tokenSaleProposal: z.string(),
      tierIds: z.array(z.string()).min(1),
      user: z.string(),
      whitelists: z
        .array(
          z.object({
            tierId: z.string(),
            users: z.array(z.string()).min(1),
          }),
        )
        .default([])
        .describe("Optional per-tier whitelist (for MerkleWhitelist proof generation)."),
    },
    async ({ tokenSaleProposal, tierIds, user, whitelists }) => {
      if (!isAddress(tokenSaleProposal)) return err(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      if (!isAddress(user)) return err(`Invalid user: ${user}`);
      const provider = rpc.requireProvider();
      const userAddr = getAddress(user);

      // For tier params we need an offset-based getTierViews. The cheapest
      // path is a single batch query with offset=min(tierIds)-1 and limit=range,
      // then index into the result by (tierId - offset - 1).
      const tierIdNums = tierIds.map((s) => BigInt(s));
      const minTier = tierIdNums.reduce((a, b) => (a < b ? a : b));
      const maxTier = tierIdNums.reduce((a, b) => (a > b ? a : b));
      const offset = (minTier - 1n).toString();
      const limit = (maxTier - minTier + 1n).toString();

      const calls: Call[] = [
        {
          target: tokenSaleProposal,
          iface: TOKEN_SALE_ABI,
          method: "getTierViews",
          args: [BigInt(offset), BigInt(limit)],
          allowFailure: true,
        },
        {
          target: tokenSaleProposal,
          iface: TOKEN_SALE_ABI,
          method: "getUserViews",
          args: [userAddr, tierIdNums, tierIdNums.map(() => [])],
          allowFailure: true,
        },
      ];

      try {
        const res = await multicall(provider, calls);
        if (!res[0]!.success) return err(`getTierViews failed: ${res[0]!.error}`);
        if (!res[1]!.success) return err(`getUserViews failed: ${res[1]!.error}`);

        const tierViewsRange = res[0]!.value as unknown as unknown[];
        const userViews = res[1]!.value as unknown as unknown[];

        const whitelistByTier = new Map(whitelists.map((w) => [w.tierId, w.users]));

        const summaries = tierIds.map((tierIdStr, i) => {
          const tierIdx = Number(BigInt(tierIdStr) - minTier);
          const tier = tierViewsRange[tierIdx] as
            | undefined
            | {
                metadata: { name: string; description: string };
                totalTokenProvided: bigint;
                saleStartTime: bigint;
                saleEndTime: bigint;
                saleTokenAddress: string;
                claimLockDuration: bigint;
                purchaseTokenAddresses: string[];
                exchangeRates: bigint[];
                minAllocationPerUser: bigint;
                maxAllocationPerUser: bigint;
                vestingSettings: {
                  cliffPeriod: bigint;
                  unlockStep: bigint;
                  vestingDuration: bigint;
                  vestingPercentage: bigint;
                };
                participationDetails: { participationType: number; data: string }[];
              };
          if (!tier) {
            return { tierId: tierIdStr, error: "tier not found in range" };
          }

          const uv = userViews[i] as
            | undefined
            | {
                canParticipate: boolean;
                purchaseView: {
                  isClaimed: boolean;
                  canClaim: boolean;
                  claimUnlockTime: bigint;
                  claimTotalAmount: bigint;
                  boughtTotalAmount: bigint;
                };
                vestingUserView: {
                  vestingTotalAmount: bigint;
                  vestingWithdrawnAmount: bigint;
                  amountToWithdraw: bigint;
                  lockedAmount: bigint;
                  nextUnlockTime: bigint;
                  nextUnlockAmount: bigint;
                };
              };
          if (!uv) {
            return { tierId: tierIdStr, error: "user view missing" };
          }

          // Surface participation requirements + compute merkle proof for user
          // when caller supplied a whitelist.
          const participation = tier.participationDetails.map((p) => ({
            type: PARTICIPATION_TYPE_NAMES[p.participationType] ?? `Unknown(${p.participationType})`,
            data: p.data,
          }));

          const wlList = whitelistByTier.get(tierIdStr);
          let merkle: { root: string; proof: string[]; included: boolean } | undefined;
          if (wlList && wlList.length > 0) {
            const checksummed = wlList.map((u) => {
              if (!isAddress(u)) throw new Error(`whitelist user invalid: ${u}`);
              return getAddress(u);
            });
            const tree = buildAddressMerkleTree(checksummed);
            const idx = checksummed.findIndex((a) => a.toLowerCase() === userAddr.toLowerCase());
            if (idx >= 0) {
              const leaf = computeLeafHash([userAddr], ["address"]);
              const proof = tree.proofs[idx]!;
              merkle = { root: tree.root, proof, included: verifyProof(proof, tree.root, leaf) };
            } else {
              merkle = { root: tree.root, proof: [], included: false };
            }
          }

          return {
            tierId: tierIdStr,
            metadata: tier.metadata,
            saleTokenAddress: tier.saleTokenAddress,
            saleStartTime: tier.saleStartTime,
            saleEndTime: tier.saleEndTime,
            totalTokenProvided: tier.totalTokenProvided,
            purchaseTokenAddresses: tier.purchaseTokenAddresses,
            exchangeRates: tier.exchangeRates,
            minAllocationPerUser: tier.minAllocationPerUser,
            maxAllocationPerUser: tier.maxAllocationPerUser,
            claimLockDuration: tier.claimLockDuration,
            vestingSettings: tier.vestingSettings,
            participation,
            user: {
              canParticipate: uv.canParticipate,
              purchase: uv.purchaseView,
              vesting: uv.vestingUserView,
              claimable:
                uv.purchaseView.canClaim && !uv.purchaseView.isClaimed
                  ? uv.purchaseView.claimTotalAmount
                  : 0n,
              vestingWithdrawable: uv.vestingUserView.amountToWithdraw,
            },
            ...(merkle ? { merkle } : {}),
          };
        });

        return ok({ tokenSaleProposal, user: userAddr, tiers: summaries });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // =============================================
  // dexe_otc_buyer_buy
  // =============================================
  server.tool(
    "dexe_otc_buyer_buy",
    "OTC buyer composite — preflights balance + allowance on the payment token, builds an " +
      "ERC20 approve when needed, then builds `TokenSaleProposal.buy(tierId, paymentToken, amount, proof)`. " +
      "Native-coin path (paymentToken == 0x000...000) skips approve and sets `value`. " +
      "If `whitelistUsers` is supplied, computes the merkle proof against that list. " +
      "When DEXE_PRIVATE_KEY is set, signs and broadcasts both txs; otherwise returns the ordered " +
      "TxPayload list.",
    {
      tokenSaleProposal: z.string(),
      tierId: z.string(),
      tokenToBuyWith: z.string().describe("Payment token; use 0x000...000 for native BNB"),
      amount: z.string().describe("Amount to spend in payment-token wei"),
      proof: z.array(z.string()).default([]),
      whitelistUsers: z.array(z.string()).default([]).describe("Optional whitelist for proof gen"),
      user: z.string().optional(),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
      simulateFirst: z
        .boolean()
        .default(false)
        .describe(
          "If true, eth_call-simulate the buy() against live state before broadcasting. Aborts with the revertReason if the sim fails.",
        ),
    },
    async (input) => {
      if (!isAddress(input.tokenSaleProposal)) return err(`Invalid tokenSaleProposal`);
      if (!isAddress(input.tokenToBuyWith)) return err(`Invalid tokenToBuyWith`);

      const userResolved =
        input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!userResolved) return err(`Provide 'user' or set DEXE_PRIVATE_KEY.`);

      const userAddr = getAddress(userResolved);
      const tierIdBn = BigInt(input.tierId);
      const amountBn = BigInt(input.amount);
      const native = isNativeSentinel(input.tokenToBuyWith);

      // Compute proof from whitelistUsers if needed.
      let proof = input.proof;
      if (proof.length === 0 && input.whitelistUsers.length > 0) {
        const checksummed = input.whitelistUsers.map((u) => {
          if (!isAddress(u)) throw new Error(`whitelist user invalid: ${u}`);
          return getAddress(u);
        });
        const tree = buildAddressMerkleTree(checksummed);
        const idx = checksummed.findIndex((a) => a.toLowerCase() === userAddr.toLowerCase());
        if (idx < 0) return err(`User ${userAddr} not in whitelist (${checksummed.length} entries).`);
        proof = tree.proofs[idx]!;
      }

      const provider = rpc.requireProvider();
      const chainId = ctx.config.chainId;
      const payloads: TxPayload[] = [];
      const skipped: { label: string; reason: string }[] = [];

      // Balance + allowance preflight (ERC20 path only). In dryRun the
      // values are still surfaced for diagnostics but never block the build.
      let balance = 0n;
      let allowance = 0n;
      if (!native) {
        const calls: Call[] = [
          {
            target: input.tokenToBuyWith,
            iface: ERC20_ABI,
            method: "balanceOf",
            args: [userAddr],
            allowFailure: true,
          },
          {
            target: input.tokenToBuyWith,
            iface: ERC20_ABI,
            method: "allowance",
            args: [userAddr, input.tokenSaleProposal],
            allowFailure: true,
          },
        ];
        const res = await multicall(provider, calls);
        balance = res[0]!.success ? (res[0]!.value as bigint) : 0n;
        allowance = res[1]!.success ? (res[1]!.value as bigint) : 0n;

        if (!input.dryRun && balance < amountBn) {
          return err(
            `Insufficient ${input.tokenToBuyWith} balance: have ${balance}, need ${amountBn}.`,
          );
        }

        if (allowance < amountBn) {
          payloads.push({
            to: input.tokenToBuyWith,
            data: ERC20_ABI.encodeFunctionData("approve", [
              input.tokenSaleProposal,
              MaxUint256,
            ]),
            value: "0",
            chainId,
            description: `ERC20.approve(${input.tokenSaleProposal}, MAX_UINT256)`,
          });
        } else {
          skipped.push({ label: "ERC20.approve", reason: "Allowance sufficient" });
        }
      }

      // buy()
      const buyData = TOKEN_SALE_ABI.encodeFunctionData("buy", [
        tierIdBn,
        input.tokenToBuyWith,
        amountBn,
        proof,
      ]);
      payloads.push({
        to: input.tokenSaleProposal,
        data: buyData,
        value: native ? amountBn.toString() : "0",
        chainId,
        description: `TokenSaleProposal.buy(tier=${tierIdBn}, ${native ? "native" : input.tokenToBuyWith}, ${amountBn})`,
      });

      // Optional simulation gate: preflight the buy() against live state before
      // we ever touch the broadcast path. Skipped on dryRun since dryRun
      // already short-circuits to payload return.
      let simulation: unknown;
      if (input.simulateFirst && !input.dryRun) {
        const sim = await simulateCalldata(rpc, {
          to: input.tokenSaleProposal,
          data: buyData,
          value: native ? amountBn.toString() : undefined,
          from: userAddr,
        });
        simulation = sim;
        if (!sim.success) {
          return err(
            `Simulation failed before broadcast: ${sim.revertReason ?? "unknown revert"}`,
          );
        }
      }

      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun });

      return ok({
        mode: result.mode,
        tierId: input.tierId,
        user: userAddr,
        native,
        amount: amountBn.toString(),
        proofLength: proof.length,
        preflight: native ? null : { balance: balance.toString(), allowance: allowance.toString() },
        ...(simulation ? { simulation } : {}),
        steps: [...skipped, ...result.steps],
      });
    },
  );

  // =============================================
  // dexe_otc_buyer_claim_all
  // =============================================
  server.tool(
    "dexe_otc_buyer_claim_all",
    "OTC buyer composite — reads `getUserViews(user, tierIds)`, picks tier ids with " +
      "`claimableAmount > 0` and broadcasts `claim`, then picks tier ids with " +
      "`vestingWithdrawAmount > 0` and broadcasts `vestingWithdraw`. When DEXE_PRIVATE_KEY " +
      "is unset, returns ordered TxPayloads. Skips silently if no tiers have anything claimable.",
    {
      tokenSaleProposal: z.string(),
      tierIds: z.array(z.string()).min(1),
      user: z.string().optional(),
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
    },
    async (input) => {
      if (!isAddress(input.tokenSaleProposal)) return err(`Invalid tokenSaleProposal`);
      const userResolved =
        input.user ?? (signer.hasSigner() ? signer.getAddress() : undefined);
      if (!userResolved) return err(`Provide 'user' or set DEXE_PRIVATE_KEY.`);

      const userAddr = getAddress(userResolved);
      const tierIdBns = input.tierIds.map((s) => BigInt(s));

      const provider = rpc.requireProvider();
      const chainId = ctx.config.chainId;

      const res = await multicall(provider, [
        {
          target: input.tokenSaleProposal,
          iface: TOKEN_SALE_ABI,
          method: "getUserViews",
          args: [userAddr, tierIdBns, tierIdBns.map(() => [])],
          allowFailure: true,
        },
      ]);
      if (!res[0]!.success) return err(`getUserViews failed: ${res[0]!.error}`);

      const userViews = res[0]!.value as unknown as unknown[];

      const claimable: string[] = [];
      const vestingReady: string[] = [];
      const summary = input.tierIds.map((tierId, i) => {
        const uv = userViews[i] as
          | undefined
          | {
              purchaseView: {
                isClaimed: boolean;
                canClaim: boolean;
                claimTotalAmount: bigint;
              };
              vestingUserView: { amountToWithdraw: bigint };
            };
        const c =
          uv?.purchaseView?.canClaim && !uv?.purchaseView?.isClaimed
            ? uv.purchaseView.claimTotalAmount
            : 0n;
        const v = uv?.vestingUserView?.amountToWithdraw ?? 0n;
        if (c > 0n) claimable.push(tierId);
        if (v > 0n) vestingReady.push(tierId);
        return { tierId, claimable: c.toString(), vestingWithdrawable: v.toString() };
      });

      const payloads: TxPayload[] = [];
      const skipped: { label: string; reason: string }[] = [];

      if (claimable.length === 0) {
        skipped.push({ label: "TokenSaleProposal.claim", reason: "No tiers have claimableAmount > 0" });
      } else {
        payloads.push({
          to: input.tokenSaleProposal,
          data: TOKEN_SALE_ABI.encodeFunctionData("claim", [claimable.map((s) => BigInt(s))]),
          value: "0",
          chainId,
          description: `TokenSaleProposal.claim([${claimable.join(",")}])`,
        });
      }

      if (vestingReady.length === 0) {
        skipped.push({
          label: "TokenSaleProposal.vestingWithdraw",
          reason: "No tiers have vestingWithdrawAmount > 0",
        });
      } else {
        payloads.push({
          to: input.tokenSaleProposal,
          data: TOKEN_SALE_ABI.encodeFunctionData("vestingWithdraw", [
            vestingReady.map((s) => BigInt(s)),
          ]),
          value: "0",
          chainId,
          description: `TokenSaleProposal.vestingWithdraw([${vestingReady.join(",")}])`,
        });
      }

      if (payloads.length === 0) {
        return ok({
          mode: "noop",
          user: userAddr,
          tokenSaleProposal: input.tokenSaleProposal,
          summary,
          steps: skipped,
        });
      }

      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun });

      return ok({
        mode: result.mode,
        user: userAddr,
        tokenSaleProposal: input.tokenSaleProposal,
        claimedTierIds: claimable,
        vestingWithdrawTierIds: vestingReady,
        summary,
        steps: [...skipped, ...result.steps],
      });
    },
  );
}
