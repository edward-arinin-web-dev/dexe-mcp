import { z } from "zod";
import { Interface, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { gqlRequest, resolveSubgraphUrl, subgraphChains } from "../lib/subgraph.js";
import { proposalStateLabel } from "../lib/govEnums.js";
import { chainIdParam } from "../lib/params.js";

/**
 * dexe_user_inbox — multi-DAO attention aggregator.
 *
 * Per DAO, surfaces three kinds of pending items for `user`:
 *   1. unvotedProposal — proposal in Voting state where user has zero personal vote
 *   2. claimableRewards — proposals user voted on with a positive pendingRewards balance
 *   3. lockedDeposit — UserKeeper.tokenBalance(user, PersonalVote) DEPOSITED
 *      portion (balance − ownedBalance) > 0. `balance` alone includes
 *      wallet-held tokens that were never deposited (bug F6/#16 class).
 *
 * The proposal scan window anchors to the END of the list (latestProposalId −
 * proposalScanLimit … latest) — newest proposals are the ones still in Voting.
 *
 * When `daos` is omitted the list is DISCOVERED from the pools subgraph of the
 * REQUESTED chain (`voterInPool` rows, limit 50). Discovery and the per-DAO
 * scan must run on the same chain: reading the flat `config.subgraphPoolsUrl`
 * discovered BSC MAINNET DAOs and then scanned them on whatever chain the
 * caller asked for, so a chain-97 call answered "1 DAO, nothing pending" for a
 * user who belongs to zero testnet DAOs — a wrong answer shaped like a
 * successful read (H1). A chain with no pools endpoint therefore refuses to
 * discover; the scan itself is pure on-chain, so passing `daos[]` still works
 * everywhere.
 */

// ---------- ABI ----------

export const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function latestProposalId() view returns (uint256)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst) proposal, tuple(tuple(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter, uint128 quorum, uint256 votesFor, uint256 votesAgainst) core) validatorProposal, uint8 proposalState, uint256 requiredQuorum, uint256 requiredValidatorsQuorum)[])",
  // NOTE field semantics (GovPool.sol getTotalVotes): the first two values are
  // PROPOSAL-level raw totals; only the THIRD is the queried voter's stake.
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 voterRawVoted, bool isVoteFor)",
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] onchainTokens, uint256[] staticRewards, tuple(uint256 personal, uint256 micropool, uint256 treasury)[] votingRewards, uint256[] offchainRewards, address[] offchainTokens))",
]);

const USER_KEEPER_ABI = new Interface([
  "function tokenAddress() view returns (address)",
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
]);

// Tries to read pendingRewards using the canonical ABI; if the contract
// version doesn't expose it, we silently skip and only surface unvoted +
// lockedDeposit. The subgraph would be the next-best signal.
// ABI mirrors IGovPool.PendingRewardsView EXACTLY (interfaces/gov/IGovPool.sol):
// (onchainTokens, staticRewards, VotingRewards[]{personal,micropool,treasury},
//  offchainRewards, offchainTokens). The pre-fix shape (tokens, amounts,
//  proposalIds) decoded votingRewards structs into a bogus "proposalIds" array
//  and undercounted totals (static only).
export const PENDING_REWARDS_ABI = new Interface([
  "function getPendingRewards(address user, uint256[] proposalIds) view returns (tuple(address[] onchainTokens, uint256[] staticRewards, tuple(uint256 personal, uint256 micropool, uint256 treasury)[] votingRewards, uint256[] offchainRewards, address[] offchainTokens) rewards)",
]);

/**
 * True when an (already multicall-unwrapped) getTotalVotes result shows the
 * queried voter has NOT voted. The voter's stake is the THIRD output
 * (`voterRawVoted`) — the first two are proposal-level totals, so testing the
 * first field (F6 regression) reported "voted" for every proposal anyone had
 * voted on.
 */
export function isUnvotedTotalVotes(value: unknown): boolean {
  const v = value as { voterRawVoted?: bigint } | null | undefined;
  return v?.voterRawVoted === 0n;
}

/**
 * Summarizes an already-multicall-unwrapped getPendingRewards value. The
 * function has a SINGLE tuple output, so multicall's single-return unwrap
 * hands us the tuple itself — there is no extra `.rewards` wrapper (reading
 * one crashed the whole per-DAO scan). Returns null when nothing is claimable.
 *
 * `scannedProposalIds` is the SAME id list passed to getPendingRewards —
 * PendingRewardsView arrays are positional per input id, the view does not
 * echo the ids back.
 */
export function summarizePendingRewards(
  value: unknown,
  scannedProposalIds: readonly string[] = [],
): {
  totalAmount: string;
  proposalIds: string[];
  rewardTokens: string[];
  offchainTotal?: string;
  offchainTokens?: string[];
} | null {
  const r = value as
    | {
        onchainTokens?: readonly string[];
        staticRewards?: readonly bigint[];
        votingRewards?: readonly { personal: bigint; micropool: bigint; treasury: bigint }[];
        offchainRewards?: readonly bigint[];
        offchainTokens?: readonly string[];
      }
    | null
    | undefined;
  if (!r?.staticRewards) return null;
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  let total = 0n;
  const ids: string[] = [];
  const tokens = new Set<string>();
  for (let i = 0; i < r.staticRewards.length; i++) {
    const v = r.votingRewards?.[i];
    const perProposal =
      (r.staticRewards[i] ?? 0n) + (v ? v.personal + v.micropool + v.treasury : 0n);
    if (perProposal > 0n) {
      total += perProposal;
      ids.push(scannedProposalIds[i] ?? String(i + 1));
      const t = r.onchainTokens?.[i];
      if (t && t.toLowerCase() !== ZERO_ADDR) tokens.add(t);
    }
  }
  let offchainTotal = 0n;
  for (const a of r.offchainRewards ?? []) offchainTotal += a;
  if (total <= 0n && offchainTotal <= 0n) return null;
  return {
    totalAmount: total.toString(),
    proposalIds: ids,
    rewardTokens: [...tokens],
    ...(offchainTotal > 0n
      ? {
          offchainTotal: offchainTotal.toString(),
          offchainTokens: [...(r.offchainTokens ?? [])],
        }
      : {}),
  };
}

// ---------- subgraph ----------

const USER_DAOS_QUERY = /* GraphQL */ `
  query UserDaos($user: String!, $first: Int!) {
    voterInPools(where: { voter_: { id: $user } }, first: $first) {
      pool {
        id
      }
    }
  }
`;

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function ok(data: Record<string, unknown>) {
  const text = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return {
    content: [{ type: "text" as const, text }],
    // Re-parsed from the same text so the machine-readable copy can never
    // disagree with what the human sees, and so no bigint leaks into
    // structuredContent (which must be plain JSON).
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

interface PendingItem {
  dao: string;
  type: "unvotedProposal" | "claimableRewards" | "lockedDeposit";
  proposalId?: string;
  proposalIds?: string[];
  deadline?: string;
  totalAmount?: string;
  amount?: string;
  govToken?: string;
  rewardTokens?: string[];
  offchainTotal?: string;
  offchainTokens?: string[];
}

// ---------- register ----------

export function registerInboxTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  // Built from the endpoints this install actually has — a hardcoded
  // "mainnet discovers, testnet doesn't" sentence goes stale the moment
  // someone sets DEXE_SUBGRAPH_POOLS_URL_97.
  const discoveryChains = subgraphChains(ctx.config, "pools");
  const discoveryNote = discoveryChains.length
    ? `chains that can auto-discover here: ${discoveryChains.join(", ")}`
    : "NO chain can auto-discover here (no pools subgraph configured)";

  server.registerTool(
    "dexe_user_inbox",
    {
      title: "Multi-DAO attention aggregator",
      description:
        "Aggregates pending items across N DAOs for a user: unvoted proposals in Voting state, claimable rewards, and locked deposits. " +
        `Discovery and scan both run on \`chainId\` (default ${ctx.config.defaultChainId}). Omitting \`daos\` auto-discovers the ` +
        `user's DAOs from that chain's pools subgraph (limit 50; ${discoveryNote}); on any other chain pass \`daos[]\` — the scan ` +
        "itself is pure on-chain and works everywhere. The response reports `indexedChainId` = the chain the discovered list came " +
        "from (null when you supplied it); discovery never answers from another chain's index. Read-only.",
      inputSchema: {
        user: z.string().describe("User wallet address"),
        daos: z
          .array(z.string())
          .optional()
          .describe("Optional explicit DAO list. Required on chains with no pools subgraph."),
        proposalScanLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Per-DAO recent-proposal scan window for unvoted/rewards detection"),
        chainId: chainIdParam,
      },
    },
    async ({ user, daos, proposalScanLimit = 20, chainId }) => {
      if (!isAddress(user)) return err(`Invalid user: ${user}`);
      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;
      // The chain the per-DAO scan will actually run on. Discovery resolves
      // against this exact number rather than the raw (possibly omitted)
      // `chainId`, so the two steps cannot drift apart even if the RPC and
      // subgraph defaults ever stop agreeing.
      const scanChainId = rpc.resolveChainId(chainId);
      const userAddr = getAddress(user);

      // ----- DAO list resolution -----
      let resolvedDaos: string[] = [];
      let daoSource: "caller" | "subgraph";
      /** Chain the discovered list was indexed from; null when the caller passed it. */
      let indexedChainId: number | null = null;
      let discoveryUnavailable: string | undefined;

      if (daos && daos.length > 0) {
        for (const d of daos) {
          if (!isAddress(d)) return err(`Invalid dao: ${d}`);
          resolvedDaos.push(getAddress(d));
        }
        daoSource = "caller";
        // Only discovery needs a subgraph; the scan is pure on-chain. When the
        // chain has none, say the coverage is exactly the supplied list — an
        // empty inbox here is not evidence that the user's OTHER DAOs are clear.
        if (!discoveryChains.includes(scanChainId)) {
          discoveryUnavailable =
            `Chain ${scanChainId} has no DeXe pools subgraph, so DAO auto-discovery is off: only the ` +
            `${resolvedDaos.length} DAO(s) you passed were checked, and DAOs outside that list were not.`;
        }
      } else {
        let sg: { url: string; chainId: number };
        try {
          sg = resolveSubgraphUrl(ctx.config, "pools", scanChainId);
        } catch (e) {
          // The resolver's message is already the user-facing remediation; the
          // one thing it can't know is that this tool has a subgraph-free path.
          return err(
            `${e instanceof Error ? e.message : String(e)}\n\n` +
              `dexe_user_inbox can still scan chain ${scanChainId} if you name the DAOs yourself — ` +
              `pass \`daos: ["0x…"]\`. Only auto-discovery needs the subgraph.`,
          );
        }
        daoSource = "subgraph";
        indexedChainId = sg.chainId;
        try {
          const data = await gqlRequest<{ voterInPools: { pool: { id: string } }[] }>(sg.url, USER_DAOS_QUERY, {
            user: userAddr.toLowerCase(),
            first: 50,
          });
          resolvedDaos = data.voterInPools.map((v) => getAddress(v.pool.id));
        } catch (e) {
          return err(
            `Subgraph DAO discovery failed on chain ${sg.chainId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const pendingItems: PendingItem[] = [];
      const scanErrors: { dao: string; step: string; error: string }[] = [];
      let daosWithItems = 0;

      // ----- per-DAO scan -----
      for (const dao of resolvedDaos) {
        const items: PendingItem[] = [];
        try {
          // Step 1: helpers + latest proposal id, then the NEWEST
          // `proposalScanLimit` proposals (F6: a 0-anchored window missed every
          // proposal past the limit — exactly the ones still in Voting).
          const [helpersR, latestR] = await multicall(provider, [
            { target: dao, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [], allowFailure: true },
            { target: dao, iface: GOV_POOL_ABI, method: "latestProposalId", args: [], allowFailure: true },
          ]);

          if (!helpersR?.success) {
            scanErrors.push({ dao, step: "getHelperContracts", error: "call failed" });
            continue;
          }
          const latest = latestR?.success ? BigInt(latestR.value as string | number | bigint) : BigInt(proposalScanLimit);
          const scanOffset = latest > BigInt(proposalScanLimit) ? latest - BigInt(proposalScanLimit) : 0n;
          const [proposalsR] = await multicall(provider, [
            {
              target: dao,
              iface: GOV_POOL_ABI,
              method: "getProposals",
              args: [scanOffset, BigInt(proposalScanLimit)],
              allowFailure: true,
            },
          ]);
          const helpers = helpersR.value as unknown as { userKeeper: string };
          const userKeeper = helpers.userKeeper;

          // Step 2: read deposit balance + token address.
          const [tokenAddrR, balanceR] = await multicall(provider, [
            { target: userKeeper, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [], allowFailure: true },
            {
              target: userKeeper,
              iface: USER_KEEPER_ABI,
              method: "tokenBalance",
              args: [userAddr, 0],
              allowFailure: true,
            },
          ]);
          const govToken = tokenAddrR?.success ? (tokenAddrR.value as string) : undefined;
          if (balanceR?.success) {
            // F6: `balance` includes wallet-held (never deposited) tokens —
            // the reclaimable deposit is balance − ownedBalance (bug #16 rule).
            const bal = balanceR.value as unknown as { balance: bigint; ownedBalance: bigint };
            const deposited = bal.balance - bal.ownedBalance;
            if (deposited > 0n) {
              items.push({
                dao,
                type: "lockedDeposit",
                amount: deposited.toString(),
                govToken,
              });
            }
          }

          // Step 3: walk recent proposals for unvoted in Voting state, and for
          // claimable rewards on already-voted proposals.
          if (proposalsR?.success) {
            const views = proposalsR.value as unknown as Array<{
              proposal: { core: { voteEnd: bigint } };
              proposalState: bigint | number;
            }>;
            const proposalIds: string[] = [];
            const votingIds: { id: string; deadline: string }[] = [];
            for (let i = 0; i < views.length; i++) {
              const id = (scanOffset + BigInt(i) + 1n).toString();
              proposalIds.push(id);
              const stateIdx = Number(views[i]!.proposalState);
              const stateName = proposalStateLabel(stateIdx);
              if (stateName === "Voting" || stateName === "ValidatorVoting") {
                votingIds.push({ id, deadline: views[i]!.proposal.core.voteEnd.toString() });
              }
            }

            // For each voting proposal, ask getTotalVotes → if voter has zero,
            // surface as unvoted.
            if (votingIds.length > 0) {
              const calls: Call[] = votingIds.map((p) => ({
                target: dao,
                iface: GOV_POOL_ABI,
                method: "getTotalVotes",
                args: [BigInt(p.id), userAddr, 0],
                allowFailure: true,
              }));
              const res = await multicall(provider, calls);
              for (let i = 0; i < votingIds.length; i++) {
                const r = res[i];
                if (!r?.success) continue;
                if (isUnvotedTotalVotes(r.value)) {
                  items.push({
                    dao,
                    type: "unvotedProposal",
                    proposalId: votingIds[i]!.id,
                    deadline: votingIds[i]!.deadline,
                  });
                }
              }
            }

            // Pending rewards across all scanned proposals (best-effort —
            // contracts that don't expose `getPendingRewards` will silently
            // produce an empty list).
            if (proposalIds.length > 0) {
              const [rewardsR] = await multicall(provider, [
                {
                  target: dao,
                  iface: PENDING_REWARDS_ABI,
                  method: "getPendingRewards",
                  args: [userAddr, proposalIds.map((s) => BigInt(s))],
                  allowFailure: true,
                },
              ]);
              if (rewardsR?.success) {
                const summary = summarizePendingRewards(rewardsR.value, proposalIds);
                if (summary) {
                  items.push({ dao, type: "claimableRewards", ...summary });
                }
              }
            }
          }
        } catch (e) {
          // Best-effort per DAO — skip on failure, but SAY so (a silently
          // dropped DAO reads as "nothing pending" — F6).
          scanErrors.push({ dao, step: "scan", error: e instanceof Error ? e.message : String(e) });
          continue;
        }

        if (items.length > 0) daosWithItems++;
        pendingItems.push(...items);
      }

      const criticalCount = pendingItems.filter((i) => i.type === "unvotedProposal").length;

      return ok({
        user: userAddr,
        chainId: scanChainId,
        daoSource,
        indexedChainId,
        ...(discoveryUnavailable ? { discoveryUnavailable } : {}),
        pendingItems,
        ...(scanErrors.length > 0 ? { scanErrors } : {}),
        summary: {
          totalDaos: resolvedDaos.length,
          daosWithItems,
          criticalCount,
        },
      });
    },
  );
}
