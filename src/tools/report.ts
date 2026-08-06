import { z } from "zod";
import { Interface, isAddress, getAddress } from "ethers";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { DexeConfig, SubgraphKind } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { gqlRequest, resolveSubgraphUrl } from "../lib/subgraph.js";
import { proposalStateLabel } from "../lib/govEnums.js";
import { renameWithRetry, tempStatePath, withWriteLock } from "../lib/stateStore.js";
import { chainIdParam } from "../lib/params.js";
import { unixToUtc } from "../lib/time.js";
import { renderUntrusted } from "../lib/sanitize.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/errors.js";
import { debugLog } from "../runtime.js";
import { DEFAULT_TOOLSETS, TOOLSETS, defaultProfileToolNames } from "./gate.js";
import { labelProposalSettings } from "./read.js";
import {
  GOV_POOL_ABI as GOV_POOL_INBOX_ABI,
  PENDING_REWARDS_ABI,
  isUnvotedTotalVotes,
  summarizePendingRewards,
} from "./inbox.js";

/**
 * `dexe_dao_report` — the whole picture of one DAO in a single call.
 *
 * A "how is this DAO doing" answer used to cost 12-18 tool calls plus one more
 * PER PROPOSAL for turnout, which is why nobody could put a DAO report behind
 * /schedule or /loop: the call budget scaled with the DAO. This composes the
 * same reads into one call — identity, settings, treasury, membership,
 * delegation, experts, validators, proposal throughput/outcomes, per-proposal
 * turnout, recent activity, and everything with a deadline attached.
 *
 * **Composition, not duplication.** Every on-chain read reuses the shared ABIs
 * and `multicall` the single-purpose tools use (`GOV_POOL_ABI` /
 * `PENDING_REWARDS_ABI` / `summarizePendingRewards` come straight from
 * `inbox.ts`, settings labelling from `read.ts`). The GraphQL documents here
 * are deliberately NOT copies of the per-entity queries in `subgraph.ts`: they
 * are ONE batched document per subgraph, which is the entire point — the pools
 * subgraph can return turnout for every proposal at once, so the report never
 * pays the per-proposal round-trip that `dexe_proposal_voters` does. For deeper
 * pagination past the report's window the per-entity tools remain the right
 * call, and the report names them in `followUps`.
 *
 * **Degradation is a feature.** Sections are independent. A chain with no
 * subgraph still renders every on-chain section and NAMES the missing ones with
 * the resolver's own remediation text; a dead RPC still renders the subgraph
 * sections. A half-report that silently drops sections is the failure mode this
 * release train exists to kill, so `unavailable[]` is always populated and the
 * text body always prints it.
 *
 * **`since` is what makes it schedulable.** A report that restates the same
 * numbers every hour is noise a user switches off. With `since` the payload
 * carries `changes`: proposals created, proposals that MOVED STATE, members
 * joined, delegation shifts, treasury deltas. Timestamp-filtered subgraph
 * queries answer "what is new"; a small per-DAO snapshot store (sibling of
 * state.json, same write discipline) answers "what MOVED" — nothing else can,
 * because the chain has no "state changed at" record to query.
 */

// ---------- constants ----------

export const REPORT_SECTIONS = [
  "identity",
  "settings",
  "treasury",
  "membership",
  "delegation",
  "experts",
  "validators",
  "proposals",
  "turnout",
  "activity",
  "deadlines",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * Activity window used when the caller gave no `since`. A scheduled run always
 * passes one; this only shapes the first/ad-hoc report, where "recent" has to
 * mean something concrete rather than "all of history".
 */
const DEFAULT_ACTIVITY_WINDOW_SEC = 7 * 24 * 60 * 60;

/** Rows kept per delta list — a diff is a summary, not a data dump. */
const DELTA_ROW_CAP = 100;

/** Snapshots retained in the report store (one per chain+DAO, newest first). */
const MAX_SNAPSHOTS = 100;

// ---------- ABIs ----------

/**
 * The GovPool reads `inbox.ts` does not already cover. `getHelperContracts`,
 * `latestProposalId`, `getProposals`, `getTotalVotes` and `getPendingRewards`
 * are imported from there so the two tools can never disagree about the
 * ProposalView tuple shape (bug #26 class).
 */
const GOV_POOL_EXTRA_ABI = new Interface([
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
  "function descriptionURL() view returns (string)",
  "function getCreditInfo() view returns (tuple(address token, uint256 monthLimit, uint256 currentWithdrawLimit)[])",
]);

const GOV_SETTINGS_ABI = new Interface([
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
  "function getInternalSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
]);

const GOV_VALIDATORS_ABI = new Interface([
  "function validatorsCount() view returns (uint256)",
]);

const USER_KEEPER_ABI = new Interface([
  "function tokenAddress() view returns (address)",
]);

const ERC20_ABI = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

// ---------- GraphQL ----------

/**
 * One document, one round-trip, five entity families. `$poolId` is `Bytes!`
 * because `DaoPool_filter.id` is typed from the entity's own id, while
 * `$pool` is `String!` because relation filters (`VoterInPool.pool`,
 * `Proposal.pool`) are generated as `String` — the two proven spellings already
 * in `subgraph.ts`. Mixing them up produces "Odd number of digits" at the
 * gateway, not a type error here.
 */
const POOLS_REPORT_QUERY = /* GraphQL */ `
  query DaoReport(
    $poolId: Bytes!
    $pool: String!
    $members: Int!
    $proposals: Int!
    $pairs: Int!
  ) {
    daoPools(first: 1, where: { id: $poolId }) {
      id
      name
      userKeeper
      erc20Token
      erc721Token
      nftMultiplier
      votersCount
      proposalCount
      creationTime
      creationBlock
      totalCurrentTokenDelegated
      totalCurrentTokenDelegatees
      totalCurrentTokenDelegatedTreasury
    }
    members: voterInPools(
      where: { pool: $pool }
      first: $members
      orderBy: joinedTimestamp
      orderDirection: desc
    ) {
      joinedTimestamp
      receivedDelegation
      receivedTreasuryDelegation
      engagedProposalsCount
      currentDelegateesCount
      currentDelegatorsCount
      totalClaimedUSD
      totalLockedUSD
      expertNft {
        tokenId
      }
      voter {
        id
        totalProposalsCreated
        totalVotedProposals
        totalVotes
        currentVotesReceived
        currentVotesDelegated
      }
    }
    experts: voterInPools(
      where: { pool: $pool, expertNft_: { id_not: null } }
      first: 100
    ) {
      receivedDelegation
      receivedTreasuryDelegation
      expertNft {
        tokenId
        tags
      }
      voter {
        id
      }
    }
    proposals(
      where: { pool: $pool }
      first: $proposals
      orderBy: proposalId
      orderDirection: desc
    ) {
      proposalId
      votersVoted
      currentVotesFor
      currentVotesAgainst
      quorum
      quorumReachedTimestamp
      executionTimestamp
      isFor
      creator {
        id
      }
    }
    delegations: voterInPoolPairs(
      where: { delegator_: { pool: $pool } }
      first: $pairs
      orderBy: delegatedAmount
      orderDirection: desc
    ) {
      creationTimestamp
      delegatedAmount
      delegatedVotes
      delegatedUSD
      delegatedNfts
      delegator {
        voter {
          id
        }
      }
      delegatee {
        voter {
          id
        }
        expertNft {
          tokenId
        }
      }
    }
  }
`;

/**
 * The `since` half. Split from the base document because the `_gt` filters are
 * only meaningful with an anchor — folding them in would force a sentinel
 * `since: 0` on every plain report and page rows nobody asked for.
 */
const POOLS_DELTA_QUERY = /* GraphQL */ `
  query DaoReportDelta($pool: String!, $since: BigInt!, $first: Int!) {
    joined: voterInPools(
      where: { pool: $pool, joinedTimestamp_gt: $since }
      first: $first
      orderBy: joinedTimestamp
      orderDirection: desc
    ) {
      joinedTimestamp
      voter {
        id
      }
    }
    newDelegations: voterInPoolPairs(
      where: { delegator_: { pool: $pool }, creationTimestamp_gt: $since }
      first: $first
      orderBy: creationTimestamp
      orderDirection: desc
    ) {
      creationTimestamp
      delegatedAmount
      delegatedVotes
      delegator {
        voter {
          id
        }
      }
      delegatee {
        voter {
          id
        }
      }
    }
    delegationEvents: delegationHistories(
      where: { pool: $pool, timestamp_gt: $since }
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      timestamp
      type
      amount
      delegator {
        id
      }
      delegatee {
        id
      }
    }
  }
`;

/**
 * DAO-scoped activity feed. The interactions subgraph is the only one with a
 * per-event timestamp for a pool — pools `Proposal` has no creation time at all
 * (see docs/GRAPH.md), which is why "what happened lately" cannot come from the
 * pools index. No `orderBy`: ordering by a nested `transaction__timestamp` is
 * not portable across graph-node versions, so the rows are sorted here.
 */
const INTERACTIONS_ACTIVITY_QUERY = /* GraphQL */ `
  query DaoActivity($pool: String!, $since: BigInt!, $first: Int!) {
    proposalsCreated: daoProposalCreates(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      proposalId
      transaction {
        timestamp
        user
        block
      }
    }
    votes: daoPoolProposalInteractions(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      interactionType
      totalVote
      transaction {
        timestamp
        user
      }
    }
    executions: daoPoolExecutes(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      proposalId
      transaction {
        timestamp
        user
      }
    }
    delegations: daoPoolDelegates(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      amount
      transaction {
        timestamp
        user
      }
    }
    rewardClaims: daoPoolRewardClaims(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      proposalId
      transaction {
        timestamp
        user
      }
    }
    deposits: daoPoolVests(
      where: { pool: $pool, transaction_: { timestamp_gt: $since } }
      first: $first
    ) {
      amount
      transaction {
        timestamp
        user
      }
    }
  }
`;

const VALIDATORS_REPORT_QUERY = /* GraphQL */ `
  query DaoValidators($pool: String!, $first: Int!) {
    validatorInPools(
      where: { pool: $pool }
      first: $first
      orderBy: balance
      orderDirection: desc
    ) {
      validatorAddress
      balance
    }
  }
`;

// ---------- `since` parsing ----------

export type ParsedSince =
  | { kind: "lastRun" }
  | { kind: "timestamp"; unix: number }
  | { kind: "block"; block: number }
  | { kind: "error"; message: string };

/**
 * Block numbers and Unix seconds are both bare integers, so a bare number is
 * disambiguated by magnitude: BSC is around 6e7 blocks in 2026 and Unix seconds
 * are around 1.8e9, and the two ranges do not converge for centuries. The
 * explicit `block:` / `unix:` prefixes exist so a caller never has to trust that
 * reasoning.
 */
export const SINCE_TIMESTAMP_FLOOR = 1_000_000_000;

export function parseSince(raw: string): ParsedSince {
  const s = raw.trim();
  if (!s) return { kind: "error", message: "`since` is empty." };
  const lower = s.toLowerCase();
  if (lower === "last" || lower === "lastrun" || lower === "last-run") {
    return { kind: "lastRun" };
  }
  const blockPrefix = /^block:(\d+)$/.exec(lower);
  if (blockPrefix) return { kind: "block", block: Number(blockPrefix[1]) };
  const unixPrefix = /^unix:(\d+)$/.exec(lower);
  if (unixPrefix) return { kind: "timestamp", unix: Number(unixPrefix[1]) };
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= SINCE_TIMESTAMP_FLOOR
      ? { kind: "timestamp", unix: n }
      : { kind: "block", block: n };
  }
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return { kind: "timestamp", unix: Math.floor(ms / 1000) };
  return {
    kind: "error",
    message:
      `Could not read \`since\`: "${renderUntrusted(s, 60)}". Accepted: an ISO-8601 timestamp ` +
      `("2026-08-01T00:00:00Z"), Unix seconds ("1785000000" or "unix:1785000000"), a block number ` +
      `("block:62000000"), or "last" to diff against this DAO's previous report run.`,
  };
}

// ---------- snapshot store ----------

/**
 * What the next run needs in order to say what MOVED. Deliberately small: the
 * chain can answer "what exists now" but has no queryable record of "this
 * proposal was Voting an hour ago", so only the fields a diff consumes are kept.
 */
export interface ReportSnapshot {
  govPool: string;
  chainId: number;
  /** Unix seconds when the snapshot was taken. */
  at: number;
  blockNumber: number | null;
  latestProposalId: string | null;
  /** proposalId → state name, for the scanned window only. */
  proposalStates: Record<string, string>;
  /** Voter wallets seen in the member window (lowercased). */
  memberIds: string[];
  /** True when the member window was saturated — a departure diff is then window-scoped. */
  memberWindowFull: boolean;
  membersTotal: string | null;
  delegationTotal: string | null;
  delegateesTotal: string | null;
  treasuryNative: string | null;
  treasuryToken: string | null;
  validatorsCount: string | null;
  expertCount: number | null;
}

interface ReportStoreFile {
  version: number;
  snapshots: ReportSnapshot[];
}

const REPORT_STORE_VERSION = 1;

const snapshotKey = (chainId: number, govPool: string) =>
  `${chainId}:${govPool.toLowerCase()}`;

/**
 * Per-DAO report snapshots, stored beside `state.json`.
 *
 * Kept OUT of `PersistedState` on purpose: that file is the record of DAOs the
 * user paid gas for, and pushing a growing per-DAO blob through the same
 * read-modify-write would make every deploy re-serialize report history.
 *
 * Same write discipline as `StateStore` — private temp file, cross-process lock
 * (`withWriteLock`), atomic publish (`renameWithRetry`), and a compare-and-swap
 * on the bytes we computed from, so a writer that could not take the lock still
 * cannot erase another window's snapshots. Tolerant at every layer: a missing,
 * corrupt or unwritable store degrades to "no previous run", never to a failed
 * report.
 */
export class ReportStore {
  constructor(private readonly path: string) {}

  get(chainId: number, govPool: string): ReportSnapshot | null {
    const key = snapshotKey(chainId, govPool);
    return (
      this.read().state.snapshots.find((s) => snapshotKey(s.chainId, s.govPool) === key) ?? null
    );
  }

  put(next: ReportSnapshot): void {
    withWriteLock(this.path, () => {
      const key = snapshotKey(next.chainId, next.govPool);
      // Three tries against a concurrent writer, then publish anyway: losing a
      // snapshot costs one noisier report, so blocking longer buys nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { raw, state } = this.read();
        const merged: ReportStoreFile = {
          version: REPORT_STORE_VERSION,
          snapshots: [
            next,
            ...state.snapshots.filter((s) => snapshotKey(s.chainId, s.govPool) !== key),
          ].slice(0, MAX_SNAPSHOTS),
        };
        if (this.publish(merged, raw) !== "stale") return;
      }
      const { state } = this.read();
      this.publish(
        {
          version: REPORT_STORE_VERSION,
          snapshots: [
            next,
            ...state.snapshots.filter((s) => snapshotKey(s.chainId, s.govPool) !== key),
          ].slice(0, MAX_SNAPSHOTS),
        },
        undefined,
      );
    });
  }

  private read(): { raw: string | null; state: ReportStoreFile } {
    const empty: ReportStoreFile = { version: REPORT_STORE_VERSION, snapshots: [] };
    try {
      if (!existsSync(this.path)) return { raw: null, state: empty };
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ReportStoreFile>;
      if (parsed?.version !== REPORT_STORE_VERSION || !Array.isArray(parsed.snapshots)) {
        return { raw, state: empty };
      }
      return { raw, state: { version: REPORT_STORE_VERSION, snapshots: parsed.snapshots } };
    } catch (err) {
      debugLog("report", `could not read snapshots at ${this.path}`, err);
      return { raw: null, state: empty };
    }
  }

  /** `undefined` for `expect` skips the compare-and-swap (last-resort publish). */
  private publish(
    file: ReportStoreFile,
    expect: string | null | undefined,
  ): "published" | "stale" | "failed" {
    const tmp = tempStatePath(this.path);
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
      if (expect !== undefined) {
        const now = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
        if (now !== expect) {
          rmSync(tmp, { force: true });
          return "stale";
        }
      }
      renameWithRetry(tmp, this.path);
      return "published";
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Same permission problem that failed the write; nothing more to do.
      }
      // stderr only — stdout is the MCP protocol channel. A store that cannot be
      // written costs future diffs, never this report.
      process.stderr.write(
        `[dexe-mcp] could not persist report snapshot to ${this.path} ` +
          `(${safeErrorMessage(err)}); the next \`since\` diff will have no baseline.\n`,
      );
      return "failed";
    }
  }
}

/** Sibling of `state.json` — same directory, same lifecycle, separate file. */
export function reportStorePath(config: DexeConfig): string {
  return join(dirname(config.statePath), "reports.json");
}

// ---------- output schema ----------

/**
 * One shared instance, referenced by all eleven section keys. The JSON-Schema
 * converter emits a `$ref` for a repeated schema OBJECT but a full copy for
 * eleven structurally-identical ones — and `tools/list` ships this schema on
 * every session of every install, so the difference is a permanent token cost.
 */
const SECTION_ENVELOPE = z.object({
  available: z.boolean(),
  source: z.enum(["onchain", "subgraph", "mixed", "none"]),
  /** Present only when `available` is false — why, in the caller's terms. */
  reason: z.string().optional(),
  /** The tool to call for the missing part, when one exists. */
  followUp: z.string().optional(),
  /** Section payload; shapes are documented per section in docs/REPORTING.md. */
  data: z.record(z.unknown()).nullable(),
});

const rows = z.array(z.record(z.unknown()));

/**
 * Declared so the report can be consumed by code, which is the point of a
 * recurring report: every existing subgraph tool emits `structuredContent` with
 * no `outputSchema`, so nothing downstream can be typed against them.
 *
 * Leaf rows stay `z.record(z.unknown())` rather than enumerating every subgraph
 * field — `tools/list` ships this schema on every session, and the envelope
 * (`available` / `source` / `reason`) plus `deadlines` and `changes` are what
 * automation actually branches on.
 */
export const DAO_REPORT_OUTPUT_SHAPE = {
  govPool: z.string(),
  chainId: z.number(),
  generatedAt: z.string(),
  generatedAtUnix: z.number(),
  blockNumber: z.number().nullable(),
  since: z
    .object({
      requested: z.string(),
      mode: z.enum(["timestamp", "block", "lastRun"]),
      unix: z.number(),
      iso: z.string(),
      note: z.string().optional(),
    })
    .nullable(),
  sources: z.object({
    rpc: z.object({ available: z.boolean(), reason: z.string().optional() }),
    subgraphs: z.record(
      z.object({
        available: z.boolean(),
        indexedChainId: z.number().nullable(),
        reason: z.string().optional(),
      }),
    ),
  }),
  // `.partial()` because `sections` narrows the run — a key is absent exactly
  // when the caller did not ask for it. A section that WAS asked for is always
  // present, with `available: false` and a reason when it could not render.
  sections: z
    .object({
      identity: SECTION_ENVELOPE,
      settings: SECTION_ENVELOPE,
      treasury: SECTION_ENVELOPE,
      membership: SECTION_ENVELOPE,
      delegation: SECTION_ENVELOPE,
      experts: SECTION_ENVELOPE,
      validators: SECTION_ENVELOPE,
      proposals: SECTION_ENVELOPE,
      turnout: SECTION_ENVELOPE,
      activity: SECTION_ENVELOPE,
      deadlines: SECTION_ENVELOPE,
    })
    .partial(),
  /** Every section that did NOT render, with the reason — never a silent omission. */
  unavailable: z.array(
    z.object({ section: z.string(), reason: z.string(), followUp: z.string().optional() }),
  ),
  /** Populated only with `since`; null otherwise. */
  changes: z
    .object({
      sinceUnix: z.number(),
      sinceIso: z.string(),
      baseline: z.enum(["snapshot", "timestampOnly", "none"]),
      baselineAt: z.string().nullable(),
      newProposals: rows,
      proposalStateChanges: rows,
      membersJoined: rows,
      membersNoLongerInWindow: z.array(z.string()),
      membersCountDelta: z.number().nullable(),
      delegationChanges: rows,
      delegationTotalDelta: z.string().nullable(),
      treasuryDeltas: rows,
      validatorsCountDelta: z.number().nullable(),
      expertCountDelta: z.number().nullable(),
      notes: z.array(z.string()),
    })
    .nullable(),
  followUps: z.array(z.string()),
  snapshotPersisted: z.boolean(),
} as const;

// ---------- helpers ----------

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** `GovPool.getHelperContracts()` return, named so the section code can be typed. */
interface GovHelpers {
  settings: string;
  userKeeper: string;
  validators: string;
  poolRegistry: string;
  votePower: string;
}

interface Section {
  available: boolean;
  source: "onchain" | "subgraph" | "mixed" | "none";
  reason?: string;
  followUp?: string;
  data: Record<string, unknown> | null;
}

const have = (source: Section["source"], data: Record<string, unknown>): Section => ({
  available: true,
  source,
  data,
});

const missing = (reason: string, followUp?: string): Section => ({
  available: false,
  source: "none",
  reason,
  ...(followUp ? { followUp } : {}),
  data: null,
});

// ---------- naming a follow-up tool the caller can actually call ----------

/**
 * The tools a session HAS when `DEXE_TOOLSETS` is unset. Read from the gate,
 * never hand-listed: 0.31.0 moved this boundary (core+proposals → core), and
 * every followUp below is emitted BY that default profile. A name that has
 * quietly left it turns this tool's degradation advice into a confident 404 —
 * which is worse than no advice, because the user follows it.
 */
const DEFAULT_PROFILE_TOOLS: ReadonlySet<string> = defaultProfileToolNames();

/**
 * Which set to name when a tool lives in several. `read` first because that is
 * where the reads a report signposts live; `dev` last because loading the
 * Solidity dev surface to answer a governance question is the biggest ask.
 */
const TOOLSET_PREFERENCE = ["read", "vote", "proposals", "governor", "dev"] as const;

/**
 * The `DEXE_TOOLSETS` value that makes `tool` callable, or null when the default
 * profile already has it.
 *
 * Always spells the DEFAULT sets PLUS the one being added, because
 * `DEXE_TOOLSETS` REPLACES the profile rather than extending it: bare
 * `DEXE_TOOLSETS=read` would take away `dexe_dao_report` itself — the tool that
 * printed the advice.
 */
export function toolsetHint(tool: string): string | null {
  if (DEFAULT_PROFILE_TOOLS.has(tool)) return null;
  const owner =
    TOOLSET_PREFERENCE.find((s) => TOOLSETS[s]?.has(tool)) ??
    Object.keys(TOOLSETS).find((s) => TOOLSETS[s]!.has(tool));
  return `DEXE_TOOLSETS=${owner ? [...DEFAULT_TOOLSETS, owner].join(",") : "full"}`;
}

/**
 * A tool named in a followUp: bare when this session can call it, annotated with
 * the env value that unlocks it when it cannot. The annotation is the FALLBACK —
 * every followUp below names a default-profile tool first whenever one can
 * answer the same question.
 */
export function toolRef(tool: string, note?: string): string {
  const hint = toolsetHint(tool);
  const inner = [note, hint].filter(Boolean).join("; ");
  return inner ? `${tool} (${inner})` : tool;
}

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === "bigint" ? v.toString() : String(v);

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Difference of two decimal-integer strings, or null when either is absent. */
function bigDelta(now: string | null, before: string | null): string | null {
  if (now === null || before === null) return null;
  try {
    return (BigInt(now) - BigInt(before)).toString();
  } catch {
    return null;
  }
}

function fmtDuration(sec: number): string {
  const a = Math.abs(sec);
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const parts = d > 0 ? [`${d}d`, `${h}h`] : h > 0 ? [`${h}h`, `${m}m`] : [`${m}m`];
  return `${sec < 0 ? "-" : ""}${parts.join(" ")}`;
}

/** Plain-JSON copy — bigints stringified, `undefined` dropped, no shared refs. */
function jsonPlain<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}

interface SubgraphSource {
  available: boolean;
  indexedChainId: number | null;
  reason?: string;
}

/** Resolve one subgraph endpoint, keeping the resolver's remediation verbatim. */
function resolveSource(
  config: DexeConfig,
  kind: SubgraphKind,
  chainId: number,
): { url: string; source: SubgraphSource } | { url: null; source: SubgraphSource } {
  try {
    const sg = resolveSubgraphUrl(config, kind, chainId);
    return { url: sg.url, source: { available: true, indexedChainId: sg.chainId } };
  } catch (err) {
    return {
      url: null,
      source: { available: false, indexedChainId: null, reason: safeErrorMessage(err) },
    };
  }
}

// ---------- register ----------

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  const store = new ReportStore(reportStorePath(ctx.config));

  server.registerTool(
    "dexe_dao_report",
    {
      title: "Full DAO report — one call, every section, with a since-diff",
      description:
        "The whole picture of one DAO in a single call: identity + settings, treasury, membership, delegation " +
        "(who delegated to whom — no address list needed), experts, validators, proposal throughput and outcomes, " +
        "per-proposal voter turnout, recent activity, and everything with a DEADLINE (open votes, executable " +
        "proposals, and — with `user` — unvoted proposals and claimable rewards). Replaces the 12-18 read calls " +
        "this used to take, plus one per proposal for turnout. " +
        "Pass `since` (ISO timestamp, Unix seconds, `block:<n>`, or `last`) to get ONLY what changed — new " +
        "proposals, proposals that moved state, members joined, delegation shifts, treasury deltas — which is what " +
        "makes it usable on a schedule. Each run stores a small snapshot so the next `since` diff has a baseline. " +
        "Sections degrade independently: on a chain with no subgraph the on-chain sections still render and the " +
        "unavailable ones are NAMED in `unavailable[]` with the reason and the tool to call instead. " +
        "Narrow the work with `sections`. Read-only.",
      inputSchema: {
        govPool: z.string().describe("GovPool / DAO address"),
        chainId: chainIdParam,
        since: z
          .string()
          .optional()
          .describe(
            "Diff anchor: ISO-8601 ('2026-08-01T00:00:00Z'), Unix seconds ('1785000000' / 'unix:…'), a block " +
              "number ('block:62000000'; a bare integer below 1e9 is read as a block), or 'last' to diff against " +
              "this DAO's previous report run. Omit for a full point-in-time report.",
          ),
        sections: z
          .array(z.enum(REPORT_SECTIONS))
          .optional()
          .describe(`Narrow the report. Default: all of ${REPORT_SECTIONS.join(", ")}.`),
        user: z
          .string()
          .optional()
          .describe(
            "Optional wallet. Adds per-user deadline items: proposals in Voting this user has NOT voted on, and claimable rewards.",
          ),
        proposalLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(30)
          .describe("How many of the NEWEST proposals to walk for state, outcomes and turnout."),
        memberLimit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Member/delegation rows to fetch (newest joiners first)."),
        persist: z
          .boolean()
          .default(true)
          .describe(
            "Store this run's snapshot so a later `since` diff has a baseline. Full runs only — a `sections`-narrowed run never overwrites it.",
          ),
      },
      outputSchema: DAO_REPORT_OUTPUT_SHAPE,
    },
    async ({
      govPool,
      chainId,
      since,
      sections,
      user,
      proposalLimit = 30,
      memberLimit = 50,
      persist = true,
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (user !== undefined && !isAddress(user)) return errorResult(`Invalid user: ${user}`);
      const dao = getAddress(govPool);
      const daoLower = dao.toLowerCase();
      const userAddr = user ? getAddress(user) : null;

      const wanted = new Set<ReportSection>(sections?.length ? sections : REPORT_SECTIONS);
      const want = (s: ReportSection) => wanted.has(s);

      // The chain everything is filed under. Resolved even when no RPC exists,
      // so a subgraph-only report still states which chain it describes.
      let resolvedChainId: number;
      try {
        resolvedChainId = rpc.resolveChainId(chainId);
      } catch {
        resolvedChainId = chainId ?? ctx.config.defaultChainId;
      }

      const pr = rpc.tryProvider(chainId);
      const provider = "ok" in pr ? pr.ok : null;
      const rpcSource: { available: boolean; reason?: string } =
        "ok" in pr
          ? { available: true }
          : { available: false, reason: `${pr.error} ${pr.remediation}` };

      const pools = resolveSource(ctx.config, "pools", resolvedChainId);
      const validatorsSg = resolveSource(ctx.config, "validators", resolvedChainId);
      const interactions = resolveSource(ctx.config, "interactions", resolvedChainId);

      if (!provider && !pools.url && !validatorsSg.url && !interactions.url) {
        return errorResult(
          `Cannot report on ${dao}: chain ${resolvedChainId} has neither an RPC nor any subgraph configured, ` +
            `so there is no source to read from.\n\nRPC: ${rpcSource.reason}\n\nSubgraph: ${pools.source.reason}`,
        );
      }

      const nowWall = Math.floor(Date.now() / 1000);
      const previous = store.get(resolvedChainId, dao);

      // ----- `since` resolution -----
      let sinceUnix: number | null = null;
      let sinceMode: "timestamp" | "block" | "lastRun" | null = null;
      let sinceNote: string | undefined;
      if (since !== undefined) {
        const parsed = parseSince(since);
        if (parsed.kind === "error") return errorResult(parsed.message);
        if (parsed.kind === "timestamp") {
          sinceMode = "timestamp";
          sinceUnix = parsed.unix;
        } else if (parsed.kind === "lastRun") {
          if (!previous) {
            return errorResult(
              `since: "last" needs a previous report for ${dao} on chain ${resolvedChainId}, and none is stored ` +
                `(this is the first run, or it ran with persist: false). Run dexe_dao_report once without \`since\` ` +
                `to lay down a baseline, or pass an explicit timestamp.`,
            );
          }
          sinceMode = "lastRun";
          sinceUnix = previous.at;
          sinceNote = `Anchored to the previous run at ${new Date(previous.at * 1000).toISOString()}.`;
        } else {
          if (!provider) {
            return errorResult(
              `since: "block:${parsed.block}" needs an RPC to turn a block number into a timestamp, and chain ` +
                `${resolvedChainId} has none. ${rpcSource.reason ?? ""}\nPass an ISO timestamp or Unix seconds instead.`,
            );
          }
          try {
            const blk = await provider.getBlock(parsed.block);
            if (!blk) {
              return errorResult(
                `Block ${parsed.block} was not found on chain ${resolvedChainId} — it may be ahead of the chain head, ` +
                  `or pruned by this RPC. Pass an ISO timestamp instead.`,
              );
            }
            sinceMode = "block";
            sinceUnix = Number(blk.timestamp);
            sinceNote = `Block ${parsed.block} → ${unixToUtc(sinceUnix)}.`;
          } catch (err) {
            return errorResult(toActionableError(err, `dexe_dao_report since block lookup`).message);
          }
        }
      }

      /** The window the activity section covers, with or without an explicit anchor. */
      const activitySince = sinceUnix ?? nowWall - DEFAULT_ACTIVITY_WINDOW_SEC;

      // ----- on-chain reads -----
      interface ProposalRow {
        proposalId: string;
        state: string;
        stateIndex: number;
        descriptionURL: string;
        votesFor: string;
        votesAgainst: string;
        voteEnd: string;
        validatorVoteEnd: string;
        executeAfter: string;
        executed: boolean;
        requiredQuorum: string;
      }

      let helpers: GovHelpers | null = null;
      let nftContracts: Record<string, string> | null = null;
      let descriptionURL: string | null = null;
      let latestProposalId: string | null = null;
      let onchainProposals: ProposalRow[] = [];
      let defaultSettings: unknown = null;
      let internalSettings: unknown = null;
      let validatorsCount: string | null = null;
      let creditLines: Array<Record<string, string>> | null = null;
      let govToken: string | null = null;
      let tokenMeta: Record<string, unknown> | null = null;
      let nativeBalance: string | null = null;
      let blockNumber: number | null = null;
      let chainNow = nowWall;
      let onchainError: string | null = null;
      let scanOffset = 0n;

      if (provider) {
        try {
          const [helpersR, nftR, descR, latestR] = await multicall(provider, [
            { target: dao, iface: GOV_POOL_INBOX_ABI, method: "getHelperContracts", args: [], allowFailure: true },
            { target: dao, iface: GOV_POOL_EXTRA_ABI, method: "getNftContracts", args: [], allowFailure: true },
            { target: dao, iface: GOV_POOL_EXTRA_ABI, method: "descriptionURL", args: [], allowFailure: true },
            { target: dao, iface: GOV_POOL_INBOX_ABI, method: "latestProposalId", args: [], allowFailure: true },
          ]);

          if (!helpersR?.success) {
            // Not a GovPool (or a dead RPC that answered) — every on-chain
            // section depends on the helpers, so say it once, here.
            onchainError =
              `${dao} did not answer getHelperContracts() on chain ${resolvedChainId} — it is not a DeXe GovPool, ` +
              `or the address is wrong for this chain. Check with ${toolRef("dexe_dao_registry_lookup")}.`;
          } else {
            helpers = helpersR.value as unknown as GovHelpers;
            if (nftR?.success) {
              const n = nftR.value as unknown as Record<string, string>;
              nftContracts = {
                nftMultiplier: n.nftMultiplier!,
                expertNft: n.expertNft!,
                dexeExpertNft: n.dexeExpertNft!,
                babt: n.babt!,
              };
            }
            if (descR?.success && typeof descR.value === "string") descriptionURL = descR.value;
            const latest = latestR?.success ? BigInt(latestR.value as string | number | bigint) : 0n;
            latestProposalId = latest.toString();

            // Newest-first window: the proposals that are still live are at the
            // END of the list, so a 0-anchored window misses exactly the ones a
            // report exists to surface (the F6 bug in the inbox scan).
            scanOffset = latest > BigInt(proposalLimit) ? latest - BigInt(proposalLimit) : 0n;

            const batch: Call[] = [
              { target: helpers.settings, iface: GOV_SETTINGS_ABI, method: "getDefaultSettings", args: [], allowFailure: true },
              { target: helpers.settings, iface: GOV_SETTINGS_ABI, method: "getInternalSettings", args: [], allowFailure: true },
              { target: helpers.validators, iface: GOV_VALIDATORS_ABI, method: "validatorsCount", args: [], allowFailure: true },
              { target: helpers.userKeeper, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [], allowFailure: true },
              { target: dao, iface: GOV_POOL_EXTRA_ABI, method: "getCreditInfo", args: [], allowFailure: true },
              {
                target: dao,
                iface: GOV_POOL_INBOX_ABI,
                method: "getProposals",
                args: [scanOffset, BigInt(proposalLimit)],
                allowFailure: true,
              },
            ];
            const [defR, intR, vcR, tokenR, creditR, proposalsR] = await multicall(provider, batch);

            if (defR?.success) defaultSettings = labelProposalSettings(defR.value);
            if (intR?.success) internalSettings = labelProposalSettings(intR.value);
            if (vcR?.success) validatorsCount = (vcR.value as bigint).toString();
            if (tokenR?.success) govToken = tokenR.value as string;
            if (creditR?.success) {
              creditLines = (
                creditR.value as unknown as Array<{
                  token: string;
                  monthLimit: bigint;
                  currentWithdrawLimit: bigint;
                }>
              ).map((c) => ({
                token: c.token,
                monthLimit: c.monthLimit.toString(),
                currentWithdrawLimit: c.currentWithdrawLimit.toString(),
              }));
            }
            if (proposalsR?.success) {
              const views = proposalsR.value as unknown as Array<{
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
                validatorProposal: { core: { voteEnd: bigint; executeAfter: bigint } };
                proposalState: bigint | number;
                requiredQuorum: bigint;
              }>;
              onchainProposals = views.map((v, i) => {
                const idx = Number(v.proposalState);
                return {
                  proposalId: (scanOffset + BigInt(i) + 1n).toString(),
                  state: proposalStateLabel(idx),
                  stateIndex: idx,
                  descriptionURL: v.proposal.descriptionURL,
                  votesFor: v.proposal.core.votesFor.toString(),
                  votesAgainst: v.proposal.core.votesAgainst.toString(),
                  voteEnd: v.proposal.core.voteEnd.toString(),
                  validatorVoteEnd: v.validatorProposal.core.voteEnd.toString(),
                  executeAfter: v.proposal.core.executeAfter.toString(),
                  executed: v.proposal.core.executed,
                  requiredQuorum: (v.requiredQuorum ?? 0n).toString(),
                };
              });
            }

            // Treasury + chain clock. Sequential with the batch above because
            // the gov token address only exists after it.
            const [balance, block] = await Promise.all([
              provider.getBalance(dao).catch(() => null),
              provider.getBlock("latest").catch(() => null),
            ]);
            nativeBalance = balance === null ? null : balance.toString();
            if (block) {
              blockNumber = block.number;
              chainNow = Number(block.timestamp);
            }
            if (govToken && isAddress(govToken) && govToken !== "0x" + "0".repeat(40)) {
              const [symR, decR, supplyR, balR] = await multicall(provider, [
                { target: govToken, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true },
                { target: govToken, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
                { target: govToken, iface: ERC20_ABI, method: "totalSupply", args: [], allowFailure: true },
                { target: govToken, iface: ERC20_ABI, method: "balanceOf", args: [dao], allowFailure: true },
              ]);
              tokenMeta = {
                token: govToken,
                symbol: symR?.success ? (symR.value as string) : null,
                decimals: decR?.success ? Number(decR.value as bigint) : null,
                totalSupply: supplyR?.success ? (supplyR.value as bigint).toString() : null,
                daoBalance: balR?.success ? (balR.value as bigint).toString() : null,
              };
            }
          }
        } catch (err) {
          onchainError = toActionableError(err, "dexe_dao_report on-chain reads").message;
        }
      }

      // ----- per-user deadline items (on-chain, needs a live pool) -----
      const personalItems: Array<Record<string, unknown>> = [];
      if (provider && userAddr && helpers && onchainProposals.length > 0 && want("deadlines")) {
        try {
          const voting = onchainProposals.filter(
            (p) => p.state === "Voting" || p.state === "ValidatorVoting",
          );
          if (voting.length > 0) {
            const res = await multicall(
              provider,
              voting.map((p) => ({
                target: dao,
                iface: GOV_POOL_INBOX_ABI,
                method: "getTotalVotes",
                args: [BigInt(p.proposalId), userAddr, 0],
                allowFailure: true,
              })),
            );
            voting.forEach((p, i) => {
              const r = res[i];
              if (r?.success && isUnvotedTotalVotes(r.value)) {
                personalItems.push({
                  kind: "unvoted",
                  proposalId: p.proposalId,
                  deadline: p.voteEnd,
                  deadlineUTC: unixToUtc(p.voteEnd),
                  secondsRemaining: int(p.voteEnd) - chainNow,
                });
              }
            });
          }
          const ids = onchainProposals.map((p) => BigInt(p.proposalId));
          const [rewardsR] = await multicall(provider, [
            {
              target: dao,
              iface: PENDING_REWARDS_ABI,
              method: "getPendingRewards",
              args: [userAddr, ids],
              allowFailure: true,
            },
          ]);
          if (rewardsR?.success) {
            const summary = summarizePendingRewards(
              rewardsR.value,
              onchainProposals.map((p) => p.proposalId),
            );
            if (summary) personalItems.push({ kind: "claimableRewards", ...summary });
          }
        } catch (err) {
          // Personal extras must never sink the DAO-level report.
          debugLog("report", "per-user deadline scan failed", err);
        }
      }

      // ----- subgraph reads -----
      interface PoolsData {
        daoPools: Array<Record<string, unknown>>;
        members: Array<Record<string, unknown>>;
        experts: Array<Record<string, unknown>>;
        proposals: Array<Record<string, unknown>>;
        delegations: Array<Record<string, unknown>>;
      }
      let poolsData: PoolsData | null = null;
      const poolsSource = { ...pools.source };
      const needsPools =
        want("identity") ||
        want("membership") ||
        want("delegation") ||
        want("experts") ||
        want("turnout");
      if (pools.url && needsPools) {
        try {
          poolsData = await gqlRequest<PoolsData>(pools.url, POOLS_REPORT_QUERY, {
            poolId: daoLower,
            pool: daoLower,
            members: memberLimit,
            proposals: proposalLimit,
            pairs: memberLimit,
          });
        } catch (err) {
          poolsSource.available = false;
          poolsSource.reason = toActionableError(err, "dexe_dao_report pools subgraph").message;
        }
      }

      let validatorRows: Array<Record<string, unknown>> | null = null;
      const validatorsSource = { ...validatorsSg.source };
      if (validatorsSg.url && want("validators")) {
        try {
          const d = await gqlRequest<{ validatorInPools: Array<Record<string, unknown>> }>(
            validatorsSg.url,
            VALIDATORS_REPORT_QUERY,
            { pool: daoLower, first: 100 },
          );
          validatorRows = d.validatorInPools;
        } catch (err) {
          validatorsSource.available = false;
          validatorsSource.reason = toActionableError(
            err,
            "dexe_dao_report validators subgraph",
          ).message;
        }
      }

      interface ActivityData {
        proposalsCreated: Array<Record<string, unknown>>;
        votes: Array<Record<string, unknown>>;
        executions: Array<Record<string, unknown>>;
        delegations: Array<Record<string, unknown>>;
        rewardClaims: Array<Record<string, unknown>>;
        deposits: Array<Record<string, unknown>>;
      }
      let activityData: ActivityData | null = null;
      const interactionsSource = { ...interactions.source };
      if (interactions.url && want("activity")) {
        try {
          activityData = await gqlRequest<ActivityData>(
            interactions.url,
            INTERACTIONS_ACTIVITY_QUERY,
            { pool: daoLower, since: String(activitySince), first: DELTA_ROW_CAP },
          );
        } catch (err) {
          interactionsSource.available = false;
          interactionsSource.reason = toActionableError(
            err,
            "dexe_dao_report interactions subgraph",
          ).message;
        }
      }

      // ----- since-scoped subgraph deltas -----
      interface DeltaData {
        joined: Array<Record<string, unknown>>;
        newDelegations: Array<Record<string, unknown>>;
        delegationEvents: Array<Record<string, unknown>>;
      }
      let deltaData: DeltaData | null = null;
      let deltaError: string | null = null;
      if (sinceUnix !== null && pools.url && poolsSource.available) {
        try {
          deltaData = await gqlRequest<DeltaData>(pools.url, POOLS_DELTA_QUERY, {
            pool: daoLower,
            since: String(sinceUnix),
            first: DELTA_ROW_CAP,
          });
        } catch (err) {
          deltaError = toActionableError(err, "dexe_dao_report since-diff").message;
        }
      }

      // ----- assemble sections -----
      const daoPool = poolsData?.daoPools?.[0] ?? null;
      const unavailable: Array<{ section: string; reason: string; followUp?: string }> = [];
      const followUps: string[] = [];
      const sectionsOut: Record<ReportSection, Section> = {} as Record<ReportSection, Section>;

      const onchainDown =
        onchainError ??
        (provider ? null : `No RPC for chain ${resolvedChainId}. ${rpcSource.reason ?? ""}`);
      const poolsDown = poolsSource.available
        ? null
        : (poolsSource.reason ?? `No pools subgraph for chain ${resolvedChainId}.`);

      const record = (name: ReportSection, s: Section) => {
        if (!want(name)) return;
        sectionsOut[name] = s;
        if (!s.available) {
          unavailable.push({
            section: name,
            reason: s.reason ?? "unavailable",
            ...(s.followUp ? { followUp: s.followUp } : {}),
          });
        }
      };

      // identity — on-chain helpers + subgraph name/creation. Renders with
      // either half; the missing half is named inside the section.
      if (want("identity")) {
        if (!helpers && !daoPool) {
          record(
            "identity",
            missing(
              `Neither the RPC nor the pools subgraph could describe ${dao}. ${onchainDown ?? ""} ${poolsDown ?? ""}`.trim(),
              `${toolRef("dexe_dao_registry_lookup", "is this address a DeXe DAO on this chain?")} / ` +
                toolRef("dexe_dao_info", "helpers + validator count, one RPC round-trip"),
            ),
          );
        } else {
          record(
            "identity",
            have(helpers && daoPool ? "mixed" : helpers ? "onchain" : "subgraph", {
              govPool: dao,
              chainId: resolvedChainId,
              name: daoPool ? str(daoPool.name) : null,
              descriptionURL,
              helpers,
              nftContracts,
              govToken,
              erc20Token: daoPool ? str(daoPool.erc20Token) : null,
              erc721Token: daoPool ? str(daoPool.erc721Token) : null,
              creationTime: daoPool ? str(daoPool.creationTime) : null,
              creationTimeUTC: daoPool ? unixToUtc(str(daoPool.creationTime) ?? 0) : null,
              creationBlock: daoPool ? str(daoPool.creationBlock) : null,
              ...(helpers ? {} : { onchainUnavailable: onchainDown }),
              ...(daoPool ? {} : { subgraphUnavailable: poolsDown ?? "DAO not indexed" }),
            }),
          );
        }
      }

      if (want("settings")) {
        record(
          "settings",
          defaultSettings || internalSettings
            ? have("onchain", {
                settingsContract: helpers?.settings ?? null,
                default: defaultSettings,
                internal: internalSettings,
              })
            : missing(
                onchainDown ?? `GovSettings on ${dao} did not answer getDefaultSettings().`,
                toolRef("dexe_read_settings"),
              ),
        );
      }

      if (want("treasury")) {
        // On-chain only, deliberately: the DeXe backend's token auto-discovery +
        // USD prices are mainnet-only and would make a core section of the
        // report fail on testnet. The two numbers here are also the ones a diff
        // can compare exactly, run to run.
        record(
          "treasury",
          nativeBalance !== null || tokenMeta
            ? have("onchain", {
                native: nativeBalance,
                govToken: tokenMeta,
                note:
                  "On-chain balances only — no token auto-discovery and no USD. " +
                  `Call ${toolRef("dexe_read_treasury")} for the full priced holdings (mainnets).`,
              })
            : missing(onchainDown ?? "Treasury balances unreadable.", toolRef("dexe_read_treasury")),
        );
        followUps.push(
          `${toolRef("dexe_read_treasury")} — full token discovery + USD prices for this DAO`,
        );
      }

      if (want("membership")) {
        record(
          "membership",
          poolsData
            ? have("subgraph", {
                totalMembers: daoPool ? str(daoPool.votersCount) : null,
                returned: poolsData.members.length,
                windowFull: poolsData.members.length >= memberLimit,
                members: poolsData.members,
                tokenHolders: {
                  available: false,
                  reason:
                    "Token-holder balances come from the DeXe backend (mainnets only) and are not part of this report.",
                  followUp: toolRef("dexe_read_token_holders"),
                },
              })
            : missing(
                poolsDown ?? "Members need the pools subgraph.",
                `${toolRef("dexe_read_dao_members", "same index, paginated")} / ` +
                  `${toolRef("dexe_graph_query", "subgraph: 'pools', voterInPools")} / ` +
                  toolRef("dexe_read_multicall", "on-chain balances, no indexer"),
              ),
        );
      }

      if (want("delegation")) {
        record(
          "delegation",
          poolsData
            ? have("subgraph", {
                // The gap this closes: dexe_read_delegation_map needs the caller
                // to already know the addresses. Filtering pairs by the
                // delegator's POOL answers "who delegated to whom in DAO X"
                // without one.
                totalTokenDelegated: daoPool ? str(daoPool.totalCurrentTokenDelegated) : null,
                totalDelegatees: daoPool ? str(daoPool.totalCurrentTokenDelegatees) : null,
                totalTreasuryDelegated: daoPool
                  ? str(daoPool.totalCurrentTokenDelegatedTreasury)
                  : null,
                returned: poolsData.delegations.length,
                windowFull: poolsData.delegations.length >= memberLimit,
                pairs: poolsData.delegations.map((p) => ({
                  delegator: (p.delegator as { voter?: { id?: string } })?.voter?.id ?? null,
                  delegatee: (p.delegatee as { voter?: { id?: string } })?.voter?.id ?? null,
                  delegateeIsExpert: Boolean(
                    (p.delegatee as { expertNft?: unknown } | undefined)?.expertNft,
                  ),
                  delegatedAmount: str(p.delegatedAmount),
                  delegatedVotes: str(p.delegatedVotes),
                  delegatedUSD: str(p.delegatedUSD),
                  delegatedNfts: p.delegatedNfts ?? [],
                  since: str(p.creationTimestamp),
                  sinceUTC: unixToUtc(str(p.creationTimestamp) ?? 0),
                })),
              })
            : missing(
                poolsDown ?? "Delegation pairs need the pools subgraph.",
                `${toolRef("dexe_read_delegation_map", "needs the addresses up front")} / ` +
                  toolRef("dexe_graph_query", "subgraph: 'pools', voterInPoolPairs — no address list needed"),
              ),
        );
      }

      if (want("experts")) {
        record(
          "experts",
          poolsData
            ? have("subgraph", {
                count: poolsData.experts.length,
                experts: poolsData.experts.map((e) => ({
                  address: (e.voter as { id?: string } | undefined)?.id ?? null,
                  expertNftTokenId: (e.expertNft as { tokenId?: string } | undefined)?.tokenId ?? null,
                  tags: (e.expertNft as { tags?: string[] } | undefined)?.tags ?? [],
                  receivedDelegation: str(e.receivedDelegation),
                  receivedTreasuryDelegation: str(e.receivedTreasuryDelegation),
                })),
              })
            : missing(
                poolsDown ?? "Experts need the pools subgraph.",
                `${toolRef("dexe_graph_query", "subgraph: 'pools', voterInPools where expertNft_: {id_not: null}")} / ` +
                  `${toolRef("dexe_read_dao_experts", "the roster, one call")} / ` +
                  toolRef("dexe_read_expert_status", "one address, on-chain — works with no indexer"),
              ),
        );
      }

      if (want("validators")) {
        const anyValidators = validatorsCount !== null || validatorRows !== null;
        record(
          "validators",
          anyValidators
            ? have(
                validatorsCount !== null && validatorRows !== null
                  ? "mixed"
                  : validatorsCount !== null
                    ? "onchain"
                    : "subgraph",
                {
                  contract: helpers?.validators ?? null,
                  count: validatorsCount,
                  creditLines,
                  validators:
                    validatorRows?.map((v) => ({
                      address: str(v.validatorAddress),
                      balance: str(v.balance),
                    })) ?? null,
                  ...(validatorRows
                    ? {}
                    : { rosterUnavailable: validatorsSource.reason ?? "no validators subgraph" }),
                },
              )
            : missing(
                onchainDown ?? validatorsSource.reason ?? "Validator data unavailable.",
                `${toolRef("dexe_dao_info", "on-chain validator count + the validators contract")} / ` +
                  `${toolRef("dexe_read_validators", "chamber state on-chain")} / ` +
                  toolRef("dexe_read_validator_list", "the roster, from the validators subgraph"),
              ),
        );
      }

      // proposals — throughput + outcomes, purely on-chain so it survives a
      // subgraph outage.
      const byState: Record<string, number> = {};
      for (const p of onchainProposals) byState[p.state] = (byState[p.state] ?? 0) + 1;
      if (want("proposals")) {
        record(
          "proposals",
          onchainProposals.length > 0 || latestProposalId !== null
            ? have("onchain", {
                latestProposalId,
                scanned: onchainProposals.length,
                scanFrom: (scanOffset + 1n).toString(),
                byState,
                outcomes: {
                  executedFor: byState.ExecutedFor ?? 0,
                  executedAgainst: byState.ExecutedAgainst ?? 0,
                  defeated: byState.Defeated ?? 0,
                  inFlight:
                    (byState.Voting ?? 0) +
                    (byState.ValidatorVoting ?? 0) +
                    (byState.WaitingForVotingTransfer ?? 0) +
                    (byState.Locked ?? 0) +
                    (byState.SucceededFor ?? 0) +
                    (byState.SucceededAgainst ?? 0),
                },
                proposals: onchainProposals,
              })
            : missing(
                onchainDown ?? "Proposal list unreadable.",
                `${toolRef("dexe_proposal_list")} / ${toolRef("dexe_proposal_state", "one proposal, in detail")}`,
              ),
        );
      }

      // turnout — the measured win: the subgraph returns per-proposal voter
      // counts for EVERY proposal in one query, where dexe_proposal_voters costs
      // one call each.
      if (want("turnout")) {
        if (poolsData) {
          const voters = poolsData.proposals.map((p) => int(p.votersVoted));
          const totalVoters = voters.reduce((s, n) => s + n, 0);
          const members = daoPool ? int(daoPool.votersCount) : 0;
          const avg = voters.length ? totalVoters / voters.length : 0;
          record(
            "turnout",
            have("subgraph", {
              proposalsMeasured: voters.length,
              averageVotersPerProposal: Number(avg.toFixed(2)),
              maxVotersOnAProposal: voters.length ? Math.max(...voters) : 0,
              zeroVoteProposals: voters.filter((v) => v === 0).length,
              participationRateOfMembers:
                members > 0 ? Number((avg / members).toFixed(4)) : null,
              perProposal: poolsData.proposals.map((p) => ({
                proposalId: str(p.proposalId),
                votersVoted: str(p.votersVoted),
                votesFor: str(p.currentVotesFor),
                votesAgainst: str(p.currentVotesAgainst),
                quorum: str(p.quorum),
                quorumReached: int(p.quorumReachedTimestamp) > 0,
                quorumReachedAtUTC: unixToUtc(str(p.quorumReachedTimestamp) ?? 0) || null,
                executedAtUTC: unixToUtc(str(p.executionTimestamp) ?? 0) || null,
                creator: (p.creator as { id?: string } | undefined)?.id ?? null,
              })),
            }),
          );
        } else {
          record(
            "turnout",
            missing(
              `${poolsDown ?? "Turnout needs the pools subgraph."} Per-proposal vote TOTALS are still in the ` +
                `\`proposals\` section (on-chain votesFor/votesAgainst); only the per-proposal VOTER COUNTS need the indexer.`,
              `${toolRef("dexe_graph_query", "subgraph: 'pools', proposals { proposalId votersVoted } — every proposal in one query")} / ` +
                toolRef("dexe_proposal_voters", "one call per proposal"),
            ),
          );
        }
      }

      if (want("activity")) {
        if (activityData) {
          const feed: Array<Record<string, unknown>> = [];
          const push = (
            kind: string,
            list: Array<Record<string, unknown>>,
            extra: (r: Record<string, unknown>) => Record<string, unknown>,
          ) => {
            for (const r of list) {
              const tx = r.transaction as { timestamp?: string; user?: string } | undefined;
              feed.push({
                kind,
                timestamp: str(tx?.timestamp),
                timestampUTC: unixToUtc(str(tx?.timestamp) ?? 0),
                user: tx?.user ?? null,
                ...extra(r),
              });
            }
          };
          push("proposalCreated", activityData.proposalsCreated, (r) => ({
            proposalId: str(r.proposalId),
          }));
          push("vote", activityData.votes, (r) => ({
            interactionType: str(r.interactionType),
            totalVote: str(r.totalVote),
          }));
          push("execute", activityData.executions, (r) => ({ proposalId: str(r.proposalId) }));
          push("delegate", activityData.delegations, (r) => ({ amount: str(r.amount) }));
          push("rewardClaim", activityData.rewardClaims, (r) => ({
            proposalId: str(r.proposalId),
          }));
          push("deposit", activityData.deposits, (r) => ({ amount: str(r.amount) }));
          feed.sort((a, b) => int(b.timestamp) - int(a.timestamp));
          const counts: Record<string, number> = {};
          for (const e of feed) counts[String(e.kind)] = (counts[String(e.kind)] ?? 0) + 1;
          const actors = new Set(feed.map((e) => String(e.user ?? "")).filter(Boolean));
          record(
            "activity",
            have("subgraph", {
              windowFrom: activitySince,
              windowFromUTC: unixToUtc(activitySince),
              windowSource: sinceUnix !== null ? "since" : "default-7d",
              totalEvents: feed.length,
              uniqueActors: actors.size,
              counts,
              events: feed.slice(0, DELTA_ROW_CAP),
            }),
          );
        } else {
          record(
            "activity",
            missing(
              interactionsSource.reason ??
                `Activity needs the interactions subgraph on chain ${resolvedChainId}.`,
              `${toolRef("dexe_graph_query", "subgraph: 'interactions', same feed, hand-written")} / ` +
                toolRef("dexe_read_user_activity", "per user"),
            ),
          );
        }
      }

      // deadlines — the only section that is about ACTING, so it is assembled
      // last and printed first.
      if (want("deadlines")) {
        if (onchainProposals.length === 0 && personalItems.length === 0) {
          record(
            "deadlines",
            onchainDown
              ? missing(
                  `${onchainDown} Deadlines are computed from on-chain proposal state, so there is nothing to time.`,
                  `${toolRef("dexe_proposal_list")} / ${toolRef("dexe_proposal_state", "one proposal")} / ` +
                    toolRef("dexe_user_inbox", "one wallet: unvoted proposals + claimable rewards"),
                )
              : have("onchain", { items: [], note: "No proposals in the scanned window." }),
          );
        } else {
          const items: Array<Record<string, unknown>> = [];
          const add = (
            kind: string,
            p: ProposalRow,
            at: string,
            action: string,
          ) => {
            const ts = int(at);
            if (ts <= 0) return;
            items.push({
              kind,
              proposalId: p.proposalId,
              state: p.state,
              deadline: at,
              deadlineUTC: unixToUtc(at),
              secondsRemaining: ts - chainNow,
              expired: ts - chainNow <= 0,
              action,
            });
          };
          for (const p of onchainProposals) {
            if (p.state === "Voting") add("votingEnds", p, p.voteEnd, "vote before it closes");
            else if (p.state === "ValidatorVoting")
              add("validatorVotingEnds", p, p.validatorVoteEnd, "validators must vote");
            else if (p.state === "SucceededFor" || p.state === "SucceededAgainst")
              add("executable", p, p.executeAfter, "execute it");
            else if (p.state === "Locked")
              add("executionDelay", p, p.executeAfter, "wait, then execute");
            else if (p.state === "WaitingForVotingTransfer")
              add("awaitingValidators", p, p.voteEnd, "move it to the validators chamber");
          }
          items.sort((a, b) => int(a.secondsRemaining) - int(b.secondsRemaining));
          record(
            "deadlines",
            have("onchain", {
              chainNow,
              chainNowUTC: unixToUtc(chainNow),
              items,
              personal: userAddr ? { user: userAddr, items: personalItems } : null,
              ...(userAddr
                ? {}
                : { note: "Pass `user` to add unvoted proposals and claimable rewards." }),
            }),
          );
        }
      }

      // ----- changes -----
      let changes: Record<string, unknown> | null = null;
      if (sinceUnix !== null) {
        const notes: string[] = [];
        if (deltaError) notes.push(deltaError);
        const usable = previous && previous.at <= nowWall ? previous : null;
        if (!previous) {
          notes.push(
            "No stored snapshot for this DAO, so state changes and count deltas could not be computed — " +
              "only what the indexer can date. This run lays down the baseline; the next `since` diff will be complete.",
          );
        }

        const newProposals = onchainProposals
          .filter((p) => {
            if (usable?.latestProposalId) return BigInt(p.proposalId) > BigInt(usable.latestProposalId);
            return false;
          })
          .map((p) => ({ proposalId: p.proposalId, state: p.state, descriptionURL: p.descriptionURL }));

        const stateChanges: Array<Record<string, unknown>> = [];
        if (usable) {
          for (const p of onchainProposals) {
            const before = usable.proposalStates[p.proposalId];
            if (before && before !== p.state) {
              stateChanges.push({ proposalId: p.proposalId, from: before, to: p.state });
            }
          }
        }

        const currentMemberIds = (poolsData?.members ?? [])
          .map((m) => String((m.voter as { id?: string } | undefined)?.id ?? "").toLowerCase())
          .filter(Boolean);
        const noLongerInWindow = usable
          ? usable.memberIds.filter((id) => !currentMemberIds.includes(id))
          : [];
        if (noLongerInWindow.length > 0 && (usable?.memberWindowFull ?? false)) {
          notes.push(
            `membersNoLongerInWindow is window-scoped: the previous member window was full (${usable?.memberIds.length} rows), ` +
              "so an address can drop out because newer members pushed it past `memberLimit`, not because it left. " +
              "membersCountDelta is the authoritative sign.",
          );
        }

        const treasuryDeltas: Array<Record<string, unknown>> = [];
        const nativeDelta = bigDelta(nativeBalance, usable?.treasuryNative ?? null);
        if (nativeDelta !== null && nativeDelta !== "0") {
          treasuryDeltas.push({ asset: "native", delta: nativeDelta, now: nativeBalance });
        }
        const tokenNow = tokenMeta ? str(tokenMeta.daoBalance) : null;
        const tokenDelta = bigDelta(tokenNow, usable?.treasuryToken ?? null);
        if (tokenDelta !== null && tokenDelta !== "0") {
          treasuryDeltas.push({
            asset: tokenMeta ? (str(tokenMeta.symbol) ?? "govToken") : "govToken",
            token: govToken,
            delta: tokenDelta,
            now: tokenNow,
          });
        }

        const membersTotalNow = daoPool ? str(daoPool.votersCount) : null;
        const delegationTotalNow = daoPool ? str(daoPool.totalCurrentTokenDelegated) : null;

        changes = {
          sinceUnix,
          sinceIso: new Date(sinceUnix * 1000).toISOString(),
          baseline: usable ? "snapshot" : deltaData ? "timestampOnly" : "none",
          baselineAt: usable ? new Date(usable.at * 1000).toISOString() : null,
          newProposals,
          proposalStateChanges: stateChanges,
          membersJoined: (deltaData?.joined ?? []).map((j) => ({
            address: (j.voter as { id?: string } | undefined)?.id ?? null,
            joinedAt: str(j.joinedTimestamp),
            joinedAtUTC: unixToUtc(str(j.joinedTimestamp) ?? 0),
          })),
          membersNoLongerInWindow: noLongerInWindow,
          membersCountDelta:
            membersTotalNow !== null && usable?.membersTotal
              ? int(membersTotalNow) - int(usable.membersTotal)
              : null,
          delegationChanges: [
            ...(deltaData?.newDelegations ?? []).map((d) => ({
              kind: "newPair",
              delegator: (d.delegator as { voter?: { id?: string } })?.voter?.id ?? null,
              delegatee: (d.delegatee as { voter?: { id?: string } })?.voter?.id ?? null,
              amount: str(d.delegatedAmount),
              votes: str(d.delegatedVotes),
              at: str(d.creationTimestamp),
            })),
            ...(deltaData?.delegationEvents ?? []).map((e) => ({
              kind: "event",
              type: str(e.type),
              amount: str(e.amount),
              delegator: (e.delegator as { id?: string } | undefined)?.id ?? null,
              delegatee: (e.delegatee as { id?: string } | undefined)?.id ?? null,
              at: str(e.timestamp),
            })),
          ],
          delegationTotalDelta: bigDelta(delegationTotalNow, usable?.delegationTotal ?? null),
          treasuryDeltas,
          validatorsCountDelta:
            validatorsCount !== null && usable?.validatorsCount
              ? int(validatorsCount) - int(usable.validatorsCount)
              : null,
          expertCountDelta:
            poolsData && usable?.expertCount != null
              ? poolsData.experts.length - usable.expertCount
              : null,
          notes,
        };
      }

      // ----- persist the snapshot for the NEXT diff -----
      let snapshotPersisted = false;
      // Two guards, both about not poisoning the next diff:
      //  - a run that saw nothing on-chain would record "every proposal
      //    vanished" and the next report would announce it as a state change;
      //  - a `sections`-narrowed run never looked at the sections it skipped,
      //    so publishing it as the baseline would age out a full snapshot and
      //    report the untouched fields as having reset to empty.
      const fullRun = !sections?.length;
      if (
        persist &&
        fullRun &&
        (onchainProposals.length > 0 || latestProposalId !== null || poolsData)
      ) {
        const proposalStates: Record<string, string> = {};
        for (const p of onchainProposals) proposalStates[p.proposalId] = p.state;
        const memberIds = (poolsData?.members ?? [])
          .map((m) => String((m.voter as { id?: string } | undefined)?.id ?? "").toLowerCase())
          .filter(Boolean);
        store.put({
          govPool: dao,
          chainId: resolvedChainId,
          at: nowWall,
          blockNumber,
          latestProposalId,
          proposalStates,
          memberIds,
          memberWindowFull: (poolsData?.members.length ?? 0) >= memberLimit,
          membersTotal: daoPool ? str(daoPool.votersCount) : null,
          delegationTotal: daoPool ? str(daoPool.totalCurrentTokenDelegated) : null,
          delegateesTotal: daoPool ? str(daoPool.totalCurrentTokenDelegatees) : null,
          treasuryNative: nativeBalance,
          treasuryToken: tokenMeta ? str(tokenMeta.daoBalance) : null,
          validatorsCount,
          expertCount: poolsData ? poolsData.experts.length : null,
        });
        snapshotPersisted = true;
      }

      if (poolsDown) {
        followUps.push(
          `${toolRef("dexe_proposal_list")} / ${toolRef("dexe_dao_info")} / ${toolRef("dexe_read_settings")} / ` +
            `${toolRef("dexe_read_treasury")} — on-chain reads that need no indexer, all in this profile`,
        );
        followUps.push(
          `${toolRef("dexe_read_multicall", "arbitrary view calls")} / ` +
            `${toolRef("dexe_read_gov_state", "raw GovPool/Validators/UserKeeper state")} — ` +
            "the escape hatches, for facts the tools above do not cover",
        );
      }

      const payload = {
        govPool: dao,
        chainId: resolvedChainId,
        generatedAt: new Date(nowWall * 1000).toISOString(),
        generatedAtUnix: nowWall,
        blockNumber,
        since:
          sinceUnix !== null && sinceMode
            ? {
                requested: since!,
                mode: sinceMode,
                unix: sinceUnix,
                iso: new Date(sinceUnix * 1000).toISOString(),
                ...(sinceNote ? { note: sinceNote } : {}),
              }
            : null,
        sources: {
          rpc: rpcSource,
          subgraphs: {
            pools: poolsSource,
            validators: validatorsSource,
            interactions: interactionsSource,
          },
        },
        sections: sectionsOut,
        unavailable,
        changes,
        followUps,
        snapshotPersisted,
      };

      const plain = jsonPlain(payload);
      return {
        content: [{ type: "text" as const, text: renderReport(plain) }],
        structuredContent: plain as unknown as Record<string, unknown>,
      };
    },
  );
}

// ---------- text rendering ----------

/**
 * The human/LLM view. Deliberately not `JSON.stringify(payload)`: a report is
 * read top-down, so deadlines and changes — the two things a reader must ACT on
 * — come first, and every unavailable section is printed by name rather than
 * being silently absent.
 *
 * Exported for tests; takes the already-plain payload.
 */
export function renderReport(p: Record<string, unknown>): string {
  const out: string[] = [];
  const sections = (p.sections ?? {}) as Record<string, { available?: boolean; data?: Record<string, unknown> | null; reason?: string; followUp?: string }>;
  const data = (name: string): Record<string, unknown> | null =>
    sections[name]?.available ? (sections[name]?.data ?? null) : null;

  const identity = data("identity");
  const name = identity?.name ? renderUntrusted(identity.name, 60) : "(unnamed)";
  out.push(`DAO REPORT — ${name}  ${p.govPool}  (chain ${p.chainId})`);
  out.push(`generated ${p.generatedAt}${p.blockNumber != null ? `  block ${p.blockNumber}` : ""}`);
  const since = p.since as { iso?: string; mode?: string; note?: string } | null;
  if (since) out.push(`since ${since.iso} (${since.mode})${since.note ? ` — ${since.note}` : ""}`);
  out.push("");

  // 1. Act on this.
  const deadlines = data("deadlines");
  if (deadlines) {
    const items = (deadlines.items ?? []) as Array<Record<string, unknown>>;
    const personal = deadlines.personal as { items?: Array<Record<string, unknown>> } | null;
    const live = items.filter((i) => !i.expired);
    out.push(`NEEDS ATTENTION — ${live.length} live deadline(s)`);
    for (const i of items.slice(0, 10)) {
      const rem = Number(i.secondsRemaining ?? 0);
      out.push(
        `  #${i.proposalId} ${String(i.kind).padEnd(20)} ${rem > 0 ? `in ${fmtDuration(rem)}` : `OVERDUE ${fmtDuration(rem)}`}  — ${i.action}  (${i.deadlineUTC})`,
      );
    }
    if (items.length > 10) out.push(`  … +${items.length - 10} more`);
    for (const i of personal?.items ?? []) {
      out.push(
        i.kind === "unvoted"
          ? `  YOU have not voted on #${i.proposalId} — ${Number(i.secondsRemaining) > 0 ? `${fmtDuration(Number(i.secondsRemaining))} left` : "CLOSED"}`
          : `  YOU can claim rewards on proposals ${(i.proposalIds as string[] | undefined)?.join(", ")} (total ${i.totalAmount})`,
      );
    }
    if (items.length === 0 && !(personal?.items ?? []).length) out.push("  nothing pending");
    out.push("");
  }

  // 2. What changed.
  const changes = p.changes as Record<string, unknown> | null;
  if (changes) {
    out.push(`CHANGES SINCE ${changes.sinceIso} (baseline: ${changes.baseline})`);
    const line = (label: string, n: number) => {
      if (n > 0) out.push(`  ${label}: ${n}`);
    };
    const arr = (k: string) => (changes[k] as unknown[] | undefined) ?? [];
    line("new proposals", arr("newProposals").length);
    for (const c of arr("proposalStateChanges") as Array<Record<string, unknown>>) {
      out.push(`  proposal #${c.proposalId}: ${c.from} -> ${c.to}`);
    }
    line("members joined", arr("membersJoined").length);
    if (changes.membersCountDelta != null && changes.membersCountDelta !== 0) {
      out.push(`  member count delta: ${Number(changes.membersCountDelta) > 0 ? "+" : ""}${changes.membersCountDelta}`);
    }
    line("delegation changes", arr("delegationChanges").length);
    if (changes.delegationTotalDelta && changes.delegationTotalDelta !== "0") {
      out.push(`  delegated-token delta: ${changes.delegationTotalDelta}`);
    }
    for (const t of arr("treasuryDeltas") as Array<Record<string, unknown>>) {
      out.push(`  treasury ${t.asset}: ${String(t.delta).startsWith("-") ? "" : "+"}${t.delta}`);
    }
    const nothing =
      arr("newProposals").length === 0 &&
      arr("proposalStateChanges").length === 0 &&
      arr("membersJoined").length === 0 &&
      arr("delegationChanges").length === 0 &&
      arr("treasuryDeltas").length === 0;
    if (nothing) out.push("  nothing changed in this window");
    for (const n of (changes.notes as string[] | undefined) ?? []) out.push(`  note: ${n}`);
    out.push("");
  }

  // 3. The standing picture.
  const proposals = data("proposals");
  if (proposals) {
    const o = (proposals.outcomes ?? {}) as Record<string, number>;
    out.push(
      `PROPOSALS — ${proposals.latestProposalId ?? "?"} total, ${proposals.scanned} scanned from #${proposals.scanFrom}`,
    );
    out.push(
      `  executed for/against: ${o.executedFor ?? 0}/${o.executedAgainst ?? 0}   defeated: ${o.defeated ?? 0}   in flight: ${o.inFlight ?? 0}`,
    );
  }
  const turnout = data("turnout");
  if (turnout) {
    out.push(
      `TURNOUT — avg ${turnout.averageVotersPerProposal} voters/proposal over ${turnout.proposalsMeasured} proposal(s), ` +
        `max ${turnout.maxVotersOnAProposal}, ${turnout.zeroVoteProposals} with zero votes` +
        (turnout.participationRateOfMembers != null
          ? `, participation ${(Number(turnout.participationRateOfMembers) * 100).toFixed(1)}% of members`
          : ""),
    );
  }
  const membership = data("membership");
  if (membership) {
    out.push(`MEMBERS — ${membership.totalMembers ?? "?"} total (${membership.returned} listed)`);
  }
  const delegation = data("delegation");
  if (delegation) {
    const pairs = (delegation.pairs ?? []) as Array<Record<string, unknown>>;
    out.push(
      `DELEGATION — ${delegation.totalDelegatees ?? "?"} delegatee(s), ${pairs.length} pair(s) listed, ${delegation.totalTokenDelegated ?? "?"} tokens delegated`,
    );
    for (const d of pairs.slice(0, 5)) {
      out.push(`  ${d.delegator} -> ${d.delegatee}${d.delegateeIsExpert ? " (expert)" : ""}  ${d.delegatedAmount}`);
    }
  }
  const experts = data("experts");
  if (experts) out.push(`EXPERTS — ${experts.count}`);
  const validators = data("validators");
  if (validators) {
    out.push(
      `VALIDATORS — ${validators.count ?? "?"}${validators.creditLines ? `, ${(validators.creditLines as unknown[]).length} credit line(s)` : ""}`,
    );
  }
  const treasury = data("treasury");
  if (treasury) {
    const t = treasury.govToken as Record<string, unknown> | null;
    out.push(
      `TREASURY — native ${treasury.native ?? "?"}` +
        (t ? `, ${renderUntrusted(t.symbol ?? "?", 20)} ${t.daoBalance ?? "?"} of ${t.totalSupply ?? "?"}` : ""),
    );
  }
  const activity = data("activity");
  if (activity) {
    const counts = (activity.counts ?? {}) as Record<string, number>;
    out.push(
      `ACTIVITY since ${activity.windowFromUTC} — ${activity.totalEvents} event(s), ${activity.uniqueActors} actor(s): ` +
        Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
    );
  }
  const settings = data("settings");
  if (settings) {
    const d = settings.default as Record<string, unknown> | null;
    if (d) {
      out.push(
        `SETTINGS — quorum ${d.quorumPct ?? "?"}%, duration ${d.duration ?? "?"}s, validators vote: ${d.validatorsVote}, delegated voting: ${d.delegatedVotingAllowed}`,
      );
    }
  }

  // 4. What is missing, and why. Never a silent omission.
  const unavailable = (p.unavailable ?? []) as Array<{ section: string; reason: string; followUp?: string }>;
  if (unavailable.length > 0) {
    out.push("");
    out.push(`SECTIONS NOT RENDERED (${unavailable.length}) — this report is partial:`);
    for (const u of unavailable) {
      out.push(`  ${u.section}: ${u.reason}${u.followUp ? `\n    try: ${u.followUp}` : ""}`);
    }
  }
  const followUps = (p.followUps ?? []) as string[];
  if (followUps.length > 0) {
    out.push("");
    out.push("Go deeper:");
    for (const f of followUps) out.push(`  ${f}`);
  }
  return out.join("\n");
}
