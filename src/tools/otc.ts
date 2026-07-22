import { z } from "zod";
import { Interface, ZeroAddress, ZeroHash, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { SignerManager } from "../lib/signer.js";
import type { WalletConnectManager } from "../lib/walletconnect.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import type { TxPayload } from "../lib/calldata.js";
import { attachPairingQr, runProposalCreate, sendOrCollect, flowFailureResult, type ProposalCreateInput } from "./flow.js";
import { resolveChain } from "../config.js";
import {
  buildTokenSaleMultiActions,
  tierSchema,
  type TierSpec,
} from "./proposalBuildComplex.js";
import { PinataClient } from "../lib/ipfs.js";
import {
  buildAddressMerkleTree,
  computeLeafHash,
  verifyProof,
} from "../lib/merkleTree.js";
import { simulateCalldata } from "./simulate.js";
import { parseUintString } from "../lib/amount.js";
import { parseAmount, formatAmount, from18 } from "../lib/units.js";
import { chainIdParam } from "../lib/params.js";
import { unixToUtc } from "../lib/time.js";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ---------- ABI fragments ----------

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/**
 * Exact mirror of `ITokenSaleProposal.TierView` — a NESTED struct of
 * `{ tierInitParams, tierInfo, tierAdditionalInfo }`. The previous flat shape
 * (saleTokenAddress before claimLockDuration, reversed VestingSettings) was
 * the pre-Bug-#25 field order and decoded garbage against live tiers.
 * Field order verified against
 * `DeXe-Protocol/contracts/interfaces/gov/proposals/ITokenSaleProposal.sol`.
 */
export const TIER_VIEW_TUPLE =
  "tuple(" +
  "tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint64 saleStartTime, uint64 saleEndTime, uint64 claimLockDuration, address saleTokenAddress, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 vestingPercentage, uint64 vestingDuration, uint64 cliffPeriod, uint64 unlockStep) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails) tierInitParams, " +
  "tuple(bool isOff, uint256 totalSold, string uri, tuple(uint64 vestingStartTime, uint64 vestingEndTime) vestingTierInfo) tierInfo, " +
  "tuple(bytes32 merkleRoot, string merkleUri, uint256 lastModified) tierAdditionalInfo" +
  ")";

export const GET_TIER_VIEWS_FRAGMENT = `function getTierViews(uint256 offset, uint256 limit) view returns (${TIER_VIEW_TUPLE}[] tierViews)`;

/** Authoritative `getUserViews` fragment — shared with read.ts so both decode the same nested UserView shape. */
export const GET_USER_VIEWS_FRAGMENT =
  "function getUserViews(address user, uint256[] tierIds, bytes32[][] proofs) view returns (tuple(bool canParticipate, tuple(bool isClaimed, bool canClaim, uint64 claimUnlockTime, uint256 claimTotalAmount, uint256 boughtTotalAmount, address[] lockedTokenAddresses, uint256[] lockedTokenAmounts, address[] lockedNftAddresses, uint256[][] lockedNftIds, address[] purchaseTokenAddresses, uint256[] purchaseTokenAmounts) purchaseView, tuple(uint64 latestVestingWithdraw, uint64 nextUnlockTime, uint256 nextUnlockAmount, uint256 vestingTotalAmount, uint256 vestingWithdrawnAmount, uint256 amountToWithdraw, uint256 lockedAmount) vestingUserView)[] userViews)";

const TOKEN_SALE_ABI = new Interface([
  "function latestTierId() view returns (uint256)",
  GET_TIER_VIEWS_FRAGMENT,
  GET_USER_VIEWS_FRAGMENT,
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

/**
 * Protocol-wide native-coin sentinel (`Globals.sol::ETHEREUM_ADDRESS`).
 * `TokenSaleProposalBuy` keys exchange rates by this address and checks
 * `tokenToBuyWith != ETHEREUM_ADDRESS` for the native path — passing the
 * zero address on-chain reverts with "TSP: incorrect token". We accept the
 * zero address as caller input for convenience, but calldata must always
 * carry ETHEREUM_ADDRESS.
 */
export const ETHEREUM_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function isNativeSentinel(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ZeroAddress || a === ETHEREUM_ADDRESS.toLowerCase();
}

/**
 * W29: exact-scope ERC20 approval for an OTC purchase.
 *
 * The spender is a per-proposal `TokenSaleProposal` address that cannot be
 * resolved through the pool registry (it is not a pool helper), so the builder
 * can only `isAddress`-check it. Granting `MAX_UINT256` to an unvalidated,
 * possibly attacker-supplied spender lets it `transferFrom` the buyer's entire
 * payment-token balance and leaves a residual unlimited allowance after the
 * session. Approve exactly what `buy()` will spend — never more.
 */
export function buildExactApproval(
  paymentToken: string,
  tokenSaleProposal: string,
  amount: bigint,
  chainId: number,
): TxPayload {
  return {
    to: paymentToken,
    data: ERC20_ABI.encodeFunctionData("approve", [tokenSaleProposal, amount]),
    value: "0",
    chainId,
    description: `ERC20.approve(${tokenSaleProposal}, ${amount})`,
  };
}

/**
 * Frontend-compat (app.dexe.io): the buyer UI regenerates merkle proofs from
 * the IPFS `{ list: [...] }` JSON referenced by the tier's MerkleWhitelist
 * uri (`useTokenSaleWhiteListProofFetcher`). A merkle tier created with an
 * empty uri is unbuyable through the frontend — nobody can fetch the list to
 * derive a proof. So before encoding, upload the whitelist and inject
 * `ipfs://<cid>` into the participation spec (matches the frontend's
 * `IpfsEntity.path` format; addresses lowercased like the frontend does).
 */
async function resolveMerkleUris(
  tiers: readonly TierSpec[],
  pinataJwt: string | undefined,
): Promise<{
  tiers: TierSpec[];
  uploaded: { tierName: string; uri: string }[];
  warnings: string[];
}> {
  const uploaded: { tierName: string; uri: string }[] = [];
  const warnings: string[] = [];
  const out: TierSpec[] = [];
  for (const tier of tiers) {
    const parts = tier.participation ?? [];
    const needsUpload = parts.some(
      (p) => p.type === "MerkleWhitelist" && !p.uri && (p.users?.length ?? 0) > 0,
    );
    if (!needsUpload) {
      out.push(tier);
      continue;
    }
    if (!pinataJwt) {
      warnings.push(
        `Tier "${tier.name}": MerkleWhitelist uri left empty (DEXE_PINATA_JWT unset) — ` +
          `app.dexe.io buyers cannot regenerate proofs for this tier; distribute the whitelist out-of-band.`,
      );
      out.push(tier);
      continue;
    }
    const pinata = new PinataClient(pinataJwt);
    const newParts: TierSpec["participation"] = [];
    for (const p of parts) {
      if (p.type === "MerkleWhitelist" && !p.uri && (p.users?.length ?? 0) > 0) {
        const list = p.users.map((u) => u.toLowerCase());
        const res = await pinata.pinJson(
          { list },
          { name: `otc-whitelist:${tier.name.slice(0, 24)}` },
        );
        const uri = `ipfs://${res.cid}`;
        uploaded.push({ tierName: tier.name, uri });
        newParts.push({ ...p, uri });
      } else {
        newParts.push(p);
      }
    }
    out.push({ ...tier, participation: newParts });
  }
  return { tiers: out, uploaded, warnings };
}

// ---------- register ----------

export function registerOtcTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
  wc: WalletConnectManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_otc_dao_open_sale
  // =============================================
  server.tool(
    "dexe_otc_dao_open_sale",
    "OTC composite — propose to open a multi-tier token sale on a deployed OTC DAO. " +
      "Builds the multi-tier `createTiers` envelope (deduped/summed approves, auto-merkle, " +
      "auto-addToWhitelist for plain Whitelist tiers, auto-upload of merkle whitelists to " +
      "IPFS so app.dexe.io buyers can regenerate proofs), then runs the full proposal_create " +
      "flow: balance + threshold check, ERC20 approve to UserKeeper if needed, deposit, " +
      "IPFS proposal-metadata upload, `createProposalAndVote`. " +
      "When DEXE_PRIVATE_KEY is set, signs and broadcasts each tx; otherwise returns " +
      "an ordered TxPayload list. Every DAO deployed with `dexe_dao_create` (v0.19+) already has " +
      "TokenSaleProposal wired as an executor, so this works right after a deploy. Only DAOs deployed " +
      "by other/older tooling without that executor need a `new_proposal_type` proposal " +
      "(dexe_proposal_create, executors=[tokenSaleProposal]) or a redeploy first. " +
      "Unsure of the full sale journey or which params to collect from the user? Call dexe_guide (flow:'otc_sale') first.",
    {
      govPool: z.string().describe("GovPool address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
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
        // Frontend-compat: merkle tiers must reference their whitelist on
        // IPFS or app.dexe.io buyers cannot derive proofs. buildOnly skips
        // uploads by design — the caller owns IPFS there.
        let tiers: readonly TierSpec[] = input.tiers;
        let whitelistUploads: { tierName: string; uri: string }[] = [];
        let whitelistWarnings: string[] = [];
        if (!input.buildOnly) {
          const resolved = await resolveMerkleUris(input.tiers, ctx.config.pinataJwt);
          tiers = resolved.tiers;
          whitelistUploads = resolved.uploaded;
          whitelistWarnings = resolved.warnings;
        }

        const built = buildTokenSaleMultiActions({
          tokenSaleProposal: input.tokenSaleProposal,
          tiers,
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
                (_, i) => (parseUintString(input.latestTierId, "latestTierId") + 1n + BigInt(i)).toString(),
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
          chainId: input.chainId,
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
        const result = await runProposalCreate(proposalInput, { ctx, signer, rpc, wc });

        // Surface the OTC-specific extras alongside the proposal_create body.
        // The proposal_create response may lead with WalletConnect QR blocks
        // (ASCII text + PNG image); its JSON envelope is the LAST text block.
        // Parse that, merge the OTC extras in, and keep the QR blocks intact.
        const content = result.content ?? [];
        let resultJson: Record<string, unknown> = {};
        let jsonIdx = -1;
        for (let i = content.length - 1; i >= 0; i--) {
          const c = content[i];
          if (c && c.type === "text" && "text" in c) {
            try {
              resultJson = JSON.parse(c.text) as Record<string, unknown>;
              jsonIdx = i;
            } catch {
              // proposal_create returned an error string — pass through unchanged.
            }
            break;
          }
        }
        if (jsonIdx < 0) return result;

        const qrBlocks = content.filter((_, i) => i !== jsonIdx);
        const merged = ok({
          ...resultJson,
          otc: {
            tokenSaleProposal: input.tokenSaleProposal,
            tierCount: input.tiers.length,
            tierNames: built.tierNames,
            derivedMerkleRoots: built.derivedMerkleRoots,
            whitelistRequests: built.whitelistRequests,
            merkleWhitelistUploads: whitelistUploads,
            ...(whitelistWarnings.length > 0 ? { warnings: whitelistWarnings } : {}),
            tierIdsAfterExecute: input.tiers.map(
              (_, i) => (parseUintString(input.latestTierId, "latestTierId") + 1n + BigInt(i)).toString(),
            ),
          },
        });
        return { content: [...qrBlocks, ...merged.content] };
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
      "lockup ETA, totalSold, on-chain merkle root). When `whitelists` is supplied per tier, " +
      "computes the user's merkle proof against that list AND passes it into getUserViews — " +
      "so `canParticipate` is accurate for merkle-gated tiers. Read-only.",
    {
      tokenSaleProposal: z.string(),
      chainId: chainIdParam,
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
    async ({ tokenSaleProposal, chainId, tierIds, user, whitelists }) => {
      if (!isAddress(tokenSaleProposal)) return err(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      if (!isAddress(user)) return err(`Invalid user: ${user}`);
      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;
      const userAddr = getAddress(user);

      // For tier params we need an offset-based getTierViews. The cheapest
      // path is a single batch query with offset=min(tierIds)-1 and limit=range,
      // then index into the result by (tierId - offset - 1).
      const tierIdNums = tierIds.map((s) => parseUintString(s, "tierId"));
      const minTier = tierIdNums.reduce((a, b) => (a < b ? a : b));
      const maxTier = tierIdNums.reduce((a, b) => (a > b ? a : b));
      const offset = (minTier - 1n).toString();
      const limit = (maxTier - minTier + 1n).toString();

      try {
        // Pre-compute merkle proofs per tier BEFORE the reads — the contract's
        // getUserViews takes bytes32[][] proofs, and canParticipate for
        // MerkleWhitelist tiers is proof-dependent (empty proofs => false even
        // for included users). Mirrors the frontend's useFetchMergedTierViews.
        const whitelistByTier = new Map(whitelists.map((w) => [w.tierId, w.users]));
        const merkleByTier = new Map<
          string,
          { root: string; proof: string[]; included: boolean }
        >();
        for (const [tierId, wlUsers] of whitelistByTier) {
          if (!wlUsers || wlUsers.length === 0) continue;
          const checksummed = wlUsers.map((u) => {
            if (!isAddress(u)) throw new Error(`whitelist user invalid: ${u}`);
            return getAddress(u);
          });
          const tree = buildAddressMerkleTree(checksummed);
          const idx = checksummed.findIndex((a) => a.toLowerCase() === userAddr.toLowerCase());
          if (idx >= 0) {
            const leaf = computeLeafHash([userAddr], ["address"]);
            const proof = tree.proofs[idx]!;
            merkleByTier.set(tierId, {
              root: tree.root,
              proof,
              included: verifyProof(proof, tree.root, leaf),
            });
          } else {
            merkleByTier.set(tierId, { root: tree.root, proof: [], included: false });
          }
        }

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
            args: [userAddr, tierIdNums, tierIds.map((id) => merkleByTier.get(id)?.proof ?? [])],
            allowFailure: true,
          },
        ];

        const res = await multicall(provider, calls);
        if (!res[0]!.success) return err(`getTierViews failed: ${res[0]!.error}`);
        if (!res[1]!.success) return err(`getUserViews failed: ${res[1]!.error}`);

        const tierViewsRange = res[0]!.value as unknown as unknown[];
        const userViews = res[1]!.value as unknown as unknown[];

        const summaries = tierIds.map((tierIdStr, i) => {
          const tierIdx = Number(BigInt(tierIdStr) - minTier);
          // Contract returns nested TierView { tierInitParams, tierInfo,
          // tierAdditionalInfo } — see TIER_VIEW_TUPLE.
          const tv = tierViewsRange[tierIdx] as
            | undefined
            | {
                tierInitParams: {
                  metadata: { name: string; description: string };
                  totalTokenProvided: bigint;
                  saleStartTime: bigint;
                  saleEndTime: bigint;
                  claimLockDuration: bigint;
                  saleTokenAddress: string;
                  purchaseTokenAddresses: string[];
                  exchangeRates: bigint[];
                  minAllocationPerUser: bigint;
                  maxAllocationPerUser: bigint;
                  vestingSettings: {
                    vestingPercentage: bigint;
                    vestingDuration: bigint;
                    cliffPeriod: bigint;
                    unlockStep: bigint;
                  };
                  participationDetails: { participationType: bigint; data: string }[];
                };
                tierInfo: {
                  isOff: boolean;
                  totalSold: bigint;
                  uri: string;
                  vestingTierInfo: { vestingStartTime: bigint; vestingEndTime: bigint };
                };
                tierAdditionalInfo: {
                  merkleRoot: string;
                  merkleUri: string;
                  lastModified: bigint;
                };
              };
          if (!tv) {
            return { tierId: tierIdStr, error: "tier not found in range" };
          }
          const tier = tv.tierInitParams;

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

          // Surface participation requirements; the merkle proof (if a
          // whitelist was supplied) was already computed pre-read.
          const participation = tier.participationDetails.map((p) => ({
            type:
              PARTICIPATION_TYPE_NAMES[Number(p.participationType)] ??
              `Unknown(${p.participationType})`,
            data: p.data,
          }));

          const onchainMerkleRoot =
            tv.tierAdditionalInfo.merkleRoot === ZeroHash
              ? null
              : tv.tierAdditionalInfo.merkleRoot;
          const merkleLocal = merkleByTier.get(tierIdStr);
          const merkle = merkleLocal
            ? {
                ...merkleLocal,
                onchainRoot: onchainMerkleRoot,
                // Guards against a stale/foreign whitelist: the proof only
                // works on-chain when the roots match.
                rootMatchesOnchain:
                  onchainMerkleRoot === null
                    ? null
                    : merkleLocal.root.toLowerCase() === onchainMerkleRoot.toLowerCase(),
              }
            : undefined;

          return {
            tierId: tierIdStr,
            metadata: { name: tier.metadata.name, description: tier.metadata.description },
            saleTokenAddress: tier.saleTokenAddress,
            saleStartTime: tier.saleStartTime,
            saleEndTime: tier.saleEndTime,
            saleStartTimeUTC: unixToUtc(tier.saleStartTime),
            saleEndTimeUTC: unixToUtc(tier.saleEndTime),
            totalTokenProvided: tier.totalTokenProvided,
            totalSold: tv.tierInfo.totalSold,
            isOff: tv.tierInfo.isOff,
            tierUri: tv.tierInfo.uri || null,
            onchainMerkleRoot,
            merkleUri: tv.tierAdditionalInfo.merkleUri || null,
            purchaseTokenAddresses: [...tier.purchaseTokenAddresses],
            exchangeRates: [...tier.exchangeRates],
            minAllocationPerUser: tier.minAllocationPerUser,
            maxAllocationPerUser: tier.maxAllocationPerUser,
            claimLockDuration: tier.claimLockDuration,
            vestingSettings: {
              vestingPercentage: tier.vestingSettings.vestingPercentage,
              vestingDuration: tier.vestingSettings.vestingDuration,
              cliffPeriod: tier.vestingSettings.cliffPeriod,
              unlockStep: tier.vestingSettings.unlockStep,
            },
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
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
      tierId: z.string(),
      tokenToBuyWith: z
        .string()
        .describe(
          "Payment token; for native BNB pass 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (protocol ETHEREUM_ADDRESS). " +
            "The zero address is accepted as an alias, but calldata always carries ETHEREUM_ADDRESS — the contract keys exchange rates by it.",
        ),
      amount: z
        .string()
        .describe(
          "Amount to spend. Human units with a decimal point ('100.5') are handled for you regardless of the " +
            "payment token's decimals (recommended). A digits-only string is treated as the 18-decimal-normalized " +
            "quantity buy() expects (back-compat) — the tool converts it to the token's native decimals for the " +
            "balance check and approve.",
        ),
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
      const tierIdBn = parseUintString(input.tierId, "tierId");
      // buy() takes the 18-dec-NORMALIZED amount regardless of the payment
      // token's decimals; parseAmount treats digits-only as already normalized
      // (back-compat) and a decimal string ("100.5") as human units.
      let amountBn: bigint;
      try {
        amountBn = parseAmount(input.amount, 18);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      const native = isNativeSentinel(input.tokenToBuyWith);
      // Contract-canonical payment token: native buys MUST carry
      // ETHEREUM_ADDRESS (0xEeee…EEeE) — the zero address reverts on-chain
      // with "TSP: incorrect token".
      const tokenArg = native ? ETHEREUM_ADDRESS : getAddress(input.tokenToBuyWith);

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

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const pr2 = rpc.tryProvider(chainId);
      if ("error" in pr2) return errorResult(`${pr2.error}\n${pr2.remediation}`);
      const provider = pr2.ok;
      const payloads: TxPayload[] = [];
      const skipped: { label: string; reason: string }[] = [];

      // Balance + allowance preflight (ERC20 path only). R9: `balanceOf` /
      // `allowance` / `transferFrom` all operate in the token's NATIVE raw
      // units, while buy() carries the 18-dec-normalized amount — read the
      // token's real decimals and compare/approve the CONVERTED raw amount
      // (an 18-dec comparison silently mis-judges any <18-dec stable).
      let balance = 0n;
      let allowance = 0n;
      let rawNeeded = amountBn;
      if (!native) {
        const calls: Call[] = [
          {
            target: tokenArg,
            iface: ERC20_ABI,
            method: "balanceOf",
            args: [userAddr],
            allowFailure: true,
          },
          {
            target: tokenArg,
            iface: ERC20_ABI,
            method: "allowance",
            args: [userAddr, input.tokenSaleProposal],
            allowFailure: true,
          },
          { target: tokenArg, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
          { target: tokenArg, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true },
        ];
        const res = await multicall(provider, calls);
        balance = res[0]!.success ? (res[0]!.value as bigint) : 0n;
        allowance = res[1]!.success ? (res[1]!.value as bigint) : 0n;
        const payDecimals = res[2]!.success ? Number(res[2]!.value) : 18;
        const paySymbol = res[3]!.success ? String(res[3]!.value) : "";

        try {
          rawNeeded = from18(amountBn, payDecimals);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }

        if (!input.dryRun && balance < rawNeeded) {
          return err(
            `Insufficient payment-token balance: have ${formatAmount(balance, payDecimals, paySymbol)}, ` +
              `need ${formatAmount(rawNeeded, payDecimals, paySymbol)} (token ${tokenArg}).`,
          );
        }

        if (allowance < rawNeeded) {
          payloads.push(
            buildExactApproval(tokenArg, input.tokenSaleProposal, rawNeeded, chainId),
          );
        } else {
          skipped.push({ label: "ERC20.approve", reason: "Allowance sufficient" });
        }
      }

      // buy()
      const buyData = TOKEN_SALE_ABI.encodeFunctionData("buy", [
        tierIdBn,
        tokenArg,
        amountBn,
        proof,
      ]);
      payloads.push({
        to: input.tokenSaleProposal,
        data: buyData,
        value: native ? amountBn.toString() : "0",
        chainId,
        description: `TokenSaleProposal.buy(tier=${tierIdBn}, ${native ? `native (${ETHEREUM_ADDRESS})` : tokenArg}, ${amountBn})`,
      });

      // Optional simulation gate: preflight the buy() against live state before
      // we ever touch the broadcast path. Skipped on dryRun since dryRun
      // already short-circuits to payload return. Also skipped when an approve
      // must land first — live state has allowance 0, so simulating buy() would
      // fail with a false "insufficient allowance" (F13).
      let simulation: unknown;
      const approvePending = payloads.length > 1;
      if (input.simulateFirst && !input.dryRun && approvePending) {
        simulation = {
          skipped: true,
          reason: "approve must land first — live-state sim of buy() would false-fail on allowance",
        };
      }
      if (input.simulateFirst && !input.dryRun && !approvePending) {
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

      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc });
      if (result.mode === "failed") {
        return flowFailureResult(result, { tierId: input.tierId, user: userAddr });
      }

      return attachPairingQr(ok({
        mode: result.mode,
        tierId: input.tierId,
        user: userAddr,
        native,
        amount: amountBn.toString(),
        proofLength: proof.length,
        preflight: native ? null : { balance: balance.toString(), allowance: allowance.toString() },
        ...(simulation ? { simulation } : {}),
        steps: [...skipped, ...result.steps],
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
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
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
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
      const tierIdBns = input.tierIds.map((s) => parseUintString(s, "tierId"));

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const pr2 = rpc.tryProvider(chainId);
      if ("error" in pr2) return errorResult(`${pr2.error}\n${pr2.remediation}`);
      const provider = pr2.ok;

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

      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc });
      if (result.mode === "failed") {
        return flowFailureResult(result, { user: userAddr, tokenSaleProposal: input.tokenSaleProposal });
      }

      return attachPairingQr(ok({
        mode: result.mode,
        user: userAddr,
        tokenSaleProposal: input.tokenSaleProposal,
        claimedTierIds: claimable,
        vestingWithdrawTierIds: vestingReady,
        summary,
        steps: [...skipped, ...result.steps],
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
    },
  );
}
