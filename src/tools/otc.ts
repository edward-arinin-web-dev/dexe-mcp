import { z } from "zod";
import { Interface, ZeroAddress, ZeroHash, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { SignerManager, hotKeySafetyFields } from "../lib/signer.js";
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
import { PinataClient, pinataCidForJson } from "../lib/ipfs.js";
import type { IpfsArtifact } from "../lib/ipfsPreview.js";
import {
  buildAddressMerkleTree,
  computeLeafHash,
  verifyProof,
} from "../lib/merkleTree.js";
import { simulateCalldata } from "./simulate.js";
import { parseUintString } from "../lib/amount.js";
import { parseAmount, formatAmount, from18 } from "../lib/units.js";
import { chainIdParam, signerKeyParam, NFT_IDS_OWN_DESC } from "../lib/params.js";
import { unixToUtc } from "../lib/time.js";
import type { StateStore } from "../lib/stateStore.js";
import { flowChainFields, flowContextSchema } from "../lib/flowChain.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError, sanitizeRevertReason } from "../lib/errors.js";
import { untrustedResult } from "../lib/sanitize.js";
import {
  VESTING_WITHDRAW_ADVISORY,
  findVestingTiers,
  vestingBlockedReport,
  vestingRefusalText,
  type VestingTierRisk,
} from "../lib/protocolAdvisories.js";

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

/**
 * What the untrusted half of an OTC payload actually is. Opening a sale is
 * permissionless, so `TierMetadata.name` / `.description` and `TierInfo.uri`
 * are free text chosen by whoever opened it — the same class of channel as a
 * DAO name, aimed at an agent that may be holding a signer.
 */
const OTC_UNTRUSTED_LABEL =
  "OTC tier metadata (name / description / uri authored by whoever opened the sale)";

/**
 * Where the provenance sentence lives inside the JSON body. Written last on
 * purpose: a payload key of the same name would be attacker-influenced, and the
 * server-authored value must win the collision.
 */
const PROVENANCE_KEY = "_untrustedContent";

/**
 * THE result funnel for this file — every OTC tool that returns a payload
 * returns it through here, and none of them build a result any other way.
 *
 * All the sanitizing is `untrustedResult`'s, unchanged: NFKC, control-char
 * escaping, zero-width/bidi stripping and fence-marker defanging applied to
 * every string AND every key, plus the provenance sentence. Nothing here
 * reimplements any of it. Before 0.33.0 this helper was a raw `JSON.stringify`,
 * so `dexe_otc_buyer_status` handed back sale-opener text with its zero-width
 * characters and forged fence-closes intact — while `dexe_read_token_sale_tiers`
 * returned the SAME on-chain bytes neutralized.
 *
 * Both channels below are literally the one object `untrustedResult` produced,
 * so "sanitize the prose, leak the rows through `structuredContent`" is not
 * expressible here.
 *
 * The text block stays a single JSON document rather than
 * `untrustedResult`'s summary-above-payload prose: these results carry signable
 * `TxPayload`s and are consumed by `JSON.parse` on that block (scripts,
 * orchestrators, tests). So the provenance line is folded INTO the document as
 * `_untrustedContent` instead of being printed above it.
 */
function ok(data: Record<string, unknown>) {
  const funnelled = untrustedResult({
    summary: "",
    label: OTC_UNTRUSTED_LABEL,
    structured: data,
  });
  const body = {
    ...funnelled.structuredContent,
    [PROVENANCE_KEY]: funnelled.content[0]!.text.trim(),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

/**
 * F15 pre-block for sale creation. A tier with `vestingPercentage > 0` strands
 * its vested allocation forever on any current pool, so the refusal has to land
 * BEFORE anything is encoded, uploaded or broadcast — not as a note attached to
 * a payload the caller is about to sign. `acknowledgeVestingBlocked: true` is
 * the deliberate override for a caller who is opening the tier on a
 * known-unaffected (pre-SphereX) pool or accepts the loss.
 */
function vestingTierGuard(
  tiers: readonly TierSpec[],
  acknowledged: boolean,
): { risks: VestingTierRisk[]; refusal: string | null } {
  const risks = findVestingTiers(tiers);
  if (risks.length === 0 || acknowledged) return { risks, refusal: null };
  // The text itself now lives in src/lib/protocolAdvisories.ts so the three
  // token-sale PROPOSAL surfaces refuse with the identical wording instead of
  // building the stranding tier silently.
  return { risks, refusal: vestingRefusalText(risks, "acknowledgeVestingBlocked: true") };
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
export async function resolveMerkleUris(
  tiers: readonly TierSpec[],
  pinataJwt: string | undefined,
  opts: { dryRun: boolean },
): Promise<{
  tiers: TierSpec[];
  uploaded: { tierName: string; uri: string; pinned: boolean }[];
  warnings: string[];
}> {
  const uploaded: { tierName: string; uri: string; pinned: boolean }[] = [];
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
      // Two different truths, and a preview must tell the right one. Without a
      // key the REAL run emits an empty uri — so a dryRun that fabricated one
      // would advertise calldata the real run will never produce.
      warnings.push(
        opts.dryRun
          ? `Tier "${tier.name}": preview only — DEXE_PINATA_JWT is unset, so a real run will leave this ` +
              `MerkleWhitelist uri EMPTY and app.dexe.io buyers will not be able to derive proofs. ` +
              `Set DEXE_PINATA_JWT (see dexe_doctor) before the real run.`
          : `Tier "${tier.name}": MerkleWhitelist uri left empty (DEXE_PINATA_JWT unset) — ` +
              `app.dexe.io buyers cannot regenerate proofs for this tier; distribute the whitelist out-of-band.`,
      );
      out.push(tier);
      continue;
    }
    // Under dryRun no client is constructed at all, so a spy on `pinJson`
    // provably cannot fire.
    const pinata = opts.dryRun ? undefined : new PinataClient(pinataJwt);
    const newParts: TierSpec["participation"] = [];
    for (const p of parts) {
      if (p.type === "MerkleWhitelist" && !p.uri && (p.users?.length ?? 0) > 0) {
        const list = p.users.map((u) => u.toLowerCase());
        const cid = pinata
          ? (await pinata.pinJson({ list }, { name: `otc-whitelist:${tier.name.slice(0, 24)}` })).cid
          : (await pinataCidForJson({ list })).cid;
        const uri = `ipfs://${cid}`;
        uploaded.push({ tierName: tier.name, uri, pinned: !!pinata });
        newParts.push({ ...p, uri });
        if (!pinata) {
          warnings.push(
            `Tier "${tier.name}": whitelist NOT pinned (dryRun). The uri ${uri} was computed locally — it is the ` +
              `same CID a real run pins, so this createTiers calldata matches, but the list itself is on nobody's ` +
              `IPFS node. Do not broadcast these payloads as-is: buyers could not derive proofs and the tier would ` +
              `be unbuyable on app.dexe.io. Re-run without dryRun to pin it.`,
          );
        }
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
  state?: StateStore,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_otc_dao_open_sale
  // =============================================
  server.tool(
    "dexe_otc_dao_open_sale",
    "Broadcasts when a signer is configured. Proposes a multi-tier token sale on an OTC DAO: builds the " +
      "`createTiers` envelope (deduped approves, auto-merkle, auto-addToWhitelist, merkle lists pinned to " +
      "IPFS so buyers can regenerate proofs), then runs the proposal_create flow (approve, deposit, IPFS " +
      "metadata, `createProposalAndVote`). DAOs from `dexe_dao_create` (v0.19+) already wire " +
      "TokenSaleProposal as an executor; older ones need a `new_proposal_type` proposal first.",
    {
      govPool: z.string().describe("GovPool address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper address"),
      tiers: z
        .array(tierSchema)
        .min(1)
        .describe("Tier specs for `createTiers`, in order; at least one."),
      latestTierId: z
        .string()
        .default("0")
        .describe("Current `latestTierId()` on the sale; new tiers start after it."),
      proposalName: z.string().default("Open OTC Token Sale").describe("Proposal title in the DAO UI."),
      proposalDescription: z.string().default("").describe("Proposal body; Markdown supported."),
      voteAmount: z
        .string()
        .optional()
        .describe("Vote size: whole tokens ('12.5') or raw wei. Omit to vote with all available power."),
      voteNftIds: z.array(z.string()).default([]).describe(NFT_IDS_OWN_DESC),
      user: z.string().optional().describe("Acting address; defaults to the configured signer."),
      signerKey: signerKeyParam,
      dryRun: z
        .boolean()
        .default(false)
        .describe("Preview: no broadcast, no IPFS pin. CIDs are right but unpinned — do NOT broadcast."),
      buildOnly: z
        .boolean()
        .default(false)
        .describe("Return only the envelope (actions + metadata + merkle roots); skips IPFS and DAO reads."),
      acknowledgeVestingBlocked: z
        .boolean()
        .default(false)
        .describe("Refused by default: opt into vestingPercentage > 0; the vested leg is stranded (F15)."),
      flowContext: flowContextSchema,
    },
    async (input) => {
      try {
        // F15 first: a stranded-vesting tier must be refused before any
        // encoding, IPFS pin or DAO read — the damage is done at createTiers,
        // not at withdraw time.
        const vesting = vestingTierGuard(input.tiers, input.acknowledgeVestingBlocked);
        if (vesting.refusal) return err(vesting.refusal);

        // Frontend-compat: merkle tiers must reference their whitelist on
        // IPFS or app.dexe.io buyers cannot derive proofs. buildOnly skips
        // uploads by design — the caller owns IPFS there.
        let tiers: readonly TierSpec[] = input.tiers;
        let whitelistUploads: { tierName: string; uri: string; pinned: boolean }[] = [];
        let whitelistWarnings: string[] = [];
        if (!input.buildOnly) {
          const resolved = await resolveMerkleUris(input.tiers, ctx.config.pinataJwt, { dryRun: input.dryRun });
          tiers = resolved.tiers;
          whitelistUploads = resolved.uploaded;
          whitelistWarnings = resolved.warnings;
        }
        // Whatever the whitelist resolution did rides into the createTiers
        // calldata, so it belongs in the same `ipfs` disclosure block as the
        // proposal metadata rather than in a second, separate claim.
        const merkleArtifacts: IpfsArtifact[] = whitelistUploads.map((u) => ({
          field: `merkleWhitelist[${u.tierName}]`,
          uri: u.uri,
          pinned: u.pinned,
        }));

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
              ...(vesting.risks.length > 0
                ? {
                    vestingBlocked: {
                      acknowledged: true,
                      tiers: vesting.risks,
                      reason: VESTING_WITHDRAW_ADVISORY.text,
                      upstream: VESTING_WITHDRAW_ADVISORY.upstream,
                    },
                  }
                : {}),
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
          extraIpfsArtifacts: merkleArtifacts,
          // Opening a sale is a write composite like any other, so it must be
          // signable as a named persona. It was the one broadcast composite
          // 0.32.0 missed — and docs/AGENTS.md had already listed it as
          // supporting signerKey, which is how the gap surfaced.
          signerKey: input.signerKey,
        };
        const result = await runProposalCreate(proposalInput, { ctx, signer, rpc, wc, state });

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
          ...(resultJson.mode === "executed"
            ? flowChainFields(input.flowContext, state, {
                chainId: resolveChain(ctx.config, input.chainId).chainId,
                govPool: input.govPool,
              })
            : {}),
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
            ...(vesting.risks.length > 0
              ? {
                  vestingBlocked: {
                    acknowledged: true,
                    tiers: vesting.risks,
                    reason: VESTING_WITHDRAW_ADVISORY.text,
                    upstream: VESTING_WITHDRAW_ADVISORY.upstream,
                  },
                }
              : {}),
          },
        });
        // Keep the funnel's `structuredContent`: dropping it here would put the
        // sanitized payload in one channel and nothing in the other, which is
        // the asymmetry this release exists to remove.
        return { content: [...qrBlocks, ...merged.content], structuredContent: merged.structuredContent };
      } catch (e) {
        return err(safeErrorMessage(e));
      }
    },
  );

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
      tierIds: z.array(z.string()).min(1).describe("Tier ids to report on, decimal strings."),
      user: z.string().describe("Buyer address to report state for."),
      whitelists: z
        .array(
          z.object({
            tierId: z.string().describe("Tier the whitelist belongs to, decimal string."),
            users: z.array(z.string()).min(1).describe("Whitelisted addresses, exactly as the merkle root was built."),
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

  // =============================================
  // dexe_otc_buyer_buy
  // =============================================
  server.tool(
    "dexe_otc_buyer_buy",
    "Broadcasts when a signer is configured. Preflights balance + allowance, adds an ERC20 approve when " +
      "needed, then builds `TokenSaleProposal.buy(tierId, paymentToken, amount, proof)`. Native path " +
      "(0x000...000) skips approve and sets `value`; `whitelistUsers` generates the proof.",
    {
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
      tierId: z.string().describe("Tier to buy from, decimal string."),
      tokenToBuyWith: z
        .string()
        .describe(
          "Payment token; native BNB = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (0x0 is an alias).",
        ),
      amount: z
        .string()
        .describe("Amount to spend: human units ('100.5'), or digits-only = 18-decimal-normalized."),
      proof: z.array(z.string()).default([]).describe("Merkle proof for a gated tier; [] when not gated."),
      whitelistUsers: z.array(z.string()).default([]).describe("Optional whitelist for proof gen"),
      user: z.string().optional().describe("Buyer address; defaults to the configured signer."),
      signerKey: signerKeyParam,
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
      simulateFirst: z
        .boolean()
        .default(false)
        .describe("eth_call-simulate buy() first; aborts with the revertReason if the sim fails."),
    },
    async (input) => {
      if (!isAddress(input.tokenSaleProposal)) return err(`Invalid tokenSaleProposal`);
      if (!isAddress(input.tokenToBuyWith)) return err(`Invalid tokenToBuyWith`);

      const userResolved =
        input.user ?? (signer.hasSigner(input.signerKey) ? signer.getAddress(input.signerKey) : undefined);
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
        return err(safeErrorMessage(e));
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
          return err(safeErrorMessage(e));
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
            `Simulation failed before broadcast: ${sanitizeRevertReason(sim.revertReason, "unknown revert")}`,
          );
        }
      }

      const result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc, signerKey: input.signerKey });
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
        ...(result.signer ? { signer: result.signer } : {}),
        ...hotKeySafetyFields(Boolean(result.signer?.safety)),
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
    "Broadcasts when a signer is configured. Reads `getUserViews(user, tierIds)` and sends `claim` for " +
      "tiers with `claimableAmount > 0`. Tiers whose only balance is the VESTED leg are reported under " +
      "`vestingBlocked` and NOT sent — `vestingWithdraw` is refused by the pool's firewall (upstream " +
      "defect F15); `includeVesting: true` tries anyway.",
    {
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper address"),
      chainId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target chain id. Defaults to the MCP's default chain."),
      tierIds: z.array(z.string()).min(1).describe("Tier ids to sweep, decimal strings."),
      user: z.string().optional().describe("Claimer address; defaults to the configured signer."),
      signerKey: signerKeyParam,
      dryRun: z.boolean().default(false).describe("If true, return ordered TxPayloads even when DEXE_PRIVATE_KEY is set."),
      includeVesting: z
        .boolean()
        .default(false)
        .describe("Attempt `vestingWithdraw` too; it reverts on every current pool (upstream F15)."),
    },
    async (input) => {
      if (!isAddress(input.tokenSaleProposal)) return err(`Invalid tokenSaleProposal`);
      const userResolved =
        input.user ?? (signer.hasSigner(input.signerKey) ? signer.getAddress(input.signerKey) : undefined);
      if (!userResolved) return err(`Provide 'user' or set DEXE_PRIVATE_KEY.`);

      const userAddr = getAddress(userResolved);
      const tierIdBns = input.tierIds.map((s) => parseUintString(s, "tierId"));

      const chain = resolveChain(ctx.config, input.chainId);
      const chainId = chain.chainId;
      const pr2 = rpc.tryProvider(chainId);
      if ("error" in pr2) return errorResult(`${pr2.error}\n${pr2.remediation}`);
      const provider = pr2.ok;

      // Unguarded, an RPC stall/429 here escapes the handler as a raw ethers
      // dump — which on a keyed endpoint carries the API key (W36).
      let res;
      try {
        res = await multicall(provider, [
          {
            target: input.tokenSaleProposal,
            iface: TOKEN_SALE_ABI,
            method: "getUserViews",
            args: [userAddr, tierIdBns, tierIdBns.map(() => [])],
            allowFailure: true,
          },
        ]);
      } catch (e) {
        return err(toActionableError(e, "dexe_otc_buyer_claim_all getUserViews").message);
      }
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

      // F15: vestingWithdraw is refused by the pool firewall in EVERY shape, so
      // auto-appending it (as this tool used to) guaranteed a reverted tx and
      // told the buyer nothing about why their vested tokens never arrived.
      // Report it instead; broadcast only on an explicit opt-in.
      let vestingBlocked:
        | (ReturnType<typeof vestingBlockedReport> & { attempted?: boolean })
        | undefined;
      if (vestingReady.length === 0) {
        skipped.push({
          label: "TokenSaleProposal.vestingWithdraw",
          reason: "No tiers have vestingWithdrawAmount > 0",
        });
      } else if (!input.includeVesting) {
        vestingBlocked = vestingBlockedReport(vestingReady, "includeVesting: true");
        skipped.push({
          label: "TokenSaleProposal.vestingWithdraw",
          reason: `Blocked upstream (F15) for tier(s) ${vestingReady.join(",")} — not broadcast. ${VESTING_WITHDRAW_ADVISORY.text}`,
        });
      } else {
        vestingBlocked = {
          ...vestingBlockedReport(vestingReady, "includeVesting: true"),
          attempted: true,
        };
        payloads.push({
          to: input.tokenSaleProposal,
          data: TOKEN_SALE_ABI.encodeFunctionData("vestingWithdraw", [
            vestingReady.map((s) => BigInt(s)),
          ]),
          value: "0",
          chainId,
          description: `TokenSaleProposal.vestingWithdraw([${vestingReady.join(",")}]) — upstream F15: expected to revert`,
        });
      }

      if (payloads.length === 0) {
        return ok({
          mode: "noop",
          user: userAddr,
          tokenSaleProposal: input.tokenSaleProposal,
          summary,
          steps: skipped,
          ...(vestingBlocked ? { vestingBlocked } : {}),
        });
      }

      let result;
      try {
        result = await sendOrCollect(signer, payloads, { dryRun: input.dryRun, chainId, wc, signerKey: input.signerKey });
      } catch (e) {
        return err(toActionableError(e, "dexe_otc_buyer_claim_all broadcast").message);
      }
      if (result.mode === "failed") {
        return flowFailureResult(result, { user: userAddr, tokenSaleProposal: input.tokenSaleProposal });
      }

      return attachPairingQr(ok({
        mode: result.mode,
        user: userAddr,
        tokenSaleProposal: input.tokenSaleProposal,
        claimedTierIds: claimable,
        // Only the ids actually broadcast; the blocked ones live under
        // `vestingBlocked` so a caller cannot read this as "withdrawn".
        vestingWithdrawTierIds: input.includeVesting ? vestingReady : [],
        ...(vestingBlocked ? { vestingBlocked } : {}),
        summary,
        steps: [...skipped, ...result.steps],
        ...(result.signer ? { signer: result.signer } : {}),
        ...hotKeySafetyFields(Boolean(result.signer?.safety)),
        ...(result.enableWrites ? { enableWrites: result.enableWrites } : {}),
        ...(result.pairing ? { pairing: result.pairing } : {}),
      }), result.pairingContent);
    },
  );
}
