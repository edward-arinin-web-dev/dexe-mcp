import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Persistent operational state (Phase 3 / v0.14.0). The MCP server otherwise
 * remembers nothing between sessions — every session re-derives which DAOs
 * exist, which chain was last used, etc. This is a tiny JSON store that records
 * DAOs deployed via `dexe_dao_create` and proposals broadcast via
 * `dexe_proposal_create`, so `dexe_context` can surface them next session.
 *
 * Design: single-process, load-once-cache, atomic write (temp + rename).
 * Tolerant — a missing/corrupt/newer file never throws into a tool; it degrades
 * to empty state so a disk hiccup can't brick a broadcast.
 */

export const STATE_VERSION = 1;

export interface KnownDao {
  name: string;
  govPool: string;
  chainId: number;
  userKeeper?: string;
  token?: string;
  txHash?: string;
  /** ISO-8601 timestamp of when it was recorded. */
  deployedAt: string;
}

export interface RecentProposal {
  govPool: string;
  chainId: number;
  title?: string;
  descriptionURL?: string;
  txHash?: string;
  createdAt: string;
}

/** In-progress guided flow (Phase B knowledge layer) — survives sessions. */
export interface ActiveFlow {
  flow: string;
  step: string;
  chainId: number;
  govPool?: string;
  startedAt: string;
  updatedAt: string;
}

export interface PersistedState {
  version: number;
  knownDaos: KnownDao[];
  lastChainId?: number;
  recentProposals: RecentProposal[];
  /** address (lowercased) → human label. */
  walletLabels: Record<string, string>;
  /** Set while a dexe_guide-driven flow is mid-journey; cleared on the final step. */
  activeFlow?: ActiveFlow;
}

const MAX_DAOS = 50;
const MAX_PROPOSALS = 25;

function emptyState(): PersistedState {
  return { version: STATE_VERSION, knownDaos: [], recentProposals: [], walletLabels: {} };
}

/** Resolve the state file path: DEXE_STATE_PATH override, else ~/.dexe-mcp/state.json. */
export function resolveStatePath(override?: string): string {
  const raw = (override ?? process.env.DEXE_STATE_PATH)?.trim();
  if (raw) return raw;
  return join(homedir(), ".dexe-mcp", "state.json");
}

export class StateStore {
  private cache: PersistedState | null = null;

  constructor(private readonly path: string) {}

  /** Load (and cache) the state. Never throws — degrades to empty on any error. */
  load(): PersistedState {
    if (this.cache) return this.cache;
    this.cache = this.readFromDisk();
    return this.cache;
  }

  private readFromDisk(): PersistedState {
    try {
      if (!existsSync(this.path)) return emptyState();
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) {
        // Unknown/older schema — start fresh rather than risk misreads. (A real
        // migration ladder can slot in here when STATE_VERSION bumps.)
        if (parsed && parsed.version !== undefined && parsed.version !== STATE_VERSION) {
          process.stderr.write(
            `[dexe-mcp] state.json version ${parsed.version} != ${STATE_VERSION}; starting fresh.\n`,
          );
        }
        return emptyState();
      }
      return {
        version: STATE_VERSION,
        knownDaos: Array.isArray(parsed.knownDaos) ? parsed.knownDaos : [],
        lastChainId: typeof parsed.lastChainId === "number" ? parsed.lastChainId : undefined,
        recentProposals: Array.isArray(parsed.recentProposals) ? parsed.recentProposals : [],
        walletLabels:
          parsed.walletLabels && typeof parsed.walletLabels === "object" ? parsed.walletLabels : {},
        // Tolerant: a minimal shape check, never a throw — a garbled activeFlow
        // just reads as "no flow in progress".
        ...(parsed.activeFlow &&
        typeof parsed.activeFlow === "object" &&
        typeof parsed.activeFlow.flow === "string" &&
        typeof parsed.activeFlow.step === "string" &&
        typeof parsed.activeFlow.chainId === "number"
          ? { activeFlow: parsed.activeFlow }
          : {}),
      };
    } catch (err) {
      process.stderr.write(
        `[dexe-mcp] could not read state at ${this.path} (${err instanceof Error ? err.message : String(err)}); using empty state.\n`,
      );
      return emptyState();
    }
  }

  /** Atomic write: temp file + rename. Best-effort — logs and swallows errors. */
  private persist(state: PersistedState): void {
    this.cache = state;
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      process.stderr.write(
        `[dexe-mcp] could not persist state to ${this.path} (${err instanceof Error ? err.message : String(err)}).\n`,
      );
    }
  }

  getState(): PersistedState {
    return this.load();
  }

  /**
   * Record a deployed DAO. De-dupes by (govPool, chainId): a repeat deploy of
   * the same address updates the existing entry and moves it to the front.
   */
  recordDao(dao: KnownDao): void {
    const state = this.load();
    const key = (d: { govPool: string; chainId: number }) =>
      `${d.chainId}:${d.govPool.toLowerCase()}`;
    const k = key(dao);
    const rest = state.knownDaos.filter((d) => key(d) !== k);
    const next: PersistedState = {
      ...state,
      knownDaos: [dao, ...rest].slice(0, MAX_DAOS),
      lastChainId: dao.chainId,
    };
    this.persist(next);
  }

  /** Record a broadcast proposal (most-recent first, capped). */
  recordProposal(p: RecentProposal): void {
    const state = this.load();
    const next: PersistedState = {
      ...state,
      recentProposals: [p, ...state.recentProposals].slice(0, MAX_PROPOSALS),
      lastChainId: p.chainId,
    };
    this.persist(next);
  }

  setLastChainId(chainId: number): void {
    const state = this.load();
    this.persist({ ...state, lastChainId: chainId });
  }

  setWalletLabel(address: string, label: string): void {
    const state = this.load();
    this.persist({
      ...state,
      walletLabels: { ...state.walletLabels, [address.toLowerCase()]: label },
    });
  }

  /** Most-recently recorded DAO, or null. */
  lastDao(): KnownDao | null {
    return this.load().knownDaos[0] ?? null;
  }

  /** Record/advance the in-progress guided flow (keeps startedAt across steps of the same flow). */
  setActiveFlow(next: Omit<ActiveFlow, "startedAt" | "updatedAt">): void {
    const state = this.load();
    const now = new Date().toISOString();
    const startedAt =
      state.activeFlow && state.activeFlow.flow === next.flow ? state.activeFlow.startedAt : now;
    this.persist({ ...state, activeFlow: { ...next, startedAt, updatedAt: now } });
  }

  /** Clear the in-progress flow (final step completed or user abandoned it). */
  clearActiveFlow(): void {
    const state = this.load();
    if (!state.activeFlow) return;
    const { activeFlow: _dropped, ...rest } = state;
    this.persist(rest as PersistedState);
  }
}
