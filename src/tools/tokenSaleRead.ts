import { z } from "zod";
import { Interface, ZeroHash, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import {
  buildAddressMerkleTree,
  computeLeafHash,
  verifyProof,
} from "../lib/merkleTree.js";
import { parseUintString } from "../lib/amount.js";
import { chainIdParam } from "../lib/params.js";
import { unixToUtc } from "../lib/time.js";
import { toActionableError } from "../lib/errors.js";
import { GET_TIER_VIEWS_FRAGMENT, GET_USER_VIEWS_FRAGMENT } from "../lib/abi/tokenSale.js";
import { tokenSaleResult as ok } from "../lib/tokenSaleResult.js";
import { VESTING_WITHDRAW_ADVISORY } from "../lib/upstreamAdvisories.js";
import { MAX_ID_LIST, MAX_WHITELISTS, MAX_WHITELIST_USERS } from "../lib/inputLimits.js";

/**
 * dexe_otc_buyer_status — a buyer's position across tiers of a token sale.
 * One multicall plus a merkle proof computed locally: no signer, no writes.
 *
 * Kept apart from the OTC composites in ./otc.ts (open sale / buy / claim),
 * which sign and broadcast, so reading a position never loads them. Results go
 * through the same sanitizing funnel as those composites.
 */

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** The two TokenSaleProposal views this tool reads. */
const TOKEN_SALE_ABI = new Interface([GET_TIER_VIEWS_FRAGMENT, GET_USER_VIEWS_FRAGMENT]);

const PARTICIPATION_TYPE_NAMES = [
  "DAOVotes",
  "Whitelist",
  "BABT",
  "TokenLock",
  "NftLock",
  "MerkleWhitelist",
] as const;

export function registerTokenSaleReadTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_otc_buyer_status
  // =============================================
  server.tool(
    "dexe_otc_buyer_status",
    "Read-only. Tier params + user state across N tiers: purchasable status, claimable amount, vesting " +
      "withdrawable, lockup ETA, totalSold, merkle root. `whitelists` adds the user's proof, making " +
      "`canParticipate` accurate for gated tiers.",
    {
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper address"),
      chainId: chainIdParam,
      tierIds: z
        .array(z.string())
        .min(1)
        .max(MAX_ID_LIST)
        .describe(`Tier ids to report on, decimal strings (1 to ${MAX_ID_LIST}).`),
      user: z.string().describe("Buyer address to report state for."),
      whitelists: z
        .array(
          z.object({
            tierId: z.string().describe("Tier the whitelist belongs to, decimal string."),
            users: z
              .array(z.string())
              .min(1)
              .max(MAX_WHITELIST_USERS)
              .describe("Whitelisted addresses, exactly as the merkle root was built."),
          }),
        )
        .max(MAX_WHITELISTS)
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
            // F15: a non-zero vested leg is unrecoverable on current pools, so
            // say so next to the number that claims to be withdrawable.
            ...(tier.vestingSettings.vestingPercentage > 0n
              ? {
                  vestingWithdrawBlocked: {
                    reason: VESTING_WITHDRAW_ADVISORY.text,
                    upstream: VESTING_WITHDRAW_ADVISORY.upstream,
                  },
                }
              : {}),
            ...(merkle ? { merkle } : {}),
          };
        });

        return ok({ tokenSaleProposal, user: userAddr, tiers: summaries });
      } catch (e) {
        return err(toActionableError(e, "dexe_otc_buyer_status").message);
      }
    },
  );
}
