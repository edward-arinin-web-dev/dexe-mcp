import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { proposalStateLabel } from "../lib/govEnums.js";
import { gqlRequest, resolveSubgraphUrl, PROPOSAL_INTERACTIONS_QUERY } from "../lib/subgraph.js";
import { chainIdParam } from "../lib/params.js";
import { proposalInteractionLabel } from "../lib/interactionTypes.js";
import { safeErrorMessage } from "../lib/redact.js";
import { untrustedResult } from "../lib/sanitize.js";
import { toActionableError } from "../lib/errors.js";
import { quorumAttainmentPct, votesShortOfQuorum } from "../lib/quorumRisk.js";

/**
 * One ProposalView row, as far as the quorum readout needs it.
 *
 * `executeAfter` is the protocol's own answer to "did quorum pass":
 * GovPoolVote.sol:249-261 sets it to `executionDelay + quorumTimestamp` the
 * moment quorum is reached and resets it to 0 when a cancelled vote drops back
 * below (`_quorumReachedThroughVoting` is literally `core.executeAfter != 0`).
 * It costs nothing — the ABI already decodes it.
 */
interface QuorumRow {
  votesFor: bigint;
  votesAgainst: bigint;
  executeAfter: bigint;
  requiredQuorum: bigint;
}

/**
 * Quorum in DeXe is per-SIDE: EITHER votesFor or votesAgainst clearing the
 * target reaches it, never their sum (GovPoolVote.sol:367-375). A single
 * "attainment" number measured against votesFor alone would call an
 * Against-carried proposal "short of quorum" when it is not.
 */
function quorumFields(row: QuorumRow) {
  return {
    quorumReached: row.executeAfter > 0n,
    quorumAttainmentForPct: quorumAttainmentPct(row.votesFor, row.requiredQuorum),
    quorumAttainmentAgainstPct: quorumAttainmentPct(row.votesAgainst, row.requiredQuorum),
    votesShortOfQuorum: votesShortOfQuorum(row.votesFor, row.votesAgainst, row.requiredQuorum),
  };
}

const GOV_POOL_READ_ABI = [
  "function getProposalState(uint256 proposalId) view returns (uint8)",
  "function getProposalRequiredQuorum(uint256 proposalId) view returns (uint256)",
  "function getProposals(uint256 offset, uint256 limit) view returns (tuple(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription) settings, uint64 voteEnd, uint64 executeAfter, bool executed, uint256 votesFor, uint256 votesAgainst, uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 givenRewards) core, string descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst) proposal, tuple(tuple(bool executed, uint56 snapshotId, uint64 voteEnd, uint64 executeAfter, uint128 quorum, uint256 votesFor, uint256 votesAgainst) core) validatorProposal, uint8 proposalState, uint256 requiredQuorum, uint256 requiredValidatorsQuorum)[])",
] as const;

export function registerProposalTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerProposalState(server, ctx, rpc);
  registerProposalList(server, ctx, rpc);
  registerProposalVoters(server, ctx);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function registerProposalState(server: McpServer, ctx: ToolContext, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_proposal_state",
    {
      title: "Live proposal state + required quorum",
      description:
        "Reads `getProposalState`, `getProposalRequiredQuorum` and the proposal's votes on a GovPool in one " +
        "multicall. Returns named state (Voting, Defeated, SucceededFor, ExecutedFor, …), the votes on both " +
        "sides, and how far each side is from quorum. `requiredQuorum` is an ABSOLUTE vote weight, not a " +
        "percentage; quorum is per-side — either For or Against clearing it reaches quorum.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        proposalId: z.union([z.string(), z.number()]).describe("Proposal id (uint256)"),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        state: z.string(),
        stateIndex: z.number(),
        requiredQuorum: z.string(),
        // Nullable across the board: the votes leg is allowFailure, proposalId 0
        // is never queried, and an id past latestProposalId comes back as an
        // EMPTY array rather than a revert (GovPoolView.sol:56).
        votesFor: z.string().nullable(),
        votesAgainst: z.string().nullable(),
        quorumReached: z.boolean().nullable(),
        quorumAttainmentForPct: z.number().nullable(),
        quorumAttainmentAgainstPct: z.number().nullable(),
        votesShortOfQuorum: z.string().nullable(),
      },
    },
    async ({ govPool, proposalId, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      const id = BigInt(proposalId as string);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(GOV_POOL_READ_ABI as unknown as string[]);
        const calls: Call[] = [
          { target: govPool, iface, method: "getProposalState", args: [id] },
          { target: govPool, iface, method: "getProposalRequiredQuorum", args: [id] },
        ];
        // The votes ride along in the SAME batch — no extra round-trip. Only for
        // id > 0: `getProposals(id - 1, 1)` would encode a negative uint256 for
        // id 0, and multicall builds calldata outside its allowFailure guard
        // (src/lib/multicall.ts:48-52), so the throw would escape.
        if (id > 0n) {
          calls.push({
            target: govPool,
            iface,
            method: "getProposals",
            args: [id - 1n, 1n],
            allowFailure: true,
          });
        }
        const [stateR, quorumR, listR] = await multicall(provider, calls);
        if (!stateR?.success || !quorumR?.success) {
          return errorResult("Multicall failed — is govPool valid and proposalId known?");
        }
        const stateIndex = Number(stateR.value as bigint);
        const state = proposalStateLabel(stateIndex);
        const requiredQuorumRaw = quorumR.value as bigint;
        const requiredQuorum = requiredQuorumRaw.toString();

        // An id past latestProposalId SUCCEEDS with an empty array rather than
        // reverting (GovPoolView.sol:56), so length is checked, not just success.
        const rows = listR?.success && Array.isArray(listR.value) ? (listR.value as unknown[]) : [];
        const view = rows[0] as
          | {
              proposal: { core: { executeAfter: bigint; votesFor: bigint; votesAgainst: bigint } };
              requiredQuorum?: bigint;
            }
          | undefined;
        const row: QuorumRow | null = view?.proposal?.core
          ? {
              votesFor: view.proposal.core.votesFor,
              votesAgainst: view.proposal.core.votesAgainst,
              executeAfter: view.proposal.core.executeAfter,
              requiredQuorum: view.requiredQuorum ?? requiredQuorumRaw,
            }
          : null;
        const q = row
          ? quorumFields(row)
          : {
              quorumReached: null,
              quorumAttainmentForPct: null,
              quorumAttainmentAgainstPct: null,
              votesShortOfQuorum: null,
            };

        const structured = {
          govPool,
          proposalId: id.toString(),
          state,
          stateIndex,
          requiredQuorum,
          votesFor: row ? row.votesFor.toString() : null,
          votesAgainst: row ? row.votesAgainst.toString() : null,
          ...q,
        };
        const pct = (n: number | null) => (n === null ? "?" : String(n));
        const votesText = row
          ? `, votesFor=${row.votesFor} (${pct(q.quorumAttainmentForPct)}% of quorum)` +
            `, votesAgainst=${row.votesAgainst} (${pct(q.quorumAttainmentAgainstPct)}%)` +
            `, quorum ${q.quorumReached ? "REACHED" : `not reached — leading side short by ${q.votesShortOfQuorum ?? "?"}`}`
          : "";
        const zeroNote =
          requiredQuorum === "0"
            ? " — requiredQuorum 0 means this proposal does not exist or has not started (GovPool returns 0 for voteEnd==0)."
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Proposal ${id} on ${govPool}: state=${state} (${stateIndex}), ` +
                `requiredQuorum=${requiredQuorum} (absolute vote weight)${votesText}${zeroNote}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_proposal_state").message,
        );
      }
    },
  );
}

function registerProposalList(server: McpServer, ctx: ToolContext, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_proposal_list",
    {
      title: "List proposals on a GovPool",
      description:
        "Calls `GovPool.getProposals(offset, limit)` and returns a compact summary per proposal: id, " +
        "descriptionURL, state, votesFor/Against, voteEnd, executed, and quorum progress. Quorum is per-side " +
        "in DeXe — either For or Against clearing the target reaches it; `requiredQuorum` is an ABSOLUTE vote " +
        "weight, not a percentage.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        offset: z.number(),
        limit: z.number(),
        proposals: z.array(
          z.object({
            proposalId: z.string(),
            descriptionURL: z.string(),
            state: z.string(),
            stateIndex: z.number(),
            votesFor: z.string(),
            votesAgainst: z.string(),
            voteEnd: z.string(),
            executed: z.boolean(),
            requiredQuorum: z.string(),
            quorumReached: z.boolean(),
            // Null when requiredQuorum is 0 — a proposal that does not exist or
            // has not started (GovPool.sol:490-492). Never Infinity, never NaN.
            quorumAttainmentForPct: z.number().nullable(),
            quorumAttainmentAgainstPct: z.number().nullable(),
            votesShortOfQuorum: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ govPool, offset = 0, limit = 20, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(GOV_POOL_READ_ABI as unknown as string[]);
        const [res] = await multicall(provider, [
          {
            target: govPool,
            iface,
            method: "getProposals",
            args: [BigInt(offset), BigInt(limit)],
          },
        ]);
        if (!res?.success) return errorResult("getProposals reverted");
        const views = res.value as unknown as Array<{
          proposal: {
            core: {
              voteEnd: bigint;
              executeAfter: bigint;
              executed: boolean;
              votesFor: bigint;
              votesAgainst: bigint;
            };
            descriptionURL: string;
          };
          proposalState: number | bigint;
          requiredQuorum?: bigint;
        }>;
        const proposals = views.map((v, i) => {
          const idx = Number(v.proposalState);
          const row: QuorumRow = {
            votesFor: v.proposal.core.votesFor,
            votesAgainst: v.proposal.core.votesAgainst,
            executeAfter: v.proposal.core.executeAfter ?? 0n,
            requiredQuorum: v.requiredQuorum ?? 0n,
          };
          return {
            proposalId: String(offset + i + 1),
            descriptionURL: v.proposal.descriptionURL,
            state: proposalStateLabel(idx),
            stateIndex: idx,
            votesFor: row.votesFor.toString(),
            votesAgainst: row.votesAgainst.toString(),
            voteEnd: v.proposal.core.voteEnd.toString(),
            executed: v.proposal.core.executed,
            requiredQuorum: row.requiredQuorum.toString(),
            ...quorumFields(row),
          };
        });
        // `descriptionURL` is written by whoever created the proposal — anyone
        // with creating power — and an agent will often follow it. The per-row
        // summary below is all server-derived (ids, enum labels, uint256s); the
        // URL rides out through structuredContent, deep-sanitized.
        const structured = { govPool, offset, limit, proposals };
        const summary =
          `Proposals on ${govPool} [offset=${offset}, limit=${limit}] — ${proposals.length} returned\n` +
          proposals
            .map(
              (p) =>
                `  #${p.proposalId}  ${p.state.padEnd(22)}  ` +
                `for=${p.votesFor} (${p.quorumAttainmentForPct ?? "?"}% of quorum)  ` +
                `against=${p.votesAgainst}  ` +
                `${p.quorumReached ? "quorum REACHED" : `short by ${p.votesShortOfQuorum ?? "?"}`}  ` +
                `${p.executed ? "executed" : ""}`,
            )
            .join("\n");
        return untrustedResult({
          summary,
          label: "proposal descriptionURLs (proposer-authored)",
          structured,
        });
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_proposal_list").message,
        );
      }
    },
  );
}

function registerProposalVoters(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_voters",
    {
      title: "Voter list for a proposal (subgraph)",
      description:
        "Paginated voter list for one proposal, from the DeXe POOLS subgraph (`proposalInteractions`). " +
        "`chainId` selects which chain's subgraph is queried (default: the MCP's default chain) and the " +
        "response reports `indexedChainId` = where the rows came from. A chain with no pools endpoint " +
        "returns an error naming DEXE_SUBGRAPH_POOLS_URL_<chainId> and the on-chain alternatives — it never " +
        "answers from another chain's index.",
      inputSchema: {
        govPool: z.string().describe("GovPool address (used as filter on `pool` field)"),
        proposalId: z.union([z.string(), z.number()]),
        first: z.number().int().min(1).max(200).default(50),
        skip: z.number().int().min(0).default(0),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        /** The chain these rows were indexed from — not necessarily the request's default. */
        indexedChainId: z.number(),
        voters: z.array(
          z.object({
            voter: z.string(),
            interactionType: z.string(),
            interactionLabel: z.string().describe("VOTE_FOR | VOTE_AGAINST | VOTE_CANCEL"),
            totalVote: z.string(),
            timestamp: z.string(),
            transactionHash: z.string(),
          }),
        ),
      },
    },
    async ({ govPool, proposalId, first = 50, skip = 0, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      // The tool declared `chainId` and then dropped it, so a testnet caller got
      // mainnet voters presented as their own. Resolve per chain instead; the
      // resolver's message is already the user-facing remediation.
      let sg: { url: string; chainId: number };
      try {
        sg = resolveSubgraphUrl(ctx.config, "pools", chainId);
      } catch (err) {
        return errorResult(safeErrorMessage(err));
      }
      const id = BigInt(proposalId as string).toString();
      const num = Number(id);
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, num, true);
      const leHex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const compositeId = `${govPool.toLowerCase()}${leHex}`;
      try {
        const data = await gqlRequest<{
          proposalInteractions: Array<{
            id: string;
            hash: string;
            timestamp: string;
            interactionType: string;
            totalVote: string;
            voter: { id: string; voter: { id: string } };
          }>;
        }>(sg.url, PROPOSAL_INTERACTIONS_QUERY, {
          proposalId: compositeId,
          first,
          skip,
        });
        const voters = data.proposalInteractions.map((pi) => {
          // Voter entity id = `<userAddr><poolAddr>` (40+40 hex, no separator).
          // Slice the user address out of the composite, falling back to a
          // nested user id if a future schema exposes one.
          const raw = pi.voter?.voter?.id ?? pi.voter?.id ?? "";
          const userAddr = raw.length >= 42 ? raw.slice(0, 42) : raw;
          return {
            voter: userAddr,
            interactionType: pi.interactionType,
            interactionLabel: proposalInteractionLabel(pi.interactionType),
            totalVote: pi.totalVote,
            timestamp: pi.timestamp,
            transactionHash: pi.hash,
          };
        });
        const structured = { govPool, proposalId: id, indexedChainId: sg.chainId, voters };
        return untrustedResult({
          summary: `Voters for proposal ${id} on ${govPool} (chain ${sg.chainId}): ${voters.length} returned (first=${first}, skip=${skip})`,
          label: `voter rows (chain ${sg.chainId})`,
          structured,
        });
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_proposal_voters").message,
        );
      }
    },
  );
}
